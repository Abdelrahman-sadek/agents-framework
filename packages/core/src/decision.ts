import type { Principal } from "./identity.js";

/**
 * Decision engine extension point.
 *
 * Routing, classification, ranking, verification, guard decisions,
 * prompt-injection detection, destructive-action gating, context compaction and
 * evaluation can be decided by deterministic rules, local models, external
 * engines or an LLM judge — without being folded into an agent prompt.
 *
 * Providers declare whether they are deterministic. Security-relevant callers
 * (e.g. tool authorization) must only accept deterministic providers.
 */
export type DecisionKind =
  | "routing"
  | "classification"
  | "ranking"
  | "verification"
  | "guard"
  | "prompt_injection"
  | "destructive_action"
  | "tool_authorization"
  | "context_compaction"
  | "evaluation"
  | (string & {});

export interface DecisionRequest<TInput = unknown> {
  kind: DecisionKind;
  input: TInput;
  runId?: string;
  agentId?: string;
  user?: Principal;
  metadata?: Readonly<Record<string, unknown>>;
}

export type DecisionVerdict = "allow" | "deny" | "abstain";

export interface Decision<TValue = unknown> {
  verdict: DecisionVerdict;
  /** Optional structured value (a route, a label, a ranking…). */
  value?: TValue;
  confidence?: number;
  reason?: string;
  providerId: string;
}

export interface DecisionProvider {
  readonly id: string;
  /** True when the same input always yields the same decision without a model call. */
  readonly deterministic: boolean;
  supports(kind: DecisionKind): boolean;
  decide(request: DecisionRequest): Decision | Promise<Decision>;
}

export interface DecisionEngine {
  decide(request: DecisionRequest): Promise<Decision>;
  readonly providers: readonly DecisionProvider[];
}

export interface DecisionEngineOptions {
  providers: readonly DecisionProvider[];
  /** When true, providers that are not deterministic are rejected at construction. */
  deterministicOnly?: boolean;
}

/**
 * Deny-overrides combination: any `deny` wins, then any `allow`, else `abstain`.
 * A provider that throws is treated as `deny` (fail closed).
 */
export function createDecisionEngine(options: DecisionEngineOptions): DecisionEngine {
  if (options.deterministicOnly === true) {
    const bad = options.providers.find((p) => !p.deterministic);
    if (bad !== undefined) {
      throw new TypeError(`Decision provider '${bad.id}' is not deterministic and cannot be used here`);
    }
  }
  const providers = [...options.providers];
  return {
    providers,
    async decide(request) {
      let allow: Decision | undefined;
      for (const provider of providers) {
        if (!provider.supports(request.kind)) continue;
        let decision: Decision;
        try {
          decision = await provider.decide(request);
        } catch (error) {
          return { verdict: "deny", providerId: provider.id, reason: `Decision provider failed: ${String(error)}` };
        }
        if (decision.verdict === "deny") return decision;
        if (decision.verdict === "allow") allow ??= decision;
      }
      return allow ?? { verdict: "abstain", providerId: "decision-engine", reason: "No provider decided" };
    },
  };
}

/** Deterministic rule provider built from a plain function. */
export function ruleDecisionProvider(
  id: string,
  kinds: readonly DecisionKind[],
  rule: (request: DecisionRequest) => Omit<Decision, "providerId">,
): DecisionProvider {
  return {
    id,
    deterministic: true,
    supports: (kind) => kinds.includes(kind),
    decide: (request) => ({ ...rule(request), providerId: id }),
  };
}
