import * as vscode from 'vscode';
import type { BetterSqlToolsApi } from './api';
import { SqlfluffLinter } from './adapters/sqlfluff/sqlfluff-linter';
import type { App } from './adapters/vscode/app';
import { EditorBindings } from './adapters/vscode/bindings';
import { SqlCodeLensProvider } from './adapters/vscode/codelens';
import { registerCommands } from './adapters/vscode/commands';
import { SqlCompletionProvider } from './adapters/vscode/completion';
import { LintController, SqlFixActions, SqlFormatter } from './adapters/vscode/diagnostics';
import { VsCodeHistory } from './adapters/vscode/history-repository';
import { VsCodeLogger } from './adapters/vscode/logger';
import { SettingsProfileRepository } from './adapters/vscode/profile-repository';
import { QueryRunner } from './adapters/vscode/runner';
import { ResultsView } from './adapters/vscode/results-view';
import { VsCodeSecretStore } from './adapters/vscode/secret-store';
import { VsCodeSettings } from './adapters/vscode/settings';
import { ConnectionStatusBar } from './adapters/vscode/status-bar';
import { ConnectionsTree, DriversTree } from './adapters/vscode/trees';
import { resolvePath, resolveVariables } from './adapters/vscode/variables';
import { CompletionService } from './application/completion-service';
import { ConnectionManager } from './application/connection-manager';
import { DriverRegistry } from './application/driver-registry';
import { LintService } from './application/lint-service';
import type { SecretPrompter } from './application/ports';
import { QueryService } from './application/query-service';
import { SchemaService } from './application/schema-service';
import { SqliteDriverFactory } from './drivers/sqlite';

let shutdown: (() => Promise<void>) | undefined;

/** Composition root: the only place that knows every adapter. */
export async function activate(context: vscode.ExtensionContext): Promise<BetterSqlToolsApi> {
  // driven side
  const logger = new VsCodeLogger();
  const settings = new VsCodeSettings();
  const profiles = new SettingsProfileRepository();
  const secrets = new VsCodeSecretStore(context.secrets);
  const history = new VsCodeHistory(context.globalState, () => settings.historyLimit());
  const prompter: SecretPrompter = {
    prompt: async ({ profileName, field }) =>
      vscode.window.showInputBox({ title: `Connect to ${profileName}`, prompt: field.label, password: true, ignoreFocusOut: true }),
  };

  // core
  const registry = new DriverRegistry();
  const connections = new ConnectionManager({
    registry, profiles, secrets, prompter, settings, logger, resolveVariables, env: { logger, resolvePath },
  });
  const schema = new SchemaService(connections, logger);
  const queries = new QueryService({ connections, schema, history, settings, logger });
  const completion = new CompletionService(connections, schema);
  const lint = new LintService(new SqlfluffLinter(() => settings.sqlfluff()), connections, settings);

  // driving side
  const bindings = new EditorBindings(
    context.workspaceState,
    (id) => !!connections.info(id),
    () => {
      const live = connections.list().filter((i) => i.state === 'connected');
      return live.length === 1 ? live[0].profile.id : undefined;
    },
  );
  profiles.onDidChange(() => bindings.touch());
  const results = new ResultsView(context.extensionUri);
  const runner = new QueryRunner({ queries, connections, results });
  const linting = new LintController({ lint, bindings, settings, logger });

  const app: App = {
    context, logger, settings, registry, connections, schema, queries, completion, lint,
    profiles, secrets, history, bindings, runner, linting,
  };

  // the built-in driver goes through the same door as third-party ones
  registry.register(new SqliteDriverFactory());

  const connectionsTree = new ConnectionsTree(app);
  const sql: vscode.DocumentSelector = { language: 'sql' };
  context.subscriptions.push(
    logger, profiles, bindings, linting, connectionsTree,
    vscode.window.createTreeView('betterSqlTools.connections', { treeDataProvider: connectionsTree, showCollapseAll: true }),
    vscode.window.registerTreeDataProvider('betterSqlTools.drivers', new DriversTree(app)),
    vscode.window.registerWebviewViewProvider(ResultsView.viewId, results, { webviewOptions: { retainContextWhenHidden: true } }),
    vscode.languages.registerCompletionItemProvider(sql, new SqlCompletionProvider(app), '.'),
    vscode.languages.registerDocumentFormattingEditProvider(sql, new SqlFormatter(app)),
    vscode.languages.registerCodeActionsProvider(sql, new SqlFixActions(), SqlFixActions.metadata),
    vscode.languages.registerCodeLensProvider(sql, new SqlCodeLensProvider(app)),
    new ConnectionStatusBar(app),
    vscode.workspace.onDidGrantWorkspaceTrust(() => profiles.refresh()),
    ...registerCommands(app, connectionsTree),
  );

  shutdown = () => connections.disconnectAll();
  logger.info('Better SQLTools is ready.');

  return {
    apiVersion: 1,
    registerDriver: (factory) => registry.register(factory),
  };
}

export async function deactivate(): Promise<void> {
  await shutdown?.();
}
