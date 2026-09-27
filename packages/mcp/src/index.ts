/**
 * @agent-framework/mcp — Model Context Protocol as an adapter.
 *
 * MCP server tools become ordinary framework tools: arguments are validated
 * against the server's JSON Schema, calls pass the ToolRuntime pipeline
 * (policy, approval, rate limits, idempotency, audit), and results are
 * normalized. MCP is never the internal tool representation (ADR 010).
 */
import { ConfigurationError, ToolError } from "@agent-framework/core";
import { defineTool, type AnyTool, type ToolApproval } from "@agent-framework/tools";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { z } from "zod";

/** The part of the MCP SDK `Client` this adapter uses. */
export interface McpClientLike {
  listTools(params?: { cursor?: string }): Promise<{ tools: { name: string; description?: string; inputSchema: Record<string, unknown> }[]; nextCursor?: string }>;
  callTool(
    params: { name: string; arguments?: Record<string, unknown> },
    resultSchema?: undefined,
    options?: { signal?: AbortSignal; timeout?: number },
  ): Promise<{ content?: unknown; isError?: boolean; structuredContent?: unknown }>;
}

export interface McpToolsOptions {
  client: McpClientLike;
  /** Server label, used as a name prefix and recorded in tool metadata. */
  server: string;
  /** Only these MCP tool names (default: all). */
  include?: readonly string[];
  exclude?: readonly string[];
  /** Permissions required per tool (default: `mcp.<server>`). */
  permissions?: readonly string[] | ((toolName: string) => readonly string[]);
  /** Approval rules per tool, e.g. require approval for anything that writes. */
  approval?: (toolName: string) => ToolApproval<Record<string, unknown>> | undefined;
  timeoutMs?: number;
  /** Redact inputs in audit logs. */
  sensitive?: boolean;
}

const sanitize = (name: string): string => name.replace(/[^A-Za-z0-9_-]/g, "_");

/** List the server's tools and wrap each one as a framework tool. */
export async function mcpTools(options: McpToolsOptions): Promise<AnyTool[]> {
  const listed: { name: string; description?: string; inputSchema: Record<string, unknown> }[] = [];
  let cursor: string | undefined;
  do {
    const page = await options.client.listTools(cursor === undefined ? {} : { cursor });
    listed.push(...page.tools);
    cursor = page.nextCursor;
  } while (cursor !== undefined);

  const prefix = sanitize(options.server);
  return listed
    .filter((t) => (options.include === undefined || options.include.includes(t.name)) && !(options.exclude ?? []).includes(t.name))
    .map((remote) => {
      let input: z.ZodType<Record<string, unknown>>;
      try {
        input = z.fromJSONSchema(remote.inputSchema) as unknown as z.ZodType<Record<string, unknown>>;
      } catch (cause) {
        throw new ConfigurationError(`MCP tool '${remote.name}' on '${options.server}' has an unsupported input schema`, { cause });
      }
      const permissions = typeof options.permissions === "function" ? options.permissions(remote.name) : (options.permissions ?? [`mcp.${options.server}`]);
      const approval = options.approval?.(remote.name);
      return defineTool({
        name: `${prefix}_${sanitize(remote.name)}`.slice(0, 64),
        description: remote.description ?? `${remote.name} (MCP server ${options.server})`,
        kind: "mcp",
        input,
        permissions,
        ...(approval === undefined ? {} : { approval }),
        ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
        ...(options.sensitive === undefined ? {} : { sensitive: options.sensitive }),
        metadata: { mcpServer: options.server, mcpTool: remote.name },
        execute: async (args, ctx) => {
          let result: Awaited<ReturnType<McpClientLike["callTool"]>>;
          try {
            result = await options.client.callTool({ name: remote.name, arguments: args }, undefined, { signal: ctx.signal });
          } catch (cause) {
            throw new ToolError(`MCP server '${options.server}' failed to run '${remote.name}'`, { cause, retryable: true });
          }
          const text = Array.isArray(result.content)
            ? result.content.flatMap((c) => (typeof c === "object" && c !== null && (c as { type?: unknown }).type === "text" ? [String((c as { text?: unknown }).text ?? "")] : [])).join("\n")
            : "";
          if (result.isError === true) throw new ToolError(text === "" ? `MCP tool '${remote.name}' reported an error` : text, { retryable: false });
          return result.structuredContent ?? text;
        },
      });
    });
}

/** Connect to an MCP server over stdio (spawns the server process). */
export async function connectStdioServer(options: { command: string; args?: string[]; env?: Record<string, string>; name?: string }): Promise<{ client: Client; close: () => Promise<void> }> {
  const { StdioClientTransport } = await import("@modelcontextprotocol/sdk/client/stdio.js");
  const client = new Client({ name: options.name ?? "agent-framework", version: "0.1.0" });
  await client.connect(new StdioClientTransport({ command: options.command, ...(options.args === undefined ? {} : { args: options.args }), ...(options.env === undefined ? {} : { env: options.env }) }));
  return { client, close: () => client.close() };
}

/** Connect to a remote MCP server over Streamable HTTP. Put credentials in `headers`, never in the URL. */
export async function connectHttpServer(options: { url: string; headers?: Record<string, string>; name?: string }): Promise<{ client: Client; close: () => Promise<void> }> {
  const { StreamableHTTPClientTransport } = await import("@modelcontextprotocol/sdk/client/streamableHttp.js");
  const client = new Client({ name: options.name ?? "agent-framework", version: "0.1.0" });
  const transport = new StreamableHTTPClientTransport(new URL(options.url), options.headers === undefined ? {} : { requestInit: { headers: options.headers } });
  // The SDK's transport type predates exactOptionalPropertyTypes; it is structurally the Transport the client expects.
  await client.connect(transport as unknown as Parameters<Client["connect"]>[0]);
  return { client, close: () => client.close() };
}
