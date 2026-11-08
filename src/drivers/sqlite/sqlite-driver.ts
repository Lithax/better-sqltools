import * as fs from 'node:fs';
import * as path from 'node:path';
import initSqlJs, { type Database, type SqlJsStatic, type SqlValue } from 'sql.js';
import type { Catalog, CatalogTable, SchemaNode } from '../../domain/model';
import type {
  Driver, DriverConfig, DriverEnvironment, DriverFactory, ExecutionContext, RawStatementResult,
} from '../../application/ports';
import { sqliteDescriptor } from './descriptor';

/**
 * sql.js keeps the whole database in memory. This driver loads the file on open and writes
 * it back after every statement that changed something, but never while a transaction is
 * open (exporting would roll it back) and never over a file that changed on disk behind
 * our back. Fine for development databases; use a native driver for big or shared files.
 */

function locateWasm(file: string): string {
  const beside = path.join(__dirname, file); // bundled: dist/sql-wasm.wasm
  if (fs.existsSync(beside)) return beside;
  return require.resolve(`sql.js/dist/${file}`); // running from source
}

const quoteIdent = (s: string) => `"${s.replace(/"/g, '""')}"`;

interface Options {
  path: string;
  readOnly: boolean;
  createIfMissing: boolean;
  foreignKeys: boolean;
}

class SqliteDriver implements Driver {
  private db?: Database;
  private file?: string;
  private mtimeMs?: number;
  private dirty = false;

  constructor(
    private readonly load: () => Promise<SqlJsStatic>,
    private readonly opts: Options,
    private readonly env: DriverEnvironment,
  ) {}

  async open(): Promise<void> {
    const SQL = await this.load();
    const raw = this.opts.path.trim();
    if (!raw) throw new Error('No database path configured.');

    if (raw === ':memory:') {
      this.db = new SQL.Database();
    } else {
      const file = this.env.resolvePath(raw);
      this.file = file;
      if (fs.existsSync(file)) {
        const st = fs.statSync(file);
        if (!st.isFile()) throw new Error(`"${file}" is not a file.`);
        this.db = new SQL.Database(await fs.promises.readFile(file));
        this.mtimeMs = st.mtimeMs;
        try {
          this.db.exec('SELECT count(*) FROM sqlite_master'); // fails fast on non-SQLite files
        } catch {
          this.db.close();
          this.db = undefined;
          throw new Error(`"${file}" is not a SQLite database.`);
        }
      } else if (this.opts.createIfMissing && !this.opts.readOnly) {
        this.db = new SQL.Database(); // like sqlite3: the file appears with the first write, not on open
      } else {
        throw new Error(`Database file not found: ${file}`);
      }
    }
    this.applyPragmas();
  }

  async close(): Promise<void> {
    const db = this.db;
    if (!db) return;
    try {
      // An unfinished transaction is discarded, like closing any other client.
      if (this.dirty && !this.inTransaction()) await this.persist();
    } finally {
      db.close();
      this.db = undefined;
    }
  }

  async execute(sql: string, ctx: ExecutionContext): Promise<RawStatementResult> {
    const db = this.requireDb();
    if (ctx.signal?.aborted) throw new Error('Cancelled');

    const before = this.snapshot();
    const stmt = db.prepare(sql);
    let result: RawStatementResult;
    try {
      const columns = stmt.getColumnNames();
      const rows: unknown[][] = [];
      let truncated = false;
      if (columns.length > 0) {
        while (stmt.step()) {
          if (rows.length >= ctx.maxRows) {
            truncated = true;
            break;
          }
          rows.push(stmt.get());
        }
        result = { columns: columns.map((name) => ({ name })), rows, truncated };
      } else {
        stmt.step();
        result = { columns: [], rows: [] };
      }
      const after = this.snapshot();
      if (columns.length === 0) {
        // changes() is stale after DDL, so only trust it when total_changes moved.
        result.affectedRows = after.changes === before.changes ? 0 : db.getRowsModified();
      }
      if (after.changes !== before.changes || after.schema !== before.schema) this.dirty = true;
    } finally {
      stmt.free();
    }
    if (this.dirty) await this.persist();
    return result;
  }

  async children(parent?: SchemaNode): Promise<SchemaNode[]> {
    this.requireDb();
    if (!parent) {
      const count = (types: string[]) =>
        Number(this.scalar(`SELECT count(*) FROM sqlite_master WHERE type IN (${types.map(() => '?').join(',')}) AND name NOT LIKE 'sqlite_%'`, types));
      return [
        { id: 'folder:tables', kind: 'folder', label: 'Tables', description: String(count(['table'])), expandable: true },
        { id: 'folder:views', kind: 'folder', label: 'Views', description: String(count(['view'])), expandable: true },
        { id: 'folder:indexes', kind: 'folder', label: 'Indexes', description: String(count(['index'])), expandable: true },
        { id: 'folder:triggers', kind: 'folder', label: 'Triggers', description: String(count(['trigger'])), expandable: true },
      ];
    }

    switch (parent.id) {
      case 'folder:tables':
      case 'folder:views': {
        const type = parent.id === 'folder:tables' ? 'table' : 'view';
        return this.all("SELECT name FROM sqlite_master WHERE type = ? AND name NOT LIKE 'sqlite_%' ORDER BY name", [type]).map((r) => ({
          id: `${type}:${r.name}`,
          kind: type,
          label: String(r.name),
          expandable: true,
          qualifiedName: quoteIdent(String(r.name)),
          data: { name: r.name },
        }));
      }
      case 'folder:indexes':
        return this.all("SELECT name, tbl_name FROM sqlite_master WHERE type = 'index' AND name NOT LIKE 'sqlite_%' ORDER BY tbl_name, name").map((r) => ({
          id: `index:${r.name}`, kind: 'index', label: String(r.name), description: `on ${r.tbl_name}`, expandable: false, data: { name: r.name },
        }));
      case 'folder:triggers':
        return this.all("SELECT name, tbl_name FROM sqlite_master WHERE type = 'trigger' ORDER BY tbl_name, name").map((r) => ({
          id: `trigger:${r.name}`, kind: 'trigger', label: String(r.name), description: `on ${r.tbl_name}`, expandable: false, data: { name: r.name },
        }));
    }

    if (parent.kind === 'table' || parent.kind === 'view') {
      const table = String((parent.data as { name: string }).name);
      return this.all('SELECT cid, name, type, "notnull" AS nn, pk FROM pragma_table_info(?) ORDER BY cid', [table]).map((c) => {
        const flags = [c.type ? String(c.type) : '', Number(c.pk) ? 'PK' : '', Number(c.nn) ? 'NOT NULL' : ''].filter(Boolean);
        return {
          id: `column:${table}:${c.cid}`,
          kind: 'column' as const,
          label: String(c.name),
          description: flags.join(' · '),
          expandable: false,
          primaryKey: Number(c.pk) > 0,
        };
      });
    }
    return [];
  }

  async catalog(): Promise<Catalog> {
    const rows = this.all(
      `SELECT m.name AS t, m.type AS k, p.name AS c, p.type AS ty, p."notnull" AS nn, p.pk AS pk
         FROM sqlite_master m JOIN pragma_table_info(m.name) p
        WHERE m.type IN ('table','view') AND m.name NOT LIKE 'sqlite_%'
        ORDER BY m.name, p.cid`,
    );
    const tables = new Map<string, CatalogTable>();
    for (const r of rows) {
      const name = String(r.t);
      let t = tables.get(name);
      if (!t) tables.set(name, (t = { name, kind: r.k === 'view' ? 'view' : 'table', columns: [] }));
      t.columns.push({ name: String(r.c), type: r.ty ? String(r.ty) : undefined, primaryKey: Number(r.pk) > 0, nullable: !Number(r.nn) });
    }
    // Empty tables/views have no pragma rows; list them anyway.
    for (const r of this.all("SELECT name, type FROM sqlite_master WHERE type IN ('table','view') AND name NOT LIKE 'sqlite_%'")) {
      if (!tables.has(String(r.name))) tables.set(String(r.name), { name: String(r.name), kind: r.type === 'view' ? 'view' : 'table', columns: [] });
    }
    return { tables: [...tables.values()], defaultSchema: 'main' };
  }

  async ddl(node: SchemaNode): Promise<string> {
    const name = (node.data as { name?: string } | undefined)?.name;
    if (!name) return '';
    const own = this.all('SELECT sql FROM sqlite_master WHERE name = ? AND sql IS NOT NULL', [name]).map((r) => String(r.sql));
    const extra =
      node.kind === 'table'
        ? this.all("SELECT sql FROM sqlite_master WHERE tbl_name = ? AND type IN ('index','trigger') AND sql IS NOT NULL ORDER BY type, name", [name]).map((r) => String(r.sql))
        : [];
    return [...own, ...extra].map((s) => s.trim().replace(/;?$/, ';')).join('\n\n');
  }

  // ---- helpers -----------------------------------------------------------------

  private requireDb(): Database {
    if (!this.db) throw new Error('The database is not open.');
    return this.db;
  }

  private applyPragmas() {
    const db = this.requireDb();
    if (this.opts.readOnly) db.run('PRAGMA query_only = ON');
    if (this.opts.foreignKeys) db.run('PRAGMA foreign_keys = ON');
  }

  private all(sql: string, params: SqlValue[] = []): Record<string, SqlValue>[] {
    const stmt = this.requireDb().prepare(sql);
    try {
      stmt.bind(params);
      const out: Record<string, SqlValue>[] = [];
      while (stmt.step()) out.push(stmt.getAsObject());
      return out;
    } finally {
      stmt.free();
    }
  }

  private scalar(sql: string, params: SqlValue[] = []): SqlValue {
    const row = this.all(sql, params)[0];
    return row ? Object.values(row)[0] : null;
  }

  private snapshot() {
    return { changes: Number(this.scalar('SELECT total_changes()')), schema: Number(this.scalar('PRAGMA schema_version')) };
  }

  /** BEGIN fails inside a transaction (or savepoint); outside, we roll the probe back. */
  private inTransaction(): boolean {
    const db = this.requireDb();
    try {
      db.run('BEGIN');
      db.run('ROLLBACK');
      return false;
    } catch {
      return true;
    }
  }

  private async persist(): Promise<void> {
    const db = this.requireDb();
    if (!this.file || this.opts.readOnly) {
      this.dirty = false;
      return;
    }
    if (this.inTransaction()) return; // db.export() would roll it back; flush after COMMIT
    const file = this.file;

    const st = await fs.promises.stat(file).catch(() => undefined);
    // mtimeMs is undefined when the file did not exist at open; either way it must not have changed since.
    if (st && (this.mtimeMs === undefined || Math.abs(st.mtimeMs - this.mtimeMs) > 1)) {
      throw new Error(
        `"${file}" was modified on disk after it was opened. Your change was applied in memory but NOT saved. Reconnect to reload the file.`,
      );
    }

    const data = db.export(); // closes and reopens the database: pragmas are reset
    this.applyPragmas();

    const real = await fs.promises.realpath(file).catch(() => file);
    const tmp = `${real}.${process.pid}.tmp`;
    await fs.promises.writeFile(tmp, data);
    if (st) await fs.promises.chmod(tmp, st.mode).catch(() => undefined);
    await fs.promises.rename(tmp, real);
    this.mtimeMs = (await fs.promises.stat(file)).mtimeMs;
    this.dirty = false;
  }
}

export class SqliteDriverFactory implements DriverFactory {
  readonly descriptor = sqliteDescriptor;
  private sql?: Promise<SqlJsStatic>;

  private loadSql(): Promise<SqlJsStatic> {
    return (this.sql ??= initSqlJs({ locateFile: locateWasm }));
  }

  create(config: DriverConfig, env: DriverEnvironment): Driver {
    const o = config.options;
    return new SqliteDriver(
      () => this.loadSql(),
      {
        path: String(o.path ?? ''),
        readOnly: o.readOnly === true,
        createIfMissing: o.createIfMissing !== false,
        foreignKeys: o.foreignKeys !== false,
      },
      env,
    );
  }
}
