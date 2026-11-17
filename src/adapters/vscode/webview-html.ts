import { randomBytes } from 'node:crypto';
import * as vscode from 'vscode';

/** The page shell for our webviews: strict CSP, theme-aware CSS, the codicon font, and the page's scripts. Pages live in /media. */
export function webviewHtml(webview: vscode.Webview, extensionUri: vscode.Uri, page: 'results' | 'connection-form' | 'inspect', title: string): string {
  const nonce = randomBytes(16).toString('base64');
  const asset = (file: string) => webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'media', file));
  // the results page keeps its pure logic (value display, column fitting, sorting) in a file of its own, loaded first
  const scripts = (page === 'results' ? ['results-core.js', 'results.js'] : [`${page}.js`])
    .map((f) => `<script nonce="${nonce}" src="${asset(f)}"></script>`)
    .join('\n');
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}'; img-src ${webview.cspSource} data:; font-src ${webview.cspSource};">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${title}</title>
<link rel="stylesheet" href="${asset('codicons/codicon.css')}">
<link rel="stylesheet" href="${asset('common.css')}">
<link rel="stylesheet" href="${asset(`${page}.css`)}">
</head>
<body>
<div id="root"></div>
${scripts}
</body>
</html>`;
}
