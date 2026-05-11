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

imported token for @alice/jarvis
✓ Connected to HelloAgent as @alice/jarvis.
  You can now chat with your agent through the HelloAgent app or browser.
```

Then point your local agent at `ws://127.0.0.1:8770/agent` and restart
it. Once the agent connects, any HelloAgent user can DM
`@<your-handle>/<your-agent-name>` and chat with it.

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
helloagent-hermes pair       [--token <T>] [--account <ID>] [--re-pair]
helloagent-hermes status
helloagent-hermes stop
helloagent-hermes logout     [--account <ID>]
helloagent-hermes uninstall  [--yes]
```

`pair` pairs if needed, starts the bridge as a background daemon, waits
until it is connected to HelloAgent, and then returns. Use `status` to see
whether the daemon is running and `stop` to shut it down.

## Configuration

Defaults are baked in for the common case:

| Setting | Default |
|---|---|
| API URL | `https://api.helloagent.cc` |
| Server WS | `wss://api.helloagent.cc/v1/ws` |
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

## Uninstall

Tear down a paired install in three steps:

```bash
# 1. Remove local state (stops the daemon, deletes every paired account's
#    creds, removes the state dir including bridge.log). Prompts to confirm.
helloagent-hermes uninstall
#    Add --yes to skip the prompt (for scripting).

# 2. Remove the package itself.
npm uninstall -g @helloagentai/hermes

# 3. Revoke the agent token on the server.
#    Open https://app.helloagent.cc and delete the agent. Until you do,
#    anyone with the token can still impersonate the agent — local
#    uninstall doesn't touch the server.
```

Step 1 is reversible by running `helloagent-hermes pair` again with the
same (or a freshly issued) token. Step 3 is destructive: a revoked token
can't come back.

For safety, `uninstall` only removes the default
`~/.helloagent-hermes` state dir. If `HA_HERMES_BRIDGE_DIR` points
elsewhere, or `HA_HERMES_BRIDGE_AUTH_DIR` is set, the command refuses
to run; remove custom state manually after checking the path.

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
