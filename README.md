# pi-sock — unix-socket JSONL RPC for a live pi TUI session

pi-sock is a [pi](https://github.com/earendil-works/pi) coding-agent extension that
opens a unix domain socket into the *running* pi process. Any local program can
inject messages into, observe, and abort the agent — while the TUI stays attached,
fully interactive, and visible in the same process. What you type in the TUI and
what clients send over the socket share one conversation and one context of truth.

Derived from the session-control extension in
[mitsuhiko/agent-stuff](https://github.com/mitsuhiko/agent-stuff)
(`extensions/control.ts`, npm: `mitsupi`, MIT, by Armin Ronacher) — see
[NOTICE](NOTICE). That extension coordinates multiple pi sessions; pi-sock is
trimmed to a single-session, client-agnostic transport: no session discovery, no
aliases, no CLI startup sends, no LLM summarizer, and a generic wire protocol that
knows nothing about its clients.

## Install

    pi install git:git.quinntyx.dev/quinntyx/pi-sock

or add to a profile `settings.json` `packages` list. The socket binds on session
start: `~/.pi/pi-sock/<PI_SOCK_NAME>.sock` (default `main.sock`). The directory is
created `0700` and the socket `0600` — that filesystem boundary is the entire
security model. Anything that can write the socket can drive an agent with full
shell access; keep it to the local user account.

## Protocol

Newline-delimited JSON (split on `\n` only). Every command may carry an `id`,
echoed on its response.

### Commands (client → pi)

```json
{"id":"r1","type":"send","text":"...","mode":"steer"}
{"id":"r2","type":"get_state"}
{"id":"r3","type":"get_message"}
{"id":"r4","type":"subscribe","events":["agent_start","turn_end","agent_settled"]}
{"id":"r5","type":"abort"}
```

**`send`** injects the text as a `[session-message]` custom message in the
conversation. When the agent is idle it triggers a turn immediately; while
streaming, `mode` selects delivery:

- `"steer"` (default) — lands between tool calls of the current run. Right for
  conversational relays and corrections ("actually, Y instead").
- `"follow_up"` — waits until the current run finishes entirely.

Response: `{"type":"response","command":"send","success":true,"data":{"delivered":true,"mode":"direct"|"steer"|"follow_up"}}`
(`mode:"direct"` means the agent was idle and the turn started immediately).

**`get_state`** returns
`{"isIdle":bool,"hasPendingMessages":bool,"model":"provider/id","thinkingLevel":"…","sessionId":"…","sessionFile":"…"}`.

**`get_message`** returns the last assistant message:
`{"message":{"content":"…","timestamp":…}}` or `{"message":null}`.

**`subscribe`** takes a non-empty subset of
`agent_start`, `turn_end`, `agent_settled` and persists until the socket closes.
Matched events arrive as `{"type":"event","event":"…","data":{…}}` lines:

- `agent_start` → `{timestamp}`
- `turn_end` → `{message:{role,content,timestamp}|null, turnIndex}`
- `agent_settled` →
  `{lastAssistant:{role,content,timestamp}|null, ranMs:number|null, isIdle:bool}`

`agent_settled` fires only when pi will not auto-continue (retries, compaction
retries, and queued follow-ups all drained) — use it for "done" detection, not
`agent_end`.

**`abort`** cancels the current run (same as Esc in the TUI).

Malformed lines get
`{"type":"response","command":"parse","success":false,"error":"…"}`. Command
responses always arrive; events arrive only after subscribing. Subscriptions end
when the socket closes — the server never pushes to a dead client.

### Example

    $ echo '{"id":"1","type":"send","text":"Reply with exactly: pong"}' \
        | socat - UNIX-CONNECT:$HOME/.pi/pi-sock/main.sock
    {"type":"response","command":"send","success":true,"data":{"delivered":true,"mode":"direct"},"id":"1"}

Or with the bundled CLI (`scripts/pisock`, Node ≥ 18, no dependencies):

    export PI_SOCK=~/.pi/pi-sock/main.sock
    pisock send "Reply with exactly: pong" --wait     # waits for agent_settled, prints the reply
    pisock send "stop and do X instead"               # steers an in-flight run
    pisock send --mode follow_up "when you're free…"  # explicitly queue behind the run
    pisock state                                      # isIdle, model, session file…
    pisock get-message
    pisock abort

## Behavior notes

- The server binds on `session_start` and unbinds on `session_shutdown`; `/new`,
  `/resume`, `/fork`, and `/reload` rebind the same path. Clients should retry on
  `ENOENT`/`ECONNREFUSED` with backoff (stale sockets are unlinked before bind).
- Injected messages live in the session like any other content — context growth is
  handled by pi's compaction.
- Correlating a settled run with a specific `send` is a client-side concern (the
  protocol stays session-generic). If a typed prompt interleaves, verify before
  reading `get_message` output.
- Known upstream issue: pi 0.84.x `pi.sendUserMessage` throws
  "content is not iterable" from the runtime; pi-sock uses `pi.sendMessage` instead.

## Development

Layout: `index.ts` (extension, TypeScript loaded by pi via jiti — no build step),
`scripts/pisock` (CLI client), `vendor-reference/` (upstream control.ts + its
license). See [PLAN.md](PLAN.md) for design notes, the test matrix, and caveats.
