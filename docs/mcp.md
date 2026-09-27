# MCP (Model Context Protocol)

`@agent-framework/mcp` turns an MCP server's tools into ordinary framework tools. MCP is an adapter, not the internal tool model ([ADR 010](./decisions/010-mcp-integration.md)). Every MCP call goes through the `ToolRuntime` like any other tool:

- JSON Schema validation (converted with `z.fromJSONSchema`);
- permissions (default `mcp.<server>`) and approval rules;
- rate limits, idempotency and audit.

```ts
import { connectStdioServer, connectHttpServer, mcpTools } from "@agent-framework/mcp";

const { client, close } = await connectStdioServer({ command: "npx", args: ["-y", "@acme/crm-mcp"] });
// or: await connectHttpServer({ url: "https://mcp.acme.example/mcp", headers: { authorization: `Bearer ${token}` } });

const crmTools = await mcpTools({
  client,
  server: "crm",                                   // tool names become crm_<tool>
  include: ["get_customer", "update_customer"],
  permissions: (name) => (name.startsWith("get") ? ["crm.read"] : ["crm.write"]),
  approval: (name) => (name.startsWith("update") ? { required: true } : undefined),
  timeoutMs: 15_000,
});

defineAgent({ name: "crm-agent", model, tools: crmTools, permissions: ["crm.read", "crm.write"], runtime });
```

Results are the server's `structuredContent` or its text content. `isError` results become non-retryable `ToolError`s, and transport failures become retryable ones. Treat MCP servers as untrusted: enable `tool_result` guardrails ([Guardrails](./guardrails.md)) and grant the fewest permissions possible.
