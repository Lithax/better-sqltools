import * as vscode from 'vscode';
import { Emitter } from '../../application/events';
import type { DriverExtensionHost, InstalledDriver } from '../../application/ports';
import type { DriverIcon } from '../../domain/driver-descriptor';

const text = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v : undefined);

function parseIcon(v: unknown): DriverIcon | undefined {
  if (typeof v === 'string') return v || undefined;
  const o = v as { light?: unknown; dark?: unknown } | null;
  return o && typeof o.light === 'string' && typeof o.dark === 'string' ? { light: o.light, dark: o.dark } : undefined;
}

/**
 * Finds driver extensions without loading them: an extension is a driver provider when its
 * package.json has `betterSqlTools.drivers: [{ id, name, description?, icon? }]`.
 */
export class VsCodeDriverExtensions implements DriverExtensionHost, vscode.Disposable {
  private readonly emitter = new Emitter<void>();
  readonly onDidChange = this.emitter.event;
  private readonly sub = vscode.extensions.onDidChange(() => this.emitter.fire());

  list(): InstalledDriver[] {
    const out: InstalledDriver[] = [];
    for (const ext of vscode.extensions.all) {
      const entries: unknown = ext.packageJSON?.betterSqlTools?.drivers;
      if (!Array.isArray(entries)) continue;
      for (const e of entries as Record<string, unknown>[]) {
        const id = text(e?.id);
        const name = text(e?.name);
        if (!id || !name) continue;
        out.push({
          id,
          name,
          description: text(e.description),
          icon: parseIcon(e.icon),
          extensionId: ext.id,
          baseUri: ext.extensionUri.toString(),
          version: text(ext.packageJSON?.version),
        });
      }
    }
    return out;
  }

  async activate(extensionId: string): Promise<void> {
    const ext = vscode.extensions.getExtension(extensionId);
    if (!ext) throw new Error(`Extension ${extensionId} is not installed.`);
    await ext.activate();
  }

  dispose() {
    this.sub.dispose();
  }
}
