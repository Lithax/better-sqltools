import type * as vscode from 'vscode';
import type { CompletionService } from '../../application/completion-service';
import type { ConnectionManager } from '../../application/connection-manager';
import type { DriverDirectory } from '../../application/driver-directory';
import type { DriverRegistry } from '../../application/driver-registry';
import type { HistoryRepository } from '../../application/ports';
import type { LintService } from '../../application/lint-service';
import type { QueryService } from '../../application/query-service';
import type { SchemaService } from '../../application/schema-service';
import type { EditorBindings } from './bindings';
import type { LintController } from './diagnostics';
import type { VsCodeLogger } from './logger';
import type { VsCodeSecretStore } from './secret-store';
import type { SettingsProfileRepository } from './profile-repository';
import type { QueryRunner } from './runner';
import type { VsCodeSettings } from './settings';

/** Everything the VS Code adapters share. Built once in extension.ts. */
export interface App {
  context: vscode.ExtensionContext;
  logger: VsCodeLogger;
  settings: VsCodeSettings;
  registry: DriverRegistry;
  drivers: DriverDirectory;
  connections: ConnectionManager;
  schema: SchemaService;
  queries: QueryService;
  completion: CompletionService;
  lint: LintService;
  profiles: SettingsProfileRepository;
  secrets: VsCodeSecretStore;
  history: HistoryRepository;
  bindings: EditorBindings;
  runner: QueryRunner;
  linting: LintController;
}
