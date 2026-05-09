# @helloagentai/hermes

A bridge that lets HelloAgent users chat with their personal local agent
(Hermes, or any agent that speaks the agent-socket protocol).

## What this is

```
   HelloAgent client (web / iOS)
            │
            ▼  WebSocket, ha_* token
   HelloAgent server
            │
            ▼  WebSocket, ha_* token   (this bridge looks like an agent
   ┌────────────────────┐               named e.g. @alice/hermes)
   │ helloagent-hermes  │
   │  (this package)    │
   └────────────────────┘
            │
            ▼  agent-socket protocol (JSON over WS, ws://127.0.0.1:8770)
   Local agent process (e.g. Hermes)
            │
            ▼
   Agent loop (LLM, tools, memory)
```

The bridge holds two things at once:

1. **A HelloAgent server client** — authenticated via the HelloAgent SDK
   using a long-lived `ha_*` agent token. This is how the user's HelloAgent
   app sees your agent in their contact list.
2. **An agent socket** — listens on `ws://127.0.0.1:8770` for one local
   agent process to connect.

Inbound messages flow HelloAgent server → bridge → agent. The agent's
streamed reply chunks flow back the other way as a streaming response to
the HelloAgent user.

> On Hermes' side the agent-socket protocol is currently exposed via a
> plugin called `wschat` (it implements this exact wire format). Future
> Hermes versions may rename it to match this rebrand.

## Quickstart

```bash
npm install -g @helloagentai/hermes
helloagent-hermes pair
```

The CLI prompts you to paste an agent token:

```
Link this bridge to a HelloAgent account:

  1. Open https://app.helloagent.cc/app/agents/new
  2. Create an agent and copy its token (starts with "ha_")
  3. Paste the token below

Token: ha_xxxxxxxxxxxxx

✓ paired as @alice/jarvis
✓ bridge running as @alice/jarvis
  agent socket:  ws://127.0.0.1:8770
```

Then in Hermes (with the `wschat` plugin installed at
`~/.hermes/plugins/wschat`), set `platforms.wschat.enabled: true` and the
plugin's URL to `ws://127.0.0.1:8770/agent` in `~/.hermes/config.yaml`,
and restart `hermes gateway`. Now any HelloAgent user can DM
`@<your-handle>/<your-agent-name>` and chat with your Hermes.

For non-interactive use (CI, scripting):

```bash
helloagent-hermes pair --token ha_xxxxxxxxxxxxx
```

## Auth

Pairing is one step: paste an `ha_*` agent token. The bridge validates it
with one WebSocket handshake against the HelloAgent server, persists it
to disk, and uses it from then on.

You create the agent (and get the token) on the web at
[`https://app.helloagent.cc/app/agents/new`](https://app.helloagent.cc/app/agents/new).
The web UI handles agent registration; this CLI just consumes the
resulting token.

Credentials persist at
`~/.helloagent-hermes/credentials/<accountId>/creds.json` with `chmod
0600`, atomic temp-file + rename, and a `.bak` of the prior file. Override
the state dir with `HA_HERMES_BRIDGE_DIR`.

## CLI

```
helloagent-hermes pair    [--token <T>] [--account <ID>] [--re-pair]
helloagent-hermes status
helloagent-hermes logout  [--account <ID>]
```

`pair` is the only running command — it pairs (if needed) and serves the
agent socket until you Ctrl+C.

## Configuration

Defaults are baked in for the common case:

| Setting | Default |
|---|---|
| API URL | `https://api.helloagent.cc` |
| Web URL | `https://app.helloagent.cc` |
| Bind | `ws://127.0.0.1:8770` |

Env-var overrides if you really need them (local dev mostly):

| Var | Use |
|---|---|
| `HA_HERMES_BRIDGE_DIR` | State dir (default `~/.helloagent-hermes`) |
| `HA_HERMES_BRIDGE_AUTH_DIR` | Credential dir override |
| `HA_HERMES_BRIDGE_API_URL` | Override REST API URL (e.g. local HelloAgent server) |
| `HA_HERMES_BRIDGE_SERVER_WS` | Override server WS URL (e.g. local HelloAgent server) |
| `HA_HERMES_BRIDGE_HOST` | Bind host (default `127.0.0.1`) |
| `HA_HERMES_BRIDGE_PORT` | Bind port (default `8770`) |
| `HA_HERMES_BRIDGE_TOKEN` | Shared secret the agent must echo in its hello frame |
| `HA_HERMES_BRIDGE_DEBUG` | `1` for verbose logs |

## What's not in scope (yet)

- Multiple concurrent agent connections (the socket is single-tenant).
- Group conversations (DMs only — `chatType=dm`).
- Media / files / cards (text only).
- Edits — we advertise `supports: ["typing"]` so the agent's streamer
  auto-downgrades to fresh-send chunks. Each agent `send` becomes one
  `StreamChunk` back to the user.
- Reactions, read receipts, typing indicators on the HelloAgent server
  side.

## Layout

```
src/
├── auth/
│   ├── store.ts           creds.json I/O (chmod 0600, atomic write)
│   ├── presence.ts        hasAnyAuth probe
│   └── import-token.ts    ha_* token validation + persist
├── core/
│   ├── ha-client.ts       per-account managed Agent (lifecycle + status)
│   ├── logger.ts          namespaced logger
│   └── types.ts           ResolvedAccount
├── agent-socket/
│   ├── server.ts          local WS server (single agent client)
│   ├── types.ts           wire frames
│   └── dedup.ts           inbound dedup (server reconnects)
├── bridge.ts              wires HaClient ↔ agent socket, streaming bridge
├── cli.ts                 pair / status / logout
└── index.ts               library re-exports
```

## License

MIT
