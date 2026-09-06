pi-sock: unix-socket JSONL RPC for a live pi TUI session
========================================================

pi-sock is a pi extension that opens a unix domain socket into the *running* pi
process, letting any local program inject messages into, observe, and abort the
agent — while the TUI stays attached, fully interactive, and visible in the same
process. Typing in the TUI and clients over the socket share one conversation and
one context of truth.

Forked and trimmed from Armin Ronacher's session control extension
(mitsuhiko/agent-stuff, `extensions/control.ts`, MIT); see NOTICE.

Install (pi package, e.g. into a profile):

    pi install git:git.quinntyx.dev/quinntyx/pi-sock

or point a profile `settings.json` `extensions` entry at `index.ts`.

Socket: `~/.pi/pi-sock/<PI_SOCK_NAME>.sock` (default `main.sock`; override with the
`PI_SOCK_NAME` env var). The directory is created 0700 and the socket 0600 — that
filesystem boundary is the entire security model.

Protocol
--------

Newline-delimited JSON. Commands carry an optional `id`, echoed on the response.

    {"id":"r1","type":"send","text":"...","mode":"steer"}
    {"id":"r2","type":"get_state"}
    {"id":"r3","type":"get_message"}
    {"id":"r4","type":"subscribe","events":["agent_start","turn_end","agent_settled"]}
    {"id":"r5","type":"abort"}

- `send` uses `mode:"steer"` (default) or `"follow_up"`. When the agent is idle the
  text triggers a turn immediately; while streaming, steering lands the message
  between tool calls of the current run, follow-up waits for it to finish.
- `get_state` returns `{isIdle, hasPendingMessages, model, thinkingLevel,
  sessionId, sessionFile}`.
- `get_message` returns the last assistant message (`{message: {content,
  timestamp}}` or `{message: null}`).
- `subscribe` persists until the socket closes; matched events arrive as
  `{"type":"event","event":"agent_settled","data":{...}}` lines. `agent_settled`
  fires only when pi will not auto-continue (retries/compaction/follow-ups done).
- `abort` cancels the current run.

Responses: `{"type":"response","command":"...","success":bool,"data":...,"id":...}`.

CLI client (`scripts/pisock`, Node, no deps):

    pisock send "run /daily"                  # returns once accepted
    pisock send --wait "check the schedule"   # waits for agent_settled, prints reply
    pisock state
    pisock abort

See PLAN.md for design notes, test matrix, and caveats.
