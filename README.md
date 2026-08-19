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

Copy the environment template and set the web login plus at least one model provider key:

```bash
cp .env.example .env
```

Fresh installs default to Keva's `qwen3.6-35b-a3b` model and also include `qwen3.8-27b`. Set `KEVA_API_KEY` for those models, or use a built-in provider key such as `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, or `GROQ_API_KEY` and select one of its available models.

Pi configuration is environment-only. The application never reads credentials, models, settings, skills, prompts, themes, or extensions from `~/.pi`. `pnpm start` loads `.env` with Node's native environment-file support. Docker should receive the same file with `--env-file .env`.

For a custom provider catalog, set these optional variables:

- `PI_WEB_MODELS_JSON`: the complete, one-line JSON content that would normally be in Pi's `models.json`. API keys should reference another environment variable, for example `"apiKey":"$MY_LLM_API_KEY"`.
- `PI_WEB_DEFAULT_PROVIDER`: initial provider for a fresh data volume. Defaults to `keva`.
- `PI_WEB_DEFAULT_MODEL`: initial model for a fresh data volume. Defaults to `qwen3.6-35b-a3b`.
- `PI_WEB_DEFAULT_THINKING`: initial thinking level. Defaults to `low`.

The selected model and thinking level remain application state in the data volume, so existing user choices survive restarts and take precedence over these initial defaults.

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

Run it with persistent conversation data and the environment file:

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
  --env-file .env \
  pi-web
```

Open `http://localhost:3000`. Set `ORIGIN=https://your-domain.example` behind an HTTPS reverse proxy. The image runs as the unprivileged `node` user, includes a health check at `/api/auth/status`, stores durable state in `/data`, and uses `/tmp` for disposable workspaces and generated Pi runtime files. Do not mount a Pi config directory, Docker socket, or host directory as an agent workspace. Container isolation is the security boundary for the agent's shell and file tools.

### Deployment caching

Every build emits content-hashed JavaScript and CSS under `/_app/immutable/`; adapter-node serves those files with a one-year immutable cache because changed content receives a new URL. The HTML shell contains the current asset URLs and is served with `Cache-Control: private, no-store, max-age=0`, plus legacy no-cache headers. A reverse proxy or CDN must preserve that HTML policy. Do not apply a blanket static cache rule to `/` or other HTML routes.

### Sandboxed run (recommended)

`pnpm run start:sandboxed` launches the server under a macOS seatbelt profile (`sandbox.sb` -> `sandbox-start.sh`).

- **No writes** outside OS temp area and the data dir (`~/.pi-web`). File tool escapes return `EPERM`.
- **No process spawns** — the `bash` tool is removed (`excludeTools`), and the OS denies every `execve` except `/usr/bin/security` (Exa keychain access).
- **Reads allowed** - host reads by absolute path remain possible, but no host Pi config is loaded.

The launcher appends an allow rule for the resolved `node` binary; the blanket exec-deny would block the first `execve`. macOS-only. On Linux, use a container (e.g. Docker) for equivalent containment.

> **Residual risk.** Host file reads via absolute paths are not blocked (would break the runtime), and outbound network is open (LLM API + Exa). Sandbox = strong write/exec containment, not full isolation.

## Features

- **Chat history sidebar** — multiple conversations, expand/collapse, rename-by-first-message, per-row delete. Mobile: drawer over dimmed backdrop.
- **Login access gate** — environment-defined credentials with a 24-hour signed JWT session and protected API routes.
- Streaming markdown (safe rendering by default)
- Collapsible thinking blocks and tool activity rows
- **Web search / fetch** — `web_search_exa` + `web_fetch_exa`, shown as generic web search and web fetch rows (titles, hosts, previews, result count).
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
