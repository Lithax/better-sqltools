import * as vscode from 'vscode';
import type { SettingsReader } from '../../application/ports';
import type { SqlfluffOptions } from '../sqlfluff/sqlfluff-linter';

const clamp = (v: unknown, d: number, min: number, max: number) =>
  typeof v === 'number' && Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : d;

export type LintMode = 'onType' | 'onSave' | 'manual';

/**
 * Reads `betterSqlTools.*` live, so setting changes apply without a reload. Values a project's TOML file sets
 * (`[settings]`) win over VS Code's user and workspace settings; `overlay` supplies them.
 */
export class VsCodeSettings implements SettingsReader {
  constructor(private readonly overlay: () => Record<string, unknown> = () => ({})) {}

  private get cfg() {
    return vscode.workspace.getConfiguration('betterSqlTools');
  }

  /** `key` is the setting without the "betterSqlTools." prefix. */
  private get<T>(key: string, fallback?: T): T | undefined {
    const o = this.overlay();
    if (Object.prototype.hasOwnProperty.call(o, key)) return o[key] as T;
    return fallback === undefined ? this.cfg.get<T>(key) : this.cfg.get<T>(key, fallback);
  }

  maxRows() { return clamp(this.get('results.maxRows'), 1000, 1, 1_000_000); }
  connectTimeoutMs() { return clamp(this.get('connection.timeoutMs'), 30_000, 0, 600_000); }
  historyLimit() { return clamp(this.get('history.maxEntries'), 200, 0, 5000); }
  defaultDialect() { return this.get<string>('lint.defaultDialect') || 'ansi'; }

  completionEnabled() { return this.get<boolean>('completion.enabled', true) !== false; }
  codeLensEnabled() { return this.get<boolean>('codeLens.enabled', true) !== false; }
  /** Linting runs an external program, so it waits for workspace trust. */
  lintEnabled() { return vscode.workspace.isTrusted && this.get<boolean>('lint.enabled', true) !== false; }
  lintMode(): LintMode { return this.get<LintMode>('lint.run', 'onSave') as LintMode; }

  lintSeverity(): vscode.DiagnosticSeverity {
    switch (this.get<string>('lint.severity', 'warning')) {
      case 'error': return vscode.DiagnosticSeverity.Error;
      case 'information': return vscode.DiagnosticSeverity.Information;
      case 'hint': return vscode.DiagnosticSeverity.Hint;
      default: return vscode.DiagnosticSeverity.Warning;
    }
  }

  sqlfluff(): SqlfluffOptions {
    const args = this.get<unknown>('lint.sqlfluffArgs', []);
    return {
      command: this.get<string>('lint.sqlfluffPath') || 'sqlfluff',
      args: Array.isArray(args) ? args.filter((a): a is string => typeof a === 'string') : [],
      timeoutMs: 30_000,
    };
  }
}
