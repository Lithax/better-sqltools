import * as vscode from 'vscode';
import type { Logger } from '../../application/ports';

export class VsCodeLogger implements Logger, vscode.Disposable {
  readonly channel = vscode.window.createOutputChannel('Better SQLTools', { log: true });
  debug(m: string, ...a: unknown[]) { this.channel.debug(m, ...a); }
  info(m: string, ...a: unknown[]) { this.channel.info(m, ...a); }
  warn(m: string, ...a: unknown[]) { this.channel.warn(m, ...a); }
  error(m: string, ...a: unknown[]) { this.channel.error(m, ...a); }
  dispose() { this.channel.dispose(); }
}
