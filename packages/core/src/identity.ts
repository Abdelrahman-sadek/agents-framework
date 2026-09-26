/**
 * Identity model used for every authorization decision.
 *
 * Authorization combines the user (principal), the agent identity and the
 * tenant. None of these values ever come from model output.
 */
export interface Principal {
  userId: string;
  tenantId?: string;
  roles?: readonly string[];
  permissions?: readonly string[];
  attributes?: Readonly<Record<string, unknown>>;
}

export interface AgentIdentity {
  agentId: string;
  name: string;
  version?: string;
  /** Permissions granted to the agent itself. A tool needs them on both the agent and the user. */
  permissions: readonly string[];
}

export interface RunIdentity {
  agent: AgentIdentity;
  user?: Principal;
}

/**
 * Permission matching with namespace wildcards: `database.*` grants
 * `database.read`; `*` grants everything.
 */
export function hasPermission(granted: readonly string[] | undefined, required: string): boolean {
  if (granted === undefined) return false;
  for (const g of granted) {
    if (g === required || g === "*") return true;
    if (g.endsWith(".*") && required.startsWith(g.slice(0, -1))) return true;
  }
  return false;
}
