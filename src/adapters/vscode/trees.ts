import * as vscode from 'vscode';
import { errorMessage } from '../../domain/errors';
import type { DriverDescriptor } from '../../domain/driver-descriptor';
import type { ConnectionId, SchemaNode } from '../../domain/model';
import type { App } from './app';

export type TreeNode =
  | { type: 'connection'; id: ConnectionId }
  | { type: 'node'; connectionId: ConnectionId; node: SchemaNode };

const KIND_ICON: Record<SchemaNode['kind'], string> = {
  database: 'database',
  schema: 'symbol-namespace',
  folder: 'folder',
  table: 'table',
  view: 'eye',
  column: 'symbol-field',
  index: 'list-ordered',
  trigger: 'zap',
  routine: 'symbol-method',
  sequence: 'symbol-numeric',
  other: 'symbol-misc',
};

const connectCommand = (id: ConnectionId): vscode.Command => ({
  command: 'betterSqlTools.connect',
  title: 'Connect',
  arguments: [{ type: 'connection', id } satisfies TreeNode],
});

/**
 * Connections and their schema objects. A connection only has children while connected; clicking a
 * disconnected one connects it. The item id carries the state, so a freshly connected item opens expanded.
 */
export class ConnectionsTree implements vscode.TreeDataProvider<TreeNode>, vscode.Disposable {
  private readonly emitter = new vscode.EventEmitter<TreeNode | undefined>();
  readonly onDidChangeTreeData = this.emitter.event;
  private readonly subs: { dispose(): void }[];

  constructor(private readonly app: Pick<App, 'connections' | 'schema' | 'registry' | 'logger'>) {
    this.subs = [
      this.emitter,
      app.connections.onDidChange(() => this.refresh()),
      app.registry.onDidChange(() => this.refresh()),
      // DDL run from an editor, or a manual refresh, must show up in the tree without further ado
      app.schema.onDidInvalidate(() => this.refresh()),
    ];
  }

  dispose() { this.subs.forEach((s) => s.dispose()); }

  /** VS Code only re-reads children when told to; `undefined` refreshes everything. */
  refresh(node?: TreeNode) { this.emitter.fire(node); }

  getTreeItem(el: TreeNode): vscode.TreeItem {
    return el.type === 'connection' ? this.connectionItem(el.id) : this.nodeItem(el);
  }

  async getChildren(el?: TreeNode): Promise<TreeNode[]> {
    if (!el) return this.app.connections.list().map((i) => ({ type: 'connection', id: i.profile.id }));
    const connectionId = el.type === 'connection' ? el.id : el.connectionId;
    try {
      const nodes = await this.app.schema.children(connectionId, el.type === 'node' ? el.node : undefined);
      return nodes.map((node) => ({ type: 'node', connectionId, node }));
    } catch (e) {
      this.app.logger.error(`Loading schema failed: ${errorMessage(e)}`);
      void vscode.window.showErrorMessage(`Could not load schema objects: ${errorMessage(e)}`);
      return [];
    }
  }

  private nodeItem(el: Extract<TreeNode, { type: 'node' }>): vscode.TreeItem {
    const n = el.node;
    const item = new vscode.TreeItem(
      n.label,
      n.expandable ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None,
    );
    item.id = `${el.connectionId}/${n.id}`;
    item.description = n.description;
    item.tooltip = n.tooltip ?? (n.description ? `${n.label}: ${n.description}` : n.label);
    item.contextValue = `node.${n.kind}`;
    item.iconPath = new vscode.ThemeIcon(n.primaryKey ? 'key' : (KIND_ICON[n.kind] ?? 'symbol-misc'));
    return item;
  }

  private connectionItem(id: ConnectionId): vscode.TreeItem {
    const info = this.app.connections.info(id);
    const item = new vscode.TreeItem(info?.profile.name ?? id, vscode.TreeItemCollapsibleState.None);
    if (!info) return item;

    const driverName = info.descriptor?.displayName ?? info.profile.driver;
    const tip = new vscode.MarkdownString(undefined, true);
    tip.appendMarkdown(`**${info.profile.name.replace(/[*_`\\]/g, '\\$&')}**\n\n${driverName}`);
    item.tooltip = tip;

    if (!info.descriptor) {
      item.id = `connection/${id}/nodriver`;
      item.contextValue = 'connection.nodriver';
      item.description = `${driverName} · driver not installed`;
      item.iconPath = new vscode.ThemeIcon('warning', new vscode.ThemeColor('list.warningForeground'));
      tip.appendMarkdown('\n\nThis driver is not installed. Click to look for it in the Marketplace.');
      item.command = { command: 'betterSqlTools.findDrivers', title: 'Find drivers' };
      return item;
    }

    item.id = `connection/${id}/${info.state}`;
    item.contextValue = `connection.${info.state}`;
    item.description = driverName;
    switch (info.state) {
      case 'connected':
        item.collapsibleState = vscode.TreeItemCollapsibleState.Expanded;
        item.iconPath = new vscode.ThemeIcon('database', new vscode.ThemeColor('charts.green'));
        break;
      case 'connecting':
        item.iconPath = new vscode.ThemeIcon('loading~spin');
        break;
      case 'error':
        item.iconPath = new vscode.ThemeIcon('error', new vscode.ThemeColor('errorForeground'));
        tip.appendCodeblock(info.error ?? 'Connection failed', 'text');
        tip.appendMarkdown('Click to try again.');
        item.command = connectCommand(id);
        break;
      default:
        item.iconPath = new vscode.ThemeIcon('database', new vscode.ThemeColor('disabledForeground'));
        item.command = connectCommand(id);
    }
    return item;
  }
}

/** Installed drivers: what is available, which dialect, what it can do. */
export class DriversTree implements vscode.TreeDataProvider<DriverDescriptor>, vscode.Disposable {
  private readonly emitter = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.emitter.event;
  private readonly sub: { dispose(): void };

  constructor(private readonly app: Pick<App, 'registry'>) {
    this.sub = app.registry.onDidChange(() => this.emitter.fire());
  }

  dispose() {
    this.sub.dispose();
    this.emitter.dispose();
  }

  getChildren(): DriverDescriptor[] {
    return this.app.registry.list();
  }

  getTreeItem(d: DriverDescriptor): vscode.TreeItem {
    const item = new vscode.TreeItem(d.displayName, vscode.TreeItemCollapsibleState.None);
    item.id = `driver/${d.id}`;
    item.description = [d.version ? `v${d.version}` : '', d.id].filter(Boolean).join(' · ');
    item.iconPath = new vscode.ThemeIcon(d.icon ?? 'plug');
    item.contextValue = 'driver';

    const caps = Object.entries(d.capabilities).filter(([, on]) => on).map(([k]) => k);
    const tip = new vscode.MarkdownString();
    tip.appendMarkdown(`**${d.displayName}** (\`${d.id}\`)\n\n`);
    if (d.description) tip.appendMarkdown(`${d.description}\n\n`);
    tip.appendMarkdown(`Dialect for linting: \`${d.dialect.sqlfluff ?? 'ansi'}\`\n\n`);
    tip.appendMarkdown(`Capabilities: ${caps.length ? caps.join(', ') : 'basic'}`);
    item.tooltip = tip;
    return item;
  }
}
