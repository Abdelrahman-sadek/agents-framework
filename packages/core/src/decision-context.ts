/**
 * Reserved extension points for future deterministic decisioning and
 * context management. These are intentionally minimal in Phase 1/Phase 2.
 *
 * Do not implement full systems here. The point is to keep the core
 * extensible without forcing every decision into an LLM prompt.
 */

export interface DecisionProvider {
  /**
   * Decide whether a requested action is admissible under deterministic rules.
   * This is NOT an LLM authorization call.
   */
  decide?(context: DecisionContext): DecisionResult | Promise<DecisionResult>;
}

export interface DecisionContext {
  runId: string;
  agentId: string;
  userId?: string;
  tenantId?: string;
  organizationId?: string;
  decisionType: string;
  input: unknown;
  metadata?: Record<string, unknown>;
}

export interface DecisionResult {
  allowed: boolean;
  reason?: string;
  metadata?: Record<string, unknown>;
}

/**
 * Reserved context management abstraction.
 *
 * Future implementations may include:
 * - selection
 * - ranking
 * - deduplication
 * - compression
 * - summarization
 * - token budgeting
 * - provenance
 */
export interface ContextManager {
  assemble?(context: ContextAssemblyRequest): Promise<ContextAssemblyResult>;
}

export interface ContextAssemblyRequest {
  runId: string;
  agentId: string;
  userId?: string;
  tenantId?: string;
  systemInstructions?: string;
  agentInstructions?: string;
  userInput: unknown;
  conversationHistory?: ConversationTurn[];
  memories?: unknown[];
  knowledge?: unknown[];
  toolResults?: unknown[];
  taskState?: unknown;
  priorExecutionState?: unknown;
  policy?: ContextPolicy;
}

export interface ContextPolicy {
  maxTokens?: number;
  includeMemory?: boolean;
  includeToolHistory?: boolean;
  summarizeHistoryAfter?: number;
}

export interface ContextAssemblyResult {
  messages: LLMMessage[];
  usage?: { tokens: number };
}

export interface ConversationTurn {
  role: "user" | "assistant" | "tool";
  content: string;
}

/**
 * Minimal LLM message shape reused by the context abstraction.
 * This is intentionally a subset of the provider-agnostic message type.
 */
export interface LLMMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
}
