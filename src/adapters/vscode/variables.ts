import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';

const workspaceRoot = () => vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;

/** `${workspaceFolder}` (first folder), `${workspaceFolderBasename}`, `${userHome}`, `${cwd}`, `${env:NAME}`, leading `~`. */
export function resolveVariables(input: string): string {
  const ws = workspaceRoot();
  return input
    .replace(/\$\{([^}]+)\}/g, (whole, name: string) => {
      if (name === 'workspaceFolder') return ws ?? whole;
      if (name === 'workspaceFolderBasename') return ws ? path.basename(ws) : whole;
      if (name === 'userHome') return os.homedir();
      if (name === 'cwd') return process.cwd();
      if (name.startsWith('env:')) return process.env[name.slice(4)] ?? '';
      return whole;
    })
    .replace(/^~(?=$|[\\/])/, os.homedir());
}

/** Relative paths are resolved against the first workspace folder, else the home directory. */
export function resolvePath(p: string): string {
  const r = resolveVariables(p);
  return path.isAbsolute(r) ? r : path.resolve(workspaceRoot() ?? os.homedir(), r);
}
