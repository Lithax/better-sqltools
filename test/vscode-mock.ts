/**
 * A deliberately explicit stand-in for the `vscode` module. It is not a catch-all proxy:
 * touching an API that is not mocked fails loudly, so gaps show up as test failures.
 */
import * as fs from 'node:fs';
import Module from 'node:module';
import * as path from 'node:path';

type Fn = (...a: any[]) => any;

class Emitter<T> {
  private ls = new Set<(e: T) => any>();
  event = (l: (e: T) => any) => {
    this.ls.add(l);
    return { dispose: () => void this.ls.delete(l) };
  };
  fire(e: T) { for (const l of [...this.ls]) l(e); }
  dispose() { this.ls.clear(); }
}

class Uri {
  constructor(readonly scheme: string, readonly path: string) {}
  static file(p: string) { return new Uri('file', p); }
  static parse(s: string) { const m = /^([a-z][a-z0-9+.-]*):(.*)$/i.exec(s)!; return new Uri(m[1], m[2]); }
  static joinPath(b: Uri, ...parts: string[]) { return new Uri(b.scheme, path.posix.join(b.path, ...parts)); }
  get fsPath() { return this.path; }
  toString() { return `${this.scheme}:${this.path}`; }
}

class Position {
  constructor(readonly line: number, readonly character: number) {}
}
class Range {
  readonly start: Position;
  readonly end: Position;
  constructor(a: number | Position, b: number | Position, c?: number, d?: number) {
    if (typeof a === 'number') { this.start = new Position(a, b as number); this.end = new Position(c!, d!); }
    else { this.start = a; this.end = b as Position; }
  }
}

class MockDocument {
  version = 1;
  constructor(public uri: Uri, public languageId: string, public text: string) {}
  getText(r?: Range) { return r ? this.text.slice(this.offsetAt(r.start), this.offsetAt(r.end)) : this.text; }
  get lineCount() { return this.text.split('\n').length; }
  offsetAt(p: Position) {
    const lines = this.text.split('\n');
    let off = 0;
    for (let i = 0; i < p.line; i++) off += lines[i].length + 1;
    return off + p.character;
  }
  positionAt(offset: number) {
    const before = this.text.slice(0, offset).split('\n');
    return new Position(before.length - 1, before[before.length - 1].length);
  }
  getWordRangeAtPosition(p: Position) {
    const line = this.text.split('\n')[p.line] ?? '';
    const re = /[A-Za-z0-9_]+/g;
    for (let m; (m = re.exec(line)); ) {
      if (p.character >= m.index && p.character <= m.index + m[0].length) return new Range(p.line, m.index, p.line, m.index + m[0].length);
    }
    return undefined;
  }
}

class Memento {
  private m = new Map<string, unknown>();
  get<T>(k: string, d?: T): T { return (this.m.has(k) ? this.m.get(k) : d) as T; }
  async update(k: string, v: unknown) { if (v === undefined) this.m.delete(k); else this.m.set(k, JSON.parse(JSON.stringify(v))); }
}

/** An installed extension as `vscode.extensions` shows it. */
export interface MockExtension {
  id: string;
  packageJSON: any;
  extensionUri: Uri;
  readonly isActive: boolean;
  activate(): Promise<unknown>;
}

export interface MockState {
  extensions: MockExtension[];
  commands: Map<string, Fn>;
  executed: [string, unknown[]][];
  treeProviders: Record<string, any>;
  treeViewOptions: Record<string, any>;
  webviewViewProviders: Record<string, any>;
  resultsMessages: any[];
  resultsHandler?: Fn;
  panels: MockPanel[];
  providers: { completion?: any; formatting?: any; codeActions?: any; codeLens?: any };
  diagnostics: Map<string, any[]>;
  statusBar: { text?: string; hidden?: boolean };
  messages: { kind: string; message: string; items: string[] }[];
  quickPickAnswers: (Fn | number | string | undefined)[];
  inputAnswers: (string | undefined)[];
  messageAnswers: (string | undefined)[];
  openDialogAnswers: string[];
  saveDialogAnswers: (string | undefined)[];
  config: { user: Record<string, unknown>; workspace: Record<string, unknown> };
  clipboard: string;
  documents: MockDocument[];
  activeEditor?: MockEditor;
  secrets: Map<string, string>;
  folder: string;
  logs: string[];
}

export class MockPanel {
  html = '';
  posted: any[] = [];
  handler?: Fn;
  disposed = false;
  private disposeEmitter = new Emitter<void>();
  constructor(readonly type: string, public title: string) {}
  webview = {
    cspSource: 'mock-csp:',
    options: {},
    asWebviewUri: (u: Uri) => u,
    postMessage: async (m: unknown) => { this.posted.push(m); return true; },
    onDidReceiveMessage: (cb: Fn) => { this.handler = cb; return { dispose() {} }; },
    set html(v: string) { (this as any)._html = v; },
    get html() { return (this as any)._html as string; },
  };
  onDidDispose = this.disposeEmitter.event;
  reveal() {}
  dispose() { this.disposed = true; this.disposeEmitter.fire(); }
  send(m: unknown) { return this.handler!(m); }
  last(type: string) { return [...this.posted].reverse().find((m) => m.type === type); }
}

export class MockEditor {
  selection: { active: Position; isEmpty: boolean; start: Position; end: Position };
  constructor(public document: MockDocument, cursorOffset = 0) {
    const p = document.positionAt(cursorOffset);
    this.selection = { active: p, isEmpty: true, start: p, end: p };
  }
  revealed?: Range;
  revealRange(r: Range) { this.revealed = r; }
  async edit(cb: (b: { replace(r: Range, t: string): void }) => void) {
    const doc = this.document;
    cb({ replace: (r, t) => { doc.text = doc.text.slice(0, doc.offsetAt(r.start)) + t + doc.text.slice(doc.offsetAt(r.end)); doc.version++; } });
    return true;
  }
}

export function installVscodeMock(folder: string) {
  const state: MockState = {
    commands: new Map(), executed: [], treeProviders: {}, treeViewOptions: {}, webviewViewProviders: {}, resultsMessages: [], panels: [],
    providers: {}, diagnostics: new Map(), statusBar: {}, messages: [], quickPickAnswers: [], inputAnswers: [],
    messageAnswers: [], openDialogAnswers: [], saveDialogAnswers: [], config: { user: {}, workspace: {} },
    clipboard: '', documents: [], secrets: new Map(), folder, logs: [], extensions: [],
  };
  const ev = {
    config: new Emitter<any>(), open: new Emitter<any>(), save: new Emitter<any>(), change: new Emitter<any>(),
    close: new Emitter<any>(), trust: new Emitter<void>(), activeEditor: new Emitter<any>(), extChange: new Emitter<void>(), fsChange: new Emitter<void>(),
  };
  let untitled = 0;
  const message = (kind: string) => async (msg: string, ...rest: any[]) => {
    const items = rest.filter((x) => typeof x === 'string');
    state.messages.push({ kind, message: msg, items });
    return state.messageAnswers.shift();
  };
  const answer = async (queue: any[], items: any[]) => {
    const a = queue.shift();
    if (typeof a === 'function') return a(items);
    if (typeof a === 'number') return items[a];
    if (typeof a === 'string') return items.find((i) => (i.label ?? i) === a || i.label?.includes?.(a));
    return a === undefined && queue.length === 0 && items.length ? items[0] : undefined;
  };
  const folderUri = Uri.file(folder);

  const vscode: any = {
    Uri, Position, Range, EventEmitter: Emitter,
    Disposable: class { constructor(private f: Fn) {} dispose() { this.f(); } },
    ThemeIcon: class { constructor(readonly id: string, readonly color?: unknown) {} },
    ThemeColor: class { constructor(readonly id: string) {} },
    FileType: { File: 1, Directory: 2, SymbolicLink: 64 },
    RelativePattern: class { constructor(readonly base: any, readonly pattern: string) {} },
    DataTransferItem: class { constructor(readonly value: unknown) {} async asString() { return JSON.stringify(this.value); } },
    Selection: class { constructor(readonly anchor: Position, readonly active: Position) {} },
    TextEditorRevealType: { Default: 0, InCenter: 1, InCenterIfOutsideViewport: 2, AtTop: 3 },
    TreeItem: class { id?: string; description?: string; tooltip?: unknown; contextValue?: string; iconPath?: unknown; command?: unknown; constructor(public label: string, public collapsibleState: number = 0) {} },
    MarkdownString: class { value = ''; constructor(v = '', readonly supportThemeIcons = false) { this.value = v; } appendMarkdown(s: string) { this.value += s; return this; } appendCodeblock(c: string) { this.value += c; return this; } },
    CodeLens: class { constructor(readonly range: Range, readonly command?: any) {} },
    CompletionItem: class { insertText?: string; range?: Range; detail?: string; sortText?: string; constructor(readonly label: string, readonly kind?: number) {} },
    Diagnostic: class { source?: string; code?: unknown; constructor(readonly range: Range, readonly message: string, readonly severity?: number) {} },
    CodeAction: class { diagnostics?: unknown[]; command?: unknown; constructor(readonly title: string, readonly kind?: unknown) {} },
    CodeActionKind: { QuickFix: { value: 'quickfix' } },
    TextEdit: { replace: (range: Range, newText: string) => ({ range, newText }) },
    TreeItemCollapsibleState: { None: 0, Collapsed: 1, Expanded: 2 },
    StatusBarAlignment: { Left: 1, Right: 2 },
    ConfigurationTarget: { Global: 1, Workspace: 2, WorkspaceFolder: 3 },
    DiagnosticSeverity: { Error: 0, Warning: 1, Information: 2, Hint: 3 },
    CompletionItemKind: { Function: 2, Field: 4, Class: 6, Interface: 7, Module: 8, Keyword: 13 },
    ProgressLocation: { Window: 10, Notification: 15 },
    ViewColumn: { Active: -1 },
    extensions: {
      get all() { return state.extensions; },
      getExtension: (id: string) => state.extensions.find((e) => e.id === id),
      onDidChange: ev.extChange.event,
    },

    commands: {
      registerCommand: (id: string, fn: Fn) => { state.commands.set(id, fn); return { dispose: () => state.commands.delete(id) }; },
      executeCommand: async (id: string, ...args: any[]) => {
        state.executed.push([id, args]);
        const fn = state.commands.get(id);
        if (fn) return fn(...args);
        const view = /^(.*)\.focus$/.exec(id)?.[1];
        const provider = view && state.webviewViewProviders[view];
        if (provider) {
          // VS Code creates and resolves the view when it is focused for the first time.
          const handlers: Fn[] = [];
          const wv = {
            options: {}, cspSource: 'mock-csp:', html: '', asWebviewUri: (u: Uri) => u,
            postMessage: async (m: unknown) => { state.resultsMessages.push(m); return true; },
            onDidReceiveMessage: (cb: Fn) => { state.resultsHandler = cb; handlers.push(cb); return { dispose() {} }; },
          };
          provider.resolveWebviewView({ webview: wv, show() {}, onDidDispose: () => ({ dispose() {} }) });
        }
        return undefined;
      },
    },

    window: {
      createOutputChannel: () => ({ debug: (m: string) => state.logs.push(m), info: (m: string) => state.logs.push(m), warn: (m: string) => state.logs.push(m), error: (m: string) => state.logs.push(m), show() {}, dispose() {} }),
      createTreeView: (id: string, o: any) => { state.treeProviders[id] = o.treeDataProvider; state.treeViewOptions[id] = o; return { dispose() {} }; },
      registerTreeDataProvider: (id: string, p: any) => { state.treeProviders[id] = p; return { dispose() {} }; },
      registerWebviewViewProvider: (id: string, p: any) => { state.webviewViewProviders[id] = p; return { dispose() {} }; },
      createStatusBarItem: () => ({
        set text(v: string) { state.statusBar.text = v; }, get text() { return state.statusBar.text ?? ''; },
        tooltip: '', command: '', show() { state.statusBar.hidden = false; }, hide() { state.statusBar.hidden = true; }, dispose() {},
      }),
      createWebviewPanel: (type: string, title: string) => { const p = new MockPanel(type, title); state.panels.push(p); return p; },
      get activeTextEditor() { return state.activeEditor; },
      onDidChangeActiveTextEditor: ev.activeEditor.event,
      showTextDocument: async (doc: MockDocument) => { state.activeEditor = new MockEditor(doc); ev.activeEditor.fire(state.activeEditor); return state.activeEditor; },
      showQuickPick: (items: any[]) => answer(state.quickPickAnswers, items),
      showInputBox: async () => state.inputAnswers.shift(),
      showInformationMessage: message('info'),
      showWarningMessage: message('warning'),
      showErrorMessage: message('error'),
      withProgress: async (_o: unknown, task: Fn) => task({ report() {} }, { isCancellationRequested: false, onCancellationRequested: () => ({ dispose() {} }) }),
      showOpenDialog: async () => { const p = state.openDialogAnswers.shift(); return p ? [Uri.file(p)] : undefined; },
      showSaveDialog: async () => { const p = state.saveDialogAnswers.shift(); return p ? Uri.file(p) : undefined; },
    },

    workspace: {
      workspaceFolders: [{ uri: folderUri, name: 'ws', index: 0 }],
      isTrusted: true,
      get textDocuments() { return state.documents; },
      getWorkspaceFolder: (u: Uri) => (u.path.startsWith(folder) ? { uri: folderUri, name: 'ws', index: 0 } : undefined),
      openTextDocument: async (arg: any) => {
        const doc = arg instanceof Uri
          ? new MockDocument(arg, 'sql', fs.existsSync(arg.fsPath) ? fs.readFileSync(arg.fsPath, 'utf8') : '')
          : new MockDocument(Uri.parse(`untitled:Untitled-${++untitled}`), arg.language ?? 'plaintext', arg.content ?? '');
        state.documents.push(doc);
        ev.open.fire(doc);
        return doc;
      },
      fs: {
        writeFile: async (u: Uri, bytes: Uint8Array) => fs.writeFileSync(u.fsPath, bytes),
        readFile: async (u: Uri) => new Uint8Array(fs.readFileSync(u.fsPath)),
        stat: async (u: Uri) => { const s = fs.statSync(u.fsPath); return { type: s.isDirectory() ? 2 : 1, size: s.size }; },
        createDirectory: async (u: Uri) => void fs.mkdirSync(u.fsPath, { recursive: true }),
        readDirectory: async (u: Uri) => fs.readdirSync(u.fsPath, { withFileTypes: true }).map((d) => [d.name, d.isDirectory() ? 2 : 1] as [string, number]),
      },
      createFileSystemWatcher: () => ({
        onDidCreate: ev.fsChange.event, onDidChange: ev.fsChange.event, onDidDelete: ev.fsChange.event, dispose() {},
      }),
      onDidChangeConfiguration: ev.config.event,
      onDidOpenTextDocument: ev.open.event,
      onDidSaveTextDocument: ev.save.event,
      onDidChangeTextDocument: ev.change.event,
      onDidCloseTextDocument: ev.close.event,
      onDidGrantWorkspaceTrust: ev.trust.event,
      onDidChangeWorkspaceFolders: new Emitter<void>().event,
      getConfiguration: (section: string) => {
        const full = (k: string) => `${section}.${k}`;
        return {
          get: (k: string, d?: unknown) => {
            const f = full(k);
            const v = f in state.config.workspace ? state.config.workspace[f] : state.config.user[f];
            return v === undefined ? d : v;
          },
          inspect: (k: string) => ({ globalValue: state.config.user[full(k)], workspaceValue: state.config.workspace[full(k)] }),
          update: async (k: string, v: unknown, target: number) => {
            const store = target === 2 ? state.config.workspace : state.config.user;
            if (v === undefined) delete store[full(k)];
            else store[full(k)] = JSON.parse(JSON.stringify(v));
            ev.config.fire({ affectsConfiguration: (s: string) => full(k) === s || full(k).startsWith(`${s}.`) || s.startsWith(`${full(k)}.`) });
          },
        };
      },
    },

    languages: {
      createDiagnosticCollection: () => ({
        set: (u: Uri, d: any[]) => state.diagnostics.set(u.toString(), d),
        delete: (u: Uri) => state.diagnostics.delete(u.toString()),
        dispose() {},
      }),
      registerCompletionItemProvider: (_s: unknown, p: any) => { state.providers.completion = p; return { dispose() {} }; },
      registerDocumentFormattingEditProvider: (_s: unknown, p: any) => { state.providers.formatting = p; return { dispose() {} }; },
      registerCodeActionsProvider: (_s: unknown, p: any) => { state.providers.codeActions = p; return { dispose() {} }; },
      registerCodeLensProvider: (_s: unknown, p: any) => { state.providers.codeLens = p; return { dispose() {} }; },
    },

    env: { clipboard: { writeText: async (t: string) => { state.clipboard = t; }, readText: async () => state.clipboard } },
  };

  const M = Module as any;
  const original = M._load;
  M._load = function (request: string, ...rest: unknown[]) {
    return request === 'vscode' ? vscode : original.call(this, request, ...rest);
  };

  const context = {
    extension: { packageJSON: require('../package.json') },
    subscriptions: [] as { dispose(): any }[],
    extensionUri: Uri.file(path.join(__dirname, '..')),
    globalState: new Memento(),
    workspaceState: new Memento(),
    secrets: {
      get: async (k: string) => state.secrets.get(k),
      store: async (k: string, v: string) => void state.secrets.set(k, v),
      delete: async (k: string) => void state.secrets.delete(k),
    },
  };

  return {
    vscode, state, context, events: ev,
    uninstall: () => { M._load = original; },
    /** Installs an extension the way VS Code lists it; `activate` runs at most once, on first use. */
    addExtension(spec: { id: string; packageJSON: any; activate: () => Promise<unknown> | unknown }): MockExtension {
      let started: Promise<unknown> | undefined;
      const e: MockExtension = {
        id: spec.id,
        packageJSON: spec.packageJSON,
        extensionUri: Uri.file(path.join(folder, '.mock-extensions', spec.id)),
        get isActive() { return started !== undefined; },
        activate: () => (started ??= Promise.resolve().then(spec.activate)),
      };
      state.extensions.push(e);
      ev.extChange.fire();
      return e;
    },
    /** Opens a SQL editor on `content` with the cursor at `cursor` (offset, or the marker `|` in content). */
    async openSql(content: string) {
      const offset = content.indexOf('|');
      const text = content.replace('|', '');
      const doc = await vscode.workspace.openTextDocument({ language: 'sql', content: text });
      state.activeEditor = new MockEditor(doc, offset < 0 ? 0 : offset);
      ev.activeEditor.fire(state.activeEditor);
      return { doc, editor: state.activeEditor };
    },
  };
}
