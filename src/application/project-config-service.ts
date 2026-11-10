import { errorMessage } from '../domain/errors';
import { emptyConfig, interpretConfig, mergeConfigs, type ConfigIssue, type ProjectConfig } from '../domain/project-config';
import { Emitter, type Disposable } from './events';
import type { Logger, ParseToml, ProjectConfigFile, ProjectConfigSource } from './ports';

/** Puts issues the interpreter could not place on the line where their text first appears. */
function locate(issues: ConfigIssue[], text: string): void {
  const lines = text.split(/\r?\n/);
  for (const i of issues) {
    if (i.line !== undefined || !i.needle) continue;
    // a dotted key may be spelled as a table plus its last segment, so fall back to that
    const candidates = [i.needle, i.needle.includes('.') ? i.needle.split('.').pop()! : ''].filter(Boolean);
    let at = -1;
    for (const n of candidates) {
      at = lines.findIndex((l) => l.includes(n));
      if (at >= 0) break;
    }
    i.line = at >= 0 ? at + 1 : 1;
  }
}

/**
 * Reads a project's TOML files, checks them and keeps the result current. Files of one workspace folder
 * are merged with the `.better-sqltools/` directory beating the root file; across folders the first folder wins
 * for settings and groups, and every folder contributes its connections.
 */
export class ProjectConfigService implements Disposable {
  private config: ProjectConfig = emptyConfig();
  private seq = 0;
  private timer?: ReturnType<typeof setTimeout>;
  private readonly changed = new Emitter<void>();
  readonly onDidChange = this.changed.event;
  private readonly sub: Disposable;

  constructor(
    private readonly source: ProjectConfigSource,
    private readonly parse: ParseToml,
    private readonly knownSettings: () => ReadonlySet<string> | undefined,
    private readonly logger: Logger,
    private readonly debounceMs = 60,
  ) {
    this.sub = source.onDidChange(() => this.schedule());
  }

  dispose(): void {
    this.sub.dispose();
    clearTimeout(this.timer);
  }

  current(): ProjectConfig {
    return this.config;
  }

  private schedule(): void {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.reload(), this.debounceMs);
  }

  async reload(): Promise<void> {
    clearTimeout(this.timer);
    const seq = ++this.seq;
    let files: ProjectConfigFile[];
    try {
      files = await this.source.read();
    } catch (e) {
      this.logger.error(`Could not read the project config: ${errorMessage(e)}`);
      files = [];
    }
    if (seq !== this.seq) return; // a newer reload is on its way

    const known = this.knownSettings();
    const perFolder = new Map<string, ProjectConfig[]>();
    for (const f of files) {
      const parsed = this.parse(f.text);
      let part: ProjectConfig;
      if (parsed.error) {
        part = emptyConfig();
        part.files.push(f.id);
        part.issues.push({ severity: 'error', message: parsed.error.message, file: f.id, line: parsed.error.line });
      } else {
        part = interpretConfig(parsed.value, { file: f.id, scopeKey: f.scopeKey, knownSettings: known });
        locate(part.issues, f.text);
      }
      const list = perFolder.get(f.scopeKey) ?? [];
      list.push(part);
      perFolder.set(f.scopeKey, list);
    }

    const merged = mergeConfigs([...perFolder.values()].map((parts) => mergeConfigs(parts, 'last')), 'first');
    // issues from the merge step (duplicates) have no line yet; they carry the connection name as a needle
    const texts = new Map(files.map((f) => [f.id, f.text]));
    for (const i of merged.issues) if (i.line === undefined && i.needle && texts.has(i.file)) locate([i], texts.get(i.file)!);

    this.config = merged;
    for (const i of merged.issues) {
      const where = `${decodeURIComponent(i.file.split('/').pop() ?? i.file)}${i.line ? `:${i.line}` : ''}`;
      (i.severity === 'error' ? this.logger.error : this.logger.warn).call(this.logger, `${where}: ${i.message}`);
    }
    this.changed.fire();
  }
}
