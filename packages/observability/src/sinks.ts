import { appendFileSync, readFileSync } from "node:fs";
import type { AgentEvent, EventSink } from "@agent-farmework/core";

export interface RedactionOptions {
  /** Payload keys whose values are replaced entirely (at any depth). */
  dropKeys?: readonly string[];
  /** Applied to every string value. */
  patterns?: readonly RegExp[];
  replacement?: string;
}

export const DEFAULT_REDACTION_PATTERNS: readonly RegExp[] = [
  /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g,
  /\b(sk|pk|rk)-[A-Za-z0-9_-]{16,}\b/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g,
  /\b(?:\d[ -]?){13,19}\b/g,
];

export function redactValue(value: unknown, options: RedactionOptions = {}): unknown {
  const replacement = options.replacement ?? "[REDACTED]";
  const patterns = options.patterns ?? DEFAULT_REDACTION_PATTERNS;
  const drop = new Set(options.dropKeys ?? []);
  const walk = (v: unknown): unknown => {
    if (typeof v === "string") return patterns.reduce((s, p) => s.replace(p, replacement), v);
    if (Array.isArray(v)) return v.map(walk);
    if (v !== null && typeof v === "object") {
      return Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, inner]) => [k, drop.has(k) ? replacement : walk(inner)]));
    }
    return v;
  };
  return walk(value);
}

/** Wrap a sink so it only ever receives redacted events. */
export function redactingSink(sink: EventSink, options: RedactionOptions = {}): EventSink {
  return { emit: (event) => sink.emit({ ...event, payload: redactValue(event.payload, options) } as AgentEvent) };
}

export interface LogSinkOptions {
  format?: "json" | "pretty";
  /** Default: process.stdout.write */
  write?: (line: string) => void;
  /** Only log these event types (default: all). */
  types?: readonly AgentEvent["type"][];
}

/** Structured logs: one JSON line per event, or a compact human-readable form. */
export function logSink(options: LogSinkOptions = {}): EventSink {
  const write = options.write ?? ((line: string) => process.stdout.write(line));
  const types = options.types === undefined ? undefined : new Set(options.types);
  return {
    emit(event) {
      if (types !== undefined && !types.has(event.type)) return;
      if (options.format === "pretty") {
        write(`${event.occurredAt} ${event.agentId} ${event.runId} #${event.sequence} ${event.type} ${JSON.stringify(event.payload)}\n`);
      } else {
        write(`${JSON.stringify({ level: event.type.endsWith("FAILED") ? "error" : "info", ...event })}\n`);
      }
    },
  };
}

/** Append events to a JSON Lines file (development and CLI tracing). */
export function fileEventSink(path: string): EventSink {
  return { emit: (event) => appendFileSync(path, `${JSON.stringify(event)}\n`) };
}

export function readEventFile(path: string, runId?: string): AgentEvent[] {
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as AgentEvent)
    .filter((e) => runId === undefined || e.runId === runId);
}
