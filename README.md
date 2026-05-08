# @helloagentai/hermes

A bridge that lets HelloAgent users chat with their personal Hermes agent.

## What this is

```
   HelloAgent client (web / iOS)
            │
            ▼  WebSocket, ha_* token
   HelloAgent relay (Go)
            │
            ▼  WebSocket, ha_* token   (relay-side: this bridge looks like
   ┌────────────────────┐               an agent named e.g. @alice/hermes)
   │ helloagent-hermes  │
   │  (this package)    │
   └────────────────────┘
            │
            ▼  wschat protocol (JSON over WS, ws://127.0.0.1:8770)
   Hermes gateway with wschat plugin
            │
            ▼
   Agent loop (LLM, tools, memory)
```

The bridge holds two things at once:

1. **A relay client** — authenticated via the HelloAgent SDK using a
   long-lived `ha_*` agent token. This is how the user's HelloAgent app
   sees the Hermes agent in their contact list.
2. **A wschat WebSocket server** — listens on `ws://127.0.0.1:8770` for the
   Hermes [`wschat` plugin](../hermes-ws-channel/) to connect.

Inbound messages from the user flow relay → bridge → wschat → Hermes.
Hermes' streamed reply chunks flow back the other way and are forwarded
to the user as a streaming response on the relay's protocol.

## Auth

The pairing flow is lifted from
[`integrations/openclaw-HelloAgent/src/auth/`](../openclaw-HelloAgent/src/auth/).
Three paths, identical UX:

1. **Browser PKCE OAuth** (default for `pair`) — opens a browser to
   `<webUrl>/oauth/connect`, captures the redirect on a loopback server,
   exchanges the code for an access token, calls `linkChannel()` to mint
   a scoped `ha_*` agent token, persists creds.
2. **Device code** (`--device`) — for headless/CI machines. Print a
   user code, the user approves it from any other browser.
3. **Manual token import** (`--token --relay-ws`) — paste an existing
   `ha_*` token; we validate it with one WS handshake against the relay,
   then persist.

> The relay's [`channelProviders`](../../relay/internal/api/channels.go)
> map currently knows only `"openclaw"`, so internally we link as the
> `openclaw` provider for now. Functionally identical for the bridge —
> when the relay registers `"hermes"` as a provider this becomes a
> two-line change in [`auth/login-oauth.ts`](src/auth/login-oauth.ts) and
> [`auth/login-device.ts`](src/auth/login-device.ts).

Credentials are persisted at `~/.helloagent-hermes/credentials/<accountId>/creds.json`
with `chmod 0600`, atomic temp-file + rename, and a `.bak` of the prior
file. Override the state dir with `HA_HERMES_BRIDGE_DIR`.

## Quickstart

```bash
cd integrations/helloagent-hermes
npm install
npm run build

# 1) Pair with HelloAgent
node dist/cli.js pair --agent-name jarvis \
  --api-url http://localhost:8080 \
  --web-url http://localhost:5173

# Or for a headless box:
node dist/cli.js pair --device --agent-name jarvis

# Or to import an existing token:
node dist/cli.js pair \
  --token ha_xxx \
  --relay-ws ws://localhost:8080/v1/ws

# 2) Start the bridge
node dist/cli.js run --port 8770

# 3) Tell Hermes to use it
#    (assumes integrations/hermes-ws-channel is symlinked into ~/.hermes/plugins/wschat
#     and platforms.wschat.enabled: true is set in ~/.hermes/config.yaml)
WSCHAT_URL=ws://127.0.0.1:8770 hermes gateway run
```

Now any HelloAgent user can DM `@<your-handle>/jarvis` and chat with Hermes.

## CLI

```
helloagent-hermes pair    [--device | --token <T> --relay-ws <URL>]
                          [--agent-name <N>] [--api-url <URL>] [--web-url <URL>]
                          [--account <ID>]
helloagent-hermes run     [--port <N>] [--host <H>] [--wschat-token <T>]
                          [--account <ID>]
helloagent-hermes status
helloagent-hermes logout  [--account <ID>]
```

Environment variables:

| Var | Default | Use |
|---|---|---|
| `HA_HERMES_BRIDGE_DIR` | `~/.helloagent-hermes` | State dir |
| `HA_HERMES_BRIDGE_AUTH_DIR` | `<state>/credentials` | Cred dir override |
| `HA_HERMES_BRIDGE_API_URL` | `http://localhost:8080` | Default `--api-url` |
| `HA_HERMES_BRIDGE_WEB_URL` | `http://localhost:5173` | Default `--web-url` |
| `HA_HERMES_BRIDGE_CLIENT_ID` | `helloagent-hermes` | OAuth client id |
| `HA_HERMES_BRIDGE_DEBUG` | unset | Verbose logs |

## What's not in scope (yet)

- Multiple concurrent Hermes connections (server is single-tenant).
- Group conversations (DMs only — `chatType=dm`).
- Media / files / cards (text only).
- Edits — we advertise `supports: ["typing"]` so Hermes' streamer
  auto-downgrades to fresh-send chunks. Each Hermes `send` becomes one
  `StreamChunk` back to the user.
- Reactions, read receipts, typing indicators on the relay side.

## Layout

```
src/
├── auth/
│   ├── store.ts           creds.json I/O (chmod 0600, atomic write)
│   ├── presence.ts        hasAnyAuth probe
│   ├── login.ts           PKCE OAuth (browser loopback)
│   ├── login-device.ts    device-code flow
│   ├── login-oauth.ts     code exchange + linkChannel + persist
│   └── import-token.ts    manual ha_* token import
├── core/
│   ├── ha-client.ts       per-account managed Agent (lifecycle + status)
│   ├── logger.ts          namespaced logger
│   └── types.ts           ResolvedAccount
├── wschat/
│   ├── server.ts          local WS server (single Hermes client)
│   ├── types.ts           wire frames
│   └── dedup.ts           inbound dedup (relay reconnects)
├── bridge.ts              wires HaClient ↔ wschat server, streaming bridge
├── cli.ts                 pair / run / status / logout
└── index.ts               library re-exports
```

## License

Same as the parent HelloAgent repo.
