import * as vscode from 'vscode';
import type { BetterSqlToolsApi } from '../../src/api';
import { EchoDriverFactory } from './driver';

export async function activate(context: vscode.ExtensionContext) {
  // "extensionDependencies" in package.json guarantees Better SQLTools is installed and activates first.
  const api = await vscode.extensions.getExtension<BetterSqlToolsApi>('better-sqltools.better-sqltools')!.activate();
  context.subscriptions.push(api.registerDriver(new EchoDriverFactory()));
}
