/** Injectable time and id sources, so runs are deterministic under test. */
export interface Clock {
  now(): Date;
}

export interface IdGenerator {
  /** Returns a unique id. `kind` lets implementations add readable prefixes. */
  next(kind: "run" | "step" | "llm" | "event" | "approval" | "tool"): string;
}

export const systemClock: Clock = { now: () => new Date() };

export const randomIds: IdGenerator = {
  next: (kind) => `${kind}_${crypto.randomUUID()}`,
};

/** Sequential ids (`run_1`, `step_2`, …). Useful for tests and snapshots. */
export function sequentialIds(): IdGenerator {
  const counters = new Map<string, number>();
  return {
    next(kind) {
      const n = (counters.get(kind) ?? 0) + 1;
      counters.set(kind, n);
      return `${kind}_${n}`;
    },
  };
}
