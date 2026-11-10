import * as vscode from 'vscode';
import { errorMessage, ProjectManagedError } from '../../domain/errors';
import type { DriverEntry } from '../../application/driver-directory';
import type { ConnectionId, SchemaNode } from '../../domain/model';
import type { App } from './app';
import { treeIcon } from './driver-icons';
import { connectionUri } from './connection-decorations';
import { matchesFilter } from '../../domain/filter';

export type TreeNode =
  | { type: 'group'; id: string }
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

type TreeDeps = Pick<App, 'connections' | 'schema' | 'registry' | 'drivers' | 'groups' | 'settings' | 'logger'>;

/** Kinds that are objects in their own right; the rest are containers (folders, schemas) or parts of a table. */
const OBJECT_KINDS = new Set<SchemaNode['kind']>(['table', 'view', 'index', 'trigger', 'routine', 'sequence', 'other']);

/**
 * Groups, their connections and the connections' schema objects. A connection only has children while
 * connected; clicking a disconnected one connects it. The item id carries the state, so a freshly connected
 * item opens expanded. Without any group the connections are listed flat.
 */
export class ConnectionsTree implements vscode.TreeDataProvider<TreeNode>, vscode.Disposable {
  private readonly emitter = new vscode.EventEmitter<TreeNode | undefined>();
  readonly onDidChangeTreeData = this.emitter.event;
  private readonly subs: { dispose(): void }[];
  private filter = '';
  private view?: vscode.TreeView<TreeNode>;

  constructor(private readonly app: TreeDeps) {
    this.subs = [
      this.emitter,
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration('betterSqlTools.explorer')) this.refresh();
      }),
      app.connections.onDidChange(() => this.refresh()),
      app.registry.onDidChange(() => this.refresh()),
      app.drivers.onDidChange(() => this.refresh()),
      app.groups.onDidChange(() => this.refresh()),
      // DDL run from an editor, or a manual refresh, must show up in the tree without further ado
      app.schema.onDidInvalidate(() => this.refresh()),
    ];
  }

  dispose() { this.subs.forEach((s) => s.dispose()); }

  /** So the view can say which filter is active. */
  attach(view: vscode.TreeView<TreeNode>) { this.view = view; }

  get activeFilter(): string { return this.filter; }

  /** Show only objects whose name matches; an empty text clears the filter. */
  setFilter(text: string) {
    this.filter = text.trim();
    void vscode.commands.executeCommand('setContext', 'betterSqlTools.filterActive', this.filter !== '');
    if (this.view) this.view.description = this.filter ? `filter: ${this.filter}` : undefined;
    this.refresh();
  }

  /** VS Code only re-reads children when told to; `undefined` refreshes everything. */
  refresh(node?: TreeNode) { this.emitter.fire(node); }

  getTreeItem(el: TreeNode): vscode.TreeItem {
    switch (el.type) {
      case 'group': return this.groupItem(el.id);
      case 'connection': return this.connectionItem(el.id);
      default: return this.nodeItem(el);
    }
  }

  getParent(el: TreeNode): TreeNode | undefined {
    if (el.type !== 'connection') return undefined;
    const group = this.app.connections.info(el.id)?.profile.group;
    return group ? { type: 'group', id: group } : undefined;
  }

  async getChildren(el?: TreeNode): Promise<TreeNode[]> {
    if (!el) return this.roots();
    if (el.type === 'group') return this.members(el.id);
    const connectionId = el.type === 'connection' ? el.id : el.connectionId;
    try {
      const nodes = await this.app.schema.children(connectionId, el.type === 'node' ? el.node : undefined);
      const shown = this.filter ? await this.filtered(connectionId, nodes) : nodes;
      return shown.map((node) => ({ type: 'node', connectionId, node }));
    } catch (e) {
      this.app.logger.error(`Loading schema failed: ${errorMessage(e)}`);
      void vscode.window.showErrorMessage(`Could not load schema objects: ${errorMessage(e)}`);
      return [];
    }
  }

  /** Objects whose name matches, and the containers that hold at least one; a table's columns stay with it. */
  private async filtered(connectionId: ConnectionId, nodes: SchemaNode[]): Promise<SchemaNode[]> {
    const out: SchemaNode[] = [];
    for (const n of nodes) {
      if (n.kind === 'column') out.push(n);
      else if (OBJECT_KINDS.has(n.kind)) {
        if (matchesFilter(n.label, this.filter)) out.push(n);
      } else if (await this.holdsMatch(connectionId, n)) out.push(n);
    }
    return out;
  }

  private async holdsMatch(connectionId: ConnectionId, container: SchemaNode, depth = 0): Promise<boolean> {
    if (depth > 3) return true; // stop digging; show it and let the user look
    for (const k of await this.app.schema.children(connectionId, container)) {
      if (OBJECT_KINDS.has(k.kind)) {
        if (matchesFilter(k.label, this.filter)) return true;
      } else if (k.kind !== 'column' && k.expandable && (await this.holdsMatch(connectionId, k, depth + 1))) {
        return true;
      }
    }
    return false;
  }

  private roots(): TreeNode[] {
    const groups = this.app.groups.list();
    const loose = this.app.connections.list().filter((i) => !i.profile.group);
    return [
      ...groups.map((g): TreeNode => ({ type: 'group', id: g.id })),
      ...loose.map((i): TreeNode => ({ type: 'connection', id: i.profile.id })),
    ];
  }

  private members(groupId: string): TreeNode[] {
    return this.app.connections.list().filter((i) => i.profile.group === groupId).map((i) => ({ type: 'connection', id: i.profile.id }));
  }

  private groupItem(id: string): vscode.TreeItem {
    const g = this.app.groups.get(id);
    const members = this.app.connections.list().filter((i) => i.profile.group === id);
    const live = members.filter((m) => m.state === 'connected').length;
    const item = new vscode.TreeItem(g?.name ?? id, vscode.TreeItemCollapsibleState.Expanded);
    item.id = `group/${id}`;
    item.contextValue = `group.${g?.scope ?? 'implicit'}`;
    item.description = [`${members.length}`, live ? `${live} connected` : '', g?.scope === 'project' ? 'project' : ''].filter(Boolean).join(' · ');
    item.iconPath = new vscode.ThemeIcon(g?.icon ?? 'folder', g?.color ? new vscode.ThemeColor(g.color) : undefined);
    const tip = new vscode.MarkdownString(undefined, true);
    tip.appendMarkdown(`**${(g?.name ?? id).replace(/[*_`\\]/g, '\\$&')}**`);
    if (g?.description) tip.appendMarkdown(`\n\n${g.description}`);
    if (g?.scope === 'project' && g.file) tip.appendMarkdown(`\n\nDefined in \`${decodeURIComponent(g.file.split('/').pop() ?? g.file)}\``);
    item.tooltip = tip;
    return item;
  }

  private nodeItem(el: Extract<TreeNode, { type: 'node' }>): vscode.TreeItem {
    const n = el.node;
    const item = new vscode.TreeItem(
      n.label,
      n.expandable ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None,
    );
    item.id = `${el.connectionId}/${n.id}`;
    // a folder's count, a table's rows, then whatever the driver says; the user decides which counts they want
    const parts: string[] = [];
    if (n.count !== undefined && this.app.settings.explorerShowCounts() && !this.filter) parts.push(String(n.count));
    if (n.description) parts.push(n.description);
    if (n.rowCount !== undefined && this.app.settings.showRowCounts()) parts.push(`${n.rowCount.toLocaleString()} ${n.rowCount === 1 ? 'row' : 'rows'}`);
    item.description = parts.join(' \u00b7 ') || undefined;
    item.tooltip = n.tooltip ?? (item.description ? `${n.label}: ${item.description}` : n.label);
    item.contextValue = `node.${n.kind}`;
    item.iconPath = new vscode.ThemeIcon(n.primaryKey ? 'key' : (KIND_ICON[n.kind] ?? 'symbol-misc'));
    return item;
  }

  private connectionItem(id: ConnectionId): vscode.TreeItem {
    const info = this.app.connections.info(id);
    const item = new vscode.TreeItem(info?.profile.name ?? id, vscode.TreeItemCollapsibleState.None);
    if (!info) return item;

    const driver = this.app.drivers.get(info.profile.driver);
    const driverName = info.descriptor?.displayName ?? driver?.displayName ?? info.profile.driver;
    const tip = new vscode.MarkdownString(undefined, true);
    tip.appendMarkdown(`**${info.profile.name.replace(/[*_`\\]/g, '\\$&')}**\n\n${driverName}`);
    if (info.profile.scope === 'project' && info.profile.file) {
      tip.appendMarkdown(`\n\nDefined in \`${decodeURIComponent(info.profile.file.split('/').pop() ?? info.profile.file)}\``);
    }
    item.tooltip = tip;

    if (!info.descriptor) {
      // the driver is not registered: still loading, failed, or not installed at all
      const base = `connection/${id}/nodriver`;
      if (driver?.state === 'inactive') {
        item.id = `${base}/loading`;
        item.contextValue = 'connection.nodriver';
        item.description = `${driverName} · loading driver…`;
        item.iconPath = new vscode.ThemeIcon('loading~spin');
      } else {
        item.id = `${base}/${driver?.state ?? 'missing'}`;
        item.contextValue = 'connection.nodriver';
        item.description = `${driverName} · ${driver?.state === 'failed' ? 'driver failed to load' : 'driver not installed'}`;
        item.iconPath = new vscode.ThemeIcon('warning', new vscode.ThemeColor('list.warningForeground'));
        if (driver?.error) tip.appendCodeblock(driver.error, 'text');
        tip.appendMarkdown(driver?.state === 'failed' ? '\n\nThe driver\'s extension failed to activate. See the Output panel.' : '\n\nThis driver is not installed. Click to look for it in the Marketplace.');
        item.command = { command: 'betterSqlTools.findDrivers', title: 'Find drivers' };
      }
      return item;
    }

    item.id = `connection/${id}/${info.state}`;
    item.contextValue = `connection.${info.state}`;
    item.description = this.app.settings.explorerShowDriverName() ? driverName : undefined;
    const driverIcons = this.app.settings.explorerDriverIcons();
    if (driverIcons) item.resourceUri = connectionUri(id); // lets the state colour the label; see ConnectionDecorations
    switch (info.state) {
      case 'connected':
        item.collapsibleState = vscode.TreeItemCollapsibleState.Expanded;
        item.iconPath = driverIcons ? treeIcon(driver) : new vscode.ThemeIcon('database', new vscode.ThemeColor('charts.green'));
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
        item.iconPath = driverIcons ? treeIcon(driver) : new vscode.ThemeIcon('database', new vscode.ThemeColor('disabledForeground'));
        item.command = connectCommand(id);
    }
    return item;
  }
}

export const CONNECTION_DRAG_MIME = 'application/vnd.code.tree.bettersqltools.connections';

/** Drag connections onto a group to file them there, onto a connection to join its group, or onto empty space to ungroup them. */
export class ConnectionsDragAndDrop implements vscode.TreeDragAndDropController<TreeNode> {
  readonly dragMimeTypes = [CONNECTION_DRAG_MIME];
  readonly dropMimeTypes = [CONNECTION_DRAG_MIME];

  constructor(private readonly app: Pick<App, 'groups' | 'connections' | 'logger'>) {}

  handleDrag(source: readonly TreeNode[], data: vscode.DataTransfer): void {
    const ids = source.flatMap((n) => (n.type === 'connection' ? [n.id] : []));
    if (ids.length) data.set(CONNECTION_DRAG_MIME, new vscode.DataTransferItem(ids));
  }

  async handleDrop(target: TreeNode | undefined, data: vscode.DataTransfer): Promise<void> {
    const ids = data.get(CONNECTION_DRAG_MIME)?.value as ConnectionId[] | undefined;
    if (!ids?.length || target?.type === 'node') return;
    const group = target?.type === 'group' ? target.id : target ? this.app.connections.info(target.id)?.profile.group : undefined;
    const blocked: string[] = [];
    for (const id of ids) {
      try {
        await this.app.groups.assign(id, group);
      } catch (e) {
        if (!(e instanceof ProjectManagedError)) throw e;
        blocked.push(e.message);
      }
    }
    if (blocked.length) void vscode.window.showInformationMessage(blocked[0] + (blocked.length > 1 ? ` (${blocked.length - 1} more were not moved.)` : ''));
  }
}

/** Installed drivers: what is available, which dialect, what it can do, and what failed to load. */
export class DriversTree implements vscode.TreeDataProvider<DriverEntry>, vscode.Disposable {
  private readonly emitter = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.emitter.event;
  private readonly sub: { dispose(): void };

  constructor(private readonly app: Pick<App, 'drivers'>) {
    this.sub = app.drivers.onDidChange(() => this.emitter.fire());
  }

  dispose() {
    this.sub.dispose();
    this.emitter.dispose();
  }

  getChildren(): DriverEntry[] {
    return this.app.drivers.list();
  }

  getTreeItem(d: DriverEntry): vscode.TreeItem {
    const item = new vscode.TreeItem(d.displayName, vscode.TreeItemCollapsibleState.None);
    item.id = `driver/${d.id}/${d.state}`;
    item.contextValue = `driver.${d.state}`;
    const tip = new vscode.MarkdownString();
    tip.appendMarkdown(`**${d.displayName}** (\`${d.id}\`)\n\n`);
    if (d.description) tip.appendMarkdown(`${d.description}\n\n`);
    if (d.extensionId) tip.appendMarkdown(`Extension: \`${d.extensionId}\`\n\n`);

    switch (d.state) {
      case 'failed':
        item.description = 'failed to load';
        item.iconPath = new vscode.ThemeIcon('error', new vscode.ThemeColor('errorForeground'));
        tip.appendMarkdown('This driver\'s extension threw while activating:');
        tip.appendCodeblock(d.error ?? 'unknown error', 'text');
        break;
      case 'inactive':
        item.description = 'loading…';
        item.iconPath = treeIcon(d);
        tip.appendMarkdown('Installed, but it has not registered with Better SQLTools yet.');
        break;
      default: {
        item.description = [d.version ? `v${d.version}` : '', d.id].filter(Boolean).join(' · ');
        item.iconPath = treeIcon(d);
        const desc = d.descriptor!;
        const caps = Object.entries(desc.capabilities).filter(([, on]) => on).map(([k]) => k);
        tip.appendMarkdown(`Dialect for linting: \`${desc.dialect.sqlfluff ?? 'ansi'}\`\n\n`);
        tip.appendMarkdown(`Capabilities: ${caps.length ? caps.join(', ') : 'basic'}`);
      }
    }
    item.tooltip = tip;
    return item;
  }
}
