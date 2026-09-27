import { hasPermission, type Principal } from "@agent-framework/core";
import type { ToolAuthorizationRequest, ToolPolicy } from "@agent-framework/tools";

export type RoleMap = Readonly<Record<string, readonly string[]>>;

/** Expand a principal's roles into permissions (roles may reference other roles as `role:<name>`). */
export function expandRoles(principal: Principal, roles: RoleMap): Principal {
  const permissions = new Set(principal.permissions ?? []);
  const seen = new Set<string>();
  const visit = (role: string): void => {
    if (seen.has(role)) return;
    seen.add(role);
    for (const grant of roles[role] ?? []) {
      if (grant.startsWith("role:")) visit(grant.slice(5));
      else permissions.add(grant);
    }
  };
  for (const role of principal.roles ?? []) visit(role);
  return { ...principal, permissions: [...permissions] };
}

/**
 * RBAC: the user's roles (expanded through `roles`) plus direct permissions,
 * and the agent's permissions, must both cover every permission the tool requires.
 */
export function rbacPolicy(options: { roles: RoleMap; requireUser?: boolean }): ToolPolicy {
  return {
    name: "rbac",
    authorize({ tool, agent, user }) {
      if (user === undefined && options.requireUser === true) return { allowed: false, policy: "rbac", reason: "User identity required" };
      const effective = user === undefined ? undefined : expandRoles(user, options.roles);
      for (const permission of tool.permissions) {
        if (!hasPermission(agent.permissions, permission)) return { allowed: false, policy: "rbac", reason: `Agent lacks '${permission}'` };
        if (effective !== undefined && !hasPermission(effective.permissions, permission)) {
          return { allowed: false, policy: "rbac", reason: `User roles do not grant '${permission}'` };
        }
      }
      return { allowed: true, policy: "rbac", reason: "Roles grant all required permissions" };
    },
  };
}

export interface AbacRule {
  name: string;
  /** When the rule applies. */
  when: (request: ToolAuthorizationRequest) => boolean;
  effect: "allow" | "deny";
  reason?: string;
}

/**
 * ABAC: ordered rules over user attributes, tool metadata and validated input.
 * First matching rule wins; `defaultEffect` (deny by default) otherwise.
 * A rule that throws denies.
 */
export function abacPolicy(rules: readonly AbacRule[], options: { defaultEffect?: "allow" | "deny" } = {}): ToolPolicy {
  return {
    name: "abac",
    authorize(request) {
      for (const rule of rules) {
        let matches: boolean;
        try {
          matches = rule.when(request);
        } catch (error) {
          return { allowed: false, policy: `abac:${rule.name}`, reason: `Rule error: ${String(error)}` };
        }
        if (matches) return { allowed: rule.effect === "allow", policy: `abac:${rule.name}`, reason: rule.reason ?? rule.effect };
      }
      const allowed = (options.defaultEffect ?? "deny") === "allow";
      return { allowed, policy: "abac:default", reason: allowed ? "Default allow" : "No rule allowed this call" };
    },
  };
}

/**
 * Tenant isolation for data access: any tenant id found in the validated input
 * (at `field`, default `tenantId`) must equal the caller's tenant. Tools with
 * `metadata.tenantScoped === true` also require a tenant on the user.
 */
export function tenantIsolationPolicy(options: { field?: string } = {}): ToolPolicy {
  const field = options.field ?? "tenantId";
  return {
    name: "tenant-isolation",
    authorize({ tool, input, user }) {
      const requested = typeof input === "object" && input !== null ? (input as Record<string, unknown>)[field] : undefined;
      if (tool.metadata["tenantScoped"] === true && user?.tenantId === undefined) {
        return { allowed: false, policy: "tenant-isolation", reason: "Tenant-scoped tool called without a tenant" };
      }
      if (requested !== undefined && requested !== user?.tenantId) {
        return { allowed: false, policy: "tenant-isolation", reason: `Cross-tenant access to '${String(requested)}'` };
      }
      return { allowed: true, policy: "tenant-isolation", reason: "Same tenant" };
    },
  };
}

/**
 * Data governance: a tool whose `metadata.dataClassification` is more
 * sensitive than the user's clearance (`attributes.clearance`) is denied.
 */
export function dataClassificationPolicy(levels: readonly string[] = ["public", "internal", "confidential", "restricted"]): ToolPolicy {
  return {
    name: "data-classification",
    authorize({ tool, user }) {
      const required = tool.metadata["dataClassification"];
      if (typeof required !== "string") return { allowed: true, policy: "data-classification", reason: "Unclassified tool" };
      const clearance = user?.attributes?.["clearance"];
      const need = levels.indexOf(required);
      const have = typeof clearance === "string" ? levels.indexOf(clearance) : -1;
      return need >= 0 && have >= need
        ? { allowed: true, policy: "data-classification", reason: `Clearance ${String(clearance)} ≥ ${required}` }
        : { allowed: false, policy: "data-classification", reason: `Requires clearance '${required}'` };
    },
  };
}
