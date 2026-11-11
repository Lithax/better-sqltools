# Better SQLTools

A SQL client for VS Code built around a small, stable **driver API**: connection explorer, results grid, schema-aware
completion and sqlfluff linting, all native to the editor and themed by it. Every database arrives as a **driver
extension** that plugs into one registry; a SQLite driver lives in this repository (`drivers/sqlite`) as the reference.

> **Status: v0.1, an early build.** The core, the SQLite driver and the sqlfluff integration are covered by tests, and the
> whole extension is exercised end to end against a mocked VS Code API. It has **not yet been run inside a real VS Code
> window**, so expect some rough edges in the UI. See [Known limitations](#known-limitations).

## Try it

```bash
npm install
npm run seed:demo        # only needed if examples/demo/demo.db is missing
```

Open this folder in VS Code and press **F5**. A second window opens with **both extensions loaded** (the core and the
SQLite driver) and `examples/demo` open (a small library database and a `queries.sql` to play with). Click **Demo library**
in the Better SQLTools view, open `queries.sql`, and press `Ctrl+Enter` (`Cmd+Enter` on a Mac) on a statement.

To install them for real: `npm run package` and `npm run package:sqlite`, then
`code --install-extension better-sqltools-0.1.0.vsix` and `code --install-extension drivers/sqlite/better-sqltools-sqlite-0.1.0.vsix`.

## What it does

* **Connections view.** Connections, then tables, views, indexes and triggers, then columns. Click a connection to connect;
  inline buttons and context menus for the rest. Tables get *Show data*, *Generate SELECT*, *Show DDL* and *Copy name*.
* **A connection form generated from the driver.** Each driver declares its fields (text, number, password, file, select,
  checkbox); the form, validation and *Test connection* come for free. Passwords go to VS Code's secret storage, never to
  settings. Connections are stored in `betterSqlTools.connections`, in user or workspace settings, so they sync and diff
  like any other setting. `${workspaceFolder}`, `${userHome}` and `${env:NAME}` are expanded.
* **A driver picker.** The form's *Driver* field is a text field with a **Choose…** button. It opens a searchable grid of
  drivers with their icons and names, with **Select**, **Cancel** and **Install more drivers…** (the Marketplace search
  for driver extensions). A driver installed while the picker is open appears in it; drivers that failed to load are
  listed, dimmed, with the reason.
* **Run SQL.** `Ctrl/Cmd+Enter` runs the statement under the cursor (or the selection), `Ctrl/Cmd+Shift+Enter` the whole
  file. A *Run* CodeLens sits above every statement. Each editor remembers its connection; the status bar and first-line
  CodeLens show it. A fresh editor uses the only live connection if there is exactly one, and asks when it would be a guess.
* **Results panel.** A virtualised grid in the bottom panel: sticky header, click-to-sort, row filter, `NULL` and numbers
  styled, copy a cell or the visible rows, export CSV or JSON. One tab per statement, errors shown in place, a row limit
  (`betterSqlTools.results.maxRows`) that the driver honours, and Cancel between statements.
* **Completion.** Tables, views, schemas, columns (after `alias.` or `table.`, or in `SELECT`/`WHERE`/`ON`/... from the
  tables in `FROM`), keywords and functions, in the connection's dialect. Fed from a catalog that is loaded after you
  connect and refreshed after DDL.
* **Linting and formatting with [sqlfluff](https://sqlfluff.com).** Diagnostics, a quick fix that applies every
  auto-fixable rule, and *Format Document*. The dialect comes from the editor's connection. Needs `pip install sqlfluff`;
  a missing install produces one notice, not an error per keystroke. Your project's `.sqlfluff` is honoured.
* **Drivers are plugins.** A driver is its own extension. It declares itself in its `package.json`
  (`betterSqlTools.drivers`: id, name, icon), so Better SQLTools can list it before it loads, wakes it when a connection
  needs it, and shows its icon. A *Drivers* view lists what is installed and what failed to load. Connections whose driver
  is missing stay in the list, flagged, and come alive when it is installed. *Find Drivers* searches the Marketplace for
  extensions tagged `better-sqltools-driver`.
* **Groups and project config.** File connections under groups ("personal", "global", "arom-backend"): create them
  from the view, drag connections in, or use *Move to Group*. A project can also carry its own configuration in a
  `.better-sqltools.toml` (or a `.better-sqltools/` folder of `*.toml` files): connections, groups and any extension
  setting, versioned with the code. See [docs/CONFIGURATION.md](docs/CONFIGURATION.md).
* **Finding things.** *Filter Objects* (the filter icon in the Connections view) narrows the tree to objects whose name
  matches; plain text matches anywhere and `*` / `?` are wildcards. *Search Objects* is a quick pick over every table,
  view and column of a connection, with *Show data*, *Generate SELECT* and *Copy name* for the pick.
* **Inspect connection.** A page with the connection's uptime, what the core measured since connecting (statements, errors,
  rows, timings, a ping where the driver can) and whatever the driver reports about its database: for SQLite the version,
  size, integrity and foreign-key checks. It refreshes while visible.
* **A tree you can tune.** A connection shows its driver's own icon and the driver's name, with connected state as a
  coloured label like Git status. Folders show how many objects they hold, and tables can show their row count. Each of
  these is a setting (`betterSqlTools.explorer.*`).

## Architecture

Ports and adapters. Dependencies point inward only, and `test/architecture.test.ts` fails the build if they do not.

```
  driving adapters (VS Code)                                 driven adapters
  commands · trees · CodeLens · completion · status bar      settings · SecretStorage · globalState
  results + form webviews · diagnostics · formatter          sqlfluff CLI · output channel
                          │                                              ▲
                          ▼                                              │
        ┌────────────────────────── application ──────────────────────────┐
        │ ConnectionManager  QueryService  SchemaService  LintService     │
        │ CompletionService  DriverRegistry     ports.ts                  │
        └──────────────────────────────▲──────────────────────────────────┘
                                       │ implements Driver / DriverFactory
                      drivers/sqlite  ·  third-party driver extensions
  domain: model · SQL tokenizer, statement splitter, completion · validation · export   (pure TypeScript)
```

| Folder | Depends on | Holds |
| --- | --- | --- |
| `src/domain` | nothing | Profiles, results, schema model, driver descriptor, SQL tokenizer/splitter/completion, validation, CSV/JSON export |
| `src/application` | domain | Use cases and **ports**: the `Driver` SPI plus profile store, secret store, history, settings, linter |
| `src/adapters` | everything inward | VS Code UI and storage, the sqlfluff CLI adapter |
| `drivers/*` | `src/api` only | One folder per driver extension, each with its own `package.json`. `drivers/sqlite` is the SQLite driver. No core imports beyond the public API |
| `src/extension.ts` | everything | Composition root, and the exported API for driver extensions |
| `media/` | | The two webview pages (plain JS and CSS on VS Code theme variables) |

The SQLite driver is a separate extension that registers through the same `registerDriver` call every third-party driver
uses. See [docs/WRITING_A_DRIVER.md](docs/WRITING_A_DRIVER.md).

## Settings

| Setting | Default | |
| --- | --- | --- |
| `betterSqlTools.connections` | `[]` | Saved connections (no passwords). |
| `betterSqlTools.groups` | `[]` | Groups the connections are filed under. |
| `betterSqlTools.results.maxRows` | `1000` | Rows loaded per statement. |
| `betterSqlTools.connection.timeoutMs` | `30000` | Connect timeout; `0` waits forever. |
| `betterSqlTools.history.maxEntries` | `200` | Queries kept. |
| `betterSqlTools.explorer.driverIcons` | `true` | The driver's icon in front of a connection instead of the green database icon. |
| `betterSqlTools.explorer.showDriverName` | `true` | The driver's name after the connection's. |
| `betterSqlTools.explorer.showCounts` | `true` | How many objects a folder holds. |
| `betterSqlTools.explorer.showRowCounts` | `false` | Rows per table. Costs one query per table, so it is off by default. |
| `betterSqlTools.codeLens.enabled` | `true` | *Run* lenses and the connection lens. |
| `betterSqlTools.completion.enabled` | `true` | Schema-aware completion. |
| `betterSqlTools.lint.enabled` | `true` | sqlfluff diagnostics. |
| `betterSqlTools.lint.run` | `onSave` | `onSave`, `onType` or `manual`. |
| `betterSqlTools.lint.severity` | `warning` | How style issues show. Parse errors are always errors. |
| `betterSqlTools.lint.defaultDialect` | `ansi` | Dialect for editors without a connection. |
| `betterSqlTools.lint.sqlfluffPath` | | Path to the executable; empty uses `PATH`. |
| `betterSqlTools.lint.sqlfluffArgs` | `[]` | Extra arguments, e.g. `["--config", "..."]`. They win over ours. |

**Workspace trust.** Linting runs an external program and workspace-defined connections can point anywhere, so in an
untrusted workspace linting is off and `connections`, `sqlfluffPath` and `sqlfluffArgs` from workspace settings are ignored.
A project's `.better-sqltools.toml` is not read at all until the workspace is trusted.

**Precedence.** A value in a project's `[settings]` wins over workspace settings, which win over user settings.

## Development

```bash
npm install
npm run build        # esbuild → dist/extension.js, and drivers/sqlite/dist (+ the sql.js WASM beside it)
npm run typecheck
npm test             # unit, integration, end to end (mocked VS Code), webviews (jsdom), production bundles
npm run package      # → better-sqltools-0.1.0.vsix
npm run package:sqlite   # → drivers/sqlite/better-sqltools-sqlite-0.1.0.vsix
npm run icons        # regenerates the PNG extension icons (no image library needed)
```

Before publishing, change `publisher` in both `package.json` files (driver extensions refer to the core as
`<publisher>.better-sqltools`) and check the `repository` URL.

Tests, and what they stand in for:

* `splitter`, `completion`, `export-value`: the SQL language logic, pure.
* `sqlite-driver` (in `drivers/sqlite/test`): the real driver on real files: persistence, transactions, read-only, foreign keys, stale-file guard.
* `driver-directory`, `driver-manifests`: lazy activation of driver extensions, and their `package.json` manifests.
* `application`: services against in-memory ports.
* `sqlfluff-linter`: the real sqlfluff CLI (skipped if it is not installed).
* `e2e`: the real `activate()` with only the `vscode` module mocked; the webviews are driven with the messages their pages send.
* `webviews`: both pages in jsdom, including XSS safety and virtual scrolling.
* `bundle`: the built `dist/extension.js` and the SQLite driver bundle, not the sources.
* `manifest`, `architecture`, `docs`: commands, menus and settings agree; layers stay layered; the driver guide matches its template.

## Known limitations

* **Not yet seen in a real editor.** Everything is verified against `@types/vscode` 1.90 and a mock, which cannot catch layout,
  theming or focus problems.
* **SQLite is sql.js (WebAssembly).** It keeps the whole database in memory and writes the file after each change, so it is
  meant for development databases. A statement cannot be cancelled mid-run and blocks the extension host while it runs.
  Integers beyond 2^53 lose precision. If the file changes on disk behind its back, the driver refuses to overwrite it and
  tells you to reconnect. A native SQLite driver would be a better fit for large or shared files.
* **No other databases yet.** PostgreSQL, MySQL, SQL Server and friends are separate driver extensions that do not exist yet.
* **No language server.** sqlfluff has no LSP mode in the version tested (4.x), so linting shells out to its CLI behind a
  `Linter` port; an LSP adapter could slot in there. Completion runs in-process and is deliberately simple: it does not
  look into subqueries or CTEs, does not complete inside quoted identifiers, and offers no signature help.
* **Statement splitting** does not understand `GO` batch separators, MySQL's `DELIMITER`, or Oracle anonymous `BEGIN … END;` blocks.
* **Results are read-only**, export covers the loaded rows (up to the row limit), columns cannot be resized, and results are
  not pinned between runs.
* `${workspaceFolder}` means the first workspace folder.

## Roadmap

Driver extensions (PostgreSQL, MySQL/MariaDB, SQL Server, DuckDB); a worker thread or native binding for SQLite; CTE- and
subquery-aware completion; `source.fixAll` code action for fix-on-save; pinned and side-by-side results; SSH tunnelling as a
driver-independent feature; publishing the API types as a package.

## License

MIT
