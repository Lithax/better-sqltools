import * as vscode from 'vscode';
import type { BetterSqlToolsApi } from '../../../src/api';
import { SqliteDriverFactory } from './sqlite-driver';

const CORE_ID = 'better-sqltools.better-sqltools';

/** Registers the driver with Better SQLTools. Everything heavy (sql.js, the WASM) loads on first connect. */
export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const core = vscode.extensions.getExtension<BetterSqlToolsApi>(CORE_ID);
  if (!core) throw new Error(`The ${CORE_ID} extension is required.`);
  const api = await core.activate();
  context.subscriptions.push(api.registerDriver(new SqliteDriverFactory()));
}

export function deactivate(): void {}
