export type ConnectionId = string;
/** Where a connection is stored: user or workspace settings, or a project config file (read-only). */
export type ProfileScope = 'user' | 'workspace' | 'project';

/** A saved connection. Secrets are never part of it; they live in a SecretStore. */
export interface ConnectionProfile {
  id: ConnectionId;
  name: string;
  /** DriverDescriptor.id of the driver that handles this connection. */
  driver: string;
  /** Non-secret options, shaped by the driver's connectionSchema. */
  options: Record<string, unknown>;
  scope?: ProfileScope;
  /** The group (project) it is listed under, by id. */
  group?: string;
  /** The config file it comes from (a URI string); only for scope "project". */
  file?: string;
}

// ---- query results -------------------------------------------------------

/** Binary values are truncated for transport; `bytes` is the real length. */
export interface CellBlob {
  $blob: string; // hex of the first bytes
  bytes: number;
}
/** Everything a result cell can be once it crossed the driver boundary. JSON-safe. */
export type Cell = null | string | number | boolean | CellBlob;

/**
 * How a driver says the values of a column should be treated (aligned, coloured, validated). It is the driver's call:
 * only it knows that its `NUMBER(10,2)` is a decimal and its `TINYINT(1)` a boolean.
 */
export type ColumnKind = 'integer' | 'decimal' | 'text' | 'boolean' | 'datetime' | 'binary' | 'json' | 'other';

/** What a foreign key column points at. */
export interface ForeignKeyRef {
  schema?: string;
  table: string;
  column?: string;
}

/** The table column a result column is read from. */
export interface ColumnSource {
  schema?: string;
  table: string;
  column: string;
}

/**
 * A result column. Only `name` is certain; everything else is what the driver (or the catalog, for columns that map
 * straight to a table column) knows, so any of it may be missing.
 */
export interface Column {
  name: string;
  /** The type as the database spells it: `VARCHAR(30)`, `INTEGER`... */
  type?: string;
  kind?: ColumnKind;
  notNull?: boolean;
  primaryKey?: boolean;
  unique?: boolean;
  /** The database fills the value in when it is left out (identity, serial, rowid alias...). */
  autoIncrement?: boolean;
  /** The default as the database prints it. */
  defaultValue?: string;
  foreignKey?: ForeignKeyRef;
  /** Set when the column is known to be read straight from a table column. */
  source?: ColumnSource;
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
  /** Folders and other containers: how many objects are inside. Shown next to the label when the user wants counts. */
  count?: number;
  /** Tables: how many rows. Only filled in when the core asks for row counts (`ChildrenOptions.rowCounts`). */
  rowCount?: number;
  /** Driver-private payload; handed back to the driver untouched. */
  data?: unknown;
}

export interface CatalogColumn {
  name: string;
  type?: string;
  kind?: ColumnKind;
  primaryKey?: boolean;
  nullable?: boolean;
  /** Unique on its own (a single-column unique constraint or index), not as part of a composite one. */
  unique?: boolean;
  autoIncrement?: boolean;
  defaultValue?: string;
  foreignKey?: ForeignKeyRef;
}
export interface CatalogTable {
  schema?: string;
  name: string;
  /** A fully qualified, already quoted name that can be pasted into SQL. Falls back to `name`. */
  qualifiedName?: string;
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

/** A saved query. */
export interface Bookmark {
  id: string;
  name: string;
  sql: string;
  /** The connection it was saved from; the one it runs on by default when that still exists. */
  connectionId?: ConnectionId;
  createdAt: number;
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

/** A named folder for connections: "personal", "global", "arom-backend". */
export interface ConnectionGroup {
  id: string;
  name: string;
  description?: string;
  /** A codicon id, e.g. "server". */
  icon?: string;
  /** A theme colour id, e.g. "charts.blue". */
  color?: string;
}

// ---- inspecting a connection ----------------------------------------------------

export type HealthStatus = 'ok' | 'warning' | 'error';

export interface InspectItem {
  label: string;
  value: string | number | boolean | null;
  /** Shown after the value: "ms", "MB", "pages". */
  unit?: string;
  status?: HealthStatus;
  /** A tooltip. */
  hint?: string;
}

export interface InspectSection {
  title: string;
  items: InspectItem[];
}

/** What a driver can tell about the database behind a connection: version, size, settings, health checks. */
export interface DriverInspection {
  health: { status: HealthStatus; summary: string };
  sections: InspectSection[];
}

/** What the core measures itself, for every driver, since the session began. */
export interface SessionStats {
  connectedAt: number;
  statements: number;
  errors: number;
  rows: number;
  totalMs: number;
  lastMs?: number;
  lastAt?: number;
  lastError?: string;
}
