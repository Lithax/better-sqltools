import { randomBytes } from 'node:crypto';
import * as vscode from 'vscode';

/** The page shell for our webviews: strict CSP, theme-aware CSS, one script. Pages live in /media. */
export function webviewHtml(webview: vscode.Webview, extensionUri: vscode.Uri, page: 'results' | 'connection-form' | 'inspect', title: string): string {
  const nonce = randomBytes(16).toString('base64');
  const asset = (file: string) => webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'media', file));
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}'; img-src ${webview.cspSource} data:; font-src ${webview.cspSource};">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${title}</title>
<link rel="stylesheet" href="${asset('common.css')}">
<link rel="stylesheet" href="${asset(`${page}.css`)}">
</head>
<body>
<div id="root"></div>
<script nonce="${nonce}" src="${asset(`${page}.js`)}"></script>
</body>
</html>`;
}
