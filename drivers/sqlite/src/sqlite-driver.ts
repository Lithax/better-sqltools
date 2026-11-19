import * as fs from 'node:fs';
import * as path from 'node:path';
import initSqlJs, { type Database, type SqlJsStatic, type SqlValue } from 'sql.js';
import type { Catalog, CatalogColumn, CatalogTable, Cell, DriverInspection, ForeignKeyRef, InspectItem, SchemaNode } from '../../../src/api';
import type {
  ChildrenOptions, Driver, DriverConfig, DriverEdit, DriverEnvironment, DriverFactory, ExecutionContext, RawStatementResult,
  RowChange, RowChangeResult,
} from '../../../src/api';
import { sqliteDescriptor } from './descriptor';
import { sqliteKind } from './types';

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

/** A value from the grid as SQLite stores it: booleans are 0 and 1, and binary values are not edited here. */
function toSqlValue(v: Cell): SqlValue {
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (typeof v === 'object' && v !== null) throw new Error('Binary values cannot be edited here.');
  return v;
}

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
  private dirtyAtBegin = false;

  /**
   * Editing rows from the grid. Each edit is one parameterised UPDATE inside a savepoint, so a wrong row count or a failed
   * constraint changes nothing. `begin` opens a real transaction that the edits then join; `commit` and `rollback` close it
   * and can be repeated safely.
   */
  readonly edit: DriverEdit = {
    update: (change) => this.updateRow(change),
    begin: () => this.beginEdits(),
    commit: () => this.commitEdits(),
    rollback: () => this.rollbackEdits(),
  };

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

  async children(parent?: SchemaNode, options?: ChildrenOptions): Promise<SchemaNode[]> {
    this.requireDb();
    if (!parent) {
      const count = (types: string[]) =>
        Number(this.scalar(`SELECT count(*) FROM sqlite_master WHERE type IN (${types.map(() => '?').join(',')}) AND name NOT LIKE 'sqlite_%'`, types));
      return [
        { id: 'folder:tables', kind: 'folder', label: 'Tables', count: count(['table']), expandable: true },
        { id: 'folder:views', kind: 'folder', label: 'Views', count: count(['view']), expandable: true },
        { id: 'folder:indexes', kind: 'folder', label: 'Indexes', count: count(['index']), expandable: true },
        { id: 'folder:triggers', kind: 'folder', label: 'Triggers', count: count(['trigger']), expandable: true },
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
          ...(options?.rowCounts ? { rowCount: this.rowCount(String(r.name)) } : {}),
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
      `SELECT m.name AS t, m.type AS k, m.sql AS ddl, p.name AS c, p.type AS ty, p."notnull" AS nn, p.pk AS pk, p.dflt_value AS dv
         FROM sqlite_master m JOIN pragma_table_info(m.name) p
        WHERE m.type IN ('table','view') AND m.name NOT LIKE 'sqlite_%'
        ORDER BY m.name, p.cid`,
    );
    const keyOf = (table: SqlValue, column: SqlValue) => `${table}\u0000${column}`;
    // columns that are unique on their own: a single-column unique constraint or index (the primary key is not repeated here)
    const unique = new Set(
      this.all(
        `SELECT m.name AS t, ii.name AS c
           FROM sqlite_master m JOIN pragma_index_list(m.name) il JOIN pragma_index_info(il.name) ii
          WHERE m.type = 'table' AND m.name NOT LIKE 'sqlite_%'
            AND il."unique" = 1 AND il.partial = 0 AND il.origin <> 'pk'
            AND (SELECT count(*) FROM pragma_index_info(il.name)) = 1`,
      ).map((r) => keyOf(r.t, r.c)),
    );
    const references = new Map<string, ForeignKeyRef>(
      this.all(
        `SELECT m.name AS t, fk."from" AS c, fk."table" AS rt, fk."to" AS rc
           FROM sqlite_master m JOIN pragma_foreign_key_list(m.name) fk
          WHERE m.type = 'table' AND m.name NOT LIKE 'sqlite_%'`,
      ).map((r): [string, ForeignKeyRef] => [keyOf(r.t, r.c), { table: String(r.rt), ...(r.rc ? { column: String(r.rc) } : {}) }]),
    );
    const primaryKeyColumns = new Map<string, number>();
    for (const r of rows) if (Number(r.pk) > 0) primaryKeyColumns.set(String(r.t), (primaryKeyColumns.get(String(r.t)) ?? 0) + 1);

    const tables = new Map<string, CatalogTable>();
    for (const r of rows) {
      const name = String(r.t);
      const isTable = r.k !== 'view';
      let t = tables.get(name);
      if (!t) tables.set(name, (t = { name, qualifiedName: quoteIdent(name), kind: isTable ? 'table' : 'view', columns: [] }));
      const type = r.ty ? String(r.ty) : undefined;
      const primaryKey = Number(r.pk) > 0;
      // a lone INTEGER PRIMARY KEY of a rowid table is the rowid itself: SQLite fills it in and refuses NULL
      const rowidAlias = isTable && primaryKey && primaryKeyColumns.get(name) === 1 && type?.toUpperCase() === 'INTEGER' && !/\)\s*without\s+rowid\b/i.test(String(r.ddl ?? ''));
      const key = keyOf(r.t, r.c);
      const column: CatalogColumn = { name: String(r.c), type, kind: sqliteKind(type), primaryKey, nullable: !Number(r.nn) && !rowidAlias };
      if (unique.has(key)) column.unique = true;
      if (rowidAlias) column.autoIncrement = true;
      if (r.dv !== null && r.dv !== undefined) column.defaultValue = String(r.dv);
      const foreignKey = references.get(key);
      if (foreignKey) column.foreignKey = foreignKey;
      t.columns.push(column);
    }
    // Empty tables/views have no pragma rows; list them anyway.
    for (const r of this.all("SELECT name, type FROM sqlite_master WHERE type IN ('table','view') AND name NOT LIKE 'sqlite_%'")) {
      if (!tables.has(String(r.name))) tables.set(String(r.name), { name: String(r.name), qualifiedName: quoteIdent(String(r.name)), kind: r.type === 'view' ? 'view' : 'table', columns: [] });
    }
    return { tables: [...tables.values()], defaultSchema: 'main' };
  }

  async ping(): Promise<void> {
    this.scalar('SELECT 1');
  }

  async inspect(): Promise<DriverInspection> {
    this.requireDb();
    const pragma = (name: string) => this.scalar(`PRAGMA ${name}`);
    const num = (v: SqlValue) => Number(v ?? 0);
    const pageSize = num(pragma('page_size'));
    const pages = num(pragma('page_count'));
    const free = num(pragma('freelist_count'));
    const objects = (type: string) => num(this.scalar("SELECT count(*) FROM sqlite_master WHERE type = ? AND name NOT LIKE 'sqlite_%'", [type]));

    // health: SQLite's own checks. quick_check skips the index-versus-table comparison, which is plenty here.
    const integrity = this.all('PRAGMA quick_check(5)').map((r) => String(Object.values(r)[0]));
    const intact = integrity.length === 1 && integrity[0] === 'ok';
    const violations = this.all('PRAGMA foreign_key_check').length;
    let onDisk: number | undefined;
    let changedBehindOurBack = false;
    if (this.file) {
      const st = await fs.promises.stat(this.file).catch(() => undefined);
      onDisk = st?.size;
      changedBehindOurBack = !!st && this.mtimeMs !== undefined && Math.abs(st.mtimeMs - this.mtimeMs) > 1;
    }

    const health: DriverInspection['health'] = !intact
      ? { status: 'error', summary: 'The integrity check found problems.' }
      : violations
        ? { status: 'warning', summary: `${violations} foreign key violation${violations === 1 ? '' : 's'}.` }
        : changedBehindOurBack
          ? { status: 'warning', summary: 'The file changed on disk after it was opened; reconnect to reload it.' }
          : { status: 'ok', summary: 'Integrity check passed.' };

    const item = (label: string, value: InspectItem['value'], extra: Partial<InspectItem> = {}): InspectItem => ({ label, value, ...extra });
    return {
      health,
      sections: [
        {
          title: 'Database',
          items: [
            item('SQLite version', String(this.scalar('SELECT sqlite_version()'))),
            item('File', this.file ?? ':memory:'),
            ...(onDisk !== undefined ? [item('Size on disk', Math.round(onDisk / 1024), { unit: 'KB' })] : []),
            item('Size in memory', Math.round((pageSize * pages) / 1024), { unit: 'KB', hint: 'sql.js keeps the whole database in memory.' }),
            item('Access', this.opts.readOnly ? 'read-only' : 'read and write'),
            item('Text encoding', String(pragma('encoding'))),
            item('Page size', pageSize, { unit: 'bytes' }),
            item('Pages', pages, { hint: `${free} of them are free.` }),
            item('Free pages', free, { status: pages && free / pages > 0.5 ? 'warning' : undefined, hint: 'VACUUM gives them back.' }),
            item('user_version', num(pragma('user_version'))),
          ],
        },
        {
          title: 'Objects',
          items: [item('Tables', objects('table')), item('Views', objects('view')), item('Indexes', objects('index')), item('Triggers', objects('trigger'))],
        },
        {
          title: 'Checks',
          items: [
            item('Integrity (quick_check)', intact ? 'ok' : integrity.join('; '), { status: intact ? 'ok' : 'error' }),
            item('Foreign key violations', violations, { status: violations ? 'warning' : 'ok' }),
            item('Foreign keys enforced', num(pragma('foreign_keys')) === 1),
            item('Unsaved changes', this.dirty),
            ...(this.file ? [item('File unchanged on disk', !changedBehindOurBack, { status: changedBehindOurBack ? 'warning' : 'ok' })] : []),
          ],
        },
      ],
    };
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

  // ---- editing -----------------------------------------------------------------

  private async updateRow(change: RowChange): Promise<RowChangeResult> {
    const db = this.requireDb();
    if (this.opts.readOnly) throw new Error('This connection is read-only.');
    if (!change.set.length) throw new Error('There is nothing to change.');
    if (!change.key.length) throw new Error('A row cannot be found without its primary key.');

    const table = (change.table.schema ? `${quoteIdent(change.table.schema)}.` : '') + quoteIdent(change.table.name);
    const where = (key: RowChange['key']) => key.map((k) => `${quoteIdent(k.column)} = ?`).join(' AND ');
    const update =
      `UPDATE ${table} SET ${change.set.map((s) => `${quoteIdent(s.column)} = ?`).join(', ')} WHERE ${where(change.key)}`;
    const params = [...change.set.map((s) => toSqlValue(s.value)), ...change.key.map((k) => toSqlValue(k.value))];

    // A savepoint works inside a transaction (it nests) and outside one (it is the transaction, and RELEASE commits it).
    db.run('SAVEPOINT better_sqltools_edit');
    try {
      db.run(update, params);
      const changed = db.getRowsModified();
      if (changed === 0) throw new Error('No row with this key was found: it may have been changed or deleted since the query ran.');
      if (changed > 1) throw new Error(`This would change ${changed} rows instead of one, so nothing was changed.`);
    } catch (e) {
      try {
        db.run('ROLLBACK TO better_sqltools_edit');
        db.run('RELEASE better_sqltools_edit');
      } catch {
        // the original error is the one to report
      }
      throw e;
    }
    db.run('RELEASE better_sqltools_edit');
    this.dirty = true;

    // what the database now holds: affinity, triggers and defaults may have changed what was typed
    let values: Record<string, unknown> | undefined;
    try {
      const now = new Map(change.set.map((s) => [s.column.toLowerCase(), s.value] as const));
      const key = change.key.map((k) => ({ column: k.column, value: now.has(k.column.toLowerCase()) ? now.get(k.column.toLowerCase())! : k.value }));
      const row = this.all(
        `SELECT ${change.set.map((s) => quoteIdent(s.column)).join(', ')} FROM ${table} WHERE ${where(key)}`,
        key.map((k) => toSqlValue(k.value)),
      )[0];
      if (row) values = Object.fromEntries(change.set.map((s, i) => [s.column, Object.values(row)[i]]));
    } catch {
      values = undefined;
    }

    await this.persist(); // does nothing while a transaction is open: the flush follows the COMMIT
    return { affectedRows: 1, ...(values ? { values } : {}) };
  }

  private async beginEdits(): Promise<void> {
    const db = this.requireDb();
    if (this.inTransaction()) throw new Error('A transaction is already open on this connection.');
    this.dirtyAtBegin = this.dirty;
    db.run('BEGIN');
  }

  private async commitEdits(): Promise<void> {
    const db = this.requireDb();
    if (this.inTransaction()) db.run('COMMIT');
    if (this.dirty) await this.persist();
  }

  private async rollbackEdits(): Promise<void> {
    const db = this.requireDb();
    if (!this.inTransaction()) return;
    db.run('ROLLBACK');
    this.dirty = this.dirtyAtBegin; // what the transaction changed is gone; only an earlier unsaved change can remain
  }

  // ---- helpers -----------------------------------------------------------------

  /** Rows in a table. A count that fails (a broken view, say) just shows nothing. */
  private rowCount(table: string): number | undefined {
    try {
      return Number(this.scalar(`SELECT count(*) FROM ${quoteIdent(table)}`));
    } catch {
      return undefined;
    }
  }

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
