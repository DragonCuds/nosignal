import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { config } from './config.js';

export type QueryResult<Row = Record<string, unknown>> = { rows: Row[]; rowCount: number };
type Release = () => void;

class Mutex {
  private tail = Promise.resolve();
  async acquire(): Promise<Release> {
    let release!: Release;
    const next = new Promise<void>((resolve) => { release = resolve; });
    const previous = this.tail;
    this.tail = previous.then(() => next);
    await previous;
    return release;
  }
}

const jsonColumns = new Set(['payload', 'public_jwk', 'last_message', 'tags', 'transports']);
const booleanColumns = new Set(['backed_up', 'current', 'enabled']);
const normalizeRow = <Row>(row: Record<string, unknown>): Row => Object.fromEntries(
  Object.entries(row).map(([key, value]) => {
    if (booleanColumns.has(key) && (typeof value === 'number' || typeof value === 'bigint')) return [key, value !== 0 && value !== 0n];
    if (typeof value === 'bigint') {
      if (key === 'id' || key.endsWith('_id')) return [key, value.toString()];
      const number = Number(value);
      return [key, Number.isSafeInteger(number) ? number : value.toString()];
    }
    if (jsonColumns.has(key) && typeof value === 'string') {
      try { return [key, JSON.parse(value)]; } catch { return [key, value]; }
    }
    return [key, value];
  })
) as Row;

const bindSql = (sql: string): string => sql.replace(/\$(\d+)/g, '@p$1');
const execute = <Row>(database: Database.Database, sql: string, params: readonly unknown[] = []): QueryResult<Row> => {
  const bound = bindSql(sql).trim();
  if (!params.length && /;\s*\S/u.test(bound.replace(/;\s*$/u, ''))) {
    database.exec(bound);
    return { rows: [], rowCount: 0 };
  }
  const statement = database.prepare(bound);
  const bindings = Object.fromEntries(params.map((value, index) => [`p${index + 1}`, value]));
  if (statement.reader) {
    const rows = (params.length ? statement.all(bindings) : statement.all()) as Record<string, unknown>[];
    return { rows: rows.map(normalizeRow<Row>), rowCount: rows.length };
  }
  const result = params.length ? statement.run(bindings) : statement.run();
  return { rows: [], rowCount: result.changes };
};

mkdirSync(config.dataDir, { recursive: true });
const sqlite = new Database(join(config.dataDir, 'tel.db'));
sqlite.pragma('journal_mode = WAL');
sqlite.pragma('foreign_keys = ON');
sqlite.pragma('busy_timeout = 5000');
sqlite.defaultSafeIntegers(true);
const mutex = new Mutex();

export type DbClient = {
  query<Row = Record<string, unknown>>(sql: string, params?: readonly unknown[]): Promise<QueryResult<Row>>;
  release(): void;
};

export const db = {
  async query<Row = Record<string, unknown>>(sql: string, params: readonly unknown[] = []): Promise<QueryResult<Row>> {
    const release = await mutex.acquire();
    try { return execute<Row>(sqlite, sql, params); } finally { release(); }
  },
  async connect(): Promise<DbClient> {
    let transactionRelease: Release | null = null;
    let released = false;
    return {
      async query<Row = Record<string, unknown>>(sql: string, params: readonly unknown[] = []): Promise<QueryResult<Row>> {
        if (released) throw new Error('Database client has been released');
        const command = sql.trim().toUpperCase();
        if (command === 'BEGIN') {
          if (transactionRelease) throw new Error('Transaction already started');
          transactionRelease = await mutex.acquire();
          try { return execute<Row>(sqlite, 'BEGIN IMMEDIATE'); } catch (error) {
            transactionRelease(); transactionRelease = null; throw error;
          }
        }
        if (command === 'COMMIT' || command === 'ROLLBACK') {
          try { return execute<Row>(sqlite, command); } finally {
            transactionRelease?.(); transactionRelease = null;
          }
        }
        if (transactionRelease) return execute<Row>(sqlite, sql, params);
        const operationRelease = await mutex.acquire();
        try { return execute<Row>(sqlite, sql, params); } finally { operationRelease(); }
      },
      release(): void {
        if (released) return;
        if (transactionRelease) {
          if (sqlite.inTransaction) sqlite.exec('ROLLBACK');
          transactionRelease(); transactionRelease = null;
        }
        released = true;
      }
    };
  },
  async end(): Promise<void> {
    const release = await mutex.acquire();
    try { sqlite.close(); } finally { release(); }
  }
};
