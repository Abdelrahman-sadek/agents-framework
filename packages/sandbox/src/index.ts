/**
 * @agent-framework/sandbox — controlled execution capabilities.
 *
 * A model never gets raw OS authority. It gets narrow tools:
 * - workspace tools confined to one directory (symlink- and traversal-safe),
 * - an allow-listed command tool that never uses a shell, with timeouts,
 *   output caps and a scrubbed environment, running through a pluggable
 *   `SandboxRunner` (local process by default; container/VM runners are adapters).
 * All of them pass the normal tool pipeline: validation, permissions,
 * approval (writes and commands require it by default) and audit.
 */
import { execFile } from "node:child_process";
import { mkdir, readdir, readFile, realpath, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { PolicyViolationError, ToolError } from "@agent-framework/core";
import { defineTool, type AnyTool } from "@agent-framework/tools";
import { z } from "zod";

// ------------------------------------------------------------------ workspace

export interface WorkspaceOptions {
  /** The only directory the tools can touch. */
  root: string;
  /** Include `write_file`. Default false. */
  allowWrite?: boolean;
  /** Require human approval for writes. Default true. */
  approveWrites?: boolean;
  /** Largest file read or written. Default 1 MB. */
  maxFileBytes?: number;
  readPermission?: string;
  writePermission?: string;
  /** Tool name prefix. Default "workspace". */
  prefix?: string;
}

const SKIP_DIRS = new Set([".git", "node_modules", ".venv", "dist"]);

/** Resolve `path` inside `root`, rejecting absolute paths, traversal and symlink escapes. */
export async function confine(root: string, path: string, options: { mustExist: boolean }): Promise<string> {
  if (path.includes("\0")) throw new PolicyViolationError("Invalid path");
  if (isAbsolute(path)) throw new PolicyViolationError("Absolute paths are not allowed; use paths relative to the workspace");
  const realRoot = await realpath(root);
  const candidate = resolve(realRoot, path);
  const inside = (p: string): boolean => p === realRoot || p.startsWith(realRoot + sep);
  if (!inside(candidate)) throw new PolicyViolationError(`Path '${path}' is outside the workspace`);
  // Resolve symlinks of the target (or of its closest existing ancestor for new files).
  let probe = candidate;
  for (;;) {
    try {
      const real = await realpath(probe);
      if (!inside(real)) throw new PolicyViolationError(`Path '${path}' resolves outside the workspace`);
      break;
    } catch (error) {
      if (error instanceof PolicyViolationError) throw error;
      if (options.mustExist) throw new ToolError(`No such file or directory: ${path}`);
      const parent = dirname(probe);
      if (parent === probe) break;
      probe = parent;
    }
  }
  return candidate;
}

export function workspaceTools(options: WorkspaceOptions): AnyTool[] {
  const max = options.maxFileBytes ?? 1_000_000;
  const prefix = options.prefix ?? "workspace";
  const read = [options.readPermission ?? "workspace.read"];
  const rel = async (p: string): Promise<string> => relative(await realpath(options.root), p) || ".";

  const tools: AnyTool[] = [
    defineTool({
      name: `${prefix}_read_file`,
      description: "Read a UTF-8 text file from the workspace (path relative to the workspace root).",
      kind: "sandbox",
      permissions: read,
      input: z.object({ path: z.string().min(1) }),
      execute: async ({ path }) => {
        const full = await confine(options.root, path, { mustExist: true });
        const info = await stat(full);
        if (!info.isFile()) throw new ToolError(`'${path}' is not a file`);
        if (info.size > max) throw new ToolError(`'${path}' is larger than ${max} bytes`);
        return await readFile(full, "utf8");
      },
    }),
    defineTool({
      name: `${prefix}_list_dir`,
      description: "List a directory in the workspace.",
      kind: "sandbox",
      permissions: read,
      input: z.object({ path: z.string().default(".") }),
      execute: async ({ path }) => {
        const full = await confine(options.root, path, { mustExist: true });
        const entries = await readdir(full, { withFileTypes: true });
        return entries.map((e) => `${e.name}${e.isDirectory() ? "/" : ""}`).sort();
      },
    }),
    defineTool({
      name: `${prefix}_search`,
      description: "Find text in workspace files. Returns up to 50 matches as path:line: text.",
      kind: "sandbox",
      permissions: read,
      input: z.object({ query: z.string().min(1).max(200), path: z.string().default(".") }),
      execute: async ({ query, path }, ctx) => {
        const start = await confine(options.root, path, { mustExist: true });
        const matches: string[] = [];
        const walk = async (dir: string): Promise<void> => {
          for (const entry of await readdir(dir, { withFileTypes: true })) {
            if (matches.length >= 50 || ctx.signal.aborted) return;
            if (entry.isSymbolicLink()) continue;
            const full = join(dir, entry.name);
            if (entry.isDirectory()) {
              if (!SKIP_DIRS.has(entry.name)) await walk(full);
            } else if (entry.isFile() && (await stat(full)).size <= max) {
              const lines = (await readFile(full, "utf8")).split("\n");
              for (const [i, line] of lines.entries()) {
                if (line.includes(query)) matches.push(`${await rel(full)}:${i + 1}: ${line.trim().slice(0, 200)}`);
                if (matches.length >= 50) return;
              }
            }
          }
        };
        await walk(start);
        return matches;
      },
    }),
  ];

  if (options.allowWrite === true) {
    tools.push(
      defineTool({
        name: `${prefix}_write_file`,
        description: "Create or overwrite a UTF-8 text file in the workspace.",
        kind: "sandbox",
        permissions: [options.writePermission ?? "workspace.write"],
        input: z.object({ path: z.string().min(1), content: z.string().max(max) }),
        ...(options.approveWrites === false ? {} : { approval: { required: true, reason: "File write in the workspace" } }),
        execute: async ({ path, content }) => {
          const full = await confine(options.root, path, { mustExist: false });
          await mkdir(dirname(full), { recursive: true });
          await confine(options.root, path, { mustExist: false }); // re-check after creating directories
          await writeFile(full, content, "utf8");
          return { written: path, bytes: Buffer.byteLength(content) };
        },
      }),
    );
  }
  return tools;
}

// ------------------------------------------------------------------ commands

export interface CommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  truncated: boolean;
}

/** Where commands run. The local runner uses a child process; container/VM runners implement the same port. */
export interface SandboxRunner {
  run(command: string, args: readonly string[], options: { cwd: string; timeoutMs: number; env: Record<string, string>; maxOutputBytes: number; signal: AbortSignal }): Promise<CommandResult>;
}

export const localProcessRunner: SandboxRunner = {
  run(command, args, options) {
    return new Promise((resolvePromise) => {
      execFile(
        command,
        [...args],
        { cwd: options.cwd, timeout: options.timeoutMs, env: options.env, maxBuffer: options.maxOutputBytes, signal: options.signal, shell: false, windowsHide: true },
        (error, stdout, stderr) => {
          const err = error as (NodeJS.ErrnoException & { code?: number | string }) | null;
          const truncated = err?.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER";
          resolvePromise({
            exitCode: err === null ? 0 : typeof err.code === "number" ? err.code : 1,
            stdout: String(stdout).slice(0, options.maxOutputBytes),
            stderr: (err !== null && String(stderr) === "" ? err.message : String(stderr)).slice(0, options.maxOutputBytes),
            truncated,
          });
        },
      );
    });
  },
};

export interface CommandToolOptions {
  /** Working directory (the workspace). */
  cwd: string;
  /**
   * Allowed commands and, per command, the allowed first argument (subcommand).
   * An empty list allows any arguments. Example: `{ git: ["status", "diff", "log"], ls: [] }`.
   */
  allow: Readonly<Record<string, readonly string[]>>;
  /** Flags that may be passed (arguments starting with "-" are rejected otherwise). */
  allowFlags?: readonly string[];
  timeoutMs?: number;
  maxOutputBytes?: number;
  /** Environment variables passed through (everything else is dropped). Default: PATH, HOME, LANG. */
  envAllowList?: readonly string[];
  /** Require human approval. Default true. */
  approval?: boolean;
  permission?: string;
  name?: string;
  runner?: SandboxRunner;
}

/** A single command-execution tool with an allow-list, no shell, and bounded time and output. */
export function commandTool(options: CommandToolOptions): AnyTool {
  const allowFlags = new Set(options.allowFlags ?? []);
  const runner = options.runner ?? localProcessRunner;
  const commands = Object.keys(options.allow);
  if (commands.length === 0) throw new TypeError("commandTool: allow at least one command");
  return defineTool({
    name: options.name ?? "run_command",
    description: `Run an allow-listed command in the workspace. Allowed: ${commands
      .map((c) => ((options.allow[c]?.length ?? 0) === 0 ? c : `${c} ${(options.allow[c] ?? []).join("|")}`))
      .join("; ")}. No shell features (pipes, redirects, globs).`,
    kind: "sandbox",
    permissions: [options.permission ?? "sandbox.exec"],
    timeoutMs: (options.timeoutMs ?? 20_000) + 1_000,
    ...(options.approval === false ? {} : { approval: { required: true, reason: "Command execution" } }),
    input: z.object({ command: z.enum(commands as [string, ...string[]]), args: z.array(z.string().max(500)).max(32).default([]) }),
    execute: async ({ command, args }, ctx) => {
      const subcommands = options.allow[command] ?? [];
      if (subcommands.length > 0 && !subcommands.includes(args[0] ?? "")) {
        throw new PolicyViolationError(`'${command} ${args[0] ?? ""}' is not allowed; allowed: ${subcommands.join(", ")}`);
      }
      for (const arg of args) {
        if (arg.startsWith("-") && !allowFlags.has(arg.split("=")[0] ?? arg)) throw new PolicyViolationError(`Flag '${arg}' is not allowed`);
        if (arg.includes("\0")) throw new PolicyViolationError("Invalid argument");
      }
      const env: Record<string, string> = {};
      for (const key of options.envAllowList ?? ["PATH", "HOME", "LANG"]) {
        const value = process.env[key];
        if (value !== undefined) env[key] = value;
      }
      const result = await runner.run(command, args, {
        cwd: await realpath(options.cwd),
        timeoutMs: options.timeoutMs ?? 20_000,
        env,
        maxOutputBytes: options.maxOutputBytes ?? 64_000,
        signal: ctx.signal,
      });
      return result;
    },
  });
}
