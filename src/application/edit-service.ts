import { editTarget, parseEditValue, type EditTarget } from '../domain/editing';
import { errorMessage } from '../domain/errors';
import type { Cell, ConnectionId, StatementResult } from '../domain/model';
import { toCell } from '../domain/value';
import type { ConnectionManager } from './connection-manager';
import type { Driver } from './ports';
import type { SchemaService } from './schema-service';

/** `autoCommit`: every edit is final at once. `manual`: edits stay pending in a transaction until committed or rolled back. */
export type EditMode = 'autoCommit' | 'manual';

export interface PendingEdit {
  row: number;
  col: number;
  /** What the cell held before the first pending edit of it. */
  before: Cell;
  after: Cell;
}

export type EditOutcome = { ok: true; value: Cell; changed: boolean } | { ok: false; error: string };
export type EndOutcome = { ok: true; count: number; restored: { row: number; col: number; value: Cell }[] } | { ok: false; error: string };

/** What the grid needs to know to offer editing. */
export interface EditStatus {
  /** Any cell at all can be edited. */
  editable: boolean;
  /** Why not, in words for the person. */
  reason?: string;
  /** One entry per result column. */
  columns: { editable: boolean; reason?: string }[];
  /** The mode in effect, which is autoCommit when the driver cannot keep edits pending. */
  mode: EditMode;
  note?: string;
  /** A transaction is open: there is something to commit or roll back. */
  transaction: boolean;
  pending: PendingEdit[];
}

const asNumber = (v: Cell) => (typeof v === 'boolean' ? (v ? 1 : 0) : v);
/** The same value, however it is spelled: true and 1, 5 and "5". */
function sameValue(a: Cell, b: Cell): boolean {
  if (a === null || b === null) return a === b;
  if (typeof a === 'object' || typeof b === 'object') return false;
  return String(asNumber(a)) === String(asNumber(b));
}

const isBlob = (v: Cell) => typeof v === 'object' && v !== null;

/** A connection has one transaction, so the results read from it take turns holding it: the owner has edits waiting. */
export interface TransactionGate {
  owner?: EditSession;
}

interface SessionInit {
  statement: StatementResult;
  target: EditTarget;
  driver?: Driver;
  mode: EditMode;
  reason?: string;
  note?: string;
  gate?: TransactionGate;
}

/**
 * The editing of one result. It works on the result's own rows (the copy the host keeps, which export and copy read),
 * takes the row's key from them and never from the page, and keeps what a rollback has to put back.
 */
export class EditSession {
  private readonly pending: PendingEdit[] = [];
  private txn = false;
  private queue: Promise<unknown> = Promise.resolve();
  private readonly gate: TransactionGate;
  readonly mode: EditMode;

  constructor(private readonly init: SessionInit) {
    this.mode = init.mode;
    this.gate = init.gate ?? {};
  }

  status(): EditStatus {
    const { target, driver, reason, note, statement } = this.init;
    const ok = !!target.table && !!driver?.edit;
    return {
      editable: ok && target.columns.some((c) => c.editable),
      reason: ok ? undefined : reason,
      columns: ok ? target.columns : statement.columns.map(() => ({ editable: false, reason })),
      mode: this.mode,
      note,
      transaction: this.txn,
      pending: this.pending.map((p) => ({ ...p })),
    };
  }

  /** Edits run one at a time, in the order they came. */
  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.queue.then(fn, fn);
    this.queue = next.catch(() => undefined);
    return next;
  }

  /** `input` is what the person typed, or null for NULL. */
  edit(row: number, col: number, input: string | null): Promise<EditOutcome> {
    return this.serial(() => this.doEdit(row, col, input));
  }

  private async doEdit(row: number, col: number, input: string | null): Promise<EditOutcome> {
    const { statement, target, driver } = this.init;
    const edit = driver?.edit;
    if (!edit || !target.table) return { ok: false, error: this.init.reason ?? 'These rows cannot be edited.' };
    const cells = statement.rows[row];
    const column = statement.columns[col];
    if (!Number.isInteger(row) || !Number.isInteger(col) || !cells || !column) return { ok: false, error: 'There is no such cell.' };
    const state = target.columns[col];
    if (!state.editable) return { ok: false, error: state.reason ?? 'This column cannot be edited.' };
    const before = cells[col];
    if (isBlob(before)) return { ok: false, error: 'Binary values cannot be edited here.' };

    const parsed = parseEditValue(column, input);
    if (!parsed.ok) return parsed;
    if (sameValue(before, parsed.value)) return { ok: true, value: before, changed: false };
    if (this.gate.owner && this.gate.owner !== this) {
      return { ok: false, error: 'Another result of this connection has edits waiting. Commit or roll them back first.' };
    }

    // the row is found again by its key, as our copy of the row holds it now
    const key: { column: string; value: Cell }[] = [];
    for (const k of target.keyColumns) {
      const v = cells[k];
      if (v === null || isBlob(v)) return { ok: false, error: 'This row cannot be found again: its primary key is empty or binary.' };
      key.push({ column: statement.columns[k].source!.column, value: v });
    }

    const name = column.source!.column;
    let began = false;
    try {
      if (this.mode === 'manual' && !this.txn) {
        await edit.begin!();
        this.txn = began = true;
        this.gate.owner = this;
      }
      const result = await edit.update({ table: target.table, key, set: [{ column: name, value: parsed.value }] });
      if (result.affectedRows !== 1) throw new Error(`Expected to change one row, the database reports ${result.affectedRows}.`);
      const read = result.values && Object.prototype.hasOwnProperty.call(result.values, name) ? toCell(result.values[name]) : undefined;
      // the database's own word for the value; without one, keep the spelling the column already uses (1 and 0 for a boolean)
      const stored: Cell = read !== undefined ? read : typeof parsed.value === 'boolean' && typeof before === 'number' ? Number(parsed.value) : parsed.value;
      cells[col] = stored;
      if (this.mode === 'manual') this.remember(row, col, before, stored);
      return { ok: true, value: stored, changed: true };
    } catch (e) {
      if (began) {
        // the transaction was opened for this edit alone: do not leave an empty one behind
        this.txn = false;
        this.gate.owner = undefined;
        await edit.rollback!().catch(() => undefined);
      }
      return { ok: false, error: errorMessage(e) };
    }
  }

  private remember(row: number, col: number, before: Cell, after: Cell) {
    const i = this.pending.findIndex((p) => p.row === row && p.col === col);
    if (i < 0) this.pending.push({ row, col, before, after });
    else if (sameValue(this.pending[i].before, after)) this.pending.splice(i, 1); // back where it began
    else this.pending[i] = { ...this.pending[i], after };
  }

  /** Makes every pending edit final. */
  commit(): Promise<EndOutcome> {
    return this.serial(async () => {
      const edit = this.init.driver?.edit;
      if (!this.txn || !edit?.commit) return { ok: true, count: 0, restored: [] };
      try {
        await edit.commit();
      } catch (e) {
        return { ok: false, error: errorMessage(e) };
      }
      const count = this.pending.length;
      this.txn = false;
      this.gate.owner = undefined;
      this.pending.length = 0;
      return { ok: true, count, restored: [] };
    });
  }

  /** Undoes every pending edit, in the database and in the rows. `restored` lists the cells that changed back. */
  rollback(): Promise<EndOutcome> {
    return this.serial(async () => {
      const edit = this.init.driver?.edit;
      if (!this.txn || !edit?.rollback) return { ok: true, count: 0, restored: [] };
      try {
        await edit.rollback();
      } catch (e) {
        return { ok: false, error: errorMessage(e) };
      }
      const restored: { row: number; col: number; value: Cell }[] = [];
      for (const p of [...this.pending].reverse()) {
        this.init.statement.rows[p.row][p.col] = p.before;
        restored.push({ row: p.row, col: p.col, value: p.before });
      }
      const count = this.pending.length;
      this.txn = false;
      this.gate.owner = undefined;
      this.pending.length = 0;
      return { ok: true, count, restored };
    });
  }
}

export class EditService {
  /** One gate per open connection (not per id: a reconnect is a new session and starts clean). */
  private readonly gates = new WeakMap<object, TransactionGate>();

  constructor(private readonly deps: { connections: ConnectionManager; schema: SchemaService }) {}

  /**
   * Starts editing one statement's result. Nothing is changed by opening it: the session only works out which cells can be
   * edited (from what the driver reported about the columns and the table) and with what.
   */
  async open(connectionId: ConnectionId, statement: StatementResult, requested: EditMode): Promise<EditSession> {
    const session = this.deps.connections.session(connectionId);
    const unavailable = (reason: string): EditSession =>
      new EditSession({ statement, target: editTarget([], undefined), mode: 'autoCommit', reason });
    if (!session) return unavailable('The connection is closed. Run the query again to edit its rows.');

    const catalog = await this.deps.schema.catalogSoon(connectionId, 3000);
    const target = editTarget(statement.columns, catalog);
    const driver = session.driver;
    let gate = this.gates.get(session);
    if (!gate) this.gates.set(session, (gate = {}));
    if (target.table && !driver.edit) {
      const reason = `${session.descriptor.displayName} cannot edit rows: its driver does not support it.`;
      return new EditSession({ statement, target: { ...target, table: undefined, reason }, driver, mode: 'autoCommit', reason });
    }
    const transactions = !!(driver.edit?.begin && driver.edit.commit && driver.edit.rollback);
    const mode: EditMode = requested === 'manual' && transactions ? 'manual' : 'autoCommit';
    return new EditSession({
      statement, target, driver, mode, gate, reason: target.reason,
      note: requested === 'manual' && !transactions ? 'This driver cannot keep edits pending, so each edit is saved at once.' : undefined,
    });
  }
}
