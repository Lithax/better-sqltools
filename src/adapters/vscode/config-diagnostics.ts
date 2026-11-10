import * as vscode from 'vscode';
import type { ProjectConfigService } from '../../application/project-config-service';
import type { ProjectConfig } from '../../domain/project-config';

/** Shows what is wrong with a project's TOML files in the Problems panel, on the lines they are about. */
export class ConfigDiagnostics implements vscode.Disposable {
  private readonly collection = vscode.languages.createDiagnosticCollection('Better SQLTools config');
  private readonly sub: { dispose(): void };
  private shown = new Set<string>();

  constructor(project: Pick<ProjectConfigService, 'current' | 'onDidChange'>) {
    this.sub = project.onDidChange(() => this.render(project.current()));
  }

  dispose(): void {
    this.sub.dispose();
    this.collection.dispose();
  }

  private render(cfg: ProjectConfig): void {
    const byFile = new Map<string, vscode.Diagnostic[]>();
    for (const i of cfg.issues) {
      const line = Math.max(0, (i.line ?? 1) - 1);
      const d = new vscode.Diagnostic(
        new vscode.Range(line, 0, line, 1000),
        i.message,
        i.severity === 'error' ? vscode.DiagnosticSeverity.Error : vscode.DiagnosticSeverity.Warning,
      );
      d.source = 'Better SQLTools';
      byFile.set(i.file, [...(byFile.get(i.file) ?? []), d]);
    }
    for (const file of this.shown) if (!byFile.has(file)) this.collection.delete(vscode.Uri.parse(file));
    for (const [file, diags] of byFile) this.collection.set(vscode.Uri.parse(file), diags);
    this.shown = new Set(byFile.keys());
  }
}
