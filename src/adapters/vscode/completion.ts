import * as vscode from 'vscode';
import type { CandidateKind } from '../../domain/sql/completion';
import type { App } from './app';

const KIND: Record<CandidateKind, vscode.CompletionItemKind> = {
  keyword: vscode.CompletionItemKind.Keyword,
  function: vscode.CompletionItemKind.Function,
  schema: vscode.CompletionItemKind.Module,
  table: vscode.CompletionItemKind.Class,
  view: vscode.CompletionItemKind.Interface,
  column: vscode.CompletionItemKind.Field,
};

/** Schema-aware completion for the connection the editor is bound to. Never blocks on the database. */
export class SqlCompletionProvider implements vscode.CompletionItemProvider {
  constructor(private readonly app: Pick<App, 'completion' | 'bindings' | 'settings'>) {}

  provideCompletionItems(doc: vscode.TextDocument, pos: vscode.Position): vscode.CompletionItem[] {
    if (!this.app.settings.completionEnabled()) return [];
    const res = this.app.completion.complete(this.app.bindings.effective(doc.uri), doc.getText(), doc.offsetAt(pos));
    const range = new vscode.Range(doc.positionAt(res.replaceStart), pos);
    return res.candidates.map((c, i) => {
      const item = new vscode.CompletionItem(c.label, KIND[c.kind]);
      item.insertText = c.insertText;
      item.range = range;
      item.detail = c.detail;
      item.sortText = `${c.group}_${String(i).padStart(5, '0')}`;
      return item;
    });
  }
}
