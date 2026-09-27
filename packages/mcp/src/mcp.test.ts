import { createRuntime, defineAgent } from "@agent-framework/core";
import { createScriptedProvider } from "@agent-framework/core/testing";
import { InMemoryAuditLog, ToolRuntime } from "@agent-framework/tools";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { describe, expect, test } from "vitest";
import { z } from "zod";
import { mcpTools, type McpClientLike } from "./index.js";

async function connectedPair() {
  const server = new McpServer({ name: "crm", version: "1.0.0" });
  server.registerTool("get_customer", { description: "Get a customer by id", inputSchema: { id: z.string() } }, async ({ id }) => ({
    content: [{ type: "text", text: `Customer ${id}: Jane Doe` }],
  }));
  server.registerTool("delete_customer", { description: "Delete a customer", inputSchema: { id: z.string() } }, async () => ({
    content: [{ type: "text", text: "cannot delete" }],
    isError: true,
  }));
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "test", version: "1.0.0" });
  await client.connect(clientTransport);
  return client;
}

describe("MCP adapter", () => {
  test("wraps server tools with schema validation, permissions and metadata", async () => {
    const client = await connectedPair();
    const tools = await mcpTools({ client: client as unknown as McpClientLike, server: "crm" });
    expect(tools.map((t) => t.name).sort()).toEqual(["crm_delete_customer", "crm_get_customer"]);
    const get = tools.find((t) => t.name === "crm_get_customer")!;
    expect(get).toMatchObject({ kind: "mcp", definition: { permissions: ["mcp.crm"], metadata: { mcpServer: "crm", mcpTool: "get_customer" } } });
    expect(get.parameters).toMatchObject({ type: "object", properties: { id: { type: "string" } } });

    const audit = new InMemoryAuditLog();
    const runtime = new ToolRuntime({ audit });
    const agent = { agentId: "a", name: "a", permissions: ["mcp.crm"] };
    expect((await runtime.execute(get, { id: "42" }, { agent })).output).toBe("Customer 42: Jane Doe");
    expect((await runtime.execute(get, { id: 42 }, { agent })).status).toBe("error"); // validated before reaching the server
    expect((await runtime.execute(get, { id: "42" }, { agent: { ...agent, permissions: [] } })).status).toBe("denied");
    const del = tools.find((t) => t.name === "crm_delete_customer")!;
    expect((await runtime.execute(del, { id: "42" }, { agent })).error?.message).toBe("cannot delete");
    expect(audit.entries.some((e) => e.toolKind === "mcp")).toBe(true);
  });

  test("filters tools, applies approval rules, and works inside an agent", async () => {
    const client = await connectedPair();
    const tools = await mcpTools({ client: client as unknown as McpClientLike, server: "crm", include: ["get_customer", "delete_customer"], approval: (name) => (name.startsWith("delete") ? { required: true } : undefined) });
    expect(tools.find((t) => t.name === "crm_delete_customer")?.definition.approval).toEqual({ required: true });
    const provider = createScriptedProvider([{ toolCalls: [{ id: "c", name: "crm_get_customer", arguments: { id: "7" } }] }, { text: "Found Jane." }]);
    const agent = defineAgent({ name: "crm-agent", model: { providerId: "scripted", modelId: "m" }, tools, permissions: ["mcp.crm"], runtime: createRuntime({ providers: [provider], tools: new ToolRuntime() }) });
    const result = await agent.run({ input: "who is 7?" });
    expect(result.output).toBe("Found Jane.");
    expect(provider.requests[1]?.messages.at(-1)?.content).toContain("Jane Doe");
    const only = await mcpTools({ client: client as unknown as McpClientLike, server: "crm", exclude: ["delete_customer"] });
    expect(only.map((t) => t.name)).toEqual(["crm_get_customer"]);
  });
});
