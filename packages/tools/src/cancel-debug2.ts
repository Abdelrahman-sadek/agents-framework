import { z } from "zod";

// Inline the relevant types and logic to debug cancellation

interface ToolPermissions {
  allowed?: string[];
  denied?: string[];
  dataScope?: string[];
}

interface ToolRetryConfig {
  maxAttempts: number;
  backoff?: "fixed" | "exponential";
  initialDelayMs?: number;
}

interface ToolExecutionContext {
  runId: string;
  agentId: string;
  userId?: string;
  tenantId?: string;
  organizationId?: string;
  toolCallId: string;
  stepId?: string;
  metadata?: Record<string, unknown>;
  signal?: AbortSignal;
}

interface ToolCallRequest<TInput> {
  tool: {
    name: string;
    description: string;
    inputSchema: z.ZodSchema<TInput>;
    outputSchema?: z.ZodSchema<unknown>;
    version?: string;
    execute: (input: TInput, context: ToolExecutionContext) => Promise<unknown>;
    permissions?: ToolPermissions;
    timeoutMs?: number;
    retry?: ToolRetryConfig;
    metadata?: Record<string, unknown>;
  };
  input: TInput;
  callId: string;
  runId: string;
  agentId: string;
  userId?: string;
  tenantId?: string;
  organizationId?: string;
  stepId?: string;
}

class ToolRuntime {
  async execute<TInput, TOutput>(
    request: ToolCallRequest<TInput>,
    runConfig?: { signal?: AbortSignal; toolCallId?: string },
  ): Promise<{ ok: boolean; output?: TOutput; error?: { code: string; message: string } }> {
    const toolCallId = runConfig?.toolCallId ?? crypto.randomUUID();
    const context: ToolExecutionContext = {
      runId: request.runId,
      agentId: request.agentId,
      userId: request.userId,
      tenantId: request.tenantId,
      organizationId: request.organizationId,
      toolCallId,
      stepId: request.stepId,
      metadata: request.tool.metadata,
      signal: runConfig?.signal ?? request.tool.metadata?.signal,
    };

    const startedAt = Date.now();

    try {
      const result = await this.executeWithReliability(request.tool, request.input, context);
      const durationMs = Date.now() - startedAt;
      return result;
    } catch (err) {
      const durationMs = Date.now() - startedAt;
      console.log("caught error in execute, durationMs:", durationMs);
      return { ok: false, error: { code: "TOOL_ERROR", message: String(err) } };
    }
  }

  private async executeWithReliability<TInput, TOutput>(
    tool: ToolCallRequest<TInput>["tool"],
    input: TInput,
    context: ToolExecutionContext,
  ): Promise<{ ok: boolean; output?: TOutput; error?: { code: string; message: string } }> {
    const timeoutMs = tool.timeoutMs ?? 30000;

    const runWithTimeout = async (): Promise<{ ok: boolean; output?: TOutput; error?: { code: string; message: string } }> => {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => {
        try { controller.abort(new Error("Tool execution timed out")); } catch {}
      }, timeoutMs);

      // Combine the internal timeout signal with any external caller signal
      const signals: AbortSignal[] = [controller.signal];
      if (context.signal) {
        signals.push(context.signal);
      }
      const combinedSignal = signals.length === 1 ? controller.signal : AbortSignal.any(signals);

      console.log("runWithTimeout: combinedSignal is AbortSignal.any?", signals.length > 1);
      console.log("runWithTimeout: controller.signal.aborted:", controller.signal.aborted);
      console.log("runWithTimeout: context.signal.aborted:", context.signal?.aborted);

      try {
        const output = await tool.execute(input, { ...context, signal: combinedSignal });
        console.log("tool.execute completed successfully");
        return { ok: true, output: output as TOutput };
      } catch (err: any) {
        console.log("tool.execute threw:", err?.name, err?.message);
        if (err && err.name === "AbortError") {
          console.log("AbortError caught, returning TOOL_CALL_TIMED_OUT");
          return { ok: false, error: { code: "TOOL_CALL_TIMED_OUT", message: `Tool execution timed out after ${timeoutMs}ms` } };
        }
        if (controller.signal.aborted) {
          console.log("controller.signal.aborted, returning TOOL_CALL_TIMED_OUT");
          return { ok: false, error: { code: "TOOL_CALL_TIMED_OUT", message: `Tool execution timed out after ${timeoutMs}ms` } };
        }
        return { ok: false, error: { code: "TOOL_ERROR", message: err?.message ?? String(err) } };
      } finally {
        clearTimeout(timeoutId);
      }
    };

    return runWithTimeout();
  }
}

const runtime = new ToolRuntime();
const controller = new AbortController();
const tool = {
  name: "cancelable",
  description: "Cancelable tool",
  inputSchema: z.object({ delay: z.number() }),
  execute: async (input, context) => {
    console.log("tool execute start, signal:", !!context.signal, "aborted:", context.signal?.aborted);
    console.log("tool execute: context.signal === controller.signal?", context.signal === controller.signal);
    await new Promise<void>((resolve, reject) => {
      const id = setTimeout(() => { console.log("tool timeout resolve"); resolve(); }, input.delay);
      context.signal?.addEventListener("abort", () => {
        console.log("tool abort listener fired, signal.aborted:", context.signal?.aborted);
        clearTimeout(id);
        reject(new Error("Aborted"));
      }, { once: true });
    });
    console.log("tool execute end");
    return { ok: true };
  },
  timeoutMs: 5000,
};

console.log("=== Starting test ===");
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
console.log("aborting external controller...");
controller.abort();
console.log("external controller.signal.aborted:", controller.signal.aborted);
console.log("awaiting result...");
const result = await resultPromise;
console.log("result:", JSON.stringify(result));
console.log("=== Test complete ===");
