import type { Principal } from "@agent-framework/core";

/**
 * Secret management port. Vault, AWS/GCP/Azure secret managers are adapters.
 * Secrets are resolved inside tool execution and never enter model context,
 * run state, events or audit records.
 */
export interface SecretProvider {
  get(name: string): Promise<string | undefined>;
}

/** Environment-variable secrets, restricted to an allow-list of names. */
export function envSecrets(options: { allow: readonly string[]; env?: Readonly<Record<string, string | undefined>> }): SecretProvider {
  const env = options.env ?? process.env;
  return {
    async get(name) {
      return options.allow.includes(name) ? env[name] : undefined;
    },
  };
}

export interface ClaimMapping {
  userId?: string;
  tenantId?: string;
  roles?: string;
  permissions?: string;
}

/**
 * Map verified identity-token claims (OIDC/JWT, verified by your auth layer)
 * to a Principal. The framework never trusts identity claimed in prompts.
 */
export function principalFromClaims(claims: Readonly<Record<string, unknown>>, mapping: ClaimMapping = {}): Principal {
  const read = (key: string): unknown => key.split(".").reduce<unknown>((obj, k) => (typeof obj === "object" && obj !== null ? (obj as Record<string, unknown>)[k] : undefined), claims);
  const list = (value: unknown): string[] => (Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : typeof value === "string" ? value.split(/[\s,]+/).filter(Boolean) : []);
  const userId = read(mapping.userId ?? "sub");
  if (typeof userId !== "string" || userId === "") throw new TypeError("Identity claims have no user id");
  const tenantId = read(mapping.tenantId ?? "tenant_id");
  return {
    userId,
    ...(typeof tenantId === "string" ? { tenantId } : {}),
    roles: list(read(mapping.roles ?? "roles")),
    permissions: list(read(mapping.permissions ?? "scope")),
  };
}
