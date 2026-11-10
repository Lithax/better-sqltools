# Project configuration

A project can carry Better SQLTools configuration next to its code, in TOML, so a teammate who opens the folder gets the
same connections, groups and settings without touching their own VS Code settings.

## Where it lives

In each workspace folder, either or both of:

* `.better-sqltools.toml` in the folder root
* a `.better-sqltools/` directory with any number of `*.toml` files (`connections.toml`, `dev.toml`, ...), read in name order

When both exist the directory's files are read after the root file and win where they overlap. With several workspace
folders, each folder is its own project: they all contribute their connections, and the **first** folder wins for
settings and groups. Edits are picked up as you save; *Better SQLTools: Reload Project Config* forces it.
*Better SQLTools: Create Project Config File* writes a commented starter file.

Nothing is read until the workspace is **trusted**, because these files can define connections and settings that run
programs (`lint.sqlfluffPath`).

## Format

```toml
[project]
name = "Arom backend"            # connections below are filed under a group with this name...
group = "arom-backend"           # ...or under this id, when you want an id that differs from the name

[groups.arom-backend]            # optional: give the group a look
name = "Arom backend"
description = "Everything for the Arom backend"
icon = "server"                  # a codicon id
color = "charts.blue"            # a theme colour id

[settings]                       # any betterSqlTools.* setting, without the prefix
"results.maxRows" = 5000
"lint.defaultDialect" = "postgres"

[[connections]]
name = "Arom dev"
driver = "sqlite"                # the driver's id, as shown in the Drivers view
group = "arom-backend"           # optional; defaults to the [project] group
[connections.options]            # whatever the driver's form asks for
path = "${workspaceFolder}/dev.db"
readOnly = true

[[connections]]
name = "Scratch"
driver = "sqlite"
group = "personal"               # a group nobody defined is fine: it exists as long as a connection uses it
[connections.options]
path = ":memory:"
```

### `[project]`

| Key | |
| --- | --- |
| `name` | Display name of the project's group. Also the group's id (lower-cased and slugified) unless `group` is given. |
| `group` | The id connections in this file belong to unless they say otherwise. |

### `[settings]`

Any setting from the *Settings* table in the README, without the `betterSqlTools.` prefix. Nested tables work:
`[settings.results]` with `maxRows = 5000` is the same as `"results.maxRows" = 5000`. A value here **wins over your
workspace and user settings**. Unknown keys are reported, and `connections` and `groups` are not settings here: use
`[[connections]]` and `[groups]`. Settings are read when they are needed, so a change applies to the next query,
connection or lint run; toggles that decorate editors (CodeLens) may need the editor reopened.

### `[groups.<id>]` or `[[groups]]`

| Key | |
| --- | --- |
| `id` | Letters, digits, `.`, `_` and `-`. The table name in `[groups.<id>]`; a key in `[[groups]]`. Case-insensitive. |
| `name` | Shown in the view. Defaults to the id. |
| `description` | Tooltip. |
| `icon` | A codicon id such as `server`, `database`, `cloud`. Default `folder`. |
| `color` | A theme colour id such as `charts.blue`. |

A group defined here and a group of the same id in your settings are merged, field by field, and the project's wins.

### `[[connections]]` or `[connections.<id>]`

| Key | |
| --- | --- |
| `name` | Required. Shown in the view. |
| `driver` | Required. A driver id. If it is not installed the connection is listed with a *driver not installed* flag. |
| `group` | A group id or name. |
| `id` | Optional stable id, for the rare case two connections share a name. Defaults to the name. |
| `options` | A table of strings, numbers and booleans, keyed like the driver's form fields. |

Behind the scenes a project connection gets an id like `arom-dev@3fa9c1`: the hash keeps same-named connections of
different projects, and their saved passwords, apart.

**Passwords never belong in this file.** Leave password fields out: you are asked on connect and VS Code remembers the
password in its secret storage. If a script needs the value, put an environment variable reference where the password
goes, for example `password = "${env:AROM_DB_PASSWORD}"`; if that variable is not set you are asked instead.

`${workspaceFolder}`, `${workspaceFolderBasename}`, `${userHome}`, `${cwd}`, `${env:NAME}` and a leading `~` are
expanded in option values.

## In the view

Connections and groups from a file show a *project* marker and their tooltip names the file. They are read-only in the UI:

* **Edit Connection** opens the file on that connection.
* **Delete**, **Rename Group** and **Delete Group** explain that the thing lives in a file and offer to open it. Dragging a
  project connection into another group just explains it.
* **Duplicate** makes an editable copy in your user settings.

## Problems

Mistakes are reported in the **Problems** panel, on the line they are about, and in the Better SQLTools output channel:
TOML syntax errors, a connection without a `driver`, an unknown setting, an option that is not a string, number or
boolean, the same connection declared in two files. A broken file does not stop the other files from loading.
