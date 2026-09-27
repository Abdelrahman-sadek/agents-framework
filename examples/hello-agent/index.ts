/**
 * Example 1 — Simple agent: User → Agent → Tool → Answer.
 *
 * Runs offline with a scripted model so it is deterministic. Swap the provider
 * for a real adapter (OpenAI, Anthropic, a local model…) without touching the agent.
 *
 *   pnpm example:hello
 */
import { InMemoryEventSink, createRuntime, defineAgent } from "@agent-farmework/core";
import { createScriptedProvider } from "@agent-farmework/core/testing";
import { models } from "@agent-farmework/llm";
import { InMemoryAuditLog, ToolRuntime, defineTool } from "@agent-farmework/tools";
import { z } from "zod";

// 1. A tool: typed input/output, validated at runtime, permission-gated.
const weatherTool = defineTool({
  name: "get_weather",
  description: "Get the current weather for a city",
  input: z.object({ city: z.string().describe("City name, e.g. Cairo") }),
  output: z.object({ city: z.string(), temperatureC: z.number(), condition: z.string() }),
  permissions: ["weather.read"],
  timeoutMs: 5_000,
  execute: async ({ city }) => ({ city, temperatureC: 31, condition: "sunny" }),
});

// 2. A model provider. Here: a scripted stand-in that asks for the tool, then answers.
const provider = createScriptedProvider(
  [
    { toolCalls: [{ id: "call_1", name: "get_weather", arguments: { city: "Cairo" } }] },
    (request) => {
      const toolResult = request.messages.at(-1)?.content ?? "";
      const { temperatureC, condition } = JSON.parse(toolResult) as { temperatureC: number; condition: string };
      return {
        id: "resp_2",
        modelId: request.modelId,
        content: `It is ${temperatureC}°C and ${condition} in Cairo.`,
        toolCalls: [],
        finishReason: "stop",
        usage: { inputTokens: 42, outputTokens: 12 },
      };
    },
  ],
  { id: "openai" },
);

// 3. An explicit runtime: providers, the tool runtime, and event sinks. No globals.
const events = new InMemoryEventSink();
const audit = new InMemoryAuditLog();
const runtime = createRuntime({ providers: [provider], tools: new ToolRuntime({ audit }), events });

// 4. The agent.
const agent = defineAgent({
  name: "weather-assistant",
  model: models.openai("gpt-4.1-mini"),
  instructions: "You answer weather questions. Use tools for facts.",
  tools: [weatherTool],
  permissions: ["weather.read"],
  limits: { maxSteps: 4, maxToolCalls: 2 },
  runtime,
});

// 5. Run it on behalf of a user.
const result = await agent.run({
  input: "What's the weather in Cairo?",
  user: { userId: "user-42", tenantId: "acme", permissions: ["weather.read"] },
});

console.log(`status: ${result.status}`);
console.log(`output: ${result.output}`);
console.log(`usage:  ${result.usage.totalTokens} tokens, ${result.usage.toolCalls} tool call(s)`);
console.log("\nevents:");
for (const event of events.events) console.log(`  ${String(event.sequence).padStart(2)} ${event.type}`);
console.log("\naudit:");
for (const entry of audit.entries) console.log(`  ${entry.toolName} → ${entry.outcome} (${entry.authorization?.reason})`);
