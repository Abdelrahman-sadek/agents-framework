import { hasPermission, type AgentIdentity, type DecisionEngine, type Principal } from "@agent-farmework/core";
import type { ToolKind } from "./tool.js";

export interface ToolAuthorizationRequest {
  tool: {
    name: string;
    version: string | undefined;
    kind: ToolKind;
    permissions: readonly string[];
    metadata: Readonly<Record<string, unknown>>;
  };
  /** Schema-validated input. Policies may inspect it for data-level rules. */
  input: unknown;
  agent: AgentIdentity;
  user?: Principal;
  runId: string;
  toolCallId: string;
}

export interface ToolAuthorizationDecision {
  allowed: boolean;
  /** Operator-facing reason. Recorded in audit and events; not sent to the model. */
  reason: string;
  /** Name of the policy that decided. */
  policy: string;
}

/** Deterministic authorization. The model's output is never an input to "am I allowed". */
export interface ToolPolicy {
  readonly name: string;
  authorize(request: ToolAuthorizationRequest): ToolAuthorizationDecision | Promise<ToolAuthorizationDecision>;
}

export interface PermissionPolicyOptions {
  /** Deny tool calls in runs without a user identity. Default false (system/batch agents). */
  requireUser?: boolean;
}

/**
 * Default policy: every permission a tool requires must be granted to the
 * agent identity AND, when a user is present, to the user. An agent can never
 * give a user more than the user has (no escalation through the agent), and a
 * user can never widen what the agent may do.
 */
export function permissionPolicy(options: PermissionPolicyOptions = {}): ToolPolicy {
  return {
    name: "permission",
    authorize({ tool, agent, user }) {
      if (options.requireUser === true && user === undefined) {
        return { allowed: false, policy: "permission", reason: "A user identity is required to call tools" };
      }
      for (const permission of tool.permissions) {
        if (!hasPermission(agent.permissions, permission)) {
          return { allowed: false, policy: "permission", reason: `Agent '${agent.agentId}' lacks permission '${permission}'` };
        }
        if (user !== undefined && !hasPermission(user.permissions, permission)) {
          return { allowed: false, policy: "permission", reason: `User '${user.userId}' lacks permission '${permission}'` };
        }
      }
      return { allowed: true, policy: "permission", reason: "All required permissions granted" };
    },
  };
}

/** All policies must allow. The first denial wins. */
export function allOf(...policies: readonly ToolPolicy[]): ToolPolicy {
  const name = `allOf(${policies.map((p) => p.name).join(",")})`;
  return {
    name,
    async authorize(request) {
      let last: ToolAuthorizationDecision = { allowed: true, policy: name, reason: "No policies" };
      for (const policy of policies) {
        last = await policy.authorize(request);
        if (!last.allowed) return last;
      }
      return last;
    },
  };
}

/** Build a policy from a plain function. */
export function policy(
  name: string,
  authorize: (request: ToolAuthorizationRequest) => boolean | { allowed: boolean; reason?: string } | Promise<boolean | { allowed: boolean; reason?: string }>,
): ToolPolicy {
  return {
    name,
    async authorize(request) {
      const result = await authorize(request);
      const allowed = typeof result === "boolean" ? result : result.allowed;
      const reason = typeof result === "boolean" ? undefined : result.reason;
      return { allowed, policy: name, reason: reason ?? (allowed ? "Allowed" : "Denied") };
    },
  };
}

/**
 * Bridge to a core DecisionEngine for `tool_authorization` decisions. Only
 * deterministic providers are accepted, so an LLM judge can never grant access.
 * `abstain` is treated as deny (fail closed).
 */
export function decisionPolicy(engine: DecisionEngine): ToolPolicy {
  const nonDeterministic = engine.providers.find((p) => !p.deterministic);
  if (nonDeterministic !== undefined) {
    throw new TypeError(`decisionPolicy: provider '${nonDeterministic.id}' is not deterministic`);
  }
  return {
    name: "decision-engine",
    async authorize(request) {
      const decision = await engine.decide({
        kind: "tool_authorization",
        input: request,
        runId: request.runId,
        agentId: request.agent.agentId,
        ...(request.user === undefined ? {} : { user: request.user }),
      });
      return {
        allowed: decision.verdict === "allow",
        policy: `decision:${decision.providerId}`,
        reason: decision.reason ?? decision.verdict,
      };
    },
  };
}
