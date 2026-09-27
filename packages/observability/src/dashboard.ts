import { createServer, type Server } from "node:http";
import type { AgentEvent } from "@agent-farmework/core";
import { inspectRun, type RunReport } from "./inspect.js";

export interface DashboardOptions {
  /** Source of events (e.g. an InMemoryEventSink's events, or a JSONL file reader). */
  events: () => readonly AgentEvent[] | Promise<readonly AgentEvent[]>;
  port?: number;
  /** Default 127.0.0.1 — the dashboard shows operational data; do not expose it without auth. */
  host?: string;
}

export interface Dashboard {
  server: Server;
  url: string;
  close(): Promise<void>;
}

export function summarizeRuns(events: readonly AgentEvent[]): RunReport[] {
  const byRun = new Map<string, AgentEvent[]>();
  for (const e of events) byRun.set(e.runId, [...(byRun.get(e.runId) ?? []), e]);
  return [...byRun.values()].map((list) => inspectRun(list)).sort((a, b) => (b.startedAt ?? "").localeCompare(a.startedAt ?? ""));
}

/** Read-only run inspection UI and JSON API over the event stream. */
export async function createDashboardServer(options: DashboardOptions): Promise<Dashboard> {
  const server = createServer((req, res) => {
    void (async () => {
      try {
        const url = new URL(req.url ?? "/", "http://localhost");
        const send = (status: number, type: string, body: string): void => {
          res.writeHead(status, { "content-type": type, "x-content-type-options": "nosniff", "content-security-policy": "default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'" });
          res.end(body);
        };
        if (req.method !== "GET") return send(405, "text/plain", "Method not allowed");
        const runs = summarizeRuns(await options.events());
        if (url.pathname === "/api/runs") return send(200, "application/json", JSON.stringify(runs.map(({ timeline: _t, ...summary }) => summary)));
        const match = /^\/api\/runs\/([^/]+)$/.exec(url.pathname);
        if (match !== null) {
          const run = runs.find((r) => r.runId === decodeURIComponent(match[1] ?? ""));
          return run === undefined ? send(404, "application/json", '{"error":"not found"}') : send(200, "application/json", JSON.stringify(run));
        }
        if (url.pathname === "/") return send(200, "text/html; charset=utf-8", PAGE);
        return send(404, "text/plain", "Not found");
      } catch (error) {
        res.writeHead(500, { "content-type": "text/plain" });
        res.end(error instanceof Error ? error.message : "error");
      }
    })();
  });
  await new Promise<void>((resolve) => server.listen(options.port ?? 0, options.host ?? "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : options.port;
  return { server, url: `http://${options.host ?? "127.0.0.1"}:${port}`, close: () => new Promise((resolve) => server.close(() => resolve())) };
}

// Data is rendered with textContent only (no innerHTML with run data), so event content cannot inject markup.
const PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Agent runs</title><style>
:root{--bg:#fff;--fg:#1a1a1a;--muted:#666;--line:#e5e5e5;--ok:#1a7f37;--bad:#cf222e;--wait:#9a6700}
@media (prefers-color-scheme:dark){:root{--bg:#0d1117;--fg:#e6edf3;--muted:#8b949e;--line:#30363d;--ok:#3fb950;--bad:#f85149;--wait:#d29922}}
body{margin:0;font:14px/1.5 system-ui,sans-serif;background:var(--bg);color:var(--fg)}main{max-width:1100px;margin:0 auto;padding:16px}
table{width:100%;border-collapse:collapse}th,td{text-align:left;padding:6px 8px;border-bottom:1px solid var(--line)}th{color:var(--muted);font-weight:500}
tr.run{cursor:pointer}tr.run:hover{background:color-mix(in srgb,var(--fg) 5%,transparent)}.COMPLETED{color:var(--ok)}.FAILED,.TIMED_OUT,.CANCELLED{color:var(--bad)}.WAITING_FOR_APPROVAL,.RUNNING{color:var(--wait)}
pre{white-space:pre-wrap;font:12px/1.5 ui-monospace,monospace;background:color-mix(in srgb,var(--fg) 4%,transparent);padding:12px;border-radius:6px;overflow-x:auto}
</style></head><body><main><h1>Agent runs</h1><table><thead><tr><th>Run</th><th>Agent</th><th>Status</th><th>Model calls</th><th>Tools</th><th>Tokens</th><th>Cost</th></tr></thead><tbody id="runs"></tbody></table><h2 id="title"></h2><pre id="detail"></pre></main>
<script>
const cell=(tr,text,cls)=>{const td=document.createElement("td");td.textContent=text;if(cls)td.className=cls;tr.appendChild(td)};
async function load(){const runs=await (await fetch("/api/runs")).json();const body=document.getElementById("runs");body.replaceChildren();
for(const r of runs){const tr=document.createElement("tr");tr.className="run";cell(tr,r.runId);cell(tr,r.agentId);cell(tr,r.status,r.status);cell(tr,String(r.llmCalls));cell(tr,String(r.toolCalls.length));cell(tr,String(r.tokens.input+r.tokens.output));cell(tr,"$"+r.costUsd.toFixed(5));tr.onclick=()=>show(r.runId);body.appendChild(tr)}}
async function show(id){const r=await (await fetch("/api/runs/"+encodeURIComponent(id))).json();document.getElementById("title").textContent=r.runId+" · "+r.agentId+" · "+r.status;
document.getElementById("detail").textContent=[...r.errors.map(e=>"error: "+e.code+" "+e.message),...r.toolCalls.map(t=>"tool: "+t.toolName+" "+t.outcome),...r.guardrails.map(g=>"guardrail: "+g.guardrail+"@"+g.stage+" "+g.action),"",...r.timeline.map(t=>String(t.sequence).padStart(3)+"  "+t.type.padEnd(28)+" "+t.summary)].join("\\n")}
load();setInterval(load,5000);
</script></body></html>`;
