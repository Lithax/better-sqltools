# Changelog

## Unreleased

* **Results grid redesign.**
  * Headers show each column's type, with `PK` / `FK` / `UQ` pills and a tooltip with the constraint details, all taken from
    the driver; values are coloured and styled by type. `results.showTypes` and `results.colorByType` turn either off.
  * **Per-column filters** replace the single filter box: a funnel in each header (or Alt+Down) opens the column's
    distinct values with counts and a search; filters combine across columns, and the toolbar shows how many rows match
    and can clear them all.
  * Drag a column border to size it, double-click it to fit that column, and choose how all columns are sized from the
    column-width button (`results.columnFit`).
  * An *Export* dialog (CSV or JSON, copy or save) and a tab-separated *Copy* button, both for the rows as shown,
    filter and sort included.
  * The grid uses Microsoft's Codicons for its icons (licences in `media/codicons/`).

* **Edit rows in the results grid.** The grid starts locked; the lock button unlocks it when the result can be edited
  (one table, not a view, with its primary key selected, and a driver that supports editing: SQLite does). Double-click a
  cell or press Enter / F2, type, press Enter; Escape drops the change and a *NULL* button stores `NULL`. Values are checked
  against the column's type, precision, length and `NOT NULL` before they reach the database, and the grid then shows what
  the database actually stored. Computed, repeated and binary columns stay read-only, and the lock says why a whole
  result is. `results.editMode` chooses between saving every edit at once (`autoCommit`, the default) and `manual`:
  edits wait in a transaction, changed cells are marked, and *Commit* / *Roll back* in the toolbar end it. Running another
  statement over a result with edits waiting asks first; one connection holds one transaction.
* **Drivers can offer editing.** The optional `Driver.edit` (`update`, plus `begin` / `commit` / `rollback` for manual
  mode) builds the statement itself and must change exactly one row; `DriverEdit`, `RowChange` and `RowChangeResult` are
  part of the public API (see `docs/WRITING_A_DRIVER.md`). The SQLite driver implements it with a savepoint per edit.

* **Result columns know what they are.** A column read from a table carries its type, a driver-decided kind, and its
  constraints (primary key, not null, unique, foreign key, auto-increment, default), taken from the driver's catalog.
  Plain single-table `SELECT`s are traced to their table columns; anything the SQL makes unclear stays plain. A driver can
  report `source` itself. The SQLite driver now reports kinds, unique columns, foreign keys, defaults and the rowid alias.
  (The results grid shows these as type labels, pills and colours; editing uses them too.)
* **Query History view**: statements grouped by day (newest first) with connection, time, duration and a pass/fail icon;
  open, run again, copy, bookmark and delete (several at once) from inline buttons or the context menu; a filter that
  keeps entries containing every word typed. Replaces the quick pick as the main way to revisit a query (the palette
  command *Show Query History* remains).
* **Bookmarks**: *Bookmark Query* saves the selection or statement under the cursor with a name and its connection; a
  *Bookmarks* view and *Run Bookmarked Query…* bring it back. Stored in global state, so they follow you across workspaces.
* **Driver picker** in the connection form: a text field with a *Choose…* button opens a searchable grid of drivers with
  their icons, *Select* / *Cancel* and *Install more drivers…*. Drivers installed meanwhile appear live; unavailable ones
  are listed with the reason.
* Connection form: checkboxes and radios now match VS Code's own and line up with their labels (a CSS specificity clash
  had collapsed the label layout); search fields use the theme's icon colour for the clear button.
* **Drivers are plugins.** SQLite moved out of the core into its own extension (`drivers/sqlite`, `better-sqltools-sqlite`).
  Driver extensions declare themselves in `package.json` (`betterSqlTools.drivers`), are listed with their own icon before
  they load, are woken when a connection needs them, and are woken when installed at runtime.
* Extension icons (generated PNG) for the core and the SQLite driver; the welcome view points to *Find Drivers* when no
  driver is installed.
* **Groups.** File connections under groups; create, rename and delete them from the view, drag connections in, or use
  *Move to Group*.
* **Project configuration** in `.better-sqltools.toml` / `.better-sqltools/*.toml`: connections, groups and any
  setting, with problems reported in the Problems panel. See `docs/CONFIGURATION.md`.
* Inline passwords may use `${env:NAME}` and the other variables; an unset variable prompts instead of becoming an empty password.
* **Connections view** shows each driver's own icon and name (connected state as a coloured label), how many objects a
  folder holds and, optionally, rows per table. Each is a `betterSqlTools.explorer.*` setting.
* **Filter Objects** and **Search Objects** to find tables, views and columns in a large schema.
* **Inspect Connection**: uptime, session metrics (statements, errors, rows, timings) and driver-reported health. The
  SQLite driver reports version, size, integrity and foreign-key checks.

## 0.1.0

First build.

* Driver API with a registry; the SQLite driver (sql.js) is built on it. Other extensions can register drivers.
* Connection explorer, schema-driven connection form, secrets in secret storage, user or workspace scope.
* Run statement / selection / file, CodeLens, per-editor connections, history.
* Results panel with a virtualised grid, sorting, filtering, copy and CSV/JSON export.
* Schema-aware completion, sqlfluff diagnostics, quick fix and formatting.
