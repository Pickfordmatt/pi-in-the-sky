<p align="center"><img src="public/logo.svg" width="112" alt="Pi In The Sky logo: an outline cloud with a π inside"></p>

# Pi In The Sky (PITS)

*No pipe dream. Still flying when you close the tab.*

Pi In The Sky, or PITS for short (npm package name `ohmypi-web`), is a server-hosted web front end for [oh-my-pi](https://github.com/can1357/oh-my-pi) (`omp`), built for remote development.

Everything runs on the server through your installed `omp`. The browser is only a view, so tasks keep working when the
tab is closed, the laptop sleeps, or you switch devices. Nothing from omp is reimplemented: models, tools, LSP, subagents,
memory, skills, MCP, rules, slash commands and settings all come from omp itself.

## Two ways to use every task

| | Web GUI | Full TUI |
|---|---|---|
| What it is | omp's RPC mode (`--mode rpc-ui`) rendered as a web app | omp's real terminal UI (xterm.js over a server-side PTY) |
| Strengths | Streaming transcript, tool cards, approvals as buttons, works on phones and installs to the home screen | **Literally every omp feature**: Agent Hub, `/collab`, themes, keybindings, `omp git`, voice… |
| Switch | `TUI` button in the header | `GUI` button; the same omp session continues in the other mode |

Both modes keep running when no browser is attached. A session can only be owned by one omp process, so a task is in one
mode at a time; switching resumes the same session file.

## Run

Requirements: Node 20+ and `omp` installed for the user that runs the server.

```bash
git clone https://github.com/Pickfordmatt/pi-in-the-sky.git && cd pi-in-the-sky
npm install        # terminals use a prebuilt PTY binding: no compiler needed on Linux x64/arm64
npm start
```

The server prints a login URL containing the access token (also in `~/.ohmypi-web/token`).

If the PTY binding fails to install (unusual platform), the GUI still works and terminals show an explanatory message.
To build it from source install `python3 make g++` and run `npm rebuild node-pty`.

| Env var | Default | |
|---|---|---|
| `OHMYPI_WEB_HOST` | `127.0.0.1` | bind address |
| `OHMYPI_WEB_PORT` | `7878` | port |
| `OHMYPI_WEB_DATA` | `~/.ohmypi-web` | task registry, token, exports |
| `OHMYPI_WEB_TOKEN` | generated | fixed access token |
| `OMP_BIN` | `omp` | path to the omp executable |
| `OHMYPI_WEB_MAX_UPLOAD_MB` | `1024` | largest file the Files panel accepts |

omp itself honours its usual variables (`PI_CODING_AGENT_DIR`, `OMP_PROFILE`, provider API keys). Set them in the
environment of the server process; every task and terminal inherits them.

### Docker / Portainer

A ready-made image with omp inside is published to `ghcr.io/pickfordmatt/pi-in-the-sky:latest` (built and smoke-tested
by GitHub Actions on every push).

**Portainer:** Stacks → Add stack → **Repository**, URL `https://github.com/Pickfordmatt/pi-in-the-sky`, compose path
`docker-compose.yml`, then Deploy. Open the container's log to find the login URL with the access token, and browse to
`http://<docker-host>:7878`.

**Plain Docker:** `docker compose up -d` in a clone of this repo.

Data lives in three named volumes: `omp-home` (omp settings, logins, sessions), `copilot-data` (PITS token,
tasks, projects) and `workspace` (mounted at `/workspace`, the default folder for your projects).

Optional stack environment variables:

| Variable | Purpose |
|---|---|
| `OHMYPI_WEB_TOKEN` | Fixed access token (otherwise generated on first start and printed in the log) |
| `OMP_CONFIG_YML_B64`, `OMP_MODELS_YML_B64` | Base64 of omp `config.yml` / `models.yml`, written on first start so models work immediately, e.g. `base64 -w0 ~/.omp/agent/models.yml` |
| `OMP_CONFIG_OVERWRITE=1` | Re-apply the two files above on the next start |
| `PITS_PORT` | Host port (default 7878; the older `COPILOT_PORT` still works) |

Leave out Windows-only settings such as `shellPath` from a config you copy into the container. You can also configure
models after deploying through PITS's settings, Models & roles, or `omp login` in a terminal.

### Running on a Linux server

- `deploy/ohmypi-web.service` is a ready systemd unit. Tasks that were running are resumed from their omp session
  files when the service restarts, and a task that was mid-turn is told to continue.
- **Do not expose plain HTTP to the internet.** The token lets the holder run commands as the server user. Use an SSH
  tunnel (`ssh -L 7878:127.0.0.1:7878 host`), Tailscale/WireGuard, or a TLS reverse proxy (forward WebSockets; cookies are
  marked `Secure` behind `X-Forwarded-Proto: https`).
- Run it as the same user that owns `~/.omp`, so tasks, terminals and the settings editor all see the same config and sessions.

## Feature coverage

| omp area | Where in the web UI |
|---|---|
| Agent loop, tools, LSP, debugger, subagents, bash | GUI transcript with tool cards, diffs, images; Agents tab |
| Tool approvals, `ask` tool, extension dialogs | Buttons/forms, answerable from any device, survive reloads |
| Slash commands (all 50+: builtin, extension, skill, file, MCP) | Composer autocomplete incl. subcommands; output shown with colours; `/model`, `/settings`, `/login`, `/resume`, `/tree`, `/tui` open native screens |
| `!cmd`, `!!cmd`, steer, follow-up, abort, queue | Composer |
| **All 600+ settings** (`config.yml`) | **omp settings** page: grouped, searchable, typed editors, exact enum options, modified markers, reset. Generated live from `omp config`, so it always matches your omp version |
| Model catalog, **model roles** (default/smol/slow/plan/advisor/…), provider enable/disable, refresh | **Models & roles** page |
| **Every launch flag** (`--smol/--slow/--plan/--tools/--no-lsp/--advisor/--max-cost/--profile/--add-dir/--hook/--system-prompt/…`) | New task form and per-task **Launch options** |
| **Every `omp` subcommand** (`models`, `usage`, `stats`, `plugin`, `skill`, `agents`, `ssh`, `worktree`, `ps`, `commit`, `git`, `shell`, `setup`, …) | **omp commands** page: help text, run with captured output, or open in a terminal |
| Any shell / any interactive omp program | **Terminals** (persistent PTYs, mobile key bar) |
| Config files (`config.yml`, `models.yml`, `mcp.json`, `AGENTS.md`, rules, skills), project files | **Files & config** editor with quick links |
| Task folder files beside the chat | Right panel **Agents / Files** switch: browse the task folder, preview (highlighted code, images, markdown), download, upload by drag-and-drop (files and whole folders) or the Upload button, insert a path into the chat. Uploads stream to disk, are limited by `OHMYPI_WEB_MAX_UPLOAD_MB` (default 1024) and cannot escape the target folder |
| Session tree, fork, rewind, compaction, handoff, export | History tab and task menu |
| **Task agents** (bundled, `~/.omp/agent/agents`, project `.omp/agents`) and their `task.*` runtime settings | **Agents** page: browse with precedence/shadowing, edit frontmatter + system prompt in a form or as raw source, templates, **Build with AI** (omp drafts the agent from a description), per-agent enable/disable, model/advisor/prewalk/tier/compaction/budget overrides, and **Try it** to delegate a job in a task |
| Resume any past session (including ones from a terminal) | Past sessions |
| Projects | Sidebar **Projects** mapped to folders (existing, new, or `git clone`): tasks grouped under their project (explicitly or by folder), project home with git branch, quick actions (task, full TUI, shell, files, agents, AGENTS.md), past sessions to resume, per-project colour and default launch options. Stored in `~/.ohmypi-web/projects.json`; removing a project never touches tasks or files |
| OAuth logins | Settings → Accounts (or `omp login` in a terminal) |
| Any RPC command not wrapped yet | **Raw RPC** console |
| Anything TUI-only | **Full TUI** mode |

## Architecture

```
browser ⇄ WebSocket ⇄ ohmypi-web (Node) ⇄ JSONL stdio ⇄ omp --mode rpc-ui      (GUI mode, one per task)
                                         ⇄ PTY       ⇄ omp (full TUI)          (TUI mode / terminals)
                                         ⇄ spawn     ⇄ omp config / models / <subcommand>
```

- `server/omp-process.mjs` – RPC process wrapper (protocol v2, chunk reassembly, process-group cleanup on Linux).
- `server/task.mjs` – per-task live mirror, launch-flag builder, GUI↔TUI switching, crash recovery.
- `server/pty.mjs` – persistent PTYs with scrollback replay.
- `server/omp-cli.mjs` – settings catalog (incl. enum probing), subcommand help/run.
- `server/manager.mjs`, `server/index.mjs` – registry, HTTP API, WebSocket hub, auth.
- `public/` – dependency-light client, no build step: marked, DOMPurify, xterm.js, highlight.js, VS Code Codicons, Inter and JetBrains Mono, all self-hosted from `node_modules` (no CDN calls).
- `public/theme.css` – the VS Code Dark Modern visual layer (colours taken from VS Code's own theme file, Dark+ syntax colours). Remove its `<link>` in `index.html` to fall back to the plain styles.

## Known limits

- One shared access token (no multi-user accounts).
- Settings edit the global `config.yml`; project-level `.omp/config.yml` can be edited in the Files editor.
- Commands that open interactive pickers over RPC may show nothing in the GUI. Use TUI mode for those.
- Hosted on a single machine; there is no clustering.

## Status

Early but working. Developed and tested end to end on Windows 11 with omp 18.20.0 (GUI and TUI modes, agents,
projects, files, uploads, crash recovery). Linux is the intended deployment target and the code handles it
(prebuilt PTY binding, process-group cleanup, systemd unit), but it has had less real-world testing there.
Issues and pull requests are welcome.

## Security

The access token grants the same power as a shell on the server: tasks, terminals, the file browser and uploads all run
as the server's user. Keep the default `127.0.0.1` bind, or put it behind SSH, Tailscale/WireGuard or a TLS reverse proxy.
The token lives in `~/.ohmypi-web/token` (outside the repo); never commit it.

## Disclaimer

Pi In The Sky is an independent community project. It is not affiliated with or endorsed by the oh-my-pi / Pi authors
or Stencil Labs. The name is a pun on the idiom; the agents are real.

## License

[MIT](LICENSE)
