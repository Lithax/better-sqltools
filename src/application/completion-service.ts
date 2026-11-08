import type { ConnectionId } from '../domain/model';
import { complete, type CompletionResult } from '../domain/sql/completion';
import type { ConnectionManager } from './connection-manager';
import type { SchemaService } from './schema-service';

/** Completion with the connection's dialect and cached catalog; never blocks on I/O. */
export class CompletionService {
  constructor(
    private readonly connections: ConnectionManager,
    private readonly schema: SchemaService,
  ) {}

  complete(connectionId: ConnectionId | undefined, text: string, offset: number): CompletionResult {
    const info = connectionId ? this.connections.info(connectionId) : undefined;
    const catalog = connectionId ? this.schema.cachedCatalog(connectionId) : undefined;
    if (connectionId && info?.state === 'connected' && !catalog) this.schema.warm(connectionId);
    return complete({ text, offset, catalog, dialect: info?.descriptor?.dialect });
  }
}
