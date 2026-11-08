# Better SQLTools

A SQL client for VS Code built around a small, stable **driver API**: connection explorer, results grid, schema-aware
completion and sqlfluff linting, all native to the editor and themed by it. SQLite is built in. Everything else is meant
to arrive as separate driver extensions that plug into one registry.

> **Status: v0.1, an early build.** The core, the SQLite driver and the sqlfluff integration are covered by tests, and the
> whole extension is exercised end to end against a mocked VS Code API. It has **not yet been run inside a real VS Code
> window**, so expect some rough edges in the UI. See [Known limitations](#known-limitations).

## Try it

```bash
npm install
npm run seed:demo        # only needed if examples/demo/demo.db is missing
```

Open this folder in VS Code and press **F5**. A second window opens with the extension loaded and `examples/demo`
open (a small library database and a `queries.sql` to play with). Click **Demo library** in the Better SQLTools view,
open `queries.sql`, and press `Ctrl+Enter` (`Cmd+Enter` on a Mac) on a statement.

To install it for real: `npm run package`, then `code --install-extension better-sqltools-0.1.0.vsix`.

## What it does

* **Connections view.** Connections, then tables, views, indexes and triggers, then columns. Click a connection to connect;
  inline buttons and context menus for the rest. Tables get *Show data*, *Generate SELECT*, *Show DDL* and *Copy name*.
* **A connection form generated from the driver.** Each driver declares its fields (text, number, password, file, select,
  checkbox); the form, validation and *Test connection* come for free. Passwords go to VS Code's secret storage, never to
  settings. Connections are stored in `betterSqlTools.connections`, in user or workspace settings, so they sync and diff
  like any other setting. `${workspaceFolder}`, `${userHome}` and `${env:NAME}` are expanded.
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
* **Drivers.** A *Drivers* view lists what is installed. Connections whose driver is missing stay in the list, flagged,
  and come alive when it is installed. *Find Drivers* searches the Marketplace for extensions tagged
  `better-sqltools-driver`.

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
| `src/drivers` | domain, application ports | The built-in SQLite driver. No VS Code import |
| `src/adapters` | everything inward | VS Code UI and storage, the sqlfluff CLI adapter |
| `src/extension.ts` | everything | Composition root, and the exported API for driver extensions |
| `media/` | | The two webview pages (plain JS and CSS on VS Code theme variables) |

The built-in SQLite driver registers through the same `registerDriver` call a third-party driver uses. See
[docs/WRITING_A_DRIVER.md](docs/WRITING_A_DRIVER.md).

## Settings

| Setting | Default | |
| --- | --- | --- |
| `betterSqlTools.connections` | `[]` | Saved connections (no passwords). |
| `betterSqlTools.results.maxRows` | `1000` | Rows loaded per statement. |
| `betterSqlTools.connection.timeoutMs` | `30000` | Connect timeout; `0` waits forever. |
| `betterSqlTools.history.maxEntries` | `200` | Queries kept. |
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

## Development

```bash
npm install
npm run build        # esbuild → dist/extension.js (+ the sql.js WASM beside it)
npm run typecheck
npm test             # unit, integration, end to end (mocked VS Code), webviews (jsdom), production bundle
npm run package      # → better-sqltools-0.1.0.vsix
```

Before publishing, change `publisher` in `package.json` (driver extensions refer to this extension as
`<publisher>.better-sqltools`) and add a `repository` URL, so the relative links in this README resolve on the Marketplace.

Tests, and what they stand in for:

* `splitter`, `completion`, `export-value`: the SQL language logic, pure.
* `sqlite-driver`: the real driver on real files: persistence, transactions, read-only, foreign keys, stale-file guard.
* `application`: services against in-memory ports.
* `sqlfluff-linter`: the real sqlfluff CLI (skipped if it is not installed).
* `e2e`: the real `activate()` with only the `vscode` module mocked; the webviews are driven with the messages their pages send.
* `webviews`: both pages in jsdom, including XSS safety and virtual scrolling.
* `bundle`: the built `dist/extension.js`, not the sources.
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
