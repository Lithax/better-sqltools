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

const MIME: Record<string, string> = { svg: 'image/svg+xml', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp' };
const MAX_ICON_BYTES = 256 * 1024;

/** An icon a webview can show without being allowed to read the driver's extension folder. */
export interface IconData {
  light: string;
  dark: string;
}

async function dataUri(base: string | undefined, rel: string): Promise<string | undefined> {
  const uri = isImageIcon(rel) ? resolve(base, rel) : undefined;
  const mime = MIME[rel.slice(rel.lastIndexOf('.') + 1).toLowerCase()];
  if (!uri || !mime) return undefined;
  try {
    const bytes = await vscode.workspace.fs.readFile(uri);
    if (bytes.byteLength > MAX_ICON_BYTES) return undefined;
    return `data:${mime};base64,${Buffer.from(bytes).toString('base64')}`;
  } catch {
    return undefined; // a missing or unreadable icon just means the generic one is shown
  }
}

/**
 * The driver's image icon as `data:` URIs for a webview (the same image twice unless it ships a light and a dark one).
 * Codicons and missing files give undefined; the page draws its own generic database glyph.
 */
export async function iconData(source: IconSource | undefined): Promise<IconData | undefined> {
  const icon = source?.icon;
  if (!icon) return undefined;
  const [light, dark] = typeof icon === 'string' ? [icon, icon] : [icon.light, icon.dark];
  const [l, d] = await Promise.all([dataUri(source?.iconBase, light), dataUri(source?.iconBase, dark)]);
  return l && d ? { light: l, dark: d } : undefined;
}
