import type { Principal } from "./identity.js";

/**
 * Guardrails inspect text at three stages: the user input, every tool result
 * (indirect prompt injection), and the final output. They are deterministic
 * code or deterministic providers; an LLM may assist but is never the only line.
 */
export type GuardrailStage = "input" | "tool_result" | "output";

export interface GuardrailContext {
  stage: GuardrailStage;
  runId: string;
  agentId: string;
  user?: Principal;
  toolName?: string;
}

export type GuardrailResult =
  | { action: "allow" }
  | { action: "block"; reason: string }
  | { action: "redact"; content: string; reason: string };

export interface Guardrail {
  readonly name: string;
  readonly stages: readonly GuardrailStage[];
  check(content: string, context: GuardrailContext): GuardrailResult | Promise<GuardrailResult>;
}

export interface GuardrailOutcome {
  content: string;
  blocked?: { guardrail: string; reason: string };
  redactions: { guardrail: string; reason: string }[];
}

/** Apply guardrails in order. Redactions compose; the first block wins. A throwing guardrail blocks (fail closed). */
export async function applyGuardrails(
  guardrails: readonly Guardrail[],
  content: string,
  context: GuardrailContext,
): Promise<GuardrailOutcome> {
  let current = content;
  const redactions: GuardrailOutcome["redactions"] = [];
  for (const guardrail of guardrails) {
    if (!guardrail.stages.includes(context.stage)) continue;
    let result: GuardrailResult;
    try {
      result = await guardrail.check(current, context);
    } catch (error) {
      return { content: current, blocked: { guardrail: guardrail.name, reason: `Guardrail failed: ${String(error)}` }, redactions };
    }
    if (result.action === "block") return { content: current, blocked: { guardrail: guardrail.name, reason: result.reason }, redactions };
    if (result.action === "redact") {
      current = result.content;
      redactions.push({ guardrail: guardrail.name, reason: result.reason });
    }
  }
  return { content: current, redactions };
}
