import { ToolRuntime, type AnyTool } from "@agent-framework/tools";
import { mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { commandTool, workspaceTools } from "./index.js";

function workspace() {
  const root = mkdtempSync(join(tmpdir(), "af-ws-"));
  const outside = mkdtempSync(join(tmpdir(), "af-out-"));
  writeFileSync(join(outside, "secret.txt"), "TOP SECRET");
  mkdirSync(join(root, "src"));
  writeFileSync(join(root, "src", "app.ts"), "export const answer = 42;\n// TODO: refactor\n");
  symlinkSync(join(outside, "secret.txt"), join(root, "link.txt"));
  symlinkSync(outside, join(root, "escape"));
  return { root, outside };
}

const agent = { agentId: "coder", name: "coder", permissions: ["workspace.*", "sandbox.exec"] };
const run = (tool: AnyTool, input: unknown, approval?: { request: never; decision: never }) =>
  new ToolRuntime().execute(tool, input, { agent, ...(approval === undefined ? {} : { approval }) });
const byName = (tools: AnyTool[], name: string) => tools.find((t) => t.name === name)!;

describe("workspace tools", () => {
  test("read, list and search inside the workspace", async () => {
    const { root } = workspace();
    const tools = workspaceTools({ root });
    expect((await run(byName(tools, "workspace_read_file"), { path: "src/app.ts" })).output).toContain("answer = 42");
    expect((await run(byName(tools, "workspace_list_dir"), { path: "." })).output).toEqual(expect.arrayContaining(["src/"]));
    expect((await run(byName(tools, "workspace_search"), { query: "TODO" })).output).toEqual(["src/app.ts:2: // TODO: refactor"]);
    expect(tools.map((t) => t.name)).not.toContain("workspace_write_file");
  });

  test.each(["../etc/passwd", "/etc/passwd", "link.txt", "escape/secret.txt", "src/../../x"])("blocks escape via %s", async (path) => {
    const { root } = workspace();
    const result = await run(byName(workspaceTools({ root }), "workspace_read_file"), { path });
    expect(result.status).toBe("error");
    expect(JSON.stringify(result)).not.toContain("TOP SECRET");
  });

  test("writes require approval and stay inside the workspace", async () => {
    const { root, outside } = workspace();
    const write = byName(workspaceTools({ root, allowWrite: true }), "workspace_write_file");
    const tools = new ToolRuntime();
    const pending = await tools.execute(write, { path: "notes/todo.md", content: "hi" }, { agent });
    expect(pending.status).toBe("approval_required");
    const approval = { request: pending.approval!, decision: { approvalId: pending.approval!.approvalId, decision: "approved" as const } };
    const done = await tools.execute(write, { path: "notes/todo.md", content: "hi" }, { agent, toolCallId: pending.approval!.toolCallId, approval });
    expect(done.status).toBe("success");
    expect(readFileSync(join(root, "notes/todo.md"), "utf8")).toBe("hi");
    const noApproval = byName(workspaceTools({ root, allowWrite: true, approveWrites: false }), "workspace_write_file");
    expect((await run(noApproval, { path: "escape/pwned.txt", content: "x" })).status).toBe("error");
    expect(() => readFileSync(join(outside, "pwned.txt"))).toThrow();
  });
});

describe("command tool", () => {
  const { root } = workspace();
  const exec = commandTool({ cwd: root, allow: { ls: [], node: ["--version"] }, approval: false, allowFlags: ["--version", "-a"] });

  test("runs allow-listed commands without a shell", async () => {
    const ls = await run(exec, { command: "ls", args: ["src"] });
    expect(ls.output).toMatchObject({ exitCode: 0, stdout: "app.ts\n" });
    const node = await run(exec, { command: "node", args: ["--version"] });
    expect((node.output as { stdout: string }).stdout).toMatch(/^v\d+/);
  });

  test.each([
    [{ command: "rm", args: ["-rf", "/"] }, "error"],
    [{ command: "node", args: ["-e", "require('fs')"] }, "error"],
    [{ command: "ls", args: ["--color=always"] }, "error"],
  ])("rejects %j", async (input, status) => {
    expect((await run(exec, input)).status).toBe(status);
  });

  test("shell metacharacters are passed literally, never interpreted", async () => {
    const result = await run(exec, { command: "ls", args: ["src; cat /etc/passwd"] });
    expect((result.output as { exitCode: number; stdout: string }).exitCode).not.toBe(0);
    expect((result.output as { stdout: string }).stdout).not.toContain("root:");
  });

  test("requires approval by default", async () => {
    const guarded = commandTool({ cwd: root, allow: { ls: [] } });
    expect((await run(guarded, { command: "ls", args: [] })).status).toBe("approval_required");
  });
});
