export type HealthState = "ok" | "degraded" | "down";

export interface HealthReport {
  status: HealthState;
  checks: Record<string, { ok: boolean; latencyMs: number; error?: string; critical: boolean }>;
}

export interface HealthCheckDefinition {
  check: () => Promise<unknown>;
  /** A failing critical check makes the service `down`; others make it `degraded`. Default true. */
  critical?: boolean;
  timeoutMs?: number;
}

/** Liveness/readiness checks (database, queue, model provider reachability…). */
export function createHealthCheck(checks: Readonly<Record<string, HealthCheckDefinition | (() => Promise<unknown>)>>): { run(): Promise<HealthReport> } {
  return {
    async run() {
      const entries = await Promise.all(
        Object.entries(checks).map(async ([name, def]) => {
          const d = typeof def === "function" ? { check: def } : def;
          const started = Date.now();
          try {
            await Promise.race([d.check(), new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), d.timeoutMs ?? 2_000))]);
            return [name, { ok: true, latencyMs: Date.now() - started, critical: d.critical ?? true }] as const;
          } catch (error) {
            return [name, { ok: false, latencyMs: Date.now() - started, error: error instanceof Error ? error.message : String(error), critical: d.critical ?? true }] as const;
          }
        }),
      );
      const report: HealthReport["checks"] = Object.fromEntries(entries);
      const failed = Object.values(report).filter((c) => !c.ok);
      const status: HealthState = failed.some((c) => c.critical) ? "down" : failed.length > 0 ? "degraded" : "ok";
      return { status, checks: report };
    },
  };
}

/** Run `onShutdown` once on SIGTERM/SIGINT (e.g. `worker.stop()`), then exit. */
export function installGracefulShutdown(onShutdown: () => Promise<unknown>, options: { signals?: readonly NodeJS.Signals[]; exit?: boolean } = {}): () => void {
  let shuttingDown = false;
  const handler = (): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    void onShutdown().finally(() => {
      if (options.exit !== false) process.exit(0);
    });
  };
  const signals = options.signals ?? ["SIGTERM", "SIGINT"];
  for (const s of signals) process.once(s, handler);
  return () => {
    for (const s of signals) process.removeListener(s, handler);
  };
}
