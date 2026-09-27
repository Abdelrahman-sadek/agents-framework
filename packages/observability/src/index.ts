/**
 * @agent-framework/observability — consumers of the framework event stream.
 */
export { openTelemetrySink } from "./otel.js";
export type { OpenTelemetrySinkOptions } from "./otel.js";
export { DEFAULT_REDACTION_PATTERNS, fileEventSink, logSink, readEventFile, redactValue, redactingSink } from "./sinks.js";
export type { LogSinkOptions, RedactionOptions } from "./sinks.js";
export { CostTracker } from "./cost.js";
export type { CostLine, CostReport } from "./cost.js";
export { formatRunReport, inspectRun } from "./inspect.js";
export type { RunReport } from "./inspect.js";
export { createDashboardServer, summarizeRuns } from "./dashboard.js";
export type { Dashboard, DashboardOptions } from "./dashboard.js";
