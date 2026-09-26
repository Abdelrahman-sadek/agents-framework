import { defineTool, ToolRuntime } from "./index.ts";
import { z } from "zod";

const runtime = new ToolRuntime();
const controller = new AbortController();
const tool = defineTool({
  name: "cancelable",
  description: "Cancelable tool",
  inputSchema: z.object({ delay: z.number() }),
  execute: async (input, context) => {
    console.log("tool execute start, signal:", !!context.signal, "aborted:", context.signal?.aborted);
    await new Promise<void>((resolve, reject) => {
      const id = setTimeout(() => { console.log("tool timeout resolve"); resolve(); }, input.delay);
      context.signal?.addEventListener("abort", () => {
        console.log("tool abort listener fired");
        clearTimeout(id);
        reject(new Error("Aborted"));
      }, { once: true });
    });
    console.log("tool execute end");
    return { ok: true };
  },
  timeoutMs: 5000,
});

const resultPromise = runtime.execute({
  tool,
  input: { delay: 5000 },
  callId: crypto.randomUUID(),
  runId: "run-1",
  agentId: "agent-1",
  signal: controller.signal,
});

console.log("waiting 50ms...");
await new Promise(r => setTimeout(r, 50));
console.log("aborting...");
controller.abort();
console.log("awaiting result...");
const result = await resultPromise;
console.log("result:", JSON.stringify(result));
