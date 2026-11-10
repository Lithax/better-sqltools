/**
 * Ports: everything the application core needs from the outside world.
 *
 *   Driver / DriverFactory   - the extension point. Implemented by database drivers,
 *                              built in or contributed by other VS Code extensions.
 *   everything else          - implemented by the host adapter (VS Code) or by tests.
 */
import type { ConnectionGroup } from '../domain/model';
import type { ConnectionField, DriverDescriptor, DriverIcon } from '../domain/driver-descriptor';
import type {
  Catalog, Column, ConnectionId, ConnectionProfile, DriverInspection, HistoryEntry, LintIssue, SchemaNode,
} from '../domain/model';
import type { Event } from './events';

// ---- driver SPI ------------------------------------------------------------

export interface ExecutionContext {
  /** Stop reading rows after this many and report `truncated`. */
  maxRows: number;
  signal?: AbortSignal;
}

export interface RawStatementResult {
  columns: Column[];
  /** Raw driver values. The core makes them JSON-safe, so bigint/Date/Buffer are fine. */
  rows: unknown[][];
  truncated?: boolean;
  affectedRows?: number;
  notices?: string[];
}

export interface Driver {
  open(): Promise<void>;
  close(): Promise<void>;
  /** Execute exactly one statement; the core already split the script. */
  execute(sql: string, ctx: ExecutionContext): Promise<RawStatementResult>;
  /** Children of `parent`, or the top level when undefined. `options` are hints a driver may ignore. */
  children(parent?: SchemaNode, options?: ChildrenOptions): Promise<SchemaNode[]>;
  /** Optional bulk snapshot for completion. Without it the core walks `children`. */
  catalog?(): Promise<Catalog>;
  /** Optional: CREATE statement for a node. */
  ddl?(node: SchemaNode): Promise<string>;
  /** Optional: a cheap round trip, so the core can time the connection. */
  ping?(): Promise<void>;
  /** Optional: version, size, settings and health checks for the "Inspect connection" view. */
  inspect?(): Promise<DriverInspection>;
}

export interface DriverConfig {
  /** Validated, defaults applied, `${variables}` resolved. Never contains secrets. */
  options: Record<string, unknown>;
  /** Values of the descriptor's `password` fields. */
  secrets: Record<string, string>;
}

export interface DriverEnvironment {
  logger: Logger;
  /** Expands `~`, `${workspaceFolder}`... and resolves relative paths against the workspace. */
  resolvePath(p: string): string;
}

export interface DriverFactory {
  readonly descriptor: DriverDescriptor;
  create(config: DriverConfig, env: DriverEnvironment): Driver | Promise<Driver>;
}

// ---- driven ports ------------------------------------------------------------

/** A driver that an installed extension declares in its package.json (`betterSqlTools.drivers`). */
export interface InstalledDriver {
  id: string;
  name: string;
  description?: string;
  icon?: DriverIcon;
  /** The extension that provides it, e.g. "better-sqltools.better-sqltools-sqlite". */
  extensionId: string;
  /** The extension's folder as a URI string; relative icon paths are resolved against it. */
  baseUri?: string;
  version?: string;
}

/** How the core finds and wakes driver extensions. Implemented by the host (VS Code) adapter. */
export interface DriverExtensionHost {
  list(): InstalledDriver[];
  /** Activates the extension; resolves once its activate() returned, rejects if it threw. */
  activate(extensionId: string): Promise<void>;
  readonly onDidChange: Event<void>;
}

export interface Logger {
  debug(message: string, ...args: unknown[]): void;
  info(message: string, ...args: unknown[]): void;
  warn(message: string, ...args: unknown[]): void;
  error(message: string, ...args: unknown[]): void;
}

export interface ProfileRepository {
  list(): ConnectionProfile[];
  save(profile: ConnectionProfile): Promise<void>;
  remove(id: ConnectionId): Promise<void>;
  readonly onDidChange: Event<void>;
}

export interface SecretStore {
  get(profileId: ConnectionId, key: string): Promise<string | undefined>;
  set(profileId: ConnectionId, key: string, value: string): Promise<void>;
  deleteAll(profileId: ConnectionId): Promise<void>;
}

export interface SecretPrompter {
  /** Resolves to undefined when the user dismisses the prompt. */
  prompt(args: { profileName: string; field: ConnectionField }): Promise<string | undefined>;
}

export interface HistoryRepository {
  add(entry: HistoryEntry): Promise<void>;
  list(): HistoryEntry[];
  clear(): Promise<void>;
}

export interface SettingsReader {
  maxRows(): number;
  connectTimeoutMs(): number;
  historyLimit(): number;
  defaultDialect(): string;
  /** Ask drivers for the row count of every table they list (can be slow on big tables). */
  showRowCounts(): boolean;
}

export interface LintRequest {
  text: string;
  /** sqlfluff dialect id. */
  dialect: string;
  cwd?: string;
  signal?: AbortSignal;
}

export interface Linter {
  lint(req: LintRequest): Promise<LintIssue[]>;
  /** Apply every auto-fixable rule; resolves to the fixed text. */
  fix(req: LintRequest): Promise<string>;
  /** Layout-only formatting; resolves to the formatted text. */
  format(req: LintRequest): Promise<string>;
}

// ---- project configuration ---------------------------------------------------

/** One TOML file of a project (.better-sqltools.toml, or a file in .better-sqltools/). */
export interface ProjectConfigFile {
  /** Where it lives (a URI string). Issues point at it. */
  id: string;
  /** Files of one workspace folder share a key, which keeps their connection ids apart from other projects'. */
  scopeKey: string;
  /** For humans: ".better-sqltools.toml" or ".better-sqltools/dev.toml". */
  label: string;
  text: string;
}

/** Where project config files come from. Implemented by the host (VS Code) adapter. */
export interface ProjectConfigSource {
  /** Every config file of every workspace folder: folders in order; per folder the root file, then the directory's files by name. */
  read(): Promise<ProjectConfigFile[]>;
  readonly onDidChange: Event<void>;
}

/** Parses TOML text. Kept out of the core so the core has no dependencies. */
export type ParseToml = (text: string) => { value?: unknown; error?: { message: string; line?: number } };

/** Groups saved in user or workspace settings. Project files define their own. */
export interface StoredGroup extends ConnectionGroup {
  scope: 'user' | 'workspace';
}

export interface GroupRepository {
  list(): StoredGroup[];
  save(group: ConnectionGroup, scope: 'user' | 'workspace'): Promise<void>;
  remove(id: string): Promise<void>;
  readonly onDidChange: Event<void>;
}

/** Hints for `Driver.children`. A driver may ignore them. */
export interface ChildrenOptions {
  /** Fill in `SchemaNode.rowCount` for tables. */
  rowCounts?: boolean;
}
