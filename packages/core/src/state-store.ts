import type { AgentState } from "./types.js";

/**
 * Persistence port for run state. This is the durable-execution boundary: a
 * PostgreSQL, SQLite, Redis or Temporal-backed adapter implements it without
 * the runtime knowing about queues or workflow engines.
 */
export interface RunStateStore {
  load(runId: string): Promise<AgentState | undefined>;
  save(state: AgentState): Promise<void>;
}

/** Process-local store. Not durable; use for development and tests. */
export class InMemoryRunStateStore implements RunStateStore {
  private readonly states = new Map<string, AgentState>();

  async load(runId: string): Promise<AgentState | undefined> {
    const state = this.states.get(runId);
    return state === undefined ? undefined : structuredClone(state);
  }

  async save(state: AgentState): Promise<void> {
    this.states.set(state.runId, structuredClone(state));
  }
}
