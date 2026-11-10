import * as vscode from 'vscode';
import { Emitter } from '../../application/events';
import type { ProjectConfigFile, ProjectConfigSource } from '../../application/ports';
import { shortHash } from '../../domain/slug';

export const CONFIG_FILE = '.better-sqltools.toml';
export const CONFIG_DIR = '.better-sqltools';

/**
 * Finds a project's config: `.better-sqltools.toml` in each workspace folder, and every `*.toml` in a
 * `.better-sqltools/` directory next to it. Nothing is read until the workspace is trusted, because the
 * files can define connections and settings that run programs (`lint.sqlfluffPath`).
 */
export class VsCodeProjectFiles implements ProjectConfigSource, vscode.Disposable {
  private readonly emitter = new Emitter<void>();
  readonly onDidChange = this.emitter.event;
  private readonly subs: vscode.Disposable[];
  private watchers: vscode.Disposable[] = [];

  constructor() {
    this.subs = [
      vscode.workspace.onDidChangeWorkspaceFolders(() => {
        this.watch();
        this.emitter.fire();
      }),
      vscode.workspace.onDidGrantWorkspaceTrust(() => this.emitter.fire()),
    ];
    this.watch();
  }

  dispose(): void {
    [...this.subs, ...this.watchers].forEach((d) => d.dispose());
  }

  private watch(): void {
    this.watchers.forEach((w) => w.dispose());
    this.watchers = [];
    const fire = () => this.emitter.fire();
    for (const folder of vscode.workspace.workspaceFolders ?? []) {
      const w = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(folder, `{${CONFIG_FILE},${CONFIG_DIR},${CONFIG_DIR}/**/*.toml}`));
      this.watchers.push(w, w.onDidCreate(fire), w.onDidChange(fire), w.onDidDelete(fire));
    }
  }

  async read(): Promise<ProjectConfigFile[]> {
    if (!vscode.workspace.isTrusted) return [];
    const out: ProjectConfigFile[] = [];
    for (const folder of vscode.workspace.workspaceFolders ?? []) {
      const scopeKey = shortHash(folder.uri.toString());
      const candidates = [{ uri: vscode.Uri.joinPath(folder.uri, CONFIG_FILE), label: CONFIG_FILE }];
      const dir = vscode.Uri.joinPath(folder.uri, CONFIG_DIR);
      try {
        const names = (await vscode.workspace.fs.readDirectory(dir))
          .filter(([name, type]) => name.endsWith('.toml') && !(type & vscode.FileType.Directory))
          .map(([name]) => name)
          .sort((a, b) => a.localeCompare(b));
        for (const name of names) candidates.push({ uri: vscode.Uri.joinPath(dir, name), label: `${CONFIG_DIR}/${name}` });
      } catch {
        // no such directory
      }
      for (const c of candidates) {
        try {
          const bytes = await vscode.workspace.fs.readFile(c.uri);
          out.push({ id: c.uri.toString(), scopeKey, label: c.label, text: new TextDecoder().decode(bytes) });
        } catch {
          // the file does not exist
        }
      }
    }
    return out;
  }
}
