/**
 * Minimal SQL client contract. `pg.Pool`/`pg.Client` satisfy it directly;
 * other drivers need a one-line adapter. No driver is a dependency.
 */
export interface SqlClient {
  query<Row = Record<string, unknown>>(text: string, params?: readonly unknown[]): Promise<{ rows: Row[] }>;
}

/** Only allow simple identifiers for table names (they are interpolated into SQL). */
export function tableName(name: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]{0,62}$/.test(name)) throw new TypeError(`Invalid table name '${name}'`);
  return name;
}

/** Subset of `node:sqlite` DatabaseSync used here (Node ≥ 22.5). */
export interface SqliteDatabase {
  exec(sql: string): void;
  prepare(sql: string): {
    run(...params: unknown[]): unknown;
    get(...params: unknown[]): unknown;
    all(...params: unknown[]): unknown[];
  };
}

/** Open a SQLite database with the built-in `node:sqlite` module. */
export async function openSqlite(path: string): Promise<SqliteDatabase> {
  const sqlite = (await import("node:sqlite")) as unknown as { DatabaseSync: new (path: string) => SqliteDatabase };
  const db = new sqlite.DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;");
  return db;
}
