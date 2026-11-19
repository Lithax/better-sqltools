import * as vscode from 'vscode';
import type { BetterSqlToolsApi } from './api';
import { SqlfluffLinter } from './adapters/sqlfluff/sqlfluff-linter';
import type { App } from './adapters/vscode/app';
import { EditorBindings } from './adapters/vscode/bindings';
import { SqlCodeLensProvider } from './adapters/vscode/codelens';
import { registerCommands } from './adapters/vscode/commands';
import { SqlCompletionProvider } from './adapters/vscode/completion';
import { LintController, SqlFixActions, SqlFormatter } from './adapters/vscode/diagnostics';
import { VsCodeDriverExtensions } from './adapters/vscode/driver-extensions';
import { VsCodeBookmarks } from './adapters/vscode/bookmark-repository';
import { VsCodeHistory } from './adapters/vscode/history-repository';
import { VsCodeLogger } from './adapters/vscode/logger';
import { SettingsProfileRepository } from './adapters/vscode/profile-repository';
import { QueryRunner } from './adapters/vscode/runner';
import { ResultsView } from './adapters/vscode/results-view';
import { VsCodeSecretStore } from './adapters/vscode/secret-store';
import { VsCodeSettings } from './adapters/vscode/settings';
import { ConnectionStatusBar } from './adapters/vscode/status-bar';
import { ConnectionsDragAndDrop, ConnectionsTree, DriversTree } from './adapters/vscode/trees';
import { resolvePath, resolveVariables } from './adapters/vscode/variables';
import { BookmarkService } from './application/bookmark-service';
import { CompletionService } from './application/completion-service';
import { ConnectionManager } from './application/connection-manager';
import { DriverDirectory } from './application/driver-directory';
import { GroupService } from './application/group-service';
import { ProjectAwareProfiles } from './application/project-profiles';
import { ProjectConfigService } from './application/project-config-service';
import { parseToml } from './adapters/toml/toml';
import { ConfigDiagnostics } from './adapters/vscode/config-diagnostics';
import { ConnectionDecorations } from './adapters/vscode/connection-decorations';
import { SettingsGroupRepository } from './adapters/vscode/group-repository';
import { VsCodeProjectFiles } from './adapters/vscode/project-files';
import { DriverRegistry } from './application/driver-registry';
import { LintService } from './application/lint-service';
import type { SecretPrompter } from './application/ports';
import { QueryService } from './application/query-service';
import { EditService } from './application/edit-service';
import { SchemaService } from './application/schema-service';

let shutdown: (() => Promise<void>) | undefined;

/** The settings this extension declares, without the prefix, that a project file may set. */
function knownSettings(context: vscode.ExtensionContext): ReadonlySet<string> | undefined {
  const cfg = context.extension?.packageJSON?.contributes?.configuration;
  const blocks: { properties?: Record<string, unknown> }[] = Array.isArray(cfg) ? cfg : cfg ? [cfg] : [];
  const keys = blocks.flatMap((b) => Object.keys(b.properties ?? {})).map((k) => k.replace(/^betterSqlTools\./, ''));
  return keys.length ? new Set(keys.filter((k) => k !== 'connections' && k !== 'groups')) : undefined;
}

/** Composition root: the only place that knows every adapter. */
export async function activate(context: vscode.ExtensionContext): Promise<BetterSqlToolsApi> {
  // driven side
  const logger = new VsCodeLogger();
  const projectFiles = new VsCodeProjectFiles();
  const project = new ProjectConfigService(projectFiles, parseToml, () => knownSettings(context), logger);
  const settings = new VsCodeSettings(() => project.current().settings);
  const storedProfiles = new SettingsProfileRepository();
  const profiles = new ProjectAwareProfiles(storedProfiles, project);
  const groupStore = new SettingsGroupRepository();
  const groups = new GroupService({ groups: groupStore, project, profiles });
  const secrets = new VsCodeSecretStore(context.secrets);
  const history = new VsCodeHistory(context.globalState, () => settings.historyLimit());
  const bookmarks = new BookmarkService(new VsCodeBookmarks(context.globalState));
  const prompter: SecretPrompter = {
    prompt: async ({ profileName, field }) =>
      vscode.window.showInputBox({ title: `Connect to ${profileName}`, prompt: field.label, password: true, ignoreFocusOut: true }),
  };

  // core
  const registry = new DriverRegistry();
  const driverHost = new VsCodeDriverExtensions();
  const drivers = new DriverDirectory(registry, driverHost, logger);
  const connections = new ConnectionManager({
    registry, profiles, secrets, prompter, settings, logger, resolveVariables, env: { logger, resolvePath },
  });
  const schema = new SchemaService(connections, logger, settings);
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
  const edits = new EditService({ connections, schema });
  const results = new ResultsView(context.extensionUri, settings, edits);
  const overlaySub = project.onDidChange(() => results.refreshSettings()); // a project's TOML can set how results look
  const runner = new QueryRunner({ queries, connections, results });
  const linting = new LintController({ lint, bindings, settings, logger });

  const app: App = {
    context, logger, settings, registry, drivers, project, groups, connections, schema, queries, completion, lint,
    profiles, secrets, history, bookmarks, bindings, runner, linting,
  };

  // Drivers are plugins: other extensions register them through the exported API. This view of what
  // is installed (and whether any driver exists at all) drives the welcome text of the sidebar.
  const syncDriverContext = () => void vscode.commands.executeCommand('setContext', 'betterSqlTools.hasDrivers', drivers.list().length > 0);
  syncDriverContext();

  const connectionsTree = new ConnectionsTree(app);
  const connectionsView = vscode.window.createTreeView('betterSqlTools.connections', {
    treeDataProvider: connectionsTree,
    showCollapseAll: true,
    canSelectMany: true,
    dragAndDropController: new ConnectionsDragAndDrop(app),
  });
  connectionsTree.attach(connectionsView);
  void vscode.commands.executeCommand('setContext', 'betterSqlTools.filterActive', false);
  const sql: vscode.DocumentSelector = { language: 'sql' };
  context.subscriptions.push(
    logger, storedProfiles, profiles, groupStore, groups, project, projectFiles, new ConfigDiagnostics(project), results, overlaySub,
    bindings, linting, connectionsTree, connectionsView, new ConnectionDecorations(app), driverHost, drivers.onDidChange(syncDriverContext),
    vscode.window.registerTreeDataProvider('betterSqlTools.drivers', new DriversTree(app)),
    vscode.window.registerWebviewViewProvider(ResultsView.viewId, results, { webviewOptions: { retainContextWhenHidden: true } }),
    vscode.languages.registerCompletionItemProvider(sql, new SqlCompletionProvider(app), '.'),
    vscode.languages.registerDocumentFormattingEditProvider(sql, new SqlFormatter(app)),
    vscode.languages.registerCodeActionsProvider(sql, new SqlFixActions(), SqlFixActions.metadata),
    vscode.languages.registerCodeLensProvider(sql, new SqlCodeLensProvider(app)),
    new ConnectionStatusBar(app),
    vscode.workspace.onDidGrantWorkspaceTrust(() => storedProfiles.refresh()),
    ...registerCommands(app, connectionsTree),
  );

  shutdown = () => connections.disconnectAll();
  logger.info('Better SQLTools is ready.');
  void project.reload(); // .better-sqltools.toml and .better-sqltools/*.toml

  // Wake installed driver extensions once we are done activating: a driver depends on this extension,
  // so activating it from inside activate() would wait for us to finish while we wait for it.
  const wake = setTimeout(() => void drivers.activateAll(), 0);
  context.subscriptions.push({ dispose: () => clearTimeout(wake) });

  return {
    apiVersion: 1,
    registerDriver: (factory) => registry.register(factory),
  };
}

export async function deactivate(): Promise<void> {
  await shutdown?.();
}
