# Changelog

## Unreleased

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
