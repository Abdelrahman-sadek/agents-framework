import type { AgentEvent, EventSink } from "@agent-framework/core";

export interface CostLine {
  key: string;
  llmCalls: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
}

export interface CostReport {
  total: CostLine;
  byAgent: CostLine[];
  byModel: CostLine[];
  byTenant: CostLine[];
  byUser: CostLine[];
  byRun: CostLine[];
}

/**
 * Cost accounting from the event stream: provider, model, tokens, estimated
 * cost per run, agent, user and tenant.
 */
export class CostTracker implements EventSink {
  private readonly identity = new Map<string, { tenantId?: string; userId?: string }>();
  private readonly lines = new Map<string, Map<string, CostLine>>();

  emit(event: AgentEvent): void {
    if (event.type === "AGENT_STARTED") {
      this.identity.set(event.runId, {
        ...(event.payload.tenantId === undefined ? {} : { tenantId: event.payload.tenantId }),
        ...(event.payload.userId === undefined ? {} : { userId: event.payload.userId }),
      });
      return;
    }
    if (event.type !== "LLM_CALL_COMPLETED") return;
    const who = this.identity.get(event.runId) ?? {};
    const p = event.payload;
    const add = (dimension: string, key: string): void => {
      const table = this.lines.get(dimension) ?? new Map<string, CostLine>();
      this.lines.set(dimension, table);
      const line = table.get(key) ?? { key, llmCalls: 0, inputTokens: 0, outputTokens: 0, costUsd: 0 };
      line.llmCalls += 1;
      line.inputTokens += p.usage.inputTokens;
      line.outputTokens += p.usage.outputTokens;
      line.costUsd += p.estimatedCostUsd;
      table.set(key, line);
    };
    add("total", "total");
    add("agent", event.agentId);
    add("model", `${p.providerId}/${p.modelId}`);
    add("tenant", who.tenantId ?? "(none)");
    add("user", who.userId ?? "(none)");
    add("run", event.runId);
  }

  report(): CostReport {
    const list = (d: string): CostLine[] => [...(this.lines.get(d)?.values() ?? [])].sort((a, b) => b.costUsd - a.costUsd);
    return {
      total: list("total")[0] ?? { key: "total", llmCalls: 0, inputTokens: 0, outputTokens: 0, costUsd: 0 },
      byAgent: list("agent"),
      byModel: list("model"),
      byTenant: list("tenant"),
      byUser: list("user"),
      byRun: list("run"),
    };
  }
}
