<!--
  Copyright NorthernCaptain, 2026
  MIT license.
-->

# Command Center: notes for coding agents

A personal tool (not a company product): a local web UI, a center agent and
herdr worker agents that help one person run their tasks. MIT licensed, see
[LICENSE](LICENSE).

## Copyright header

Every source file starts with this notice, in the file's comment syntax.
It replaces any other copyright rule you may have (company name, "All rights
reserved", author lines): none of those belong in this project.

```js
/**
 * Copyright NorthernCaptain, 2026
 * MIT license.
 */
```

```bash
#!/usr/bin/env bash
# Copyright NorthernCaptain, 2026
# MIT license.
```

```html
<!--
  Copyright NorthernCaptain, 2026
  MIT license.
-->
```

No header in JSON or XML data files. When you change a file, keep its
header as above (fix it if it differs).

## Conventions

- Node 22 ESM, plain JS + JSDoc, zod 4, pino, Express 5, better-sqlite3;
  web: Vite + React 19.
- Jest tests next to the code (`x.test.js` / `x.test.jsx`), at least 90%
  line coverage; mock external processes and APIs (everything external
  goes through an injected function). Server: `jest.config.js`
  (`NODE_OPTIONS=--experimental-vm-modules`), web: `jest.web.config.js`.
- Prettier: 4 spaces, no semicolons, double quotes. ESLint clean.
- Shell scripts: macOS-compatible bash (BSD userland), `#!/usr/bin/env bash`.
  No Python.
- Nothing identifying in the repo: hostnames, logins, emails, org names,
  Asana gids and paths go in `~/.config/command-center/config.json`
  (see [`config.example.json`](config.example.json)); tests and docs use
  fake values (`acme`, `example.com`).
- Task data lives in its own private git repo (`tasksDir`), never in this
  one.
