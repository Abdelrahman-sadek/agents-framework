import {
  ConfigurationError,
  defineAgent,
  type Agent,
  type AgentRuntime,
  type ContextProvider,
  type Guardrail,
  type RunLimits,
  type Verifier,
} from "@agent-farmework/core";
import type { AnyTool } from "@agent-farmework/tools";
import { z } from "zod";

/**
 * Declarative agent manifest. Behaviour (tools, guardrails, context sources,
 * verifiers) is referenced by name and resolved from an application registry,
 * so a manifest can be reviewed, diffed and versioned without executing code.
 */
export const AgentManifestSchema = z
  .object({
    name: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/),
    version: z.string().min(1),
    description: z.string().optional(),
    model: z.object({ provider: z.string().min(1), model: z.string().min(1) }).strict(),
    instructions: z.string().min(1),
    tools: z.array(z.string()).default([]),
    context: z.array(z.string()).default([]),
    guardrails: z.array(z.string()).default([]),
    reflection: z.object({ verifiers: z.array(z.string()).min(1), maxAttempts: z.number().int().nonnegative().optional() }).strict().optional(),
    security: z.object({ permissions: z.array(z.string()).default([]) }).strict().default({ permissions: [] }),
    limits: z
      .object({
        maxSteps: z.number().int().positive(),
        maxToolCalls: z.number().int().positive(),
        maxTokens: z.number().int().positive(),
        maxCost: z.number().positive(),
        timeoutMs: z.number().int().positive(),
      })
      .partial()
      .strict()
      .optional(),
    metadata: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional(),
  })
  .strict();

export type AgentManifest = z.infer<typeof AgentManifestSchema>;

export interface ManifestRegistry {
  tools?: Readonly<Record<string, AnyTool>>;
  context?: Readonly<Record<string, ContextProvider>>;
  guardrails?: Readonly<Record<string, Guardrail>>;
  verifiers?: Readonly<Record<string, Verifier>>;
}

export function parseManifest(value: unknown): AgentManifest {
  const result = AgentManifestSchema.safeParse(value);
  if (!result.success) throw new ConfigurationError(`Invalid agent manifest:\n${z.prettifyError(result.error)}`);
  return result.data;
}

/** Validate a manifest against a registry without building the agent. Returns problems (empty = valid). */
export function checkManifest(manifest: AgentManifest, registry: ManifestRegistry): string[] {
  const missing = (kind: keyof ManifestRegistry, names: readonly string[]): string[] =>
    names.filter((n) => registry[kind]?.[n] === undefined).map((n) => `Unknown ${kind.replace(/s$/, "")} '${n}'`);
  const problems = [
    ...missing("tools", manifest.tools),
    ...missing("context", manifest.context),
    ...missing("guardrails", manifest.guardrails),
    ...missing("verifiers", manifest.reflection?.verifiers ?? []),
  ];
  // Least privilege: every permission a tool needs must be declared, and declared permissions should be needed.
  const needed = new Set(manifest.tools.flatMap((t) => registry.tools?.[t]?.definition.permissions ?? []));
  for (const p of needed) if (!manifest.security.permissions.includes(p)) problems.push(`Tool permission '${p}' is not declared in security.permissions`);
  for (const p of manifest.security.permissions) if (!needed.has(p) && !p.endsWith("*")) problems.push(`Declared permission '${p}' is not used by any tool`);
  return problems;
}

export function defineAgentFromManifest(input: unknown, registry: ManifestRegistry, runtime?: AgentRuntime): Agent<string> {
  const manifest = parseManifest(input);
  const problems = checkManifest(manifest, registry).filter((p) => p.startsWith("Unknown") || p.startsWith("Tool permission"));
  if (problems.length > 0) throw new ConfigurationError(`Agent manifest '${manifest.name}':\n- ${problems.join("\n- ")}`);
  const pick = <T>(table: Readonly<Record<string, T>> | undefined, names: readonly string[]): T[] => names.map((n) => table?.[n] as T);
  return defineAgent({
    name: manifest.name,
    version: manifest.version,
    ...(manifest.description === undefined ? {} : { description: manifest.description }),
    model: { providerId: manifest.model.provider, modelId: manifest.model.model },
    instructions: manifest.instructions,
    tools: pick(registry.tools, manifest.tools),
    context: pick(registry.context, manifest.context),
    guardrails: pick(registry.guardrails, manifest.guardrails),
    permissions: manifest.security.permissions,
    ...(manifest.reflection === undefined ? {} : { reflection: { verifiers: pick(registry.verifiers, manifest.reflection.verifiers) } }),
    limits: {
      ...(Object.fromEntries(Object.entries(manifest.limits ?? {}).filter(([, v]) => v !== undefined)) as RunLimits),
      ...(manifest.reflection?.maxAttempts === undefined ? {} : { maxReflectionAttempts: manifest.reflection.maxAttempts }),
    },
    ...(manifest.metadata === undefined ? {} : { metadata: manifest.metadata }),
    ...(runtime === undefined ? {} : { runtime }),
  });
}
