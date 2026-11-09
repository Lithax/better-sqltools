import * as vscode from 'vscode';
import type { DriverEntry } from '../../application/driver-directory';
import { isImageIcon } from '../../domain/driver-descriptor';

export const DEFAULT_DRIVER_ICON = 'database';

type IconSource = Pick<DriverEntry, 'icon' | 'iconBase'>;
export type TreeIcon = vscode.ThemeIcon | vscode.Uri | { light: vscode.Uri; dark: vscode.Uri };

/** Image paths come from other extensions' manifests: keep them inside the extension's folder. */
function resolve(base: string | undefined, rel: string): vscode.Uri | undefined {
  if (!base) return undefined;
  const parts = rel.replace(/\\/g, '/').split('/');
  if (rel.startsWith('/') || /^[a-z]:/i.test(rel) || parts.includes('..')) return undefined;
  return vscode.Uri.joinPath(vscode.Uri.parse(base), ...parts.filter((p) => p && p !== '.'));
}

/** The icon for a tree item: the driver's image or codicon, else a plain database icon. */
export function treeIcon(source: IconSource | undefined, color?: vscode.ThemeColor): TreeIcon {
  const icon = source?.icon;
  if (typeof icon === 'string') {
    if (!isImageIcon(icon)) return new vscode.ThemeIcon(icon, color);
    const u = resolve(source?.iconBase, icon);
    if (u) return u;
  } else if (icon) {
    const light = resolve(source?.iconBase, icon.light);
    const dark = resolve(source?.iconBase, icon.dark);
    if (light && dark) return { light, dark };
  }
  return new vscode.ThemeIcon(DEFAULT_DRIVER_ICON, color);
}

/** True when the driver ships its own image (as opposed to a codicon or nothing). */
export function hasImageIcon(source: IconSource | undefined): boolean {
  const icon = source?.icon;
  if (!icon) return false;
  const files = typeof icon === 'string' ? [icon] : [icon.light, icon.dark];
  return files.every((f) => isImageIcon(f) && resolve(source?.iconBase, f));
}
