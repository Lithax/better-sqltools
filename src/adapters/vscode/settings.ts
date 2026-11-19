import * as vscode from 'vscode';
import type { EditMode } from '../../application/edit-service';
import type { SettingsReader } from '../../application/ports';
import type { SqlfluffOptions } from '../sqlfluff/sqlfluff-linter';

const clamp = (v: unknown, d: number, min: number, max: number) =>
  typeof v === 'number' && Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : d;

export type LintMode = 'onType' | 'onSave' | 'manual';

export type ColumnFit = 'fitAll' | 'fitName' | 'fitNameAndValue';

export type { EditMode };

/** How the results grid looks and sizes itself. */
export interface ResultsPrefs {
  columnFit: ColumnFit;
  /** The data type next to each column's name. */
  showTypes: boolean;
  /** Values and headers coloured and styled by data type and constraints. */
  colorByType: boolean;
  /** How edits made in the grid are saved. */
  editMode: EditMode;
}

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

  resultsPrefs(): ResultsPrefs {
    const fit = this.get<string>('results.columnFit', 'fitNameAndValue');
    return {
      columnFit: fit === 'fitAll' || fit === 'fitName' ? fit : 'fitNameAndValue',
      showTypes: this.get<boolean>('results.showTypes', true) !== false,
      colorByType: this.get<boolean>('results.colorByType', true) !== false,
      editMode: this.get<string>('results.editMode', 'autoCommit') === 'manual' ? 'manual' : 'autoCommit',
    };
  }

  /** The grid's column menu writes the user's choice back, so the setting stays the one source of truth. */
  async setResultsColumnFit(mode: ColumnFit): Promise<void> {
    await this.cfg.update('results.columnFit', mode, vscode.ConfigurationTarget.Global);
  }
  connectTimeoutMs() { return clamp(this.get('connection.timeoutMs'), 30_000, 0, 600_000); }
  historyLimit() { return clamp(this.get('history.maxEntries'), 200, 0, 5000); }
  defaultDialect() { return this.get<string>('lint.defaultDialect') || 'ansi'; }

  /** Connections view: the driver's own icon instead of a generic database icon. */
  explorerDriverIcons() { return this.get<boolean>('explorer.driverIcons', true) !== false; }
  /** Connections view: the driver's name after the connection's. */
  explorerShowDriverName() { return this.get<boolean>('explorer.showDriverName', true) !== false; }
  /** Connections view: how many objects a folder holds. */
  explorerShowCounts() { return this.get<boolean>('explorer.showCounts', true) !== false; }
  showRowCounts() { return this.get<boolean>('explorer.showRowCounts', false) === true; }

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
