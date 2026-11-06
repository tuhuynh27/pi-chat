# CLAUDE.md

Guidance for coding agents working in this repo.

## Project

Minimal LLM chat web UI backed by the **Pi Coding Agent SDK**
(`@earendil-works/pi-coding-agent`). SvelteKit (Svelte 5, TypeScript) with
`adapter-node` — one Node server serves the SPA and the `/api/*` endpoints.
The agent runs in-process inside server routes.

## Commands

```bash
npm run check             # svelte-kit sync + svelte-check (must stay 0 errors)
npm run build             # production build -> build/
npm run dev               # dev server, http://localhost:5173
npm start                 # serve production build (node build)
npm run start:sandboxed   # macOS: serve under seatbelt sandbox (see below)
```

There is no test suite; verify with `npm run check` + `npm run build`, then
smoke-test the API over HTTP (SSE via `curl -sN`).

## Architecture

```
src/lib/server/
  auth.ts        env credentials; 24-hour HS256 JWT creation/verification
  pi.ts          per-conversation AgentSession map; SSE event mapping
                   (toSseEvents); store updates (applyToConvo)
  store.ts       conversation history: ~/.pi-web/conversations.json + session
                   files; lazy load, debounced atomic save, CRUD, applyEvent(),
                   lastModel/lastThinking (new convos inherit latest choices)
  share.ts       volatile in-memory share-token map (token -> convoId) for
                   read-only guest links; createShare/resolveShare/revoke*
  exa.ts         bundled Exa extension (web_search_exa, web_fetch_exa)
  workspace.ts   per-conversation temp workspaces ($TMPDIR/pi-web-<convoId>)
  sse.ts         server-side SSE writer (createSseWriter) + delta coalescing
                   (coalesceDeltas: merges per-token delta/thinking events
                   into ~50ms frames, first delta of a burst forwarded
                   immediately), shared by chat/, retry/, and attach/.
                   createSseWriter pokes a comment-only keepalive (`:\n\n`)
                   immediately and every 15s so proxies/browsers don't idle-
                   out a silent stream (thinking, tool wait, session setup).
src/routes/api/
  auth/          status/login/logout; HttpOnly SameSite session cookie
  conversations/     GET list (summaries + busy) / POST create
  conversations/[id] GET full convo (items, cwd, sandboxed) / DELETE (disposes
                      session + workspace, removes history, revokes its shares)
  conversations/[id]/share  POST  create a read-only share token for the convo
                      (returns {token}); the guest link is /share/<token>
  share/[token]   GET  PUBLIC (no auth, see hooks.server.ts) read-only snapshot
                      of a shared convo: {id,title,createdAt,updatedAt,items}.
                      No cwd/sandbox/context, no mutation surface. Backed by the
                      volatile in-memory token map in lib/server/share.ts — a
                      token dies on server restart or when its convo is deleted
                      (revokeSharesForConvo / revokeAllShares on the DELETE routes)
  chat/          POST {text, conversationId, images?}  SSE stream: delta,
                   thinking, tool_start, tool_end, message_error, retry,
                   error, done.
                   images is up to MAX_IMAGES (5) {data, mimeType} entries
                   (base64, no data: prefix); validated by pi.ts's
                   parseImages() and stored on the user item alongside text
  retry/         POST {conversationId, index}  same SSE stream as chat/; index
                   is the item being retried (client array index — walks back
                   to the nearest user item server-side too). Regenerates via
                   AgentSession.navigateTree(), so it truncates and resends
                   in place rather than editing text (see pi.ts wiring below).
                   navigateTree() only returns text, so any image attachments
                   on the retried turn are re-read from the stored item and
                   resent as-is (resolveRetryTarget's RetryTarget.images)
  attach/        GET  {conversationId}  read-only SSE stream for reconnecting
                   clients (e.g. after a hard refresh mid-run): sends a `sync`
                   event with the current stored items, then forwards live
                   agent events (no store writes of its own) until the run
                   ends, `done`. If the conversation isn't busy, just
                   `sync` + `done` immediately
  models/        GET   model list + sandboxed flag (snapshot only;
                     does not re-check every provider on each request)
  set-model/     POST  {id: "provider/model", conversationId}  (per-convo;
                   awaits session.setModel — auth failure returns 500 and the
                   store is not updated; also records lastModel)
  set-thinking/  POST  {level, conversationId}  (per-convo; responds
                   {level, effective} — effective is the level after clamping
                   to the model's supported levels; also records lastThinking)
  abort/         POST  {conversationId?}  (defaults to first busy)
src/lib/
  sse.ts         client-side SSE parser over fetch
  markdown/      GFM + KaTeX math, mermaid diagrams, Shiki highlighting,
                   GitHub alerts, footnotes, task lists; consumed by
                   MessageItem.svelte via @humanspeak/svelte-markdown
                   (streaming mode: rAF-batched incremental parse; raw HTML
                   rendered as inert text)
  smoother.ts    client-side smooth reveal: deltas buffer per assistant item
                   and are revealed a few chars per rAF at an adaptive rate
                   (drain backlog in ~220ms), so bursty arrival still reads
                   as flowing text. flush() before tool rows/errors keeps
                   ordering; runChat/attachToRun settle() before finishing
  types.ts       shared Item/ConvoSummary/StoredItem types + toolDetail() +
                   toItems() (stored -> client items)
  components/    Header (menu button), Sidebar, Dropdown (custom listbox
                   for model/thinking — no native <select>), MessageItem,
                   ToolLine, WebTool, Composer
```

`hooks.server.ts` rejects unauthenticated requests to every `/api/*` endpoint
except the three auth endpoints. Login credentials come from `PI_WEB_USER` and
`PI_WEB_PASS`; development defaults both to `dev`, while production requires
both. Changing either invalidates all existing JWTs.

Key wiring in `pi.ts`:

- `sessions: Map<convoId, {agent, cwd, busy, sessionManager}>`;
  `getSession(id, convo)` creates lazily via `createAgentSession({ cwd,
  sessionManager, modelRuntime, resourceLoader, settingsManager, model,
  thinkingLevel, ... })`. The convo's `model`/`thinking` go IN to
  `createAgentSession` so the SDK clamps the level against the chosen model
  (do NOT post-hoc `setModel`/`setThinkingLevel` — `setModel` is async and a
  post-hoc `setThinkingLevel` clamps against the session's fallback model).
  The same `sessionManager` instance is kept on `PiSession` (not just handed
  to the SDK) so retry can walk the tree directly.
- `runPrompt(convoId, pi, text, send)` is the shared core of a turn (subscribe
  → `applyToConvo` + SSE forward → `agent.prompt(text)`); both `/api/chat` and
  `/api/retry` call it after pushing/truncating `c.items` themselves. Routes
  claim the run via `claimRun(pi)` (checks + sets `busy` synchronously) BEFORE
  any await between the busy check and `runPrompt` — retry awaits
  `navigateTree` in that gap and would otherwise race a concurrent chat.
- **Stall watchdog** (`runPrompt`): aborts the run when no PROGRESS event
  (deltas, tool activity, cleanly completed message) arrives for
  `PI_WEB_STALL_TIMEOUT_MS` (default 180s, min 30s, 0 disables). Error/abort
  message_ends and `auto_retry_*` events deliberately do NOT reset the clock,
  so a provider stall→auto-retry→stall cycle is bounded by ONE timeout total
  (the SDK path has no mid-stream idle timeout of its own: the openai client
  `timeout` only covers up to response headers, undici's 300s default fires
  late, and the SDK auto-retries the resulting "terminated" error — a dead
  provider used to hold `busy` for ~20 min). The check pauses while a tool
  executes (tools emit no events while running). On fire it pushes its own
  error item + `message_error`, then `agent.abort()` (the SDK's generic
  aborted message_end is suppressed for that run).
- **Auto-retry surfacing**: the SDK retries transient provider errors (429/
  5xx/network, 3 attempts, exponential backoff). `auto_retry_start` is
  forwarded as SSE `retry` {attempt, maxAttempts, delayMs}, and both the
  store (`applyToConvo`) and the client pop the trailing error item pushed by
  the failed attempt's message_end — only a final failure leaves an error
  bubble. The client also resets its error dedup (`lastError`) on `retry` so
  an identical final error still renders.
- **Idle eviction**: sessions unused for 60 min are disposed from the map
  (10-min sweep; never while busy). Session file + workspace stay on disk, so
  the next message resumes transparently via `sessionManagerFor`.
- **Retry**: `resolveRetryTarget(pi, convo, index)` walks `convo.items` back
  to the nearest user item, then finds that item's session entry by ordinal
  position among `role: 'user'` message entries in
  `sessionManager.getBranch()` — `convo.items` and the session's user
  messages stay in the same order because turns are only ever appended
  linearly (no steer/followUp path exists in this app). The route then calls
  `agent.navigateTree(entryId)`, which moves the session leaf to that entry's
  parent and returns the original text (`editorText`); the route truncates
  `c.items` to the target and resends `editorText` through `runPrompt`. The
  abandoned branch is NOT deleted from the session file, only from
  `conversations.json` — this is intentional (the SDK's tree model), not a
  leak. Old conversations resumed before this feature work the same way:
  nothing is persisted per-item, retry targets are resolved fresh every time.
- **Resume**: `sessionManagerFor()` looks for the latest
  `<dataDir>/sessions/*_<convoId>.jsonl` (SessionManager names files
  `<timestamp>_<id>.jsonl`; pass the convo id as `{ id }` to
  `SessionManager.create`). `SessionManager.open()` resumes, `create()` starts
  fresh. Session files are the LLM context; `conversations.json` is the
  display history.
- `resourceLoader` = `DefaultResourceLoader({ cwd, agentDir: getIsolatedAgentDir(),
  noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true,
  noContextFiles: true, systemPromptOverride, appendSystemPromptOverride: () => [],
  extensionFactories: [exaExtension, eventLoopYieldExtension] })` — chat-only
  system prompt (reply in the conversation; never write files) and a
  deterministic toolset: bundled Exa only, plus a hidden yield hook so token
  bursts don't starve the event loop. Built-in file/shell tools are disabled via
  `tools: ['web_search_exa', 'web_fetch_exa']` (global `~/.pi/agent/extensions`
  are intentionally NOT loaded).
- `ModelRuntime.create({ authPath, modelsPath, modelsStorePath })` points at
  **temp copies** of `~/.pi/agent/{auth.json,models.json,models-store.json}`
  (see Isolation).
- `settingsManager: SettingsManager.create(dataDir(), dataDir())` — the SDK
  session persists its default model/thinking level on every change; scoping
  settings to the data dir (`<dataDir>/settings.json`) keeps the host
  `~/.pi/agent/settings.json` (pi CLI config) untouched.
- `applyToConvo()` mirrors every agent event into the stored items with the
  SAME rules as the client (text after a tool row starts a fresh assistant
  bubble; tool rows matched by tool-call id). The store is the source of
  truth, so runs keep updating history when the SSE client navigates away;
  runs are NOT aborted on client disconnect (use /api/abort).
- **Attach/resync**: `AgentSession.subscribe()` supports multiple concurrent
  listeners, so `/api/attach` adds its own listener alongside `runPrompt`'s
  (via `getLiveSession()`, which looks up `sessions` without creating one) and
  forwards events without touching the store. A small `onceDone`/`notifyDone`
  pair in `pi.ts` — fired from `runPrompt`'s `finally`, after `pi.busy =
  false` — lets `/api/attach` know when the run (which may loop through
  several tool calls) actually ends, since no single `message_end` marks that
  reliably. Busy state itself is intentionally RAM-only (`PiSession.busy`):
  it does not survive a server restart, and neither would the in-flight LLM
  request anyway.
- `vite.config.ts` keeps `@earendil-works/pi-coding-agent` in `ssr.external`
  — never bundle the SDK into the server build.
- **Image attachments**: `AgentSession.prompt(text, { images })` accepts the
  SDK's `ImageContent[]` (`{ type: 'image', data, mimeType }`); `ImageContent`
  itself isn't exported from the package root, so `pi.ts` declares a
  structurally-matching local type instead of importing `pi-ai` directly (a
  transitive dep, same reasoning as the `Model` type below). `runPrompt()`
  takes an optional `images` param and forwards it on both the initial call
  and retry.

Client (`+page.svelte`): sidebar state (open/closed, open by default ≥720px),
`convos` list, `activeId`, `items` (client view of one conversation). `select()`
refetches the full convo; `newChat()` POSTs then switches; `del()` DELETEs
then falls back to the first remaining convo or a fresh one. Header model/
thinking selects post with `conversationId`; they are disabled while busy.
**Drop recovery**: the server ends every run stream with `done` or `error`.
`runChat` treats a stream that started but ended with neither — or a
`fetch()` TypeError before headers (the POST may already have been accepted)
— as a mid-run disconnect: it keeps the busy state and hands off to
`attachToRun(cid)`, which re-syncs the stored items and continues streaming
live events. `attachToRun` likewise re-arms itself (1s delay) if ITS stream
ends with no verdict while the conversation is still being viewed; a `sync`
snapshot maps stored items via `toItems(items, busy=true)` so an in-flight
tool row keeps its running spinner (idle conversations render leftover
`running` as done). A speculative attach (fetch died before headers) that
never connects after a few tries surfaces the network error and unlocks the
composer rather than spinning forever.
`Composer.svelte` handles image attach (clipboard paste, drag-drop, and a
file-picker button) client-side: each image is downscaled to a 1568px max
dimension via `createImageBitmap`/`<canvas>` before being base64-encoded, so
pasted screenshots don't balloon the request body.

Share page (`/share/[token]`, `routes/share/[token]/+page.svelte`): a
standalone read-only guest view. No auth, no sidebar, no composer, no
retry/copy actions — it fetches `/api/share/[token]` once on mount and renders
the snapshot with the same `toItems()` + `MessageItem`/`ToolLine`/`WebTool`
components as the main page (reusing the global `app.css` message styles).
`toItems(items, busy=false)` so a leftover `running` tool renders as done
instead of spinning. The owner creates a link from the Header **Share** button
(`+page.svelte` `share()` → `ShareDialog.svelte` shows the URL + copy); the
button is disabled while a run is in flight so a snapshot never ends on a
half-finished reply.

## Isolation model (important — do not regress)

The agent must never be able to modify the host machine:

1. **Per-conversation temp workspaces** (`workspace.ts`): agent `cwd` =
   `$TMPDIR/pi-web-<convoId>` (stable across restarts). Deleting a
   conversation removes its workspace (`disposeSession`). Stale workspaces
   (>24h, not belonging to a live session) are swept on server start.
2. **Seatbelt sandbox** (macOS): `npm run start:sandboxed` →
   `sandbox-start.sh` → `sandbox-exec -f <profile> node build`.
   `sandbox.sb`: `allow default`, deny all `file-write*` outside the OS temp
   area, deny `process-exec` except `/usr/bin/security` (Exa keychain key).
   The launcher appends allows for the resolved `node` binary (the blanket
   exec-deny would otherwise block the initial `execve`) AND for the data dir
   (`PI_WEB_DATA_DIR`, default `~/.pi-web`) — the only persistent writes the
   app is allowed to make.
3. **No file/shell tools** — `createAgentSession` allowlists only
   `web_search_exa` and `web_fetch_exa`. Built-in `read`/`bash`/`edit`/`write`
   are never registered. Sandbox mode still drops process spawns at the OS
   level (`PI_WEB_SANDBOX=1`).

Known limits (documented, accepted): host file *reads* via absolute paths
still work; outbound network is open. Containment = no writes outside temp,
no process spawns.

## Gotchas (learned the hard way)

- Pi session file naming: `SessionManager.create(cwd, dir, { id })` writes
  `<timestamp>_<id>.jsonl` — resume by suffix-matching `_<convoId>.jsonl` and
  picking the latest (a convo can accumulate files across forks).
- `store.ts` must stay server-only (it imports `node:fs`); the shared item
  types are duplicated in `types.ts` (client-safe) — do not import `store.ts`
  from client code.
- `Model`/`ThinkingLevel` types are NOT exported from the SDK root — derive
  `Model` from `ReturnType<ModelRuntime['getModel']>`; the local
  `ThinkingLevel` union matches pi-agent-core's exactly, so a direct `as`
  cast works.
- `process.report.getReport().sandbox` is `undefined` under `sandbox-exec` on
  this Node/macOS — sandbox detection uses the env var instead.
- A seatbelt profile with `(deny process-exec)` blocks sandbox-exec's own
  initial `execve` of the target (even `echo` fails). The launcher must append
  `(allow process-exec (literal "<node-bin>"))`.
- Do NOT add `(deny process-fork)` to the profile: fork precedes exec in
  `spawn`, so it kills the allowed `/usr/bin/security` call.
- The Pi runtime writes `auth.json.lock` next to `auth.json` — running against
  the real `~/.pi/agent` path fails under the sandbox (and contends with a
  running pi CLI). Hence the temp copies.
- `adapter-node` defaults `BODY_SIZE_LIMIT` to 512K, which image-attachment
  requests can exceed even after client-side downscaling. `sandbox-start.sh`
  exports a 20M default; plain `npm start` needs `BODY_SIZE_LIMIT` set in
  `.env` (node's `--env-file-if-exists` reads it). `npm run dev` (Vite) is
  unaffected — the limit is an adapter-node/production concern only.
- SvelteKit 2.70: `+server.ts` endpoints must NOT export `ssr` or `csr`.
- Vite SvelteKit plugin imports from `@sveltejs/kit/vite` (not
  `@sveltejs/vite-plugin-svelte`).
- `typebox` is a direct dependency (it is nested under the SDK's
  node_modules, not hoisted) — needed by `exa.ts` for tool parameter schemas.
- Exa key resolution: `EXA_API_KEY` env → macOS Keychain
  (service `pi-exa-api-key`, account = `$USER`) via `execFileSync('security')`.
- Fast token streams arrive as already-resolved promises. Without a macrotask
  yield the Node event loop never services incoming HTTP, so a mid-run refresh
  looks like a dead static server (HTML/JS/API all pending). `eventLoopYieldExtension`
  `setImmediate`s every 8 `message_update`s; do not remove it. `/api/models`
  must stay on `getAvailableSnapshot()` — `getAvailable()` re-checks every
  built-in provider and used to pin the loading screen on every page load.

## Conventions

- Svelte 5 runes (`$state`, `$props`, `onclick`…), TypeScript, tabs for indent.
- UI: Inter everywhere (self-hosted `@fontsource-variable/inter`),
  **no `border-radius`, no `box-shadow`** (globally enforced in `app.css`),
  minimal aesthetic, hairline `1px solid var(--line)` borders. Sidebar:
  static 264px column ≥720px (closed = negative margin), fixed drawer + dim
  backdrop below. Pickers use `Dropdown.svelte` (pointer + keyboard +
  outside-tap close), never native `<select>`.
- UI levels for thinking: `off|minimal|low|medium|high` (server also accepts
  `xhigh|max`; `set-thinking` returns the clamped `effective` value).
- SSE `tool_end` forwards structured `details` for web search/fetch only (keeps
  payloads lean); UI renders them via `WebTool.svelte` as generic Web search /
  Web fetch rows (no Exa branding), all other tools via `ToolLine.svelte`.
- Stored-history updates (`applyToConvo` in `pi.ts`) and client updates
  (`handleEvent` in `+page.svelte`) must stay in sync — same bubble/tool-row
  rules on both sides.
- Server binds `0.0.0.0` by default in production — treat as localhost-only;
  do not expose to untrusted networks without auth (the agent has shell
  access outside the sandbox).
