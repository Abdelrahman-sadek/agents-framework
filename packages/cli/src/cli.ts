import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import type { Agent } from "@agent-farmework/core";
import { compareReports, formatReport, type Evaluation, type EvaluationReport } from "@agent-farmework/evaluation";
import { createDashboardServer, formatRunReport, inspectRun, readEventFile } from "@agent-farmework/observability";
import { SqliteRunStateStore, openSqlite } from "@agent-farmework/production";
import { checkManifest, parseManifest, type ManifestRegistry } from "./manifest.js";
import { scaffold } from "./templates.js";

export interface CliIO {
  out: (text: string) => void;
  err: (text: string) => void;
  cwd: string;
  /** Load a user module (default: dynamic import). */
  load?: (path: string) => Promise<Record<string, unknown>>;
  /** Read lines for `agent dev` (default: stdin). */
  lines?: () => AsyncIterable<string>;
  /** Resolves when a long-running command (dashboard) should stop (default: Ctrl-C). */
  waitForExit?: () => Promise<void>;
  /** Run a command (default: spawn with inherited stdio). */
  exec?: (command: string, args: string[]) => Promise<number>;
}

const HELP = `agent — Agent Framework developer CLI

Usage:
  agent create <name> [--dir agents]         Scaffold an agent, test, evaluation and manifest
  agent dev <module> [--input <text>]        Run an agent interactively (module exports \`agent\`)
  agent test [vitest args…]                  Run agent tests (vitest)
  agent evaluate <module> [--baseline f] [--out f]
                                             Run an evaluation (module exports \`evaluation\`)
  agent inspect <run-id> --db <sqlite file>  Show persisted run state
  agent trace <run-id> --events <file.jsonl> Show a run timeline from recorded events
  agent dashboard --events <file.jsonl> [--port 4319]
                                             Browse runs in a local web UI
  agent validate <manifest.json> [--registry <module>]
                                             Validate an agent manifest
  agent help
`;

const defaultIO = (): CliIO => ({
  out: (t) => process.stdout.write(t),
  err: (t) => process.stderr.write(t),
  cwd: process.cwd(),
});

async function loadExport<T>(io: CliIO, file: string, names: readonly string[]): Promise<T> {
  const path = resolve(io.cwd, file);
  const mod = io.load !== undefined ? await io.load(path) : ((await import(pathToFileURL(path).href)) as Record<string, unknown>);
  for (const name of names) if (mod[name] !== undefined) return mod[name] as T;
  throw new Error(`${file} must export ${names.map((n) => `\`${n}\``).join(" or ")}`);
}

export async function runCli(argv: readonly string[], ioOverrides: Partial<CliIO> = {}): Promise<number> {
  const io: CliIO = { ...defaultIO(), ...ioOverrides };
  const [command, ...rest] = argv;
  try {
    switch (command) {
      case "create": {
        const { positionals, values } = parseArgs({ args: rest, allowPositionals: true, options: { dir: { type: "string", default: "agents" } } });
        const name = positionals[0];
        if (name === undefined || !/^[a-z][a-z0-9-]{1,40}$/.test(name)) throw new Error("Usage: agent create <name> (lowercase letters, digits, dashes)");
        const dir = join(io.cwd, values.dir, name);
        if (existsSync(dir)) throw new Error(`${dir} already exists`);
        for (const [file, content] of Object.entries(scaffold(name))) {
          const target = join(dir, file);
          mkdirSync(dirname(target), { recursive: true });
          writeFileSync(target, content);
          io.out(`  created ${join(values.dir, name, file)}\n`);
        }
        io.out(`\nNext:\n  agent dev ${join(values.dir, name, "agent.ts")}\n  agent test ${join(values.dir, name)}\n  agent evaluate ${join(values.dir, name, "eval.ts")}\n`);
        return 0;
      }

      case "dev": {
        const { positionals, values } = parseArgs({ args: rest, allowPositionals: true, options: { input: { type: "string" } } });
        if (positionals[0] === undefined) throw new Error("Usage: agent dev <module>");
        const agent = await loadExport<Agent<unknown>>(io, positionals[0], ["agent", "default"]);
        const runOnce = async (input: string): Promise<void> => {
          const result = await agent.run({ input, user: { userId: "dev", tenantId: "dev", permissions: ["*"] } });
          const report = inspectRun(result.events);
          io.out(`\n${typeof result.output === "string" ? result.output : JSON.stringify(result.output, null, 2)}\n`);
          io.out(`\n[${result.status}] ${report.llmCalls} model call(s), ${report.toolCalls.length} tool call(s), ${result.usage.totalTokens} tokens, $${result.usage.estimatedCostUsd.toFixed(5)} · run ${result.runId}\n`);
          if (result.error !== undefined) io.err(`error: ${result.error.code} ${result.error.message}\n`);
          for (const a of result.pendingApprovals) io.out(`approval required: ${a.toolName} (${a.approvalId})\n`);
        };
        if (values.input !== undefined) {
          await runOnce(values.input);
          return 0;
        }
        io.out(`Chatting with ${agent.name}. Empty line or Ctrl-D to exit.\n`);
        const lines = io.lines?.() ?? createInterface({ input: process.stdin });
        for await (const line of lines) {
          if (line.trim() === "") break;
          await runOnce(line);
        }
        return 0;
      }

      case "test": {
        const exec = io.exec ?? ((cmd: string, args: string[]) => new Promise<number>((res) => spawn(cmd, args, { stdio: "inherit", cwd: io.cwd, shell: process.platform === "win32" }).on("exit", (code) => res(code ?? 1))));
        return await exec("npx", ["vitest", "run", ...rest]);
      }

      case "evaluate": {
        const { positionals, values } = parseArgs({ args: rest, allowPositionals: true, options: { baseline: { type: "string" }, out: { type: "string" } } });
        if (positionals[0] === undefined) throw new Error("Usage: agent evaluate <module>");
        const evaluation = await loadExport<Evaluation>(io, positionals[0], ["evaluation", "default"]);
        const report = await evaluation.run();
        io.out(`${formatReport(report)}\n`);
        if (values.out !== undefined) writeFileSync(resolve(io.cwd, values.out), JSON.stringify(report, null, 2));
        let ok = report.passed;
        if (values.baseline !== undefined) {
          const baseline = JSON.parse(readFileSync(resolve(io.cwd, values.baseline), "utf8")) as EvaluationReport;
          const diff = compareReports(baseline, report);
          for (const r of diff.regressions) io.out(`regression: ${r}\n`);
          for (const i of diff.improvements) io.out(`improvement: ${i}\n`);
          ok = ok && diff.passed;
        }
        return ok ? 0 : 1;
      }

      case "inspect": {
        const { positionals, values } = parseArgs({ args: rest, allowPositionals: true, options: { db: { type: "string" } } });
        if (positionals[0] === undefined || values.db === undefined) throw new Error("Usage: agent inspect <run-id> --db <sqlite file>");
        const store = new SqliteRunStateStore(await openSqlite(resolve(io.cwd, values.db)));
        const state = await store.load(positionals[0]);
        if (state === undefined) throw new Error(`Run '${positionals[0]}' not found`);
        io.out(`Run ${state.runId}  agent=${state.agentId}${state.agentVersion === undefined ? "" : `@${state.agentVersion}`}  status=${state.status}\n`);
        io.out(`Created ${state.createdAt}  updated ${state.updatedAt}  user=${state.user?.userId ?? "-"} tenant=${state.user?.tenantId ?? "-"}\n`);
        io.out(`Usage: ${state.usage.llmCalls} model calls, ${state.usage.toolCalls} tool calls, ${state.usage.totalTokens} tokens, $${state.usage.estimatedCostUsd.toFixed(5)}\n`);
        io.out("Steps:\n");
        for (const s of state.steps) io.out(`  ${String(s.index).padStart(3)} ${s.kind.padEnd(9)} ${s.status.padEnd(20)} ${s.toolName ?? ""}${s.error === undefined ? "" : `  ${s.error.code}: ${s.error.message}`}\n`);
        for (const p of state.pendingApprovals) io.out(`Pending approval: ${p.approval.toolName} ${p.approval.approvalId} expires ${p.approval.expiresAt ?? "never"}\n`);
        if (state.error !== undefined) io.out(`Error: ${state.error.code} ${state.error.message}\n`);
        if (state.status === "COMPLETED") io.out(`Output: ${typeof state.output === "string" ? state.output : JSON.stringify(state.output)}\n`);
        return 0;
      }

      case "trace": {
        const { positionals, values } = parseArgs({ args: rest, allowPositionals: true, options: { events: { type: "string" } } });
        if (positionals[0] === undefined || values.events === undefined) throw new Error("Usage: agent trace <run-id> --events <file.jsonl>");
        const events = readEventFile(resolve(io.cwd, values.events), positionals[0]);
        if (events.length === 0) throw new Error(`No events for run '${positionals[0]}'`);
        io.out(`${formatRunReport(inspectRun(events))}\n`);
        return 0;
      }

      case "dashboard": {
        const { values } = parseArgs({ args: rest, options: { events: { type: "string" }, port: { type: "string", default: "4319" } } });
        if (values.events === undefined) throw new Error("Usage: agent dashboard --events <file.jsonl> [--port 4319]");
        const file = resolve(io.cwd, values.events);
        const dashboard = await createDashboardServer({ events: () => readEventFile(file), port: Number(values.port) });
        io.out(`Dashboard: ${dashboard.url} (Ctrl-C to stop)\n`);
        await (io.waitForExit ?? (() => new Promise<void>((r) => process.once("SIGINT", () => r()))))();
        await dashboard.close();
        return 0;
      }

      case "validate": {
        const { positionals, values } = parseArgs({ args: rest, allowPositionals: true, options: { registry: { type: "string" } } });
        if (positionals[0] === undefined) throw new Error("Usage: agent validate <manifest.json>");
        const manifest = parseManifest(JSON.parse(readFileSync(resolve(io.cwd, positionals[0]), "utf8")));
        const problems = values.registry === undefined ? [] : checkManifest(manifest, await loadExport<ManifestRegistry>(io, values.registry, ["registry", "default"]));
        if (problems.length > 0) {
          for (const p of problems) io.err(`✖ ${p}\n`);
          return 1;
        }
        io.out(`✔ ${manifest.name}@${manifest.version} is valid\n`);
        return 0;
      }

      case undefined:
      case "help":
      case "--help":
      case "-h":
        io.out(HELP);
        return 0;

      default:
        io.err(`Unknown command '${command}'.\n\n${HELP}`);
        return 2;
    }
  } catch (error) {
    io.err(`${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}
