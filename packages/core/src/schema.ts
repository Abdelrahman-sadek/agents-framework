/**
 * Minimal structural schema contract.
 *
 * Any validator exposing `safeParse` (Zod v3/v4, or a hand-written adapter)
 * satisfies it, so the core never depends on a specific validation library.
 */
export type SchemaParseResult<T> =
  | { readonly success: true; readonly data: T }
  | { readonly success: false; readonly error: { readonly message: string } };

export interface Schema<T> {
  safeParse(value: unknown): SchemaParseResult<T>;
}

export type InferSchema<S> = S extends Schema<infer T> ? T : never;

/** A JSON Schema document, as sent to models for tool parameters or structured output. */
export type JsonSchema = Readonly<Record<string, unknown>>;
