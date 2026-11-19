# Writing a driver

A driver is a small object that knows how to talk to one kind of database. It lives in **its own VS Code
extension**, so it can bring native modules, a bundled client library, its own release cycle and its own
maintainers, and nothing about it has to ship with Better SQLTools.

The contract has three parts:

| Part | What it is |
| --- | --- |
| `DriverDescriptor` | Static data: id, name, SQL dialect, capabilities and the **connection schema** the form is generated from. |
| `DriverFactory` | `create({ options, secrets }, env)` returns a `Driver`. |
| `Driver` | `open`, `close`, `execute` (one statement), `children` (the tree), plus optional `catalog`, `ddl` and `edit`. |

All types come from [`src/api.ts`](../src/api.ts). They are structural and contain no VS Code imports, so a driver can
also be written in plain JavaScript and unit-tested in plain Node.

## The whole thing in about 70 lines

`examples/driver-template/driver.ts` is type-checked with the rest of the project and exercised by a test.

```ts
import type { Driver, DriverDescriptor, DriverFactory, SchemaNode } from '../../src/api';

/** A toy driver that "executes" SQL by echoing it back. It exists to show every moving part. */
export const descriptor: DriverDescriptor = {
  id: 'example.echo', // stable and unique; prefix it with your own name
  displayName: 'Echo (example)',
  description: 'Echoes every statement back as a row.',
  icon: 'comment', // a codicon name, or an image path inside your extension ("media/echo.svg")
  dialect: {
    sqlfluff: 'ansi', // which sqlfluff dialect lints this driver's SQL
    identifierQuote: { open: '"', close: '"' },
    limit: 'limit', // how "select the first N rows" is spelled
  },
  capabilities: { catalog: true },
  // The connection form is generated from this. You ship no UI.
  connectionSchema: [
    { key: 'greeting', label: 'Greeting', type: 'string', default: 'hello' },
    { key: 'token', label: 'API token', type: 'password', required: true }, // kept in secret storage
  ],
};

const tables: SchemaNode[] = [
  { id: 'table:echoes', kind: 'table', label: 'echoes', expandable: true, qualifiedName: '"echoes"' },
];

class EchoDriver implements Driver {
  constructor(
    private readonly greeting: string,
    private readonly token: string,
  ) {}

  async open() {
    if (!this.token) throw new Error('An API token is required.'); // thrown messages are shown to the user
  }

  async close() {}

  // The core splits scripts, so this always receives exactly one statement.
  async execute(sql: string) {
    return { columns: [{ name: 'greeting' }, { name: 'statement' }], rows: [[this.greeting, sql]] };
  }

  // Top level when `parent` is undefined, otherwise the children of that node.
  async children(parent?: SchemaNode): Promise<SchemaNode[]> {
    if (!parent) return tables;
    if (parent.id === 'table:echoes') {
      return ['greeting', 'statement'].map((name) => ({ id: `column:${name}`, kind: 'column' as const, label: name, description: 'TEXT', expandable: false }));
    }
    return [];
  }

  // Optional: one call that feeds completion, instead of the core walking children().
  async catalog() {
    return { tables: [{ name: 'echoes', kind: 'table' as const, columns: [{ name: 'greeting', type: 'TEXT' }, { name: 'statement', type: 'TEXT' }] }] };
  }
}

export class EchoDriverFactory implements DriverFactory {
  readonly descriptor = descriptor;

  create({ options, secrets }: Parameters<DriverFactory['create']>[0]) {
    return new EchoDriver(String(options.greeting), secrets.token ?? '');
  }
}
```

## Registering it

```ts
import * as vscode from 'vscode';
import type { BetterSqlToolsApi } from '../../src/api';
import { EchoDriverFactory } from './driver';

export async function activate(context: vscode.ExtensionContext) {
  // "extensionDependencies" in package.json guarantees Better SQLTools is installed and activates first.
  const api = await vscode.extensions.getExtension<BetterSqlToolsApi>('better-sqltools.better-sqltools')!.activate();
  context.subscriptions.push(api.registerDriver(new EchoDriverFactory()));
}
```

and in the driver extension's `package.json`:

```json
{
  "extensionDependencies": ["better-sqltools.better-sqltools"],
  "keywords": ["better-sqltools-driver"],
  "activationEvents": [],
  "betterSqlTools": {
    "drivers": [
      {
        "id": "example.echo",
        "name": "Echo (example)",
        "description": "Echoes every statement back as a row.",
        "icon": "media/echo.svg"
      }
    ]
  }
}
```

The `betterSqlTools.drivers` entry is how Better SQLTools finds your driver **without loading it**: it lists it in the
*Drivers* view and the driver picker, draws its `icon`, and activates your extension the first time a connection needs it
(or when it starts, for drivers already installed). So keep `activationEvents` empty and `activate()` light: register the
factory, and load heavy libraries inside `create()` or `open()`. `id` must match your descriptor's `id`. `icon` is a
codicon name or a path to an image in your extension (`{ "light": "…", "dark": "…" }` for per-theme images); the
descriptor's `icon` takes the same values.

The `better-sqltools-driver` keyword is what the **Find Drivers** button searches the Marketplace for. Replace the
publisher in the extension id with the one you publish under. `drivers/sqlite` in this repository is a complete,
real-world example.

`registerDriver` throws if the descriptor is invalid or the id is already taken, and returns a disposable that
unregisters the driver again. Connections that point at a driver that is not installed stay in the list, marked as such,
and come alive when the driver appears.

## What the core does for you

* **Statement splitting.** `execute` always receives one statement. The splitter understands strings, comments, quoted
  identifiers, dollar quoting (`dialect.dollarQuoting`), backslash escapes (`dialect.backslashEscapes`), `#` comments
  (`dialect.hashComments`) and `BEGIN … END` bodies of triggers and routines.
* **Value normalisation.** Return raw values. `bigint`, `Date`, `Buffer`/`Uint8Array` and objects are made JSON-safe
  and displayable by the core; `null` stays `null`.
* **Row limits.** Stop reading after `ctx.maxRows` rows and set `truncated: true`.
* **Validation, defaults and `${variables}`.** Options arrive validated against your schema, with defaults applied and
  `${workspaceFolder}`, `${userHome}` and `${env:NAME}` already expanded. Resolve relative paths with `env.resolvePath`.
* **Secrets.** Every `password` field is kept in VS Code's secret storage and arrives in `secrets`, never in `options`.
  If a `required` password is missing the user is asked at connect time.
* **Timeouts and errors.** `open()` is raced against `betterSqlTools.connection.timeoutMs`; whatever you throw is shown
  as-is, so make messages useful.
* **Completion.** Implement `catalog()` to feed completion in one call; otherwise the core walks `children()` (tables
  and views with `column` children) and builds the catalog itself.

## Tree nodes

`children()` returns `SchemaNode`s. `kind` picks the icon and the context menu (`table` and `view` get *Show data*,
*Generate SELECT* and *Show DDL*). Give tables and views a `qualifiedName` that is already quoted for your dialect; it is
pasted into generated SQL. `id` must be unique within the connection. `data` is yours: it is handed back to you untouched
in later `children()` and `ddl()` calls.

## Describing columns

Results, completion and editing all lean on what the driver knows about columns. All of it is optional: leave out what you
do not know, and never invent it.

* In `catalog()` a column can carry `type` (as the database spells it), `kind`, `primaryKey`, `nullable`, `unique` (on its
  own, not as part of a composite constraint), `autoIncrement` (the database fills it in), `defaultValue` (as the
  database prints it) and `foreignKey` (`{ table, column?, schema? }`).
* `kind` is yours to decide: `integer`, `decimal`, `text`, `boolean`, `datetime`, `binary`, `json` or `other`. It drives
  alignment and colour in the results grid. The core never guesses it from a type name, because only the driver knows that
  its `NUMBER(10,2)` is a decimal and its `TINYINT(1)` a boolean.
* A column in the result of `execute()` can carry the same facts, plus `source: { schema?, table, column }` when your
  protocol says where a result column comes from (most server databases do). The core uses that as it is.
* Without a `source`, the core works it out for a plain single-table `SELECT` from the SQL and your catalog, and leaves
  everything else (expressions, aggregates, subqueries) without extra facts. A driver that only implements `catalog()`
  therefore already gets typed, constraint-aware results for simple queries.

## Editing rows

Give the driver an optional `edit` object and the results grid can change rows. Leave it out and results stay read-only.
The core decides *whether* a result is editable (one table that is not a view, with its primary key among the selected
columns, so `catalog()` and the column facts above matter) and checks every value against the column's type before it
calls you. You decide *how* the change is written, because quoting, literals and parameters are your database's business.

```ts
edit: {
  // One row: found by the values of its primary key, then the listed columns are set.
  // change = { table: { schema?, name }, key: [{ column, value }], set: [{ column, value }] }
  async update(change) {
    const changed = await runUpdate(change);        // your own UPDATE ... WHERE <key> = ...
    if (changed !== 1) throw new Error(`${changed} rows would change, expected exactly 1`); // after undoing the statement
    return { affectedRows: 1, values: await readBack(change) };   // `values` is optional
  },
  // Optional, all three or none: lets the person keep edits pending (`results.editMode` = `manual`).
  async begin() {},
  async commit() {},
  async rollback() {},
},
```

* `update` must change **exactly one row** or change nothing and reject; the grid never sends a statement that could touch
  more. `set` and `key` use table column names, never result aliases.
* Return `values` (the columns just set, as the database now holds them) when it can convert or default what was stored;
  the grid then shows those values instead of what was typed.
* With `begin`, `commit` and `rollback`, the first edit in manual mode calls `begin`, later `update`s join that
  transaction, and nothing is final until `commit`. Make `commit` and `rollback` safe to call with no transaction open, so
  a half-failed commit cannot leave the connection stuck. Without them each edit is final at once and the grid says so.
* In manual mode the core keeps one open transaction per connection: while one result has edits waiting, a second result of
  the same connection cannot edit, so `begin` is not called again before `commit` or `rollback`.

## Capabilities

`capabilities` is advisory today (shown in the Drivers view). Implementing the optional methods is what enables the
features: `catalog` speeds up completion, `ddl` enables *Show DDL*, `edit` enables editing in the results grid.

## Testing

Because the API is plain TypeScript, test a driver without VS Code:

```ts
const driver = new MyFactory().create({ options: { host: 'localhost' }, secrets: { password: 'x' } }, env);
await driver.open();
const r = await driver.execute('select 1', { maxRows: 100 });
```

`test/sqlite-driver.test.ts` in this repository is a worked example, including transactions, truncation and error
paths. `test/e2e.test.ts` shows how a third-party driver is registered through the public API.

## Gotchas

* Do not enable `multipleStatements` or similar: statements arrive one at a time on purpose.
* Honour `ctx.signal` if your client can cancel. Between statements the core checks it for you.
* A driver that cannot cancel (like the bundled SQLite one, which is synchronous WASM) blocks the extension host for the
  duration of a statement. Prefer async clients.
* Native modules must match VS Code's Electron ABI, or be shipped as prebuilt binaries per platform. That is the part of
  driver work that is hard, and the reason drivers are separate extensions.
