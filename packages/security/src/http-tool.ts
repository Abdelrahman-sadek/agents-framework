import { ToolError } from "@agent-framework/core";
import { defineTool, type Tool, type ToolConfig } from "@agent-framework/tools";
import type { z } from "zod";
import { safeFetch, type EgressPolicy } from "./egress.js";
import type { SecretProvider } from "./secrets.js";

export interface HttpToolConfig<TInput> extends Omit<ToolConfig<TInput, unknown>, "execute" | "kind" | "output"> {
  input: z.ZodType<TInput>;
  egress: EgressPolicy;
  /** Build the request from validated input. Put secrets in headers via `secret(name)`, not in the URL. */
  request: (input: TInput, secret: (name: string) => Promise<string>) => Promise<{ url: string; method?: string; headers?: Record<string, string>; body?: string }> | { url: string; method?: string; headers?: Record<string, string>; body?: string };
  secrets?: SecretProvider;
  maxBytes?: number;
  /** Map the response to what the model sees (default: status + body text, truncated). */
  mapResponse?: (response: { status: number; body: string }) => unknown;
}

/** HTTP tool adapter: every request (and redirect) passes the egress policy; secrets stay out of model context. */
export function defineHttpTool<TInput>(config: HttpToolConfig<TInput>): Tool<TInput, unknown> {
  const { egress, request, secrets, maxBytes, mapResponse, ...rest } = config;
  return defineTool<TInput, unknown>({
    ...rest,
    kind: "http",
    execute: async (input, ctx) => {
      const secret = async (name: string): Promise<string> => {
        const value = await secrets?.get(name);
        if (value === undefined) throw new ToolError(`Secret '${name}' is not available`);
        return value;
      };
      const spec = await request(input, secret);
      const response = await safeFetch(
        spec.url,
        { method: spec.method ?? "GET", ...(spec.headers === undefined ? {} : { headers: spec.headers }), ...(spec.body === undefined ? {} : { body: spec.body }) },
        { policy: egress, signal: ctx.signal, ...(maxBytes === undefined ? {} : { maxBytes }) },
      );
      if (response.status >= 500) throw new ToolError(`Upstream returned ${response.status}`, { retryable: true });
      return mapResponse !== undefined ? mapResponse(response) : { status: response.status, body: response.body.slice(0, 20_000) };
    },
  });
}
