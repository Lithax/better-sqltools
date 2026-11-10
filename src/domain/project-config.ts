import type { ConnectionGroup, ConnectionProfile } from './model';
import { slugify } from './slug';

/** What a project config file (.better-sqltools.toml) can say, after it has been read and checked. */

export interface ConfigIssue {
  severity: 'error' | 'warning';
  message: string;
  /** The config file it is about (an opaque id, normally a URI string). */
  file: string;
  /** 1-based line, when known. */
  line?: number;
  /** Text to look for in the file to place the issue when the interpreter has no line. */
  needle?: string;
}

export interface ProjectGroup extends ConnectionGroup {
  file: string;
}

export interface ProjectConfig {
  /** Extension settings, flattened and without the "betterSqlTools." prefix: "results.maxRows" → 500. */
  settings: Record<string, unknown>;
  groups: ProjectGroup[];
  connections: ConnectionProfile[];
  issues: ConfigIssue[];
  /** The files that contributed, in load order. */
  files: string[];
}

export const emptyConfig = (): ProjectConfig => ({ settings: {}, groups: [], connections: [], issues: [], files: [] });

export interface InterpretContext {
  file: string;
  /** Keeps the ids of connections from different projects apart (e.g. a short hash of the folder). */
  scopeKey: string;
  /** Setting keys that exist, without the prefix. Unknown ones are reported. Leave out to accept anything. */
  knownSettings?: ReadonlySet<string>;
}

const isTable = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v) && !(v instanceof Date);
const text = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v.trim() : undefined);

const SECTIONS = ['project', 'settings', 'groups', 'connections'];
const GROUP_ID = /^[a-z0-9][a-z0-9._-]*$/i;
const PREFIX = 'betterSqlTools.';
const CONNECTION_KEYS = ['id', 'name', 'driver', 'group', 'options'];
const GROUP_KEYS = ['id', 'name', 'description', 'icon', 'color'];

/** Group ids are case-insensitive; anything that is not a plain id is slugified ("My Group" becomes "my-group"). */
export const toGroupId = (s: string): string => (GROUP_ID.test(s) ? s.toLowerCase() : slugify(s, 'group'));

function* flatten(obj: Record<string, unknown>, prefix = ''): Generator<[string, unknown]> {
  for (const [k, v] of Object.entries(obj)) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (isTable(v)) yield* flatten(v, key);
    else yield [key, v];
  }
}

const defined = <T extends object>(o: T): Partial<T> =>
  Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>;

/** Turns one parsed TOML document into settings, groups and connections, reporting what it could not use. */
export function interpretConfig(raw: unknown, ctx: InterpretContext): ProjectConfig {
  const out = emptyConfig();
  out.files.push(ctx.file);
  const issue = (severity: ConfigIssue['severity'], message: string, needle?: string) =>
    void out.issues.push({ severity, message, file: ctx.file, needle });

  if (!isTable(raw)) {
    issue('error', 'The file must be a TOML table.');
    return out;
  }
  for (const key of Object.keys(raw)) {
    if (!SECTIONS.includes(key)) issue('warning', `Unknown section "${key}" is ignored. Known sections: ${SECTIONS.join(', ')}.`, key);
  }

  // [project]: a name for the project, and the group its connections belong to by default
  const groups = new Map<string, ProjectGroup>();
  const addGroup = (g: ProjectGroup) => void groups.set(g.id, { ...groups.get(g.id), ...defined(g) } as ProjectGroup);
  let defaultGroup: string | undefined;
  if (raw.project !== undefined) {
    if (!isTable(raw.project)) {
      issue('error', '[project] must be a table.', 'project');
    } else {
      const name = text(raw.project.name);
      const group = text(raw.project.group);
      defaultGroup = group ? toGroupId(group) : name ? toGroupId(name) : undefined;
      if (defaultGroup && name) addGroup({ id: defaultGroup, name, file: ctx.file });
    }
  }

  // [settings]: any betterSqlTools.* setting, without the prefix
  if (raw.settings !== undefined) {
    if (!isTable(raw.settings)) {
      issue('error', '[settings] must be a table.', 'settings');
    } else {
      for (const [full, value] of flatten(raw.settings)) {
        const key = full.startsWith(PREFIX) ? full.slice(PREFIX.length) : full;
        if (ctx.knownSettings && !ctx.knownSettings.has(key)) {
          issue('warning', `Unknown setting "${full}" is ignored.`, full);
        } else {
          out.settings[key] = value;
        }
      }
    }
  }

  // [groups.id] or [[groups]] with an id; [[connections]] or [connections.id]
  const entries = (v: unknown, section: string): [string | undefined, unknown][] => {
    if (v === undefined) return [];
    if (Array.isArray(v)) return v.map((e) => [isTable(e) ? text(e.id) : undefined, e]);
    if (isTable(v)) return Object.entries(v);
    issue('error', `[${section}] must be a table of tables ([${section}.my-id]) or an array of tables ([[${section}]]).`, section);
    return [];
  };

  for (const [key, def] of entries(raw.groups, 'groups')) {
    if (!isTable(def)) {
      issue('error', `Group "${key ?? ''}" must be a table.`, key);
      continue;
    }
    if (!key || !GROUP_ID.test(key)) {
      issue('error', `Group id "${key ?? ''}" is not valid: use letters, digits, ".", "_" and "-".`, key);
      continue;
    }
    for (const k of Object.keys(def)) if (!GROUP_KEYS.includes(k)) issue('warning', `Group "${key}": unknown key "${k}" is ignored.`, k);
    addGroup({
      id: key.toLowerCase(),
      name: text(def.name) ?? groups.get(key.toLowerCase())?.name ?? key,
      description: text(def.description),
      icon: text(def.icon),
      color: text(def.color),
      file: ctx.file,
    });
  }

  const seen = new Set<string>();
  for (const [key, c] of entries(raw.connections, 'connections')) {
    if (!isTable(c)) {
      issue('error', 'A connection must be a table ([[connections]]).', 'connections');
      continue;
    }
    const name = text(c.name) ?? key;
    if (!name) {
      issue('error', 'A connection needs a "name".', 'connections');
      continue;
    }
    const driver = text(c.driver);
    if (!driver) {
      issue('error', `Connection "${name}": "driver" is required.`, name);
      continue;
    }
    for (const k of Object.keys(c)) {
      if (!CONNECTION_KEYS.includes(k)) issue('warning', `Connection "${name}": unknown key "${k}" is ignored (driver settings go under [connections.options]).`, k);
    }
    const options: Record<string, unknown> = {};
    if (c.options !== undefined) {
      if (!isTable(c.options)) {
        issue('error', `Connection "${name}": "options" must be a table.`, name);
      } else {
        for (const [k, v] of Object.entries(c.options)) {
          if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') options[k] = v;
          else issue('warning', `Connection "${name}": option "${k}" must be a string, number or boolean and is ignored.`, k);
        }
      }
    }
    const given = text(c.group);
    const group = given ? toGroupId(given) : defaultGroup;
    let id = `${slugify(text(c.id) ?? key ?? name, 'connection')}@${ctx.scopeKey}`;
    while (seen.has(id)) id += '_';
    seen.add(id);
    out.connections.push({ id, name, driver, options, scope: 'project', file: ctx.file, ...(group ? { group } : {}) });
  }
  out.groups = [...groups.values()];
  return out;
}


/**
 * Combines parsed files. With `wins: 'last'` a later part overrides an earlier one (the files of one folder:
 * the `.better-sqltools/` directory beats the root file); with `'first'` the earlier part wins (workspace
 * folders: the first folder is the primary one). Connections are never dropped, except when two parts
 * declare the very same connection.
 */
export function mergeConfigs(parts: ProjectConfig[], wins: 'last' | 'first' = 'last'): ProjectConfig {
  const out = emptyConfig();
  const byPriority = wins === 'last' ? parts : [...parts].reverse();
  const groups = new Map<string, ProjectGroup>();
  for (const p of byPriority) {
    Object.assign(out.settings, p.settings);
    for (const g of p.groups) groups.set(g.id, { ...groups.get(g.id), ...defined(g) } as ProjectGroup);
  }
  out.groups = [...groups.values()];

  const connections = new Map<string, ConnectionProfile>();
  for (const p of byPriority) {
    for (const c of p.connections) {
      if (connections.has(c.id)) {
        out.issues.push({ severity: 'warning', file: c.file ?? '', needle: c.name, message: `Connection "${c.name}" is declared in more than one file; the one in ${c.file} wins.` });
      }
      connections.set(c.id, c);
    }
  }
  // keep the order the files were given in
  const order = new Map<string, number>();
  parts.flatMap((p) => p.connections).forEach((c, i) => order.set(c.id, order.get(c.id) ?? i));
  out.connections = [...connections.values()].sort((a, b) => order.get(a.id)! - order.get(b.id)!);

  for (const p of parts) {
    out.issues.push(...p.issues);
    out.files.push(...p.files);
  }
  return out;
}
