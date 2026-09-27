import type { LLMMessage } from "./llm.js";

/**
 * Context engine port (Phase 4 implements selection, ranking, deduplication,
 * compression, summarization, token budgeting and provenance).
 *
 * The runtime asks the context manager for the messages of every model call,
 * so no code path assumes the whole transcript fits in the context window.
 */
export interface ContextAssemblyRequest {
  runId: string;
  agentId: string;
  /** The full, authoritative transcript held in run state. */
  messages: readonly LLMMessage[];
  /** Token budget for the assembled context, when known. */
  maxTokens?: number;
}

export interface ContextAssemblyResult {
  messages: LLMMessage[];
  estimatedTokens?: number;
  /** Items dropped or compressed, for observability. */
  omitted?: { reason: string; count: number }[];
}

export interface ContextManager {
  assemble(request: ContextAssemblyRequest): Promise<ContextAssemblyResult>;
}

/** Default: send the transcript unchanged. */
export const passthroughContext: ContextManager = {
  async assemble(request) {
    return { messages: [...request.messages] };
  },
};
