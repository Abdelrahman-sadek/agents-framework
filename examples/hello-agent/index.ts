import { DefaultAgentRuntime, type Agent, type AgentRunResult, type LLMProvider, type LLMResponse } from "@agent-framework/core";
import { defineTool, ToolRuntime, type ToolResult } from "@agent-framework/tools";
import { z } from "zod";

function createMockLLM(modelId: string): LLMProvider {
  return {
    capabilities: async () => ({ streaming: false, toolCalling: true, structuredOutput: true }),
    generate: async (_request): Promise<LLMResponse> => {
      return {
        id: crypto.randomUUID(),
        modelId,
        content: "Here is the answer.",
        toolCalls: [],
        finishReason: "stop",
        usage: { inputTokens: 8, outputTokens: 6, estimatedCost: 0 },
      };
    },
  };
}

const searchTool = defineTool({
  name: "search",
  description: "Search the knowledge source",
  inputSchema: z.object({ query: z.string() }),
  outputSchema: z.object({ results: z.array(z.string()) }),
  execute: async (input, context) => {
    console.log("Executing search tool for:", input.query, "runId:", context.runId);
    return { results: [`result-for-${input.query}`] };
  },
  permissions: { allowed: ["search"], dataScope: ["read"] },
});

function makeAgent(name: string, modelId: string): Agent {
  const config = {
    name,
    model: { providerId: "mock", modelId },
    system: "You are a helpful assistant with access to a search tool.",
    tools: [searchTool],
  };

  const runtime = createDefaultRuntime(modelId);

  const agent: Agent = {
    name: config.name,
    agentId: `agent-${name}`,
    config,
    run: async (runConfig) => runtime.execute(agent, runConfig),
    cancel: async () => {},
  };

  return agent;
}

function createDefaultRuntime(modelId: string): DefaultAgentRuntime {
  const provider = createMockLLM(modelId);
  const toolRuntime = new ToolRuntime();
  const emitted: { event: any; agentId: string }[] = [];
  const emitter = {
    emit: (event: any, agentId: string) => {
      emitted.push({ event, agentId });
      console.log(JSON.stringify({ event: event.type, agentId, ts: new Date().toISOString() }, null, 2));
    },
  };
  return new DefaultAgentRuntime(
    provider,
    emitter,
    { generate: () => `run-${crypto.randomUUID().slice(0, 8)}` },
    { nowISO: () => new Date().toISOString() },
  );
}

const agent = makeAgent("hello-agent", "mock-hello-model");
const result: AgentRunResult = await agent.run({ input: "Search for hello", metadata: {} });

console.log("\n--- Result ---");
console.log("runId:", result.runId);
console.log("status:", result.status);
console.log("output:", result.output);
console.log("events:", result.events.map((e) => e.type));

// Also exercise the tool runtime directly to demonstrate deterministic tool execution.
const toolRuntime = new ToolRuntime();
const toolResult: ToolResult<{ results: string[] }> = await toolRuntime.execute({
  tool: searchTool,
  input: { query: "hello" },
  callId: crypto.randomUUID(),
  runId: result.runId,
  agentId: agent.agentId,
});

console.log("\n--- Direct tool result ---");
console.log("ok:", toolResult.ok);
console.log("output:", toolResult.output);
if (toolResult.error) {
  console.error("error:", toolResult.error);
}
