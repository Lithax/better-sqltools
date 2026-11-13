/**
 * The public surface for driver authors.
 *
 * A driver is a separate VS Code extension that depends on this one and registers a factory:
 *
 *   // package.json:  "extensionDependencies": ["better-sqltools.better-sqltools"],
 *   //                "keywords": ["better-sqltools-driver"]
 *   const api = await vscode.extensions.getExtension<BetterSqlToolsApi>('better-sqltools.better-sqltools')!.activate();
 *   context.subscriptions.push(api.registerDriver(new MyDriverFactory()));
 *
 * Nothing in here depends on VS Code, so drivers can be unit-tested in plain Node.
 */
import type { DriverFactory } from './application/ports';

export type {
  ChildrenOptions, Driver, DriverConfig, DriverEnvironment, DriverFactory, ExecutionContext, Logger, RawStatementResult,
} from './application/ports';
export type {
  ConnectionField, DialectInfo, DriverCapabilities, DriverDescriptor, DriverIcon, FieldType,
} from './domain/driver-descriptor';
export type {
  Catalog, CatalogColumn, CatalogTable, Column, ColumnKind, ColumnSource, DriverInspection, ForeignKeyRef, HealthStatus, InspectItem,
  InspectSection, NodeKind, SchemaNode,
} from './domain/model';

export interface BetterSqlToolsApi {
  /** Bumped on breaking changes to this surface. */
  readonly apiVersion: 1;
  /** Throws if the descriptor is invalid or the id is taken. Dispose to unregister. */
  registerDriver(factory: DriverFactory): { dispose(): void };
}
