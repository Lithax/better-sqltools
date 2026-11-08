import { errorMessage } from '../domain/errors';
import type { ConnectionId, QueryError, RunResult, StatementResult } from '../domain/model';
import { splitStatements } from '../domain/sql/splitter';
import { tokenizerOptions } from '../domain/sql/tokenizer';
import { toCell } from '../domain/value';
import type { ConnectionManager } from './connection-manager';
import type { HistoryRepository, Logger, SettingsReader } from './ports';
import type { SchemaService } from './schema-service';

export interface RunOptions {
  maxRows?: number;
  signal?: AbortSignal;
  /** Keep going after a failing statement. Default: stop at the first error. */
  continueOnError?: boolean;
}

const SCHEMA_CHANGING = /^\s*(create|alter|drop|truncate|rename|comment|attach|detach|vacuum|reindex)\b/i;
const KEEP_QUIET_RESULTS = 20; // of a huge script, keep this many "OK" results besides rows and errors
const MAX_RESULTS = 200;

function toQueryError(e: unknown): QueryError {
  const code = (e as { code?: unknown } | null)?.code;
  return { message: errorMessage(e), code: code === undefined ? undefined : String(code) };
}

export class QueryService {
  constructor(
    private readonly deps: {
      connections: ConnectionManager;
      schema: SchemaService;
      history: HistoryRepository;
      settings: SettingsReader;
      logger: Logger;
    },
  ) {}

  async run(connectionId: ConnectionId, sql: string, opts: RunOptions = {}): Promise<RunResult> {
    const session = await this.deps.connections.ensure(connectionId);
    const { driver, descriptor, profile } = session;
    const maxRows = opts.maxRows ?? this.deps.settings.maxRows();
    const statements = splitStatements(sql, tokenizerOptions(descriptor.dialect));

    const startedAt = Date.now();
    const t0 = performance.now();
    let results: StatementResult[] = [];
    let cancelled = false;
    let schemaChanged = false;

    for (let i = 0; i < statements.length; i++) {
      if (opts.signal?.aborted) {
        cancelled = true;
        break;
      }
      const text = statements[i].text;
      const s0 = performance.now();
      try {
        const raw = await driver.execute(text, { maxRows, signal: opts.signal });
        results.push({
          index: i,
          sql: text,
          columns: raw.columns,
          rows: raw.rows.map((r) => r.map(toCell)),
          truncated: !!raw.truncated,
          affectedRows: raw.affectedRows,
          notices: raw.notices,
          durationMs: performance.now() - s0,
        });
        if (SCHEMA_CHANGING.test(text)) schemaChanged = true;
      } catch (e) {
        if (SCHEMA_CHANGING.test(text)) schemaChanged = true; // it may have half-applied
        results.push({
          index: i, sql: text, columns: [], rows: [], truncated: false,
          durationMs: performance.now() - s0, error: toQueryError(e),
        });
        if (!opts.continueOnError) break;
      }
    }

    let omitted = 0;
    if (results.length > MAX_RESULTS) {
      let quiet = 0;
      const kept = results.filter((r) => r.columns.length > 0 || r.error || ++quiet <= KEEP_QUIET_RESULTS);
      omitted = results.length - kept.length;
      results = kept;
    }

    const durationMs = performance.now() - t0;
    const failed = results.some((r) => r.error);
    if (schemaChanged) {
      this.deps.schema.invalidate(connectionId);
      this.deps.schema.warm(connectionId);
    }
    try {
      await this.deps.history.add({
        id: `${startedAt}-${Math.random().toString(36).slice(2, 8)}`,
        sql: sql.length > 20_000 ? sql.slice(0, 20_000) : sql,
        connectionId,
        connectionName: profile.name,
        at: startedAt,
        durationMs,
        ok: !failed && !cancelled,
      });
    } catch (e) {
      this.deps.logger.warn(`Could not record history: ${errorMessage(e)}`);
    }

    return {
      connectionId,
      connectionName: profile.name,
      driverName: descriptor.displayName,
      startedAt,
      durationMs,
      statements: results,
      omitted,
      cancelled,
    };
  }
}
