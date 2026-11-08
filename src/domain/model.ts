export type ConnectionId = string;
export type ProfileScope = 'user' | 'workspace';

/** A saved connection. Secrets are never part of it; they live in a SecretStore. */
export interface ConnectionProfile {
  id: ConnectionId;
  name: string;
  /** DriverDescriptor.id of the driver that handles this connection. */
  driver: string;
  /** Non-secret options, shaped by the driver's connectionSchema. */
  options: Record<string, unknown>;
  scope?: ProfileScope;
}

// ---- query results -------------------------------------------------------

/** Binary values are truncated for transport; `bytes` is the real length. */
export interface CellBlob {
  $blob: string; // hex of the first bytes
  bytes: number;
}
/** Everything a result cell can be once it crossed the driver boundary. JSON-safe. */
export type Cell = null | string | number | boolean | CellBlob;

export interface Column {
  name: string;
  type?: string;
}

export interface QueryError {
  message: string;
  code?: string;
}

export interface StatementResult {
  index: number;
  sql: string;
  columns: Column[];
  rows: Cell[][];
  /** The driver stopped early because maxRows was reached. */
  truncated: boolean;
  affectedRows?: number;
  notices?: string[];
  durationMs: number;
  error?: QueryError;
}

export interface RunResult {
  connectionId: ConnectionId;
  connectionName: string;
  driverName: string;
  startedAt: number;
  durationMs: number;
  statements: StatementResult[];
  /** Statements executed but left out of `statements` to keep huge scripts light. */
  omitted: number;
  cancelled: boolean;
}

// ---- schema --------------------------------------------------------------

export type NodeKind =
  | 'database'
  | 'schema'
  | 'folder'
  | 'table'
  | 'view'
  | 'column'
  | 'index'
  | 'trigger'
  | 'routine'
  | 'sequence'
  | 'other';

export interface SchemaNode {
  /** Unique within one connection. Opaque to the core. */
  id: string;
  kind: NodeKind;
  label: string;
  description?: string;
  tooltip?: string;
  expandable: boolean;
  /** Tables/views: a fully qualified, already quoted name that can be pasted into SQL. */
  qualifiedName?: string;
  primaryKey?: boolean;
  /** Driver-private payload; handed back to the driver untouched. */
  data?: unknown;
}

export interface CatalogColumn {
  name: string;
  type?: string;
  primaryKey?: boolean;
  nullable?: boolean;
}
export interface CatalogTable {
  schema?: string;
  name: string;
  kind: 'table' | 'view';
  columns: CatalogColumn[];
}
/** A flat, searchable snapshot of the database used by completion. */
export interface Catalog {
  tables: CatalogTable[];
  schemas?: string[];
  defaultSchema?: string;
}

// ---- history / linting -----------------------------------------------------

export interface HistoryEntry {
  id: string;
  sql: string;
  connectionId: ConnectionId;
  connectionName: string;
  at: number;
  durationMs: number;
  ok: boolean;
}

export type LintSeverity = 'error' | 'warning' | 'info';

export interface LintIssue {
  /** 1-based. */
  line: number;
  column: number;
  endLine?: number;
  endColumn?: number;
  code: string;
  message: string;
  rule?: string;
  severity: LintSeverity;
  fixable: boolean;
}
