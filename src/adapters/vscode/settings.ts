import * as vscode from 'vscode';
import type { SettingsReader } from '../../application/ports';
import type { SqlfluffOptions } from '../sqlfluff/sqlfluff-linter';

const clamp = (v: unknown, d: number, min: number, max: number) =>
  typeof v === 'number' && Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : d;

export type LintMode = 'onType' | 'onSave' | 'manual';

/** Reads `betterSqlTools.*` live, so setting changes apply without a reload. */
export class VsCodeSettings implements SettingsReader {
  private get cfg() {
    return vscode.workspace.getConfiguration('betterSqlTools');
  }

  maxRows() { return clamp(this.cfg.get('results.maxRows'), 1000, 1, 1_000_000); }
  connectTimeoutMs() { return clamp(this.cfg.get('connection.timeoutMs'), 30_000, 0, 600_000); }
  historyLimit() { return clamp(this.cfg.get('history.maxEntries'), 200, 0, 5000); }
  defaultDialect() { return this.cfg.get<string>('lint.defaultDialect') || 'ansi'; }

  completionEnabled() { return this.cfg.get<boolean>('completion.enabled', true); }
  codeLensEnabled() { return this.cfg.get<boolean>('codeLens.enabled', true); }
  /** Linting runs an external program, so it waits for workspace trust. */
  lintEnabled() { return vscode.workspace.isTrusted && this.cfg.get<boolean>('lint.enabled', true); }
  lintMode(): LintMode { return this.cfg.get<LintMode>('lint.run', 'onSave'); }

  lintSeverity(): vscode.DiagnosticSeverity {
    switch (this.cfg.get<string>('lint.severity', 'warning')) {
      case 'error': return vscode.DiagnosticSeverity.Error;
      case 'information': return vscode.DiagnosticSeverity.Information;
      case 'hint': return vscode.DiagnosticSeverity.Hint;
      default: return vscode.DiagnosticSeverity.Warning;
    }
  }

  sqlfluff(): SqlfluffOptions {
    return {
      command: this.cfg.get<string>('lint.sqlfluffPath') || 'sqlfluff',
      args: this.cfg.get<string[]>('lint.sqlfluffArgs', []),
      timeoutMs: 30_000,
    };
  }
}
