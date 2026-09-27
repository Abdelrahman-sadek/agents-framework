/**
 * Example 6 — Enterprise agent: a refund-resolution service for "Acme" combining
 * planning, workers, tools, RAG, memory, reflection, guardrails, security,
 * human approval, observability and evaluation.
 *
 *   pnpm example:enterprise
 */
import { citationVerifier, createRuntime, defineAgent, ruleVerifier, type Principal } from "@agent-framework/core";
import { createRuleProvider } from "@agent-framework/core/testing";
import { defineDataset, defineEvaluation, evaluators, formatReport } from "@agent-framework/evaluation";
import { createKnowledgeBase, hashingEmbedder } from "@agent-framework/knowledge";
import { models } from "@agent-framework/llm";
import { createMemory } from "@agent-framework/memory";
import { CostTracker, formatRunReport, inspectRun } from "@agent-framework/observability";
import { defineOrchestrator, defineWorker, staticPlanner } from "@agent-framework/orchestration";
import { piiGuardrail, promptInjectionGuardrail, rbacPolicy, secretLeakGuardrail, tenantIsolationPolicy } from "@agent-framework/security";
import { InMemoryAuditLog, ToolRuntime, allOf, defineTool } from "@agent-framework/tools";
import { z } from "zod";

// ---------------------------------------------------------------- data & knowledge
const orders: Record<string, { tenantId: string; amount: number; status: string; daysSinceDelivery: number }> = {
  "ord-17": { tenantId: "acme", amount: 80, status: "delivered", daysSinceDelivery: 12 },
  "ord-42": { tenantId: "acme", amount: 640, status: "delivered", daysSinceDelivery: 3 },
};
const policies = createKnowledgeBase({ name: "policies", embedder: hashingEmbedder() });
await policies.ingest([
  { id: "refund-policy", title: "Refund policy", text: "Delivered orders can be refunded within 30 days of delivery. Refunds above 100 EUR require approval by a finance lead." },
  { id: "tone-guide", title: "Support tone guide", text: "Replies are short, polite, and never include internal ids beyond the order number." },
]);
const memory = createMemory({ embedder: hashingEmbedder() });

// ---------------------------------------------------------------- tools (deterministic authority)
const lookupOrder = defineTool({
  name: "lookup_order",
  description: "Look up an order",
  input: z.object({ orderId: z.string(), tenantId: z.string() }),
  permissions: ["orders.read"],
  execute: async ({ orderId }) => orders[orderId] ?? { error: "not found" },
});
const refunds: string[] = [];
const issueRefund = defineTool({
  name: "issue_refund",
  description: "Refund an order",
  input: z.object({ orderId: z.string(), amount: z.number().positive(), tenantId: z.string() }),
  permissions: ["payments.refund"],
  approval: { required: ({ amount }) => amount > 100, expiresInMs: 3_600_000, reason: "Refund above 100 EUR" },
  idempotency: { key: ({ orderId }) => `refund:${orderId}` },
  execute: async ({ orderId, amount }) => {
    refunds.push(orderId);
    return { refundId: `rf-${orderId}`, amount };
  },
});
const audit = new InMemoryAuditLog();
const roles = { "support-agent": ["orders.read", "payments.refund"], auditor: ["orders.read"] };
const tools = new ToolRuntime({ policy: allOf(rbacPolicy({ roles }), tenantIsolationPolicy()), audit });

// ---------------------------------------------------------------- model (offline stand-in)
const model = createRuleProvider(
  [
    (_r, h) => (h.hasTool("lookup_order") && h.toolResults["lookup_order"] === undefined ? { toolCalls: [{ id: "l", name: "lookup_order", arguments: { orderId: /ord-\d+/.exec(h.lastUser)?.[0] ?? "?", tenantId: "acme" } }] } : undefined),
    (_r, h) => (h.toolResults["lookup_order"] !== undefined ? { text: h.toolResults["lookup_order"] } : undefined),
    (_r, h) =>
      h.lastUser.includes("Decide")
        ? { text: JSON.stringify({ refund: true, amount: Number(/"amount":(\d+)/.exec(h.lastUser)?.[1] ?? 0), reason: "Delivered within 30 days of delivery [1]" }) }
        : undefined,
    (_r, h) => (h.lastUser.includes("Write") ? { text: `Hello! Your refund for ${/ord-\d+/.exec(h.lastUser)?.[0]} is ${h.lastUser.includes("pending") ? "awaiting approval by our finance team" : "on its way"}. We'll email you updates.` } : undefined),
  ],
  { id: "anthropic", capabilities: { pricing: { currency: "USD", inputPerMillionTokens: 5, outputPerMillionTokens: 25 } } },
);
const costs = new CostTracker();
const runtime = createRuntime({ providers: [model], tools, events: [costs] });
const guardrails = [piiGuardrail(), promptInjectionGuardrail(), secretLeakGuardrail()];

// ---------------------------------------------------------------- workers
const Decision = z.object({ refund: z.boolean(), amount: z.number(), reason: z.string() });
const investigator = defineAgent({ name: "investigator", model: models.anthropic("claude-haiku-4-5"), instructions: "Look up the order. Return the raw facts.", tools: [lookupOrder], permissions: ["orders.read"], guardrails, runtime });
const policyAgent = defineAgent({
  name: "policy-agent",
  model: models.anthropic("claude-opus-5"),
  instructions: "Decide if the refund is allowed by policy. Cite the policy as [n].",
  output: Decision,
  context: [policies.asContextProvider({ k: 1 })],
  reflection: { verifiers: [citationVerifier(), ruleVerifier("amount-positive", ({ output }) => ((output as z.infer<typeof Decision>).amount > 0 ? true : "Amount must be positive"))] },
  runtime,
});
const writer = defineAgent({
  name: "reply-writer",
  model: models.anthropic("claude-sonnet-5"),
  instructions: "Write the customer reply.",
  context: [memory.asContextProvider({ k: 2 })],
  guardrails,
  reflection: { verifiers: [ruleVerifier("short", ({ text }) => (text.length < 300 ? true : "Keep it under 300 characters"))] },
  runtime,
});

function caseResolution(user: Principal) {
  return defineOrchestrator({
    name: "refund-resolution",
    planner: staticPlanner([
      { id: "investigate", description: "Investigate the order", worker: "investigate" },
      { id: "decide", description: "Decide per policy", worker: "decide", dependsOn: ["investigate"] },
      { id: "act", description: "Execute the decision", worker: "act", dependsOn: ["decide"] },
      { id: "reply", description: "Write the reply", worker: "reply", dependsOn: ["act"] },
    ]),
    workers: [
      defineWorker({ name: "investigate", description: "Order lookup", agent: investigator, context: "shared" }),
      defineWorker({ name: "decide", description: "Policy decision", agent: policyAgent }),
      // Deterministic worker: the refund goes through the same tool pipeline (RBAC, tenant isolation, approval, idempotency, audit).
      defineWorker({
        name: "act",
        description: "Refund execution",
        handler: async (task) => {
          const decision = task.dependencies["decide"] as z.infer<typeof Decision>;
          if (!decision.refund) return { status: "declined" };
          const orderId = /ord-\d+/.exec(String(task.goal))?.[0] ?? "";
          const result = await tools.execute(issueRefund, { orderId, amount: decision.amount, tenantId: user.tenantId }, { agent: { agentId: "refund-service", name: "refund-service", permissions: ["payments.refund"] }, user, runId: task.runId });
          return result.status === "approval_required" ? { status: "pending", approvalId: result.approval?.approvalId } : { status: result.status, ...(result.output as object) };
        },
      }),
      defineWorker({ name: "reply", description: "Customer reply", agent: writer, context: "shared" }),
    ],
  });
}

// ---------------------------------------------------------------- run
const agentUser: Principal = { userId: "agent-desk-3", tenantId: "acme", roles: ["support-agent"] };
await memory.store({ kind: "user", content: "Customer prefers email updates", scope: { tenantId: "acme", userId: agentUser.userId }, confidence: 0.9 }, { user: agentUser, agentId: "reply-writer" });

for (const request of ["Please refund ord-17, it arrived damaged.", "Refund ord-42 please, my card is 4111 1111 1111 1111"]) {
  const result = await caseResolution(agentUser).run({ input: request, goal: request, user: agentUser });
  console.log(`\n▶ ${request}\n  status: ${result.status}`);
  console.log(`  decision: ${JSON.stringify(result.steps["decide"]?.output)}`);
  console.log(`  action:   ${JSON.stringify(result.steps["act"]?.output)}`);
  console.log(`  reply:    ${String(result.output)}`);
}

console.log(`\nrefunds executed: ${refunds.join(", ") || "none"} (ord-42 waits for a finance lead)`);
console.log(`audit: ${audit.entries.map((e) => `${e.toolName}:${e.outcome}`).join(", ")}`);
const c = costs.report();
console.log(`cost: ${c.total.llmCalls} model calls, ${c.total.inputTokens + c.total.outputTokens} tokens, $${c.total.costUsd.toFixed(4)}, by agent: ${c.byAgent.map((l) => `${l.key}=${l.llmCalls}`).join(" ")}`);

// ---------------------------------------------------------------- evaluate
const evaluation = defineEvaluation({
  name: "refund-resolution",
  dataset: defineDataset("refund-golden", [
    { id: "small-refund", input: "Please refund ord-17.", expected: "on its way" },
    { id: "large-refund", input: "Refund ord-42.", expected: "awaiting approval" },
  ]),
  target: async (c) => ({ output: (await caseResolution(agentUser).run({ input: c.input, goal: String(c.input), user: agentUser })).output }),
  evaluators: [evaluators.contains(), evaluators.safety([piiGuardrail()])],
  concurrency: 1,
});
console.log(`\n${formatReport(await evaluation.run())}`);

// A single agent run can also be inspected from its events:
const single = await investigator.run({ input: "Check ord-17", user: agentUser });
console.log(`\n${formatRunReport(inspectRun(single.events)).split("\n").slice(0, 3).join("\n")}`);
