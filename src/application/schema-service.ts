import type { Catalog, CatalogTable, ConnectionId, SchemaNode } from '../domain/model';
import { errorMessage } from '../domain/errors';
import type { ConnectionManager } from './connection-manager';
import { Emitter } from './events';
import type { Driver, Logger } from './ports';

/** Builds a catalog for drivers that only implement `children`. */
export async function walkCatalog(driver: Driver, maxNodes = 5000): Promise<Catalog> {
  const tables: CatalogTable[] = [];
  const schemas = new Set<string>();
  let budget = maxNodes;

  const visit = async (parent: SchemaNode | undefined, schema: string | undefined): Promise<void> => {
    for (const n of await driver.children(parent)) {
      if (--budget < 0) return;
      if (n.kind === 'schema' || n.kind === 'database') {
        schemas.add(n.label);
        await visit(n, n.label);
      } else if (n.kind === 'folder') {
        await visit(n, schema);
      } else if (n.kind === 'table' || n.kind === 'view') {
        const cols = n.expandable ? (await driver.children(n)).filter((c) => c.kind === 'column') : [];
        tables.push({
          schema,
          name: n.label,
          kind: n.kind,
          columns: cols.map((c) => ({ name: c.label, type: c.description, primaryKey: c.primaryKey })),
        });
      }
    }
  };
  await visit(undefined, undefined);
  return { tables, schemas: [...schemas] };
}

export class SchemaService {
  private readonly catalogs = new Map<ConnectionId, Catalog>();
  private readonly loading = new Map<ConnectionId, Promise<Catalog>>();
  private readonly invalidated = new Emitter<ConnectionId>();
  readonly onDidInvalidate = this.invalidated.event;

  constructor(
    private readonly connections: ConnectionManager,
    private readonly logger: Logger,
  ) {
    connections.onDidChange((e) => {
      if (e.id && (e.state === 'disconnected' || e.state === 'error')) this.catalogs.delete(e.id);
      if (e.id && e.state === 'connected') this.warm(e.id);
    });
  }

  async children(id: ConnectionId, parent?: SchemaNode): Promise<SchemaNode[]> {
    return (await this.connections.ensure(id)).driver.children(parent);
  }

  async ddl(id: ConnectionId, node: SchemaNode): Promise<string | undefined> {
    const s = await this.connections.ensure(id);
    return s.driver.ddl?.(node);
  }

  cachedCatalog(id: ConnectionId): Catalog | undefined {
    return this.catalogs.get(id);
  }

  catalog(id: ConnectionId): Promise<Catalog> {
    const cached = this.catalogs.get(id);
    if (cached) return Promise.resolve(cached);
    const inflight = this.loading.get(id);
    if (inflight) return inflight;
    const p = (async () => {
      const { driver } = await this.connections.ensure(id);
      const cat = driver.catalog ? await driver.catalog() : await walkCatalog(driver);
      this.catalogs.set(id, cat);
      return cat;
    })().finally(() => this.loading.delete(id));
    this.loading.set(id, p);
    return p;
  }

  /** Load the catalog in the background so completion is ready by the time you type. */
  warm(id: ConnectionId): void {
    this.catalog(id).catch((e) => this.logger.warn(`Could not load schema for completion: ${errorMessage(e)}`));
  }

  invalidate(id: ConnectionId): void {
    this.catalogs.delete(id);
    this.invalidated.fire(id);
  }
}
