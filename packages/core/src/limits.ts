import { ConfigurationError } from "./errors.js";
import { DEFAULT_RUN_LIMITS, type ResolvedRunLimits, type RunLimits } from "./types.js";

const INTEGER_LIMITS = ["maxSteps", "maxToolCalls", "maxTokens", "timeoutMs"] as const;

export function validateLimits(limits: RunLimits | undefined, where: string): void {
  if (limits === undefined) return;
  for (const key of INTEGER_LIMITS) {
    const value = limits[key];
    if (value !== undefined && (!Number.isInteger(value) || value <= 0)) {
      throw new ConfigurationError(`${where}: limits.${key} must be a positive integer`);
    }
  }
  if (limits.maxLLMRetries !== undefined && (!Number.isInteger(limits.maxLLMRetries) || limits.maxLLMRetries < 0)) {
    throw new ConfigurationError(`${where}: limits.maxLLMRetries must be a non-negative integer`);
  }
  if (limits.maxCost !== undefined && (!Number.isFinite(limits.maxCost) || limits.maxCost <= 0)) {
    throw new ConfigurationError(`${where}: limits.maxCost must be a positive number`);
  }
}

/** Framework defaults < agent config < run config. Later layers may only override, never remove, a limit. */
export function resolveLimits(...layers: (RunLimits | undefined)[]): ResolvedRunLimits {
  const resolved: ResolvedRunLimits = { ...DEFAULT_RUN_LIMITS };
  for (const layer of layers) {
    if (layer === undefined) continue;
    if (layer.maxSteps !== undefined) resolved.maxSteps = layer.maxSteps;
    if (layer.maxToolCalls !== undefined) resolved.maxToolCalls = layer.maxToolCalls;
    if (layer.maxTokens !== undefined) resolved.maxTokens = layer.maxTokens;
    if (layer.maxCost !== undefined) resolved.maxCost = layer.maxCost;
    if (layer.timeoutMs !== undefined) resolved.timeoutMs = layer.timeoutMs;
    if (layer.maxLLMRetries !== undefined) resolved.maxLLMRetries = layer.maxLLMRetries;
  }
  return resolved;
}
