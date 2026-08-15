# pi chat

Minimal LLM chat web UI for the [Pi Coding Agent](https://www.npmjs.com/package/@earendil-works/pi-coding-agent).

- **Frontend**: SvelteKit (Svelte 5, TypeScript), Inter font, no border-radius, no shadows
- **Backend**: Node.js server (SvelteKit `adapter-node`) using the Pi Coding Agent SDK
- **Tools**: Pi coding tools (`read`, `bash`, `edit`, `write`) + Exa web search/fetch, each conversation working in its own isolated temp dir
- **History**: multi-conversation sidebar (expand/collapse) — conversations, their LLM context, and tool activity persist across server restarts
- **Streaming**: Server-Sent Events over `fetch`
- **Responsive**: PC + mobile (safe-area aware, wrapping header, touch-friendly composer, sidebar becomes a drawer)

## How it works

```
Browser (Svelte 5)                    Node server
  |  POST /api/chat {text,           |
  |    conversationId}               |  sessions.get(convoId)  (lazy create/resume)
  | ----------------------------->   |  session.prompt(text)
  |                                  |  session.subscribe(events)
  |  SSE: delta / thinking /         |      |--- store: append to stored items
  |       tool_start / tool_end /    |      |--- SSE to this client
  |       done                       |<-----+  Pi agent loop (read, bash,
  | <------------------------------   |     edit, write tools)
```

One Pi `AgentSession` per conversation, created lazily and kept in memory. Each
conversation gets:

- its own **workspace** (`$TMPDIR/pi-web-<convoId>`) — the agent's file tools
  operate there, never on the project or any other host path. Deleting a
  conversation removes its workspace; stale workspaces are swept on startup.
- its own **Pi session file** (`<data dir>/sessions/*_<convoId>.jsonl`) holding
  the full LLM context. After a server restart the conversation is resumed from
  this file, so the agent remembers earlier turns.
- its own **model + thinking level**, set from the header (applies to that
  conversation only).

Displayed history is stored by the server (`<data dir>/conversations.json`) and
is the source of truth — a run keeps updating it even when you navigate away
from the conversation. Runs also continue in the background when you switch to
another conversation; use Stop to abort one explicitly.

The data dir defaults to `~/.pi-web` (override with `PI_WEB_DATA_DIR`).

> **Context vs. security boundary.** The per-conversation temp cwd keeps the
> agent *pointing at* an isolated dir, but the model can still pass absolute
> paths to the tools. To make that a real security boundary, run the server
> under the macOS seatbelt sandbox (`npm run start:sandboxed`, see below), which
> blocks all writes outside temp (plus the data dir) and all process spawning
> at the OS level.

> **Context vs. security boundary.** The temp cwd keeps the agent *pointing at*
> an isolated dir, but the model can still pass absolute paths to the tools.
> To make that a real security boundary, run the server under the macOS
> seatbelt sandbox (`npm run start:sandboxed`, see below), which blocks all
> writes outside temp and all process spawning at the OS level.

## Setup

```bash
npm install
```

Configure a model — any of:

1. Environment variable: `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GROQ_API_KEY`, …
2. Stored credentials: run the `pi` CLI once (`pi` → `/login`) — the server
   reads `~/.pi/agent/auth.json` automatically.

## Run

```bash
npm run dev                # dev server on http://localhost:5173
npm run build              # production build -> build/
npm start                  # serve the production build (Node)
npm run start:sandboxed    # serve under the macOS seatbelt sandbox (contained)
```

### Sandboxed run (recommended for unattended use)

`npm run start:sandboxed` launches `node build` under a macOS seatbelt profile
(`sandbox.sb`, applied via `sandbox-start.sh`). Inside the sandbox the server:

- **cannot write anywhere except the OS temp area and the data dir**
  (`~/.pi-web`) — the agent's file tools are confined to its workspace at the
  OS level (absolute-path escapes return `EPERM`), and only conversation
  history may be persisted outside temp
- **cannot spawn any process** — the agent's `bash` tool is removed from the
  session entirely (`excludeTools`), and the OS denies every `execve` except
  one: `/usr/bin/security`, which the bundled Exa extension needs to read its
  API key from the macOS Keychain
- still reads the host's `~/.pi/agent` config (credentials, models, settings)
  — reads are allowed; only writes and execs are blocked

The launcher appends an allow rule for the currently-resolved `node` binary,
because the profile's blanket exec-deny would otherwise block the very first
`execve` of the server. `start:sandboxed` is macOS-only; on Linux use a
container (e.g. Docker) for equivalent containment instead.

> **Residual risk**: reads of host files via absolute paths are not blocked
> (blocking all reads would break the Node runtime itself), and outbound
> network is open by necessity (the LLM API + Exa live on the network). Treat
> the sandbox as strong write/exec containment, not a full isolation domain.

## Features

- **Chat history sidebar**: multiple conversations, expand/collapse, rename-by-first-message
  titles, per-row delete. Persists across server restarts (LLM context resumes
  too). On mobile the sidebar is a drawer over a dimmed backdrop.
- Streaming assistant text (markdown rendered, safe by default)
- Collapsible thinking blocks and tool activity rows (bash commands, file ops)
- **Exa web tools**: `web_search_exa` + `web_fetch_exa` (same tools as the pi CLI's
  global `exa.ts` extension, bundled in `src/lib/server/exa.ts`). Results render as a
  dedicated visualization: result titles, URLs, highlights/previews, count + timing
- Model picker + thinking-level control — per conversation; new conversations
  start with your latest model + thinking choice (remembered across restarts)
- Stop button mid-run; background runs continue when you switch conversations
- Auto-scroll that yields when you scroll up

### Exa API key

Resolved in order:

1. `EXA_API_KEY` environment variable
2. macOS Keychain — service `pi-exa-api-key`, account = current user
   (the same entry the pi CLI extension uses):

   ```bash
   security add-generic-password -a "$USER" -s pi-exa-api-key -w "your-key"
   ```

If neither is configured, the tools still load but fail with a clear error on use.

## Notes

- Coding agents: see `CLAUDE.md` (also available as `AGENTS.md`) — architecture
  map, isolation model, and hard-won gotchas.
- Conversations + their LLM context live in `~/.pi-web` (override with
  `PI_WEB_DATA_DIR`); agent file work happens in per-conversation temp dirs
  (`$TMPDIR/pi-web-<id>`) and is deleted with the conversation.
- **Security**: this exposes a coding agent over HTTP. Bind to localhost only,
  and for real containment run `npm run start:sandboxed` (macOS seatbelt: no
  writes outside temp + data dir, no process spawns, `bash` tool removed).
  Do not expose to untrusted networks without authentication.
