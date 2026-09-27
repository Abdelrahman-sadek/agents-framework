/**
 * Example 5 — Human approval: Agent → Proposed action → Human approval → Tool.
 *
 * The run pauses with status WAITING_FOR_APPROVAL, its state is persisted, and
 * a later `resume()` (a different request, even a different process with a
 * durable RunStateStore) continues it.
 *
 *   pnpm example:approval
 */
import { InMemoryRunStateStore, createRuntime, defineAgent } from "@agent-farmework/core";
import { createScriptedProvider } from "@agent-farmework/core/testing";
import { models } from "@agent-farmework/llm";
import { ToolRuntime, defineTool } from "@agent-farmework/tools";
import { z } from "zod";

const refundTool = defineTool({
  name: "issue_refund",
  description: "Refund an order",
  input: z.object({ orderId: z.string(), amount: z.number().positive() }),
  permissions: ["payments.refund"],
  // Refunds above 100 need a human. The predicate sees validated input only.
  approval: { required: ({ amount }) => amount > 100, expiresInMs: 15 * 60_000, reason: "Refund over 100" },
  // Retries of the same refund return the stored result instead of paying twice.
  idempotency: { key: ({ orderId }) => `refund:${orderId}` },
  execute: async ({ orderId, amount }) => ({ orderId, amount, refundId: "rf_123" }),
});

const provider = createScriptedProvider(
  [
    { toolCalls: [{ id: "call_1", name: "issue_refund", arguments: { orderId: "ord_77", amount: 250 } }] },
    { text: "The refund of 250 for order ord_77 has been issued (rf_123)." },
  ],
  { id: "anthropic" },
);

// Use a durable RunStateStore adapter in production; the in-memory one is for demos.
const stateStore = new InMemoryRunStateStore();
const runtime = createRuntime({ providers: [provider], tools: new ToolRuntime(), stateStore });

const agent = defineAgent({
  name: "support-agent",
  model: models.anthropic("claude-sonnet-5"),
  instructions: "You help customers with orders.",
  tools: [refundTool],
  permissions: ["payments.*"],
  runtime,
});

const user = { userId: "agent-desk-7", tenantId: "acme", permissions: ["payments.refund"] };

// Request 1: the agent proposes the refund and the run pauses.
const paused = await agent.run({ input: "Please refund order ord_77 (250 USD).", user });
console.log(`status: ${paused.status}`);
for (const a of paused.pendingApprovals) {
  console.log(`approval needed: ${a.toolName} (${a.reason}) id=${a.approvalId} expires=${a.expiresAt}`);
}

// ... a reviewer approves in some UI; later, request 2 resumes the run:
const approval = paused.pendingApprovals[0];
if (approval === undefined) throw new Error("expected a pending approval");
const done = await agent.resume({
  runId: paused.runId,
  approvals: [{ approvalId: approval.approvalId, decision: "approved", decidedBy: "finance-lead" }],
});

console.log(`\nstatus: ${done.status}`);
console.log(`output: ${done.output}`);
console.log(`events after resume: ${done.events.map((e) => e.type).join(" → ")}`);
