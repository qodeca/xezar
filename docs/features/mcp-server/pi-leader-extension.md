# The pi leader extension

**What it is for.** xezar can push a significant project event to a leader and have that leader
*react* — a real model turn, carrying the event, with nobody typing anything. For an OpenCode leader
that works because `opencode serve` has an address you can give xezar. pi has none: its RPC speaks
over its own stdin and stdout only, with no port, no socket and no attach mode (`pi --help` and
`docs/rpc.md`, pi 0.85.1), and xezar never starts an agent process for a leader. So a pi you started
in your own terminal could not be reached at all, and its events waited until you typed something.

This extension closes that. It runs inside your pi, and it is the only way in — nothing xezar can
send over MCP starts a pi turn (see § Why not MCP, below).

**It is opt-in.** Without it, nothing changes: attaching a pi leader is refused with pi's own
recoverable reason, the events stay in the journal, and that pi reads them with `leader_events`.

## Install

The file ships with xezar at `scripts/pi-leader-extension.ts`. Either point pi at it per run:

```bash
pi --extension "$(npm root -g)/@qodeca/xezar/scripts/pi-leader-extension.ts"
```

or copy it where pi discovers extensions, which also lets `/reload` pick it up:

```bash
cp "$(npm root -g)/@qodeca/xezar/scripts/pi-leader-extension.ts" ~/.pi/agent/extensions/
# …or, for one project only:
cp "$(npm root -g)/@qodeca/xezar/scripts/pi-leader-extension.ts" <project>/.pi/extensions/
```

Then start pi **in the project directory** and attach the pi leader in the cockpit
(`POST /api/v1/mcp/leader`, `{action: 'attach', client: 'pi'}`). There is nothing to configure: you
paste no address and set no environment variable.

## What it does, exactly

1. On `session_start` it looks up from pi's working directory for a `.local/xezar` directory. If
   there is none, it does nothing at all — this is not a xezar project.
2. It opens one Unix socket in your temporary directory, named after pi's session id.
3. Once that socket really listens, it writes `<project>/.local/xezar/pi-leader.json` (mode `0600`)
   naming it. xezar reads that file when you attach, and dials the socket.
4. Down the socket it speaks pi's own RPC vocabulary — `prompt`, `steer`, `get_state`,
   `get_messages` — which it translates into pi's extension API. xezar's adapter is therefore
   unchanged by the socket existing, and a different transport could replace it.
5. On `session_shutdown` it closes the socket and removes both files. That teardown is idempotent,
   because pi tears the runtime down and rebuilds it on `/new`, `/resume`, `/fork`, `/clone` and
   `/reload` — not only on quit.

## What it does not do

- **It starts nothing on its own.** It answers commands and forwards pi's events. A turn happens
  only when xezar hands over an event, for a project you attached, in a session you started.
- **It opens nothing to the network.** A Unix socket is a path on your own machine, reachable only
  by your own user.
- **It reads none of your files, settings or credentials.** The only thing it reads from your
  session is the conversation, and only to find out which events xezar has already told this pi
  about — that is what stops the same event being put to the model twice.
- **It forwards four events and no more:** `agent_start`, `agent_settled`, `message_start`,
  `message_end`. xezar needs the busy boundary and the user message that marks a real reaction.

## Why not MCP

pi reaches xezar through the third-party `pi-mcp-adapter`, so it is fair to ask why the existing MCP
connection cannot carry this. It cannot, and that was checked rather than assumed against
`pi-mcp-adapter` 2.32.1:

| What xezar could send | What happens |
| --- | --- |
| `notifications/*` (resources updated, list changed, message) | a catalogue refresh, or a poke at an already-open UI window. No turn. |
| `elicitation/create` | a dialog; the answer goes back to the server. No turn. |
| `sampling/createMessage` | a model call on a side channel the agent's own conversation never sees. No turn. |
| MCP prompts | become pi slash commands. A server can make one *appear*; only a human can run it. |

The package has exactly two calls that can start a turn, and both need a human or a live browser
window. That is why the route is an extension.

## If it does not work

- **"no pi leader has announced itself to this project"** — pi is not running the extension, or it
  was started outside the project. Check that `<project>/.local/xezar/pi-leader.json` exists.
- **"the pi leader that wrote pi-leader.json is gone"** — a previous pi exited without cleaning up.
  Start pi again; the file is rewritten.
- Nothing is ever lost while any of this is failing: the events stay in the project journal, and
  `leader_events` still reads them.
