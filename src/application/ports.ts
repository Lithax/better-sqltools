/**
 * Ports: everything the application core needs from the outside world.
 *
 *   Driver / DriverFactory   - the extension point. Implemented by database drivers,
 *                              built in or contributed by other VS Code extensions.
 *   everything else          - implemented by the host adapter (VS Code) or by tests.
 */
import type { ConnectionField, DriverDescriptor, DriverIcon } from '../domain/driver-descriptor';
import type {
  Catalog, Column, ConnectionId, ConnectionProfile, HistoryEntry, LintIssue, SchemaNode,
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
  /** Children of `parent`, or the top level when undefined. */
  children(parent?: SchemaNode): Promise<SchemaNode[]>;
  /** Optional bulk snapshot for completion. Without it the core walks `children`. */
  catalog?(): Promise<Catalog>;
  /** Optional: CREATE statement for a node. */
  ddl?(node: SchemaNode): Promise<string>;
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
