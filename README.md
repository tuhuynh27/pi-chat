# pi chat

Minimal LLM chat web UI for the [Pi Coding Agent](https://www.npmjs.com/package/@earendil-works/pi-coding-agent).

**Frontend**: SvelteKit (Svelte 5, TypeScript) - native system font, no radius, no shadows.
**Backend**: Node.js server (`adapter-node`) embedding the Pi Coding Agent SDK.
**Tools**: `read`, `bash`, `edit`, `write` + Exa web search/fetch — each conversation isolated in its own temp directory.
**Persistence**: multi-conversation sidebar; LLM context, history, and tool activity survive restarts.
**Streaming**: Server-Sent Events over `fetch`.
**Responsive**: desktop + mobile (safe-area aware, wrapping header, touch-friendly composer, drawer-style sidebar).

## How it works

```
  Browser (Svelte 5)                 Node server
  |  POST /api/chat {text,           |  session.prompt(text)
  |    conversationId}               |  sessions.get(convoId)  (lazy create/resume)
  | -------------------------------->|  session.subscribe(events)
  |                                  |      |--- store: append to stored items
  |  SSE: delta / thinking /         |      |--- SSE to this client
  |       tool_start / tool_end /    |      |--- Pi agent loop (read, bash,
  |       done                       |      |    edit, write tools)
  |<---------------------------------|<-----+
```

One `AgentSession` per conversation, lazy-created and kept in memory. Per-conversation:

- **Workspace** (`$TMPDIR/pi-web-<convoId>`) — agent file tools operate here only. Deleting a conversation removes its workspace; stale ones sweep on startup.
- **Session file** (`<data dir>/sessions/*_<convoId>.jsonl`) — full LLM context. Resumed across restarts.
- **Model + thinking level** — set per-conversation from the header. New conversations inherit your last choices.

Server-stored history (`<data dir>/conversations.json`) is the source of truth — runs keep updating it even when you navigate away. Background runs continue when switching conversations; use Stop to abort explicitly.

Data dir defaults to `~/.pi-web` (`PI_WEB_DATA_DIR` to override).

> **Security note.** The temp cwd isolates the agent's working directory, but the model can still pass absolute paths. For real containment, run under the macOS seatbelt sandbox (`pnpm run start:sandboxed` below) — blocks all writes outside temp + data dir and all process spawning.

## Setup

```bash
pnpm install
```

Configure a model — any of:

1. Environment variable: `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GROQ_API_KEY`, ...
2. Stored credentials: run the `pi` CLI once (`pi` -> `/login`) — the server reads `~/.pi/agent/auth.json` automatically.

Set the login credentials used by the web UI:

```bash
export PI_WEB_USER="your-username"
export PI_WEB_PASS="a-long-random-password"
```

In development mode, unset credentials default to username `dev` and password `dev`, and the login form is prefilled. Both environment variables are required in production. The server issues an HttpOnly, SameSite JWT cookie after login. The session expires after 24 hours, and changing either value immediately invalidates existing sessions.
When serving through HTTPS, set `ORIGIN` to the public `https://` origin or forward `X-Forwarded-Proto: https` so the cookie is also marked Secure.

## Run

```bash
pnpm run dev               # dev server on http://localhost:5173
pnpm run build             # production build -> build/
pnpm start                 # serve production build
pnpm run start:sandboxed   # macOS seatbelt sandbox (contained)
```

### Docker

Build the production image:

```bash
docker build -t pi-web .
```

Run it with persistent conversation data and a provider API key:

```bash
docker volume create pi-web-data
docker run --detach \
  --name pi-web \
  --init \
  --read-only \
  --tmpfs /tmp:rw,nosuid,nodev,size=1g \
  --cap-drop ALL \
  --security-opt no-new-privileges \
  --publish 3000:3000 \
  --volume pi-web-data:/data \
  --env PI_WEB_USER="your-username" \
  --env PI_WEB_PASS="a-long-random-password" \
  --env ANTHROPIC_API_KEY \
  pi-web
```

Open `http://localhost:3000`. Replace `ANTHROPIC_API_KEY` with another provider key if needed. Set `ORIGIN=https://your-domain.example` behind an HTTPS reverse proxy. The image runs as the unprivileged `node` user, includes a health check at `/api/auth/status`, stores durable state in `/data`, and uses `/tmp` for disposable per-conversation workspaces.

For Pi credentials or custom model files instead of environment-based provider keys, mount a directory read-only at `/home/node/.pi/agent`. Do not mount a Docker socket or host directory as an agent workspace. Container isolation is the security boundary for the agent's shell and file tools.

### Sandboxed run (recommended)

`pnpm run start:sandboxed` launches the server under a macOS seatbelt profile (`sandbox.sb` -> `sandbox-start.sh`).

- **No writes** outside OS temp area and the data dir (`~/.pi-web`). File tool escapes return `EPERM`.
- **No process spawns** — the `bash` tool is removed (`excludeTools`), and the OS denies every `execve` except `/usr/bin/security` (Exa keychain access).
- **Reads allowed** — `~/.pi/agent` config (credentials, models, settings) is readable.

The launcher appends an allow rule for the resolved `node` binary; the blanket exec-deny would block the first `execve`. macOS-only. On Linux, use a container (e.g. Docker) for equivalent containment.

> **Residual risk.** Host file reads via absolute paths are not blocked (would break the runtime), and outbound network is open (LLM API + Exa). Sandbox = strong write/exec containment, not full isolation.

## Features

- **Chat history sidebar** — multiple conversations, expand/collapse, rename-by-first-message, per-row delete. Mobile: drawer over dimmed backdrop.
- **Login access gate** — environment-defined credentials with a 24-hour signed JWT session and protected API routes.
- Streaming markdown (safe rendering by default)
- Collapsible thinking blocks and tool activity rows
- **Exa web tools** — `web_search_exa` + `web_fetch_exa`. Renders titles, URLs, highlights, previews, count + timing.
- Model picker + thinking-level control — per conversation. New conversations start with your latest choices.
- Stop button mid-run; background runs continue on conversation switch.
- Auto-scroll that yields when you scroll up.

### Exa API key

Resolved in order:

1. `EXA_API_KEY` environment variable
2. macOS Keychain — service `pi-exa-api-key`, account = current user:

   ```bash
   security add-generic-password -a "$USER" -s pi-exa-api-key -w "your-key"
   ```

If neither is configured, the tools load but fail with a clear error on use.

## Notes

- **For developers**: see `CLAUDE.md` — architecture, isolation model, gotchas.
- **Data**: conversations + LLM context in `~/.pi-web`; agent file work in `$TMPDIR/pi-web-<id>`, deleted with the conversation.
- **Security**: this exposes a coding agent over HTTP. Bind to localhost only. For real containment, use `pnpm run start:sandboxed`. Do not expose to untrusted networks without authentication.
