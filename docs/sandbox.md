# Sandbox tools

`@agent-framework/sandbox` gives agents controlled execution capabilities. A model never gets raw OS authority, only narrow tools that pass the normal pipeline (validation, permissions, approval, audit).

## Workspace files

```ts
import { workspaceTools } from "@agent-framework/sandbox";

const tools = workspaceTools({ root: "/srv/workspaces/ticket-123", allowWrite: true, maxFileBytes: 500_000 });
// workspace_read_file, workspace_list_dir, workspace_search, workspace_write_file (approval required by default)
```

Paths are relative to `root`. The tools reject:

- absolute paths;
- `..` traversal;
- symlinks that resolve outside the root (checked on the target, or on its closest existing parent for new files).

Search skips `.git`, `node_modules` and symlinks. Permissions default to `workspace.read` and `workspace.write`.

## Commands

```ts
import { commandTool } from "@agent-framework/sandbox";

const run = commandTool({
  cwd: "/srv/workspaces/ticket-123",
  allow: { git: ["status", "diff", "log"], ls: [], npm: ["test"] },   // command → allowed subcommands ([] = any)
  allowFlags: ["--stat", "-la"],                                      // every other "-…" argument is rejected
  timeoutMs: 30_000,
  maxOutputBytes: 64_000,
});
```

Controls on every command:

- it runs through `execFile` with **no shell**, so pipes, redirects and `;` are passed literally;
- the environment is scrubbed down to an allow-list;
- time and output are capped;
- approval is required by default, and the permission is `sandbox.exec`.

## Isolation

The default `localProcessRunner` runs on the host with the limits above. For untrusted workloads, implement the `SandboxRunner` port with a container, microVM or remote sandbox (network off, read-only root, CPU and memory quotas). The tool definitions stay the same.
