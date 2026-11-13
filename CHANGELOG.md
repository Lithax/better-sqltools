# Changelog

## Unreleased

* **Result columns know what they are.** A column read from a table carries its type, a driver-decided kind, and its
  constraints (primary key, not null, unique, foreign key, auto-increment, default), taken from the driver's catalog.
  Plain single-table `SELECT`s are traced to their table columns; anything the SQL makes unclear stays plain. A driver can
  report `source` itself. The SQLite driver now reports kinds, unique columns, foreign keys, defaults and the rowid alias.
  (The results grid will use this for type labels, colours and editing.)
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
