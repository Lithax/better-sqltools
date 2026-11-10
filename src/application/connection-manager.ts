import type { DriverDescriptor } from '../domain/driver-descriptor';
import {
  BetterSqlToolsError, CancelledError, ValidationError, errorMessage,
} from '../domain/errors';
import type { ConnectionId, ConnectionProfile, DriverInspection, SessionStats } from '../domain/model';
import { normalizeOptions } from '../domain/validation';
import type { DriverRegistry } from './driver-registry';
import { Emitter } from './events';
import type {
  Driver, DriverEnvironment, Logger, ProfileRepository, SecretPrompter, SecretStore, SettingsReader,
} from './ports';

export type ConnectionState = 'disconnected' | 'connecting' | 'connected' | 'error';

export interface ConnectionInfo {
  profile: ConnectionProfile;
  state: ConnectionState;
  error?: string;
  /** Undefined when the profile's driver is not installed. */
  descriptor?: DriverDescriptor;
}

export interface Session {
  profile: ConnectionProfile;
  descriptor: DriverDescriptor;
  driver: Driver;
  connectedAt: number;
  /** Counters the core keeps for every driver; see `inspect`. */
  stats: SessionStats;
}

/** What "Inspect connection" shows: what the core measured, plus what the driver can tell. */
export interface ConnectionInspection {
  id: ConnectionId;
  name: string;
  driverId: string;
  driverName: string;
  uptimeMs: number;
  stats: SessionStats;
  /** A timed round trip, for drivers that can `ping`. */
  pingMs?: number;
  driver?: DriverInspection;
  /** The driver has `inspect` but it threw. */
  driverError?: string;
}

/** A not-yet-saved connection, e.g. from the form's "Test connection" button. */
export interface DraftConnection {
  profile: ConnectionProfile;
  /** Secrets typed by the user. Anything missing falls back to the SecretStore. */
  secrets?: Record<string, string>;
}

export interface ConnectionEvent {
  id?: ConnectionId;
  state?: ConnectionState;
}

export interface ConnectionManagerDeps {
  registry: DriverRegistry;
  profiles: ProfileRepository;
  secrets: SecretStore;
  prompter: SecretPrompter;
  settings: SettingsReader;
  logger: Logger;
  env: DriverEnvironment;
  /** Expands `${workspaceFolder}`, `${env:NAME}`... in string options. */
  resolveVariables(input: string): string;
}

function withTimeout<T>(p: Promise<T>, ms: number, message: string): Promise<T> {
  if (!(ms > 0)) return p;
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new BetterSqlToolsError(message, 'TIMEOUT')), ms);
  });
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer));
}

export class ConnectionManager {
  private readonly sessions = new Map<ConnectionId, Session>();
  private readonly pending = new Map<ConnectionId, Promise<Session>>();
  private readonly failures = new Map<ConnectionId, string>();
  private readonly connecting = new Set<ConnectionId>();
  private readonly changed = new Emitter<ConnectionEvent>();
  readonly onDidChange = this.changed.event;

  constructor(private readonly deps: ConnectionManagerDeps) {
    deps.profiles.onDidChange(() => this.reconcile());
    deps.registry.onDidChange(() => this.changed.fire({}));
  }

  list(): ConnectionInfo[] {
    return this.deps.profiles
      .list()
      .map((p) => this.describe(p))
      .sort((a, b) => a.profile.name.localeCompare(b.profile.name));
  }

  info(id: ConnectionId): ConnectionInfo | undefined {
    const p = this.deps.profiles.list().find((x) => x.id === id);
    return p ? this.describe(p) : undefined;
  }

  /** Called by the query service after every statement, for the numbers "Inspect connection" shows. */
  recordStatement(id: ConnectionId, r: { ms: number; rows: number; error?: string }): void {
    const st = this.sessions.get(id)?.stats;
    if (!st) return;
    st.statements++;
    st.rows += r.rows;
    st.totalMs += r.ms;
    st.lastMs = r.ms;
    st.lastAt = Date.now();
    if (r.error !== undefined) {
      st.errors++;
      st.lastError = r.error;
    }
  }

  /** Only for a connection that is open: this never connects on its own. */
  async inspect(id: ConnectionId): Promise<ConnectionInspection> {
    const s = this.sessions.get(id);
    if (!s) throw new BetterSqlToolsError('This connection is not open. Connect first.', 'NOT_CONNECTED');
    let pingMs: number | undefined;
    if (s.driver.ping) {
      const t = performance.now();
      try {
        await s.driver.ping();
        pingMs = performance.now() - t;
      } catch {
        // a failing ping shows up as a missing value; the driver's own inspection usually says why
      }
    }
    let driver: DriverInspection | undefined;
    let driverError: string | undefined;
    if (s.driver.inspect) {
      try {
        driver = await s.driver.inspect();
      } catch (e) {
        driverError = errorMessage(e);
      }
    }
    return {
      id,
      name: s.profile.name,
      driverId: s.profile.driver,
      driverName: s.descriptor.displayName,
      uptimeMs: Date.now() - s.stats.connectedAt,
      stats: { ...s.stats },
      pingMs,
      driver,
      driverError,
    };
  }

  session(id: ConnectionId): Session | undefined {
    return this.sessions.get(id);
  }

  /** The session, connecting first when needed. */
  ensure(id: ConnectionId): Promise<Session> {
    const s = this.sessions.get(id);
    return s ? Promise.resolve(s) : this.connect(id);
  }

  connect(id: ConnectionId): Promise<Session> {
    const existing = this.sessions.get(id);
    if (existing) return Promise.resolve(existing);
    const inflight = this.pending.get(id);
    if (inflight) return inflight;
    const p = this.doConnect(id).finally(() => this.pending.delete(id));
    this.pending.set(id, p);
    return p;
  }

  async disconnect(id: ConnectionId): Promise<void> {
    const s = this.sessions.get(id);
    this.failures.delete(id);
    if (!s) return;
    this.sessions.delete(id);
    try {
      await s.driver.close();
    } catch (e) {
      this.deps.logger.warn(`Error while closing "${s.profile.name}": ${errorMessage(e)}`);
    }
    this.changed.fire({ id, state: 'disconnected' });
  }

  async disconnectAll(): Promise<void> {
    await Promise.all([...this.sessions.keys()].map((id) => this.disconnect(id)));
  }

  /** Opens and immediately closes a connection. Throws with a readable message on failure. */
  async test(draft: DraftConnection): Promise<void> {
    const { driver } = await this.openDriver(draft.profile, draft.secrets ?? {});
    await driver.close();
  }

  // ---- internals -------------------------------------------------------------

  private describe(profile: ConnectionProfile): ConnectionInfo {
    const state: ConnectionState = this.sessions.has(profile.id)
      ? 'connected'
      : this.connecting.has(profile.id)
        ? 'connecting'
        : this.failures.has(profile.id)
          ? 'error'
          : 'disconnected';
    return {
      profile,
      state,
      error: this.failures.get(profile.id),
      descriptor: this.deps.registry.get(profile.driver)?.descriptor,
    };
  }

  private emit(id: ConnectionId, state: ConnectionState) {
    this.changed.fire({ id, state });
  }

  private async doConnect(id: ConnectionId): Promise<Session> {
    const profile = this.deps.profiles.list().find((p) => p.id === id);
    if (!profile) throw new BetterSqlToolsError(`Unknown connection "${id}".`, 'UNKNOWN_CONNECTION');

    this.failures.delete(id);
    this.connecting.add(id);
    this.emit(id, 'connecting');
    try {
      const { driver, descriptor } = await this.openDriver(profile, {});
      const connectedAt = Date.now();
      const session: Session = {
        profile, descriptor, driver, connectedAt,
        stats: { connectedAt, statements: 0, errors: 0, rows: 0, totalMs: 0 },
      };
      this.sessions.set(id, session);
      this.connecting.delete(id);
      this.deps.logger.info(`Connected to "${profile.name}" (${descriptor.displayName}).`);
      this.emit(id, 'connected');
      return session;
    } catch (e) {
      this.connecting.delete(id);
      if (e instanceof CancelledError) {
        this.emit(id, 'disconnected');
      } else {
        this.failures.set(id, errorMessage(e));
        this.deps.logger.error(`Connecting to "${profile.name}" failed: ${errorMessage(e)}`);
        this.emit(id, 'error');
      }
      throw e;
    }
  }

  private async openDriver(profile: ConnectionProfile, typedSecrets: Record<string, string>) {
    const factory = await this.deps.registry.ensure(profile.driver);
    const descriptor = factory.descriptor;

    const { options, problems } = normalizeOptions(descriptor, profile.options);
    if (problems.length) throw new ValidationError(problems);
    const resolved: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(options)) {
      resolved[k] = typeof v === 'string' ? this.deps.resolveVariables(v) : v;
    }
    for (const f of descriptor.connectionSchema) if (f.type === 'password') delete resolved[f.key];

    const secrets = await this.collectSecrets(profile, descriptor, typedSecrets);
    const driver = await factory.create({ options: resolved, secrets }, this.deps.env);
    try {
      await withTimeout(
        driver.open(),
        this.deps.settings.connectTimeoutMs(),
        `Timed out connecting to "${profile.name}".`,
      );
    } catch (e) {
      await driver.close().catch(() => undefined);
      throw e;
    }
    return { driver, descriptor };
  }

  /** typed value → stored secret → value written inline in settings or a project file (variables expanded) → prompt. */
  private async collectSecrets(
    profile: ConnectionProfile,
    descriptor: DriverDescriptor,
    typed: Record<string, string>,
  ): Promise<Record<string, string>> {
    const out: Record<string, string> = {};
    for (const f of descriptor.connectionSchema) {
      if (f.type !== 'password') continue;
      const inline = profile.options[f.key];
      const fromSettings = typeof inline === 'string' ? this.deps.resolveVariables(inline) : undefined;
      // "${env:UNSET}" must prompt, not become an empty password
      let v: string | undefined = typed[f.key] ?? (await this.deps.secrets.get(profile.id, f.key)) ?? (fromSettings === '' && inline !== '' ? undefined : fromSettings);
      if (v === undefined && f.required) {
        v = await this.deps.prompter.prompt({ profileName: profile.name, field: f });
        if (v === undefined) throw new CancelledError();
      }
      if (v !== undefined) out[f.key] = v;
    }
    return out;
  }

  /** Profiles changed on disk or in the UI: drop sessions whose profile vanished or changed. */
  private reconcile() {
    const profiles = new Map(this.deps.profiles.list().map((p) => [p.id, p]));
    for (const [id, s] of this.sessions) {
      const now = profiles.get(id);
      if (!now || JSON.stringify([now.driver, now.options]) !== JSON.stringify([s.profile.driver, s.profile.options])) {
        void this.disconnect(id);
      }
    }
    this.changed.fire({});
  }
}
