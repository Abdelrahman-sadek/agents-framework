import {
  ConfigurationError,
  applyGuardrails,
  type Agent,
  type AgentEvent,
  type Guardrail,
  type LLMProvider,
  type Principal,
  type Schema,
  type SerializedError,
  type Skill,
} from "@agent-farmework/core";

export interface EvalCase {
  id: string;
  input: unknown;
  /** Reference answer for correctness evaluators. */
  expected?: unknown;
  /** Tools that should be called / must not be called. */
  expectedTools?: readonly string[];
  forbiddenTools?: readonly string[];
  /** Documents a good retrieval should surface (knowledge source ids). */
  relevantDocuments?: readonly string[];
  user?: Principal;
  tags?: readonly string[];
}

export interface Dataset {
  name: string;
  cases: readonly EvalCase[];
}

/** Turn a skill's declared evaluation cases into a dataset. */
export function skillDataset(skill: Skill): Dataset {
  const cases = skill.evaluation?.cases ?? [];
  if (cases.length === 0) throw new ConfigurationError(`Skill '${skill.name}' declares no evaluation cases`);
  return defineDataset(`skill:${skill.name}`, cases.map((c) => ({ ...c, tags: [`skill:${skill.name}`] })));
}

export function defineDataset(name: string, cases: readonly EvalCase[]): Dataset {
  const ids = new Set<string>();
  for (const c of cases) {
    if (ids.has(c.id)) throw new ConfigurationError(`Dataset '${name}': duplicate case id '${c.id}'`);
    ids.add(c.id);
  }
  if (cases.length === 0) throw new ConfigurationError(`Dataset '${name}' has no cases`);
  return Object.freeze({ name, cases: Object.freeze([...cases]) });
}

/** What happened when the target ran on one case. */
export interface Observation {
  case: EvalCase;
  status: string;
  output: unknown;
  /** Text form of the output. */
  text: string;
  error?: SerializedError;
  latencyMs: number;
  costUsd: number;
  tokens: number;
  toolCalls: string[];
  /** Source document ids that reached the model context, in rank order. */
  retrievedDocuments: string[];
  /** Context passages that reached the model. */
  contextTexts: string[];
  events: readonly AgentEvent[];
}

export interface Score {
  /** 0–1 */
  score: number;
  passed: boolean;
  reason?: string;
}

export interface Evaluator {
  readonly name: string;
  evaluate(observation: Observation): Score | Promise<Score>;
}

export type EvalTarget = Agent<unknown> | ((evalCase: EvalCase, signal: AbortSignal) => Promise<Partial<Observation> & { output: unknown }>);

const toText = (v: unknown): string => (typeof v === "string" ? v : JSON.stringify(v) ?? "");
const normalize = (s: string): string => s.toLowerCase().replace(/\s+/g, " ").trim();
const score = (passed: boolean, reason?: string): Score => ({ score: passed ? 1 : 0, passed, ...(reason === undefined ? {} : { reason }) });

// ------------------------------------------------------------------ deterministic evaluators

export const evaluators = {
  /** Run ended with the given status (default COMPLETED). */
  status(expected = "COMPLETED"): Evaluator {
    return { name: "status", evaluate: (o) => score(o.status === expected, `status ${o.status}`) };
  },

  exactMatch(options: { caseSensitive?: boolean } = {}): Evaluator {
    return {
      name: "exact_match",
      evaluate: (o) => {
        const a = toText(o.output);
        const b = toText(o.case.expected);
        return score(options.caseSensitive === true ? a === b : normalize(a) === normalize(b));
      },
    };
  },

  /** Output contains the expected text(s). `expected` may be a string or string[]. */
  contains(options: { all?: boolean } = {}): Evaluator {
    return {
      name: "contains",
      evaluate: (o) => {
        const expected = Array.isArray(o.case.expected) ? (o.case.expected as unknown[]).map(toText) : [toText(o.case.expected)];
        const text = normalize(o.text);
        const hits = expected.filter((e) => text.includes(normalize(e)));
        const s = hits.length / expected.length;
        return { score: s, passed: options.all === false ? hits.length > 0 : s === 1, reason: `${hits.length}/${expected.length} expected phrases` };
      },
    };
  },

  regex(pattern: RegExp): Evaluator {
    return { name: "regex", evaluate: (o) => score(pattern.test(o.text)) };
  },

  jsonSchema(schema: Schema<unknown>): Evaluator {
    return {
      name: "json_schema",
      evaluate: (o) => {
        let value = o.output;
        if (typeof value === "string") {
          try {
            value = JSON.parse(value);
          } catch {
            return score(false, "not JSON");
          }
        }
        const r = schema.safeParse(value);
        return r.success ? score(true) : score(false, r.error.message);
      },
    };
  },

  /** Expected tools were called and forbidden tools were not. Score = recall of expected tools. */
  toolUsage(): Evaluator {
    return {
      name: "tool_usage",
      evaluate: (o) => {
        const expected = o.case.expectedTools ?? [];
        const forbidden = (o.case.forbiddenTools ?? []).filter((t) => o.toolCalls.includes(t));
        const hit = expected.filter((t) => o.toolCalls.includes(t)).length;
        const s = expected.length === 0 ? 1 : hit / expected.length;
        return { score: forbidden.length > 0 ? 0 : s, passed: forbidden.length === 0 && s === 1, reason: forbidden.length > 0 ? `forbidden: ${forbidden.join(", ")}` : `called ${o.toolCalls.join(", ") || "nothing"}` };
      },
    };
  },

  /** Recall@k of relevant documents among retrieved sources. */
  retrievalRecall(options: { k?: number; minRecall?: number } = {}): Evaluator {
    return {
      name: "retrieval_recall",
      evaluate: (o) => {
        const relevant = o.case.relevantDocuments ?? [];
        if (relevant.length === 0) return score(true, "no relevant documents specified");
        const top = new Set(o.retrievedDocuments.slice(0, options.k ?? 5));
        const recall = relevant.filter((d) => top.has(d)).length / relevant.length;
        return { score: recall, passed: recall >= (options.minRecall ?? 1), reason: `recall ${recall.toFixed(2)}` };
      },
    };
  },

  /**
   * Heuristic groundedness: share of answer sentences whose content words
   * mostly appear in the provided context. Use an LLM judge for nuance.
   */
  groundedness(options: { threshold?: number; minOverlap?: number } = {}): Evaluator {
    return {
      name: "groundedness",
      evaluate: (o) => {
        const context = new Set(o.contextTexts.join(" ").toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) ?? []);
        const sentences = o.text.split(/(?<=[.!?])\s+/).filter((s) => /[\p{L}]{3,}/u.test(s));
        if (sentences.length === 0) return score(false, "empty answer");
        const grounded = sentences.filter((s) => {
          const words = s.toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) ?? [];
          return words.length > 0 && words.filter((w) => context.has(w)).length / words.length >= (options.minOverlap ?? 0.5);
        }).length;
        const s = grounded / sentences.length;
        return { score: s, passed: s >= (options.threshold ?? 0.8), reason: `${grounded}/${sentences.length} sentences grounded` };
      },
    };
  },

  /** The output passes the given (deterministic) guardrails, e.g. PII or content policy. */
  safety(guardrails: readonly Guardrail[]): Evaluator {
    return {
      name: "safety",
      evaluate: async (o) => {
        const outcome = await applyGuardrails(guardrails, o.text, { stage: "output", runId: "eval", agentId: "eval" });
        if (outcome.blocked !== undefined) return score(false, `${outcome.blocked.guardrail}: ${outcome.blocked.reason}`);
        if (outcome.redactions.length > 0) return score(false, `would redact: ${outcome.redactions.map((r) => r.guardrail).join(", ")}`);
        return score(true);
      },
    };
  },

  cost(maxUsd: number): Evaluator {
    return { name: "cost", evaluate: (o) => ({ score: o.costUsd <= maxUsd ? 1 : maxUsd / o.costUsd, passed: o.costUsd <= maxUsd, reason: `$${o.costUsd.toFixed(5)}` }) };
  },

  latency(maxMs: number): Evaluator {
    return { name: "latency", evaluate: (o) => ({ score: o.latencyMs <= maxMs ? 1 : maxMs / o.latencyMs, passed: o.latencyMs <= maxMs, reason: `${o.latencyMs}ms` }) };
  },

  /** Model-graded evaluation against a rubric (LLM-as-judge). Use a different model than the one under test. */
  llmJudge(options: { provider: LLMProvider; modelId: string; rubric: string; name?: string; passScore?: number }): Evaluator {
    return {
      name: options.name ?? "llm_judge",
      async evaluate(o) {
        const response = await options.provider.generate({
          modelId: options.modelId,
          responseFormat: { type: "json" },
          settings: { temperature: 0 },
          messages: [
            { role: "system", content: 'You grade answers. Reply with JSON {"score": number between 0 and 1, "reason": string}. Judge only against the rubric.' },
            {
              role: "user",
              content: `RUBRIC:\n${options.rubric}\n\nQUESTION:\n${toText(o.case.input)}\n\nREFERENCE:\n${o.case.expected === undefined ? "(none)" : toText(o.case.expected)}\n\nCONTEXT:\n${o.contextTexts.join("\n---\n") || "(none)"}\n\nANSWER:\n${o.text}`,
            },
          ],
        });
        try {
          const parsed = JSON.parse(response.content) as { score?: unknown; reason?: unknown };
          const s = typeof parsed.score === "number" ? Math.max(0, Math.min(1, parsed.score)) : 0;
          return { score: s, passed: s >= (options.passScore ?? 0.7), ...(typeof parsed.reason === "string" ? { reason: parsed.reason } : {}) };
        } catch {
          return score(false, "judge returned unreadable output");
        }
      },
    };
  },
};

// ------------------------------------------------------------------ running

export interface EvaluationConfig {
  name: string;
  dataset: Dataset;
  target: EvalTarget;
  evaluators: readonly Evaluator[];
  concurrency?: number;
  /** Per-case timeout. Default 120 s. */
  timeoutMs?: number;
  thresholds?: {
    /** Share of cases that must pass all evaluators. Default 1. */
    minPassRate?: number;
    /** Minimum mean score per evaluator. */
    minMeanScore?: Readonly<Record<string, number>>;
    maxTotalCostUsd?: number;
  };
}

export interface CaseResult {
  id: string;
  status: string;
  passed: boolean;
  scores: Record<string, Score>;
  output: unknown;
  error?: SerializedError;
  latencyMs: number;
  costUsd: number;
  tokens: number;
  toolCalls: string[];
}

export interface EvaluationReport {
  name: string;
  dataset: string;
  startedAt: string;
  durationMs: number;
  cases: CaseResult[];
  summary: {
    cases: number;
    passed: number;
    passRate: number;
    meanScores: Record<string, number>;
    totalCostUsd: number;
    totalTokens: number;
    p50LatencyMs: number;
    p95LatencyMs: number;
  };
  /** Threshold violations; empty when the evaluation passed. */
  failures: string[];
  passed: boolean;
}

export interface Evaluation {
  readonly name: string;
  run(options?: { signal?: AbortSignal; filter?: (c: EvalCase) => boolean }): Promise<EvaluationReport>;
}

async function observe(target: EvalTarget, evalCase: EvalCase, signal: AbortSignal): Promise<Observation> {
  const started = Date.now();
  if (typeof target === "function") {
    try {
      const partial = await target(evalCase, signal);
      return {
        status: "COMPLETED",
        text: toText(partial.output),
        costUsd: 0,
        tokens: 0,
        toolCalls: [],
        retrievedDocuments: [],
        contextTexts: [],
        events: [],
        ...partial,
        case: evalCase,
        latencyMs: partial.latencyMs ?? Date.now() - started,
      };
    } catch (error) {
      return { case: evalCase, status: "FAILED", output: undefined, text: "", error: { code: "EVAL_TARGET_ERROR", message: String(error), category: "execution", retryable: false }, latencyMs: Date.now() - started, costUsd: 0, tokens: 0, toolCalls: [], retrievedDocuments: [], contextTexts: [], events: [] };
    }
  }
  const result = await target.run({ input: evalCase.input, signal, ...(evalCase.user === undefined ? {} : { user: evalCase.user }), metadata: { evaluationCase: evalCase.id } });
  const state = await target.config.runtime?.getState(result.runId);
  const toolCalls = result.events.flatMap((e) => (e.type === "TOOL_REQUESTED" ? [e.payload.toolName] : []));
  const items = state?.contextItems ?? [];
  return {
    case: evalCase,
    status: result.status,
    output: result.output,
    text: toText(result.output ?? ""),
    ...(result.error === undefined ? {} : { error: result.error }),
    latencyMs: Date.now() - started,
    costUsd: result.usage.estimatedCostUsd,
    tokens: result.usage.totalTokens,
    toolCalls,
    retrievedDocuments: [...new Set(items.flatMap((i) => (i.source === undefined ? [] : [i.source.id])))],
    contextTexts: items.map((i) => i.content),
    events: result.events,
  };
}

function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)] ?? 0;
}

export function defineEvaluation(config: EvaluationConfig): Evaluation {
  if (config.evaluators.length === 0) throw new ConfigurationError(`Evaluation '${config.name}' has no evaluators`);
  const names = config.evaluators.map((e) => e.name);
  if (new Set(names).size !== names.length) throw new ConfigurationError(`Evaluation '${config.name}' has duplicate evaluator names`);
  return {
    name: config.name,
    async run(options = {}) {
      const startedAt = new Date();
      const cases = config.dataset.cases.filter(options.filter ?? (() => true));
      const results: CaseResult[] = new Array(cases.length);
      let next = 0;
      const worker = async (): Promise<void> => {
        for (;;) {
          const index = next++;
          const evalCase = cases[index];
          if (evalCase === undefined) return;
          const signals = [AbortSignal.timeout(config.timeoutMs ?? 120_000), ...(options.signal === undefined ? [] : [options.signal])];
          const observation = await observe(config.target, evalCase, AbortSignal.any(signals));
          const scores: Record<string, Score> = {};
          for (const evaluator of config.evaluators) {
            try {
              scores[evaluator.name] = await evaluator.evaluate(observation);
            } catch (error) {
              scores[evaluator.name] = { score: 0, passed: false, reason: `evaluator error: ${String(error)}` };
            }
          }
          results[index] = {
            id: evalCase.id,
            status: observation.status,
            passed: Object.values(scores).every((s) => s.passed),
            scores,
            output: observation.output,
            ...(observation.error === undefined ? {} : { error: observation.error }),
            latencyMs: observation.latencyMs,
            costUsd: observation.costUsd,
            tokens: observation.tokens,
            toolCalls: observation.toolCalls,
          };
        }
      };
      await Promise.all(Array.from({ length: Math.max(1, Math.min(config.concurrency ?? 4, cases.length)) }, worker));

      const passed = results.filter((r) => r.passed).length;
      const meanScores = Object.fromEntries(names.map((n) => [n, results.reduce((s, r) => s + (r.scores[n]?.score ?? 0), 0) / Math.max(1, results.length)]));
      const summary = {
        cases: results.length,
        passed,
        passRate: results.length === 0 ? 0 : passed / results.length,
        meanScores,
        totalCostUsd: results.reduce((s, r) => s + r.costUsd, 0),
        totalTokens: results.reduce((s, r) => s + r.tokens, 0),
        p50LatencyMs: percentile(results.map((r) => r.latencyMs), 50),
        p95LatencyMs: percentile(results.map((r) => r.latencyMs), 95),
      };
      const failures: string[] = [];
      const t = config.thresholds ?? {};
      if (summary.passRate < (t.minPassRate ?? 1)) failures.push(`pass rate ${(summary.passRate * 100).toFixed(1)}% < ${((t.minPassRate ?? 1) * 100).toFixed(1)}%`);
      for (const [name, min] of Object.entries(t.minMeanScore ?? {})) {
        if ((meanScores[name] ?? 0) < min) failures.push(`${name} mean ${(meanScores[name] ?? 0).toFixed(3)} < ${min}`);
      }
      if (t.maxTotalCostUsd !== undefined && summary.totalCostUsd > t.maxTotalCostUsd) failures.push(`cost $${summary.totalCostUsd.toFixed(4)} > $${t.maxTotalCostUsd}`);
      return { name: config.name, dataset: config.dataset.name, startedAt: startedAt.toISOString(), durationMs: Date.now() - startedAt.getTime(), cases: results, summary, failures, passed: failures.length === 0 };
    },
  };
}

// ------------------------------------------------------------------ reporting

export function formatReport(report: EvaluationReport): string {
  const names = Object.keys(report.summary.meanScores);
  const lines = [
    `# Evaluation: ${report.name} (${report.dataset})`,
    "",
    `**${report.passed ? "PASSED" : "FAILED"}** — ${report.summary.passed}/${report.summary.cases} cases passed (${(report.summary.passRate * 100).toFixed(1)}%), cost $${report.summary.totalCostUsd.toFixed(4)}, p50 ${report.summary.p50LatencyMs}ms, p95 ${report.summary.p95LatencyMs}ms`,
    ...report.failures.map((f) => `- ❌ ${f}`),
    "",
    `| Case | Status | ${names.join(" | ")} |`,
    `| --- | --- | ${names.map(() => "---").join(" | ")} |`,
    ...report.cases.map((c) => `| ${c.passed ? "✅" : "❌"} ${c.id} | ${c.status} | ${names.map((n) => (c.scores[n] === undefined ? "–" : c.scores[n].score.toFixed(2))).join(" | ")} |`),
    `| **mean** | | ${names.map((n) => (report.summary.meanScores[n] ?? 0).toFixed(2)).join(" | ")} |`,
  ];
  return lines.join("\n");
}

export interface RegressionComparison {
  regressions: string[];
  improvements: string[];
  passed: boolean;
}

/** Regression testing: compare a run against a baseline report. */
export function compareReports(baseline: EvaluationReport, current: EvaluationReport, options: { tolerance?: number } = {}): RegressionComparison {
  const tolerance = options.tolerance ?? 0.02;
  const regressions: string[] = [];
  const improvements: string[] = [];
  for (const [name, before] of Object.entries(baseline.summary.meanScores)) {
    const after = current.summary.meanScores[name];
    if (after === undefined) continue;
    if (after < before - tolerance) regressions.push(`${name}: ${before.toFixed(3)} → ${after.toFixed(3)}`);
    else if (after > before + tolerance) improvements.push(`${name}: ${before.toFixed(3)} → ${after.toFixed(3)}`);
  }
  const baseCases = new Map(baseline.cases.map((c) => [c.id, c]));
  for (const c of current.cases) {
    if (baseCases.get(c.id)?.passed === true && !c.passed) regressions.push(`case ${c.id} now fails`);
    if (baseCases.get(c.id)?.passed === false && c.passed) improvements.push(`case ${c.id} now passes`);
  }
  return { regressions, improvements, passed: regressions.length === 0 };
}
