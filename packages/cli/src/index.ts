/**
 * @agent-farmework/cli — the `agent` command and declarative manifests.
 */
export { runCli } from "./cli.js";
export type { CliIO } from "./cli.js";
export { AgentManifestSchema, checkManifest, defineAgentFromManifest, parseManifest } from "./manifest.js";
export type { AgentManifest, ManifestRegistry } from "./manifest.js";
export { scaffold } from "./templates.js";
