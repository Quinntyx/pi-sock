# pi-sock: unix-socket RPC for a live pi TUI session

pi-sock is a generic transport: any local process can inject messages into, observe,
and abort a live pi session running with a full TUI. It is decoupled from every
client — the wire protocol carries nothing client-specific. The flagship client is
the Ren voice assistant, which lives in its own repo (`quinntyx/ren-assistant`)
with its own plan; nothing here knows or cares that it exists beyond the protocol.

## Base implementation

`mitsuhiko/agent-stuff` → `extensions/control.ts` (npm: `mitsupi`, MIT) is already a
near-complete implementation. `@mariozechner/pi-coding-agent` and
`@earendil-works/pi-coding-agent` are the same project (Mario Zechner joined
Earendil; the scoped name is the upstream, not a fork), so control.ts works mostly
verbatim — the work is decoupling it from the rest of the mitsupi package and
trimming scope, not re-deriving behavior.

Keep from control.ts:

- `net.createServer` unix-socket JSONL server, stale-socket unlink, lifecycle
  binding (`session_start` start, `session_shutdown` teardown, rebind on
  `/new`, `/resume`, `/reload`).
- Injection via `pi.sendMessage({customType, content, display},
  {triggerTurn: true, deliverAs: "followUp" | "steer"})`, choosing direct vs queued
  by `ctx.isIdle()`.
- `getLastAssistantMessage` by walking `ctx.sessionManager.getBranch()`.
- Event push to connected clients (`subscribe` → `{type:"event"}` lines), using
  `agent_settled` semantics for "done" (pi may retry/compact/continue after
  `agent_end`).
- The `[session-message]` custom message type and its TUI renderer.

Strip: multi-session discovery and alias symlinks, `clear`/rewind, CLI one-shot send
flags, `send_to_session` LLM tool, LLM summarizer (`get_summary`), npm dependency on
`pi-tui` extras beyond the minimal renderer. Add LICENSE/attribution for the
portions retained from control.ts (ISC/MIT, Armin Ronacher).

## Scope note: confirmation dialogs

Out of scope for now. YOLO mode means blocking dialogs practically do not occur, and
the operator sits in tmux next to the client with the full TUI, so any rare dialog
is answered manually. No `ui_prompt_start` plumbing in the first version.

## Architecture

```
pi TUI process (omn-assistant profile, tmux pane 1)
  └── pi-sock extension (in-process)
        └── unix socket ~/.pi/pi-sock/omn-assistant.sock (JSONL, fixed path)
              ├── command clients (scripts, one-shots, cron, other panes)
              └── persistent clients (e.g. the Ren voice assistant, tmux pane 2)
```

Clients inject, observe, and abort; all reasoning stays in the pi session, which
remains the single context of truth and stays fully visible/controllable in the TUI.

## Protocol (JSONL over unix socket)

Commands (client → pi):

```json
{"id":"r1","type":"send","text":"...","mode":"steer"}
{"id":"r2","type":"get_state"}
{"id":"r3","type":"get_message"}
{"id":"r4","type":"subscribe","events":["agent_start","turn_end","agent_settled"]}
{"id":"r5","type":"abort"}
```

- `mode`: `steer` (default) or `follow_up`. Steering matches conversational relay
  use: a correction like "actually, Y instead" must reach the agent between tool
  calls of the current run, not pile up behind it. When the agent is idle, the send
  goes direct (control.ts already skips queueing on idle). `follow_up` stays
  available for explicitly deferred requests.
- Responses mirror control.ts: `{type:"response",command,success,data?,error?,id?}`.
- Events: `{type:"event",event:"agent_settled",data:{lastAssistant,...}}`.

No sender metadata, no request-id bookkeeping, no client-specific fields anywhere in
the API. Correlating a settled run to a specific request is a client-side concern.

## Repository setup

Worktree-friendly layout per the `g` fish helper:

```
~/docs/src/pi-sock/main/        primary clone
~/docs/src/pi-sock/<worktree>/  future worktrees (g wt <name>)
```

`g clone`/`g wt`/`g cd` all key off `<repo>/main`, so the plugin lives at
`~/docs/src/pi-sock/main` and worktrees are siblings. Published to
`git.quinntyx.dev` (Forgejo) as `quinntyx/pi-sock` via the `fj` CLI.

Package shape follows the user's other pi plugins: a `package.json` with the
`pi.manifest`/`pi.extensions` entry (like `pi-ptc-next`'s manifest), extension entry
`index.ts`, TypeScript loaded via jiti (no build step needed), README, and the
retained-code attribution notice. Install into the omn-assistant profile via the
profile's `settings.json` `extensions` list pointing at a clone under
`~/.config/pi/profiles/omn-assistant/git/git.quinntyx.dev/quinntyx/pi-sock` (same
pattern the profile already uses for other plugins).

## Milestones

### M1 — pi-sock extension (1 day)

`~/docs/src/pi-sock/main`: vendored, trimmed control.ts (single `index.ts` plus
README). Fixed socket path per profile; mkdir 0700; unlink stale socket before
`listen()`; chmod 0600 socket. Commands: `send`, `get_state`, `get_message`,
`subscribe`, `abort`. TUI footer status ("pi-sock: listening"). `session_shutdown`
cleanup; rebind on all `session_start` reasons. Enable by default in the
omn-assistant profile.

### M2 — smoke test via socat/CLI (half day)

`echo '{"type":"send","text":"/daily"}' | socat - UNIX-CONNECT:~/.pi/pi-sock/...sock`
plus a small `pisock wait-settled` helper. Test matrix in tmux: idle send; send while
agent runs (must steer between tool calls); `/new` mid-flight; client killed mid-run;
stale socket after crash.

### M3 — first real client (open)

Ren is the flagship client and lives in the `ren-assistant` repo with its own
plan and milestones. Any other client (scripts, cron, other panes) works against
the same five commands.

### M4 — polish (later)

- Optional `get_summary` (cheap model) if the last assistant text is too long for a
  client to consume raw.
- Optional generic per-send annotation hook: a plain-text note appended to the
  prompt (still client-agnostic — no sender types in the schema).

## Caveats

1. **Steering is the default, by design.** External sends land between tool calls
   of the current run; clients that want hands-off queueing pass `mode:"follow_up"`
   explicitly.
2. **Context growth.** Every injected message lives in the main session; compaction
   handles volume. Do not route clients to a side session — the shared context is
   the point.
3. **Attribution races.** A typed prompt interleaved between a client send and its
   settle can make the next `get_message` return a reply meant for the typed
   prompt. This is the client's problem to disambiguate (compare timestamps; if in
   doubt, stay silent). The socket provides honest primitives, not interpretation.
4. **Session lifecycle.** `/new`, `/resume`, `/reload` rebind the server; a fixed
   socket path means clients must reconnect on `ECONNREFUSED`/`ENOENT` with backoff.
   Stale sockets are unlinked before bind.
5. **Security.** The socket injects prompts into an agent with full shell access.
   Unix perms (0700 dir, 0600 socket) are the entire security model; treat it like
   an exposed REPL — local user account only, nothing network-exposed.
6. **Blocking dialogs.** Rare in YOLO mode; if one appears, the operator answers it
   in the TUI pane manually. Clients should handle settle timeouts gracefully.
