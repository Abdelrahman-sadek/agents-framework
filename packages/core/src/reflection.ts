import type { ContextItem } from "./context.js";
import type { LLMMessage, LLMProvider } from "./llm.js";

/**
 * Reflection / verification: Generate → Verify → Correct.
 *
 * Verifiers check a candidate answer with evidence: rules, schemas, sources,
 * tools, or a *different* critic model. A verifier must explain a failure so
 * the model can correct it. Reflection costs model calls, so it is opt-in and
 * bounded by `limits.maxReflectionAttempts`.
 */
export interface VerificationContext {
  runId: string;
  agentId: string;
  input: unknown;
  /** Final text produced by the model. */
  text: string;
  /** Parsed/validated output (equals `text` without an output schema). */
  output: unknown;
  contextItems: readonly ContextItem[];
  messages: readonly LLMMessage[];
  signal: AbortSignal;
}

export interface VerificationResult {
  passed: boolean;
  /** Required when `passed` is false: what is wrong and how to fix it. */
  feedback?: string;
  score?: number;
  evidence?: unknown;
}

export interface Verifier {
  readonly name: string;
  verify(context: VerificationContext): VerificationResult | Promise<VerificationResult>;
}

export interface ReflectionConfig {
  verifiers: readonly Verifier[];
}

/** Deterministic rule verifier. Return `true`, or a failure message. */
export function ruleVerifier(name: string, rule: (context: VerificationContext) => true | string | Promise<true | string>): Verifier {
  return {
    name,
    async verify(context) {
      const result = await rule(context);
      return result === true ? { passed: true } : { passed: false, feedback: result };
    },
  };
}

/**
 * Every `[n]` citation must refer to a provided context item, and at least
 * `minCitations` must be present when context was provided.
 */
export function citationVerifier(options: { minCitations?: number } = {}): Verifier {
  const min = options.minCitations ?? 1;
  return {
    name: "citations",
    verify({ text, contextItems }) {
      if (contextItems.length === 0) return { passed: true };
      const cited = [...text.matchAll(/\[(\d+)\]/g)].map((m) => Number(m[1]));
      const invalid = cited.filter((n) => n < 1 || n > contextItems.length);
      if (invalid.length > 0) {
        return { passed: false, feedback: `Citations ${invalid.map((n) => `[${n}]`).join(", ")} do not refer to provided sources (1–${contextItems.length}).` };
      }
      if (new Set(cited).size < min) {
        return { passed: false, feedback: `Cite at least ${min} source(s) using [number] from the reference material.` };
      }
      return { passed: true, evidence: { cited: [...new Set(cited)] } };
    },
  };
}

export interface LLMCriticOptions {
  provider: LLMProvider;
  modelId: string;
  /** What a good answer must satisfy. */
  rubric: string;
  name?: string;
}

/**
 * A critic model grades the answer against a rubric and the provided sources.
 * Use a different model (or at least a different prompt) from the generator;
 * a model grading its own output without evidence is not verification.
 */
export function llmCritic(options: LLMCriticOptions): Verifier {
  return {
    name: options.name ?? "llm-critic",
    async verify({ input, text, contextItems, signal }) {
      const sources = contextItems.map((c, i) => `[${i + 1}] ${c.content}`).join("\n");
      const response = await options.provider.generate({
        modelId: options.modelId,
        signal,
        responseFormat: { type: "json" },
        messages: [
          {
            role: "system",
            content:
              'You are a strict reviewer. Judge the ANSWER against the RUBRIC using only the SOURCES as evidence. Reply with JSON: {"passed": boolean, "feedback": string}.',
          },
          {
            role: "user",
            content: `RUBRIC:\n${options.rubric}\n\nQUESTION:\n${typeof input === "string" ? input : JSON.stringify(input)}\n\nSOURCES:\n${sources || "(none)"}\n\nANSWER:\n${text}`,
          },
        ],
      });
      try {
        const verdict = JSON.parse(response.content) as { passed?: unknown; feedback?: unknown };
        const passed = verdict.passed === true;
        return { passed, ...(typeof verdict.feedback === "string" ? { feedback: verdict.feedback } : passed ? {} : { feedback: "Critic rejected the answer" }) };
      } catch {
        return { passed: false, feedback: "Critic returned an unreadable verdict" };
      }
    },
  };
}
