/**
 * @agent-framework/context — the context engine.
 *
 * Available information → relevance → priority → token budget → final model context.
 */
export { approximateTokenCounter, createContextEngine, llmSummarizer } from "./engine.js";
export type { ContextEngineOptions, Summarizer, TokenCounter } from "./engine.js";
