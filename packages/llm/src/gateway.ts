import { FrameworkError, LLMError, sleep, type LLMProvider, type LLMRequest } from "@agent-framework/core";

export interface CircuitBreakerOptions {
  /** Consecutive retryable failures that open the circuit. Default 5. */
  failureThreshold?: number;
  /** How long the circuit stays open before one trial request. Default 30 s. */
  resetAfterMs?: number;
  now?: () => number;
}

export type CircuitState = "closed" | "open" | "half-open";

/**
 * Fail fast while a provider is unhealthy: after N consecutive retryable
 * failures, calls are rejected immediately (retryable, so fallbacks and
 * backoff kick in) until a trial request succeeds.
 */
export function withCircuitBreaker(provider: LLMProvider, options: CircuitBreakerOptions = {}): LLMProvider & { readonly circuit: CircuitState } {
  const threshold = options.failureThreshold ?? 5;
  const resetAfter = options.resetAfterMs ?? 30_000;
  const now = options.now ?? Date.now;
  let failures = 0;
  let openedAt: number | undefined;
  const state = (): CircuitState => (openedAt === undefined ? "closed" : now() - openedAt >= resetAfter ? "half-open" : "open");
  return {
    id: provider.id,
    get circuit() {
      return state();
    },
    capabilities: (modelId) => provider.capabilities(modelId),
    async generate(request) {
      if (state() === "open") throw new LLMError(`Circuit open for provider '${provider.id}'`, { retryable: true, metadata: { circuit: "open" } });
      try {
        const response = await provider.generate(request);
        failures = 0;
        openedAt = undefined;
        return response;
      } catch (error) {
        const retryable = error instanceof FrameworkError ? error.retryable : true;
        if (retryable) {
          failures += 1;
          if (failures >= threshold || state() === "half-open") openedAt = now();
        }
        throw error;
      }
    },
  };
}

/** Client-side request pacing: at most `requestsPerMinute`, excess requests wait (abortable). */
export function withRateLimit(provider: LLMProvider, options: { requestsPerMinute: number; now?: () => number }): LLMProvider {
  const interval = 60_000 / options.requestsPerMinute;
  const now = options.now ?? Date.now;
  let next = 0;
  return {
    id: provider.id,
    capabilities: (modelId) => provider.capabilities(modelId),
    async generate(request) {
      const t = now();
      const slot = Math.max(t, next);
      next = slot + interval;
      if (slot > t) await sleep(slot - t, request.signal);
      return provider.generate(request);
    },
  };
}

export interface FallbackTarget {
  provider: LLMProvider;
  modelId: string;
}

/**
 * Ordered fallback: on a retryable failure of the primary, try each fallback
 * target (with its own model id). Non-retryable errors (bad request, auth,
 * policy) are not masked by falling back.
 */
export function withFallback(primary: LLMProvider, fallbacks: readonly FallbackTarget[], options: { onFallback?: (from: string, to: FallbackTarget, error: unknown) => void } = {}): LLMProvider {
  return {
    id: primary.id,
    capabilities: (modelId) => primary.capabilities(modelId),
    async generate(request: LLMRequest) {
      try {
        return await primary.generate(request);
      } catch (error) {
        let last = error;
        if (error instanceof FrameworkError && !error.retryable) throw error;
        for (const target of fallbacks) {
          if (request.signal?.aborted === true) break;
          options.onFallback?.(`${primary.id}/${request.modelId}`, target, last);
          try {
            const response = await target.provider.generate({ ...request, modelId: target.modelId });
            return { ...response, providerMetadata: { ...response.providerMetadata, fallbackFrom: `${primary.id}/${request.modelId}`, servedBy: `${target.provider.id}/${target.modelId}` } };
          } catch (fallbackError) {
            last = fallbackError;
            if (fallbackError instanceof FrameworkError && !fallbackError.retryable) throw fallbackError;
          }
        }
        throw last;
      }
    },
  };
}
