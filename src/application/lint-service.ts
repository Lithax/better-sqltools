import type { ConnectionId, LintIssue } from '../domain/model';
import type { ConnectionManager } from './connection-manager';
import type { Linter, SettingsReader } from './ports';

export interface LintInput {
  text: string;
  connectionId?: ConnectionId;
  cwd?: string;
  signal?: AbortSignal;
}

/** Linting and fixing in the dialect of the document's connection. */
export class LintService {
  constructor(
    private readonly linter: Linter,
    private readonly connections: ConnectionManager,
    private readonly settings: SettingsReader,
  ) {}

  dialectFor(connectionId?: ConnectionId): string {
    const info = connectionId ? this.connections.info(connectionId) : undefined;
    return info?.descriptor?.dialect.sqlfluff ?? this.settings.defaultDialect();
  }

  lint(i: LintInput): Promise<LintIssue[]> {
    return this.linter.lint({ text: i.text, dialect: this.dialectFor(i.connectionId), cwd: i.cwd, signal: i.signal });
  }

  fix(i: LintInput): Promise<string> {
    return this.linter.fix({ text: i.text, dialect: this.dialectFor(i.connectionId), cwd: i.cwd, signal: i.signal });
  }

  format(i: LintInput): Promise<string> {
    return this.linter.format({ text: i.text, dialect: this.dialectFor(i.connectionId), cwd: i.cwd, signal: i.signal });
  }
}
