import * as vscode from 'vscode';
import { CancelledError, DriverNotFoundError, errorMessage } from '../../domain/errors';
import type { ConnectionId, ConnectionProfile, HistoryEntry, SchemaNode } from '../../domain/model';
import { selectSample } from '../../domain/sql/generate';
import { splitStatements, statementAt } from '../../domain/sql/splitter';
import { tokenizerOptions } from '../../domain/sql/tokenizer';
import type { App } from './app';
import { ConnectionForm } from './connection-form';
import { cwdFor, fullRange } from './diagnostics';
import { slug } from './profile-repository';
import type { ConnectionsTree, TreeNode } from './trees';

const oneLine = (s: string, n: number) => {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};

interface ConnectionPick extends vscode.QuickPickItem {
  id: ConnectionId;
}

export function registerCommands(app: App, tree: ConnectionsTree): vscode.Disposable[] {
  const { connections, schema, bindings } = app;

  // ---- helpers -----------------------------------------------------------------

  const report = (e: unknown) => {
    if (e instanceof CancelledError) return;
    app.logger.error(errorMessage(e));
    if (e instanceof DriverNotFoundError) {
      void vscode.window.showErrorMessage(e.message, 'Find Drivers').then((p) => p && vscode.commands.executeCommand('betterSqlTools.findDrivers'));
    } else {
      void vscode.window.showErrorMessage(errorMessage(e), 'Show Log').then((p) => p && app.logger.channel.show());
    }
  };

  const cmd = (id: string, fn: (...args: any[]) => unknown) =>
    vscode.commands.registerCommand(`betterSqlTools.${id}`, async (...args: unknown[]) => {
      try {
        await fn(...args);
      } catch (e) {
        report(e);
      }
    });

  const connectionOf = (el?: TreeNode): ConnectionId | undefined => (el ? (el.type === 'connection' ? el.id : el.connectionId) : undefined);

  async function pickConnection(placeHolder: string, filter?: (state: string) => boolean): Promise<ConnectionId | undefined> {
    const infos = connections.list().filter((i) => !filter || filter(i.state));
    if (!connections.list().length) {
      const pick = await vscode.window.showInformationMessage('You have no connections yet.', 'New Connection');
      if (pick) ConnectionForm.show(app);
      return undefined;
    }
    if (!infos.length) {
      void vscode.window.showInformationMessage('No matching connections.');
      return undefined;
    }
    const items: ConnectionPick[] = infos.map((i) => ({
      id: i.profile.id,
      label: `$(${i.state === 'connected' ? 'database' : 'circle-outline'}) ${i.profile.name}`,
      description: i.descriptor?.displayName ?? `${i.profile.driver} (driver not installed)`,
      detail: i.state === 'connected' ? 'Connected' : i.error,
    }));
    return (await vscode.window.showQuickPick(items, { placeHolder, matchOnDescription: true }))?.id;
  }

  /** Explicit choice, else the only live connection, else the only configured one, else ask. Remembers the answer. */
  async function resolveConnection(doc: vscode.TextDocument): Promise<ConnectionId | undefined> {
    const known = bindings.effective(doc.uri);
    const all = connections.list();
    const id = known ?? (all.length === 1 ? all[0].profile.id : await pickConnection('Run this editor against…'));
    if (id && id !== bindings.get(doc.uri)) await bindings.set(doc.uri, id);
    return id;
  }

  async function openSql(connectionId: ConnectionId, content: string) {
    const doc = await vscode.workspace.openTextDocument({ language: 'sql', content });
    await bindings.set(doc.uri, connectionId);
    await vscode.window.showTextDocument(doc, { preview: false });
  }

  async function runIn(mode: 'statement' | 'file', at?: { uri: vscode.Uri; offset: number }) {
    const editor = vscode.window.activeTextEditor;
    const doc = at ? await vscode.workspace.openTextDocument(at.uri) : editor?.document;
    if (!doc) return void vscode.window.showInformationMessage('Open a SQL file first.');
    const connectionId = await resolveConnection(doc);
    if (!connectionId) return;

    let sql: string;
    if (mode === 'file') {
      sql = doc.getText();
    } else {
      const selected = !at && editor?.document === doc && !editor.selection.isEmpty ? doc.getText(editor.selection) : '';
      if (selected.trim()) {
        sql = selected;
      } else {
        const dialect = connections.info(connectionId)?.descriptor?.dialect;
        const offset = at?.offset ?? doc.offsetAt(editor!.selection.active);
        const st = statementAt(splitStatements(doc.getText(), tokenizerOptions(dialect)), offset);
        if (!st) return void vscode.window.showInformationMessage('There is no SQL statement at the cursor.');
        sql = st.text;
      }
    }
    if (!sql.trim()) return void vscode.window.showInformationMessage('Nothing to run.');
    await app.runner.run(connectionId, sql);
  }

  const asNode = (el: TreeNode): { connectionId: ConnectionId; node: SchemaNode } => {
    if (el?.type !== 'node') throw new Error('Pick a table or view in the Better SQLTools view.');
    return el;
  };
  const dialectOf = (id: ConnectionId) => connections.info(id)?.descriptor?.dialect;

  // ---- commands ----------------------------------------------------------------

  return [
    cmd('newConnection', async () => {
      if (!app.drivers.list().length) {
        const pick = await vscode.window.showInformationMessage(
          'Better SQLTools talks to databases through driver extensions, and none is installed yet.',
          'Find Drivers',
        );
        if (pick) await vscode.commands.executeCommand('betterSqlTools.findDrivers');
        return;
      }
      await app.drivers.activateAll().catch(() => undefined); // the form needs every installed driver registered
      ConnectionForm.show(app);
    }),

    cmd('editConnection', async (el: TreeNode) => {
      const profile = connections.info(connectionOf(el) ?? '')?.profile;
      if (!profile) return;
      if (!app.registry.get(profile.driver)) {
        const pick = await vscode.window.showWarningMessage(`The "${profile.driver}" driver is not installed, so the form cannot be shown.`, 'Find Drivers');
        if (pick) await vscode.commands.executeCommand('betterSqlTools.findDrivers');
        return;
      }
      ConnectionForm.show(app, { profile });
    }),

    cmd('duplicateConnection', async (el: TreeNode) => {
      const src = connections.info(connectionOf(el) ?? '')?.profile;
      if (!src) return;
      const taken = new Set(connections.list().map((i) => i.profile.id));
      const name = `${src.name} (copy)`;
      let id = slug(name);
      while (taken.has(id)) id += '-2';
      const copy: ConnectionProfile = { ...src, id, name, options: { ...src.options } };
      await app.profiles.save(copy);
      void vscode.window.showInformationMessage(`Created "${name}". Passwords are not copied.`);
    }),

    cmd('deleteConnection', async (el: TreeNode) => {
      const info = connections.info(connectionOf(el) ?? '');
      if (!info) return;
      const ok = await vscode.window.showWarningMessage(`Delete the connection "${info.profile.name}"?`, { modal: true, detail: 'Its saved password is removed too. The database itself is not touched.' }, 'Delete');
      if (!ok) return;
      await connections.disconnect(info.profile.id);
      await app.profiles.remove(info.profile.id);
      await app.secrets.deleteAll(info.profile.id);
    }),

    cmd('connect', async (el?: TreeNode) => {
      const id = connectionOf(el) ?? (await pickConnection('Connect to…', (s) => s !== 'connected'));
      if (id) await connections.connect(id);
    }),

    cmd('disconnect', async (el?: TreeNode) => {
      const id = connectionOf(el) ?? (await pickConnection('Disconnect from…', (s) => s === 'connected'));
      if (id) await connections.disconnect(id);
    }),

    cmd('refresh', (el?: TreeNode) => {
      if (el?.type === 'node') {
        schema.invalidate(el.connectionId); // the completion catalog may be stale too
        return tree.refresh(el);
      }
      const id = connectionOf(el);
      if (id) schema.invalidate(id);
      else connections.list().forEach((i) => schema.invalidate(i.profile.id));
      tree.refresh();
      return undefined;
    }),

    cmd('newQuery', async (el?: TreeNode) => {
      const id = connectionOf(el) ?? (await pickConnection('New query on…'));
      if (id) await openSql(id, '');
    }),

    cmd('selectConnection', async () => {
      const doc = vscode.window.activeTextEditor?.document;
      if (!doc) return;
      const id = await pickConnection('Run this editor against…');
      if (!id) return;
      await bindings.set(doc.uri, id);
      if (connections.info(id)?.state !== 'connected') {
        void connections.connect(id).catch(report); // so completion has a schema to work with
      }
    }),

    cmd('runStatement', (uri?: vscode.Uri, offset?: number) =>
      runIn('statement', uri instanceof vscode.Uri && typeof offset === 'number' ? { uri, offset } : undefined)),
    cmd('runFile', () => runIn('file')),

    cmd('showTableData', async (el: TreeNode) => {
      const { connectionId, node } = asNode(el);
      const dialect = dialectOf(connectionId);
      if (!dialect) return;
      await app.runner.run(connectionId, selectSample(node.qualifiedName ?? node.label, dialect, 1000));
    }),

    cmd('generateSelect', async (el: TreeNode) => {
      const { connectionId, node } = asNode(el);
      const dialect = dialectOf(connectionId);
      if (dialect) await openSql(connectionId, selectSample(node.qualifiedName ?? node.label, dialect, 100) + '\n');
    }),

    cmd('showDDL', async (el: TreeNode) => {
      const { connectionId, node } = asNode(el);
      const ddl = await schema.ddl(connectionId, node);
      if (!ddl) return void vscode.window.showInformationMessage('This driver cannot show DDL for this object.');
      await openSql(connectionId, ddl + '\n');
    }),

    cmd('copyName', async (el: TreeNode) => {
      const { node } = asNode(el);
      await vscode.env.clipboard.writeText(node.qualifiedName ?? node.label);
    }),

    cmd('showHistory', async () => {
      const items = app.history.list().map((e) => ({
        label: oneLine(e.sql, 90),
        description: `${e.connectionName} · ${new Date(e.at).toLocaleString()}`,
        detail: `${e.ok ? '$(check)' : '$(error)'} ${e.durationMs < 1 ? '<1' : Math.round(e.durationMs)} ms`,
        entry: e as HistoryEntry,
      }));
      if (!items.length) return void vscode.window.showInformationMessage('No queries in the history yet.');
      const picked = await vscode.window.showQuickPick(items, { placeHolder: 'Open a past query in a new editor', matchOnDescription: true });
      if (!picked) return;
      const { entry } = picked;
      const id = connections.info(entry.connectionId) ? entry.connectionId : await pickConnection('That connection no longer exists. Use…');
      if (id) await openSql(id, entry.sql);
    }),

    cmd('clearHistory', async () => {
      const ok = await vscode.window.showWarningMessage('Clear the query history?', { modal: true }, 'Clear');
      if (ok) await app.history.clear();
    }),

    cmd('findDrivers', () => vscode.commands.executeCommand('workbench.extensions.search', '@tag:better-sqltools-driver')),

    cmd('lintNow', async () => {
      const doc = vscode.window.activeTextEditor?.document;
      if (!doc) return;
      if (!vscode.workspace.isTrusted) return void vscode.window.showWarningMessage('Linting runs an external program, so it is off until you trust this workspace.');
      const n = await app.linting.lintDocument(doc);
      if (n === 0) void vscode.window.showInformationMessage('sqlfluff found no issues.');
    }),

    cmd('fixDocument', async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor || editor.document.languageId !== 'sql') return;
      if (!vscode.workspace.isTrusted) return void vscode.window.showWarningMessage('Fixing runs an external program, so it is off until you trust this workspace.');
      const doc = editor.document;
      const before = doc.getText();
      const fixed = await vscode.window.withProgress({ location: vscode.ProgressLocation.Window, title: 'sqlfluff fix' }, () =>
        app.lint.fix({ text: before, connectionId: bindings.effective(doc.uri), cwd: cwdFor(doc) }));
      if (fixed === before) return void vscode.window.showInformationMessage('Nothing to fix.');
      if (doc.getText() !== before) return void vscode.window.showWarningMessage('The file changed while sqlfluff was running; nothing was applied.');
      await editor.edit((b) => b.replace(fullRange(doc), fixed));
    }),
  ];
}
