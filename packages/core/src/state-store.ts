import type { AgentState, AgentStatus } from "./types.js";

/**
 * Persistence port for run state. This is the durable-execution boundary: a
 * PostgreSQL, SQLite, Redis or Temporal-backed adapter implements it without
 * the runtime knowing about queues or workflow engines.
 */
export interface RunStateStore {
  load(runId: string): Promise<AgentState | undefined>;
  save(state: AgentState): Promise<void>;
  /**
   * Atomically move a run from status `from` to `to` (compare-and-set).
   * Returns false when the run is missing or not in `from`. The runtime uses
   * it so two concurrent `resume()` calls cannot both execute an approval.
   * Stores shared by several processes should implement it.
   */
  claim?(runId: string, from: AgentStatus, to: AgentStatus): Promise<boolean>;
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

  async claim(runId: string, from: AgentStatus, to: AgentStatus): Promise<boolean> {
    const state = this.states.get(runId);
    if (state === undefined || state.status !== from) return false;
    state.status = to;
    return true;
  }
}
