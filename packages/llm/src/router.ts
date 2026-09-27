import { LLMError, type LLMProvider, type LLMRequest, type ModelCapabilities } from "@agent-framework/core";

export interface RouteCandidate {
  provider: LLMProvider;
  modelId: string;
  /** Relative quality score (higher is better) for your workloads. Default 1. */
  quality?: number;
}

export type RoutingStrategy = "cheapest" | "fastest" | "best" | "local-first";

export interface ModelRouterOptions {
  /** Provider id agents reference, e.g. `models.custom("router", "auto")`. */
  id: string;
  candidates: readonly RouteCandidate[];
  strategy?: RoutingStrategy;
  /** Try the next eligible candidate on a retryable error. Default true. */
  fallback?: boolean;
  /**
   * Data classification of a request (e.g. from `request.metadata.dataClassification`).
   * Candidates whose `allowedDataClassifications` exclude it are never used.
   */
  classify?: (request: LLMRequest) => string | undefined;
  onRoute?: (decision: { chosen: string; eligible: string[]; reason: string }) => void;
}

const approxTokens = (request: LLMRequest): number => Math.ceil(JSON.stringify(request.messages).length / 4) + (request.settings?.maxOutputTokens ?? 1024);

/**
 * Choose a model per request from task requirements + capabilities + cost +
 * latency + locality + data governance. Requirements are hard filters
 * (tool calling, structured output, context size, data classification);
 * the strategy ranks what remains.
 */
export function createModelRouter(options: ModelRouterOptions): LLMProvider {
  if (options.candidates.length === 0) throw new TypeError("createModelRouter: at least one candidate is required");
  const strategy = options.strategy ?? "cheapest";
  const describe = async (c: RouteCandidate): Promise<ModelCapabilities> => c.provider.capabilities(c.modelId);
  const price = (caps: ModelCapabilities): number => (caps.pricing === undefined ? 0 : caps.pricing.inputPerMillionTokens + caps.pricing.outputPerMillionTokens);

  const eligible = async (request: LLMRequest): Promise<{ candidate: RouteCandidate; caps: ModelCapabilities }[]> => {
    const classification = options.classify?.(request) ?? (typeof request.metadata?.["dataClassification"] === "string" ? request.metadata["dataClassification"] : undefined);
    const needed = approxTokens(request);
    const all = await Promise.all(options.candidates.map(async (candidate) => ({ candidate, caps: await describe(candidate) })));
    return all.filter(({ caps }) => {
      if ((request.tools?.length ?? 0) > 0 && !caps.toolCalling) return false;
      if (request.responseFormat?.schema !== undefined && !caps.structuredOutput) return false;
      if (caps.contextWindowTokens !== undefined && needed > caps.contextWindowTokens) return false;
      if (classification !== undefined && caps.allowedDataClassifications !== undefined && !caps.allowedDataClassifications.includes(classification)) return false;
      return true;
    });
  };

  const rank = (list: { candidate: RouteCandidate; caps: ModelCapabilities }[]): typeof list =>
    [...list].sort((a, b) => {
      switch (strategy) {
        case "fastest":
          return (a.caps.latency?.p50Ms ?? Number.MAX_SAFE_INTEGER) - (b.caps.latency?.p50Ms ?? Number.MAX_SAFE_INTEGER);
        case "best":
          return (b.candidate.quality ?? 1) - (a.candidate.quality ?? 1) || price(a.caps) - price(b.caps);
        case "local-first":
          return Number(b.caps.deployment === "local") - Number(a.caps.deployment === "local") || price(a.caps) - price(b.caps);
        default:
          return price(a.caps) - price(b.caps) || (b.candidate.quality ?? 1) - (a.candidate.quality ?? 1);
      }
    });

  return {
    id: options.id,
    async capabilities(modelId) {
      const all = await Promise.all(options.candidates.map(describe));
      // Advertise what at least one candidate can do; per-request filtering happens in generate().
      return {
        providerId: options.id,
        modelId,
        deployment: all.every((c) => c.deployment === "local") ? "local" : "cloud",
        toolCalling: all.some((c) => c.toolCalling),
        structuredOutput: all.some((c) => c.structuredOutput),
        streaming: false,
        vision: all.some((c) => c.vision),
        embeddings: false,
        contextWindowTokens: Math.max(...all.map((c) => c.contextWindowTokens ?? 0)) || undefined,
      } as ModelCapabilities;
    },
    async generate(request) {
      const ranked = rank(await eligible(request));
      if (ranked.length === 0) throw new LLMError("No model satisfies this request's requirements (tools, structured output, context size, data classification)", { retryable: false });
      let lastError: unknown;
      for (const [i, { candidate }] of ranked.entries()) {
        const name = `${candidate.provider.id}/${candidate.modelId}`;
        options.onRoute?.({ chosen: name, eligible: ranked.map((r) => `${r.candidate.provider.id}/${r.candidate.modelId}`), reason: i === 0 ? strategy : "fallback" });
        try {
          const response = await candidate.provider.generate({ ...request, modelId: candidate.modelId });
          return { ...response, providerMetadata: { ...response.providerMetadata, routedTo: name } };
        } catch (error) {
          lastError = error;
          const retryable = typeof error === "object" && error !== null && (error as { retryable?: unknown }).retryable === true;
          if (options.fallback === false || !retryable) throw error;
        }
      }
      throw lastError;
    },
  };
}
