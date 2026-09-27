import {
  ConfigurationError,
  InMemoryRunStateStore,
  createRuntime,
  type AgentRuntime,
  type ContextManager,
  type EventSink,
  type LLMProvider,
  type RunLimits,
  type RunStateStore,
} from "@agent-farmework/core";
import { InMemoryAuditLog, ToolRuntime, type AuditSink, type IdempotencyStore, type RateLimiter, type ToolPolicy } from "@agent-farmework/tools";
import { z } from "zod";

export type Environment = "development" | "test" | "production";

export interface FrameworkConfig {
  environment: Environment;
  llm: { providers: readonly LLMProvider[] };
  persistence?: { runs?: RunStateStore };
  tools?: { policy?: ToolPolicy; audit?: AuditSink; idempotency?: IdempotencyStore; rateLimiter?: RateLimiter; defaultTimeoutMs?: number };
  observability?: { sinks?: readonly EventSink[] };
  context?: ContextManager;
  limits?: RunLimits;
}

export interface Framework {
  environment: Environment;
  runtime: AgentRuntime;
  tools: ToolRuntime;
}

const LimitsSchema = z
  .object({
    maxSteps: z.number().int().positive(),
    maxToolCalls: z.number().int().positive(),
    maxTokens: z.number().int().positive(),
    maxCost: z.number().positive(),
    timeoutMs: z.number().int().positive(),
    maxLLMRetries: z.number().int().nonnegative(),
    maxOutputCorrections: z.number().int().nonnegative(),
    maxReflectionAttempts: z.number().int().nonnegative(),
  })
  .partial()
  .strict();

const ConfigSchema = z.object({
  environment: z.enum(["development", "test", "production"]),
  llm: z.object({ providers: z.array(z.object({ id: z.string().min(1) }).loose()).min(1) }),
  limits: LimitsSchema.optional(),
});

/**
 * Typed, validated framework configuration. Fails fast on invalid config and
 * enforces production requirements: durable run state, a durable audit sink,
 * and a spend budget.
 */
export function createFramework(config: FrameworkConfig): Framework {
  const parsed = ConfigSchema.safeParse(config);
  if (!parsed.success) throw new ConfigurationError(`Invalid framework configuration: ${z.prettifyError(parsed.error)}`);

  const runs = config.persistence?.runs ?? new InMemoryRunStateStore();
  const audit = config.tools?.audit ?? new InMemoryAuditLog();
  if (config.environment === "production") {
    const problems: string[] = [];
    if (runs instanceof InMemoryRunStateStore) problems.push("persistence.runs must be a durable RunStateStore");
    if (audit instanceof InMemoryAuditLog) problems.push("tools.audit must be a durable AuditSink");
    if (config.limits?.maxCost === undefined && config.limits?.maxTokens === undefined) problems.push("limits.maxCost or limits.maxTokens must be set");
    if (problems.length > 0) throw new ConfigurationError(`Production configuration is incomplete:\n- ${problems.join("\n- ")}`);
  }

  const tools = new ToolRuntime({
    audit,
    ...(config.tools?.policy === undefined ? {} : { policy: config.tools.policy }),
    ...(config.tools?.idempotency === undefined ? {} : { idempotency: config.tools.idempotency }),
    ...(config.tools?.rateLimiter === undefined ? {} : { rateLimiter: config.tools.rateLimiter }),
    ...(config.tools?.defaultTimeoutMs === undefined ? {} : { defaultTimeoutMs: config.tools.defaultTimeoutMs }),
  });
  const runtime = createRuntime({
    providers: config.llm.providers,
    tools,
    stateStore: runs,
    events: config.observability?.sinks ?? [],
    ...(config.context === undefined ? {} : { context: config.context }),
    ...(config.limits === undefined ? {} : { limits: config.limits }),
  });
  return { environment: config.environment, runtime, tools };
}
