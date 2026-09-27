import { InMemoryEventSink, sequentialIds, type AgentIdentity, type Principal, type ToolInvocation } from "@agent-framework/core";
import type { AnyTool } from "./tool.js";

export const agentIdentity = (permissions: string[] = []): AgentIdentity => ({ agentId: "agent-1", name: "agent-1", permissions });
export const user = (permissions: string[] = [], tenantId = "tenant-a", userId = "user-1"): Principal => ({ userId, tenantId, permissions });

/** Build a ToolInvocation the way the agent runtime does, collecting events. */
export function invocation(tool: AnyTool, rawArguments: unknown, overrides: Partial<ToolInvocation> = {}) {
  const sink = new InMemoryEventSink();
  const ids = sequentialIds();
  let sequence = 0;
  const inv: ToolInvocation = {
    tool,
    toolCallId: "call-1",
    rawArguments,
    runId: "run-1",
    identity: { agent: agentIdentity() },
    signal: new AbortController().signal,
    emit: (type, payload, correlation) => {
      sequence += 1;
      sink.emit({
        eventId: ids.next("event"),
        sequence,
        runId: "run-1",
        agentId: "agent-1",
        occurredAt: new Date().toISOString(),
        type,
        payload,
        ...(correlation === undefined ? {} : { correlation }),
      } as never);
    },
    ...overrides,
  };
  return { inv, sink, types: () => sink.events.map((e) => e.type) };
}
