import { describe, expect, test } from "vitest";
import { createDecisionEngine, ruleDecisionProvider, type DecisionProvider } from "./decision.js";

const allow = ruleDecisionProvider("allow-all", ["guard"], () => ({ verdict: "allow" }));
const deny = ruleDecisionProvider("deny-all", ["guard"], () => ({ verdict: "deny", reason: "blocked" }));
const llmJudge: DecisionProvider = {
  id: "llm-judge",
  deterministic: false,
  supports: () => true,
  decide: () => ({ verdict: "allow", providerId: "llm-judge" }),
};

describe("decision engine", () => {
  test("deny overrides allow", async () => {
    const engine = createDecisionEngine({ providers: [allow, deny] });
    await expect(engine.decide({ kind: "guard", input: {} })).resolves.toMatchObject({ verdict: "deny", providerId: "deny-all" });
  });

  test("abstains when no provider supports the kind", async () => {
    const engine = createDecisionEngine({ providers: [allow] });
    await expect(engine.decide({ kind: "routing", input: {} })).resolves.toMatchObject({ verdict: "abstain" });
  });

  test("a throwing provider fails closed", async () => {
    const broken: DecisionProvider = { id: "broken", deterministic: true, supports: () => true, decide: () => { throw new Error("x"); } };
    const engine = createDecisionEngine({ providers: [allow, broken] });
    await expect(engine.decide({ kind: "guard", input: {} })).resolves.toMatchObject({ verdict: "deny", providerId: "broken" });
  });

  test("deterministicOnly rejects model-based providers", () => {
    expect(() => createDecisionEngine({ providers: [llmJudge], deterministicOnly: true })).toThrow(/not deterministic/);
  });
});
