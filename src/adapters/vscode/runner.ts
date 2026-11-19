import * as vscode from 'vscode';
import type { ConnectionManager } from '../../application/connection-manager';
import type { QueryService } from '../../application/query-service';
import { CancelledError, errorMessage } from '../../domain/errors';
import type { ConnectionId } from '../../domain/model';
import type { ResultsView } from './results-view';

/** Runs SQL and drives the results panel through running → done / error. */
export class QueryRunner {
  private current?: AbortController;
  private seq = 0;

  constructor(
    private readonly deps: { queries: QueryService; connections: ConnectionManager; results: ResultsView },
  ) {}

  async run(connectionId: ConnectionId, sql: string): Promise<void> {
    const { queries, connections, results } = this.deps;
    const name = connections.info(connectionId)?.profile.name ?? connectionId;

    // edits made in the grid and not committed yet are the person's to settle before the result is replaced
    if (!(await results.resolvePending())) return;
    this.current?.abort(); // a newer run supersedes an older one (stops its remaining statements)
    const abort = (this.current = new AbortController());
    const mine = ++this.seq;

    results.showRunning(name, sql, abort);
    await results.reveal();
    await vscode.window.withProgress({ location: vscode.ProgressLocation.Window, title: `Running on ${name}` }, async () => {
      try {
        const result = await queries.run(connectionId, sql, { signal: abort.signal });
        if (mine === this.seq) results.showResult(result);
      } catch (e) {
        if (mine !== this.seq) return;
        if (e instanceof CancelledError) results.showIdle();
        else {
          results.showError(name, errorMessage(e));
          throw e;
        }
      }
    });
  }
}
