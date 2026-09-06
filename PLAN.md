# pi-sock: unix-socket RPC for a live pi TUI session

## Goal

Run omn-assistant (pi TUI) in one tmux pane and Ren — a Pipecat + OpenWakeWord voice
assistant — in another. Ren relays short spoken requests into the live omn-assistant
conversation, acknowledges immediately ("Okay, scheduling that"), and reports a spoken
summary when the agent settles. The user keeps full interactive control of the same
session in the TUI (same context, visible state).

pi-sock itself is completely generic and decoupled from Ren: it is a transport that
lets any local process inject messages into, observe, and abort a live pi session.
Nothing in the wire protocol knows a voice assistant exists.

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
the operator sits in tmux next to Ren with the full TUI, so any rare dialog is
answered manually. No `ui_prompt_start` plumbing in the first version.

## Architecture

```
tmux pane 1: pi TUI (omn-assistant profile)
  └── pi-sock extension (in-process)
        └── unix socket ~/.pi/pi-sock/omn-assistant.sock (JSONL, fixed path)

tmux pane 2: Ren (python, Pipecat) — a pi-sock CLIENT, nothing more
  wake word → VAD/end-of-turn → STT
    → send → canned ack ("Okay, scheduling that")
    → agent_settled → get_message → compress → TTS summary
```

Ren has no brain of its own: it is a relay with canned acks. All reasoning stays in
omn-assistant (one context of truth). General voice chat relays the same way, so
complex or typed requests can always go straight into the TUI instead.

## Protocol (JSONL over unix socket)

Commands (client → pi):

```json
{"id":"r1","type":"send","text":"...","mode":"steer"}
{"id":"r2","type":"get_state"}
{"id":"r3","type":"get_message"}
{"id":"r4","type":"subscribe","events":["agent_start","turn_end","agent_settled"]}
{"id":"r5","type":"abort"}
```

- `mode`: `steer` (default) or `follow_up`. Steering matches the conversational
  reality of a relay: a follow-up like "actually, Y instead" must reach the agent
  between tool calls of the current run, not pile up behind it. When the agent is
  idle, the send goes direct (control.ts already skips queueing on idle).
  `follow_up` stays available for explicitly deferred requests.
- Responses mirror control.ts: `{type:"response",command,success,data?,error?,id?}`.
- Events: `{type:"event",event:"agent_settled",data:{lastAssistant,...}}`.

No sender metadata, no request-id bookkeeping, no voice-specific fields anywhere in
the API. Ren's ack/settle correlation is Ren's problem.

## Repository setup

Worktree-friendly layout per the `g` fish helper:

```
~/docs/src/pi-sock/main/        primary clone
~/docs/src/pi-sock/<worktree>/  future worktrees (g wt <name>)
```

`g clone`/`g wt`/`g cd` all key off `<repo>/main`, so the plugin lives at
`~/docs/src/pi-sock/main` and worktrees are siblings. Published to
`git.quinntyx.dev` (Forgejo) as `quinntyx/pi-sock` via the `fj` CLI:

```
cd ~/docs/src/pi-sock/main
fj repo create pi-sock -d "Unix-socket JSONL RPC extension for live pi TUI sessions" -r origin -p
```

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
agent runs (must queue, not steer); `/new` mid-flight; client killed mid-run; stale
socket after crash.

### M3 — Ren MVP (2–4 days, separate repo)

Pipecat pipeline: OpenWakeWord (16 kHz mono frames) → Silero VAD end-of-turn → STT
(local first) → tool `relay_to_omn(text)` → TTS. The tool opens the socket, sends,
speaks the canned ack, then on the next `agent_settled` reads `get_message`, strips
markdown/tables, compresses to one or two speakable sentences, and TTSes it. Ren
keeps its own FIFO of outstanding sends for attribution; pi-sock stays ignorant.

### M4 — polish (later)

- Voice-concise replies: Ren-side compression first; only if insufficient, a generic
  (still not voice-specific) pi-sock hook that lets clients tag a send with an
  optional plain-text note appended to the prompt.
- Wake-word tuning; custom OpenWakeWord model later if the user likes the setup.
- Optional `get_summary` (cheap model) if last-assistant text is too long to speak.

## Caveats

1. **Steering is the default, by design.** Voice interactions are conversational:
   corrections and reversals must land mid-run ("actually, Y instead"). The cost is
   that an external send can redirect an in-flight task — that is the intended
   behavior, and clients that want hands-off queueing pass `mode:"follow_up"`
   explicitly.
2. **Context growth.** Every injected message lives in the main session; compaction
   handles volume. Do not route clients to a side session — the shared context is the
   point.
3. **Attribution races.** A typed prompt interleaved between a client send and its
   settle can make the next `get_message` return a reply meant for the typed prompt.
   This is the client's problem to disambiguate (compare timestamps; if in doubt,
   stay silent). The socket provides honest primitives, not interpretation.
4. **Session lifecycle.** `/new`, `/resume`, `/reload` rebind the server; a fixed
   socket path means clients must reconnect on `ECONNREFUSED`/`ENOENT` with backoff.
   Stale sockets are unlinked before bind.
5. **Security.** The socket injects prompts into an agent with full shell access.
   Unix perms (0700 dir, 0600 socket) are the entire security model; treat it like an
   exposed REPL — local user account only, nothing network-exposed.
6. **OpenWakeWord quality (Ren side).** No stock "ren" model; use the closest stock
   wake word initially, train a custom model later if the setup sticks.
7. **Blocking dialogs.** Rare in YOLO mode; if one appears, the operator answers it
   in the TUI pane manually. Ren's settle handler should timeout gracefully if a
   settle never arrives.
