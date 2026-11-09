# Better SQLTools: SQLite Driver

SQLite for [Better SQLTools](../../README.md), through [sql.js](https://sql.js.org) (WebAssembly):
pure JavaScript, nothing native to install.

Install this extension next to Better SQLTools, then create a connection and pick **SQLite**.

## How it works, and what to know

- The whole database is loaded into memory and written back to the file after every statement that
  changed something. That is fine for development databases, and the wrong tool for large or shared files.
- It refuses to overwrite a file that changed on disk behind its back; reconnect to reload it.
- A running statement cannot be cancelled.
- Use `:memory:` for a throwaway database.

Connection options: database file, open read-only, create the file if it does not exist, enforce foreign keys.

## For driver authors

This extension is also the reference for writing drivers: see `docs/WRITING_A_DRIVER.md` in the repository.
It declares itself in `package.json` under `betterSqlTools.drivers` (so Better SQLTools can list and
icon it before it loads) and registers a factory from `activate()`.
