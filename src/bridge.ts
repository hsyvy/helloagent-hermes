/**
 * Bridge wiring: HelloAgent server ↔ agent socket ↔ agent (e.g. Hermes).
 *
 * Direction 1 (inbound to the agent):
 *   HelloAgent server → HaClient.onMessage(IncomingMessage)
 *     → translate to wire `message` frame
 *     → push to the agent via the agent socket
 *     → wait for the agent's streamed reply (one or more `send` frames
 *       keyed by chatId, AsyncIterable<string> back to the HelloAgent
 *       server)
 *
 * Direction 2 (outbound from the agent):
 *   agent → `send`/`edit` frame on the agent socket
 *     → bridge maps frame.chatId → recipient handle
 *     → HaClient.send(handle, text)
 *
 * Streaming: HelloAgent SDK delivers chunks back to the peer as separate
 * StreamChunks when our onMessage handler returns an AsyncIterable<string>.
 * For each inbound user message we open a "pending response" channel keyed
 * by the inbound message's chatId; outbound `send` frames whose chatId
 * matches push a chunk into that channel; when the chat goes idle for
 * `responseIdleMs` ms or the channel is explicitly ended, we close it.
 *
 * Edits: we advertise `supports: ["typing"]` only — the agent's streamer
 * auto-downgrades to send-fresh chunks. If we ever advertise "edit" we'd
 * need to coalesce mid-stream edits into a single chunk per turn.
 */
import type { IncomingMessage } from "@helloagentai/sdk";

import { HaClient } from "./core/ha-client.js";
import { logger } from "./core/logger.js";
import type { ResolvedAccount } from "./core/types.js";
import { MessageDedup } from "./agent-socket/dedup.js";
import { createAgentSocket } from "./agent-socket/server.js";
import type {
  ClientToServer,
  IncomingMessageFrame,
  SendFrame,
} from "./agent-socket/types.js";

const log = logger("bridge");

export type BridgeOptions = {
  account: ResolvedAccount;
  /** Agent socket bind. Default 127.0.0.1:8770. */
  host?: string;
  port?: number;
  /** Optional shared secret the agent must echo in its hello frame. */
  socketToken?: string;
  /** ms of silence after which we consider the agent's reply complete. Default 1500. */
  responseIdleMs?: number;
};

type PendingResponse = {
  chatId: string;
  fromHandle: string;
  emit(text: string): void;
  end(): void;
  ended(): boolean;
};

export type Bridge = {
  start(): Promise<void>;
  stop(): Promise<void>;
  isReady(): boolean;
};

export function createBridge(opts: BridgeOptions): Bridge {
  const responseIdleMs = opts.responseIdleMs ?? 1500;
  const dedup = new MessageDedup();
  const pending = new Map<string, PendingResponse>(); // chatId → channel

  const server = createAgentSocket({
    host: opts.host,
    port: opts.port,
    agentId: opts.account.handle,
    supports: ["typing"], // see module doc — we don't claim edit support
    authToken: opts.socketToken,
  });

  let haClient: HaClient | null = null;

  // Outbound: agent frames → HelloAgent server sends.
  server.onClientFrame((frame: ClientToServer) => {
    if (frame.type === "send") {
      handleAgentSend(frame);
      return;
    }
    if (frame.type === "edit") {
      // We didn't advertise edit; treat any stray edit as a chunk anyway
      // so we don't lose data, but log a warning.
      log.warn("received edit frame though edit was not advertised; treating as chunk");
      handleAgentSend({
        type: "send",
        msgId: frame.msgId,
        chatId: frame.chatId,
        text: frame.text,
      });
      return;
    }
    if (frame.type === "typing") {
      // No HelloAgent-server-side typing indicator yet; logged for visibility.
      log.debug(`agent typing on ${frame.chatId}`);
      return;
    }
  });

  function handleAgentSend(frame: SendFrame): void {
    server.ack(frame.msgId);
    const channel = pending.get(frame.chatId);
    if (channel && !channel.ended()) {
      // We're inside a streamed response — push the chunk through the
      // SDK's onMessage AsyncIterable.
      channel.emit(frame.text);
      return;
    }
    // No pending stream — the agent is sending unsolicited (or the response
    // already closed). Send via the HelloAgent server as a fresh message.
    if (!haClient || haClient.status !== "ready") {
      log.warn(
        `dropping outbound send to ${frame.chatId}: ha-client not ready`,
      );
      return;
    }
    try {
      haClient.send(frame.chatId, frame.text);
    } catch (err) {
      log.warn(
        `outbound send failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  // Inbound: HelloAgent server messages → wire `message` frame, then yield
  // chunks back as the agent streams its reply.
  function onIncoming(msg: IncomingMessage): AsyncIterable<string> | string {
    if (!dedup.tryRecord(msg.messageId)) {
      log.debug(`duplicate message ${msg.messageId}, skipping`);
      return "";
    }
    if (!server.isReady()) {
      log.warn(
        `inbound from @${msg.fromHandle} dropped — no agent connected to socket yet`,
      );
      return "";
    }

    const frame: IncomingMessageFrame = {
      type: "message",
      msgId: msg.messageId,
      from: msg.fromHandle,
      fromName: msg.fromHandle,
      chatId: msg.fromHandle, // route by sender — simplest 1:1 mapping
      chatName: msg.fromHandle,
      chatType: "dm",
      text: msg.text,
    };

    // Set up the pending-response channel BEFORE pushing the inbound
    // frame, so we don't race with Hermes' fast replies.
    const channelId = msg.fromHandle;
    return collectStreamingResponse({
      channelId,
      fromHandle: msg.fromHandle,
      pushFrame: () => server.pushIncoming(frame),
      register: (channel) => pending.set(channelId, channel),
      unregister: () => pending.delete(channelId),
      idleMs: responseIdleMs,
    });
  }

  async function start(): Promise<void> {
    await server.start();
    log.info(`agent socket listening on ${opts.host ?? "127.0.0.1"}:${opts.port ?? 8770}`);
    haClient = new HaClient({
      account: opts.account,
      onIncoming,
      onStatus: (status, detail) => {
        if (status === "needs_repairing") {
          log.error(`HelloAgent server rejected token (${detail ?? "?"}). Re-pair.`);
        }
      },
    });
    await haClient.ready;
    log.info(`bridge ready: linked to HelloAgent as @${opts.account.handle}`);
  }

  async function stop(): Promise<void> {
    haClient?.stop();
    haClient = null;
    for (const ch of pending.values()) ch.end();
    pending.clear();
    await server.stop();
  }

  function isReady(): boolean {
    return server.isReady() && haClient?.status === "ready";
  }

  return { start, stop, isReady };
}

// The agent's first chunk gets a more generous wait than subsequent ones:
// LLMs typically take a moment to start streaming, but once chunks are
// flowing they arrive fast. This multiplier applies to the initial timer
// only; later chunks reset the timer to a single idleMs window.
const INITIAL_REPLY_IDLE_MULTIPLIER = 5;

// ---------------------------------------------------------------------------
// Streaming helper: collects chunks from a producer until idle + returns
// them as an AsyncIterable<string> for the SDK's onMessage handler.
// ---------------------------------------------------------------------------

type StreamCollectOpts = {
  channelId: string;
  fromHandle: string;
  pushFrame: () => boolean;
  register: (channel: PendingResponse) => void;
  unregister: () => void;
  idleMs: number;
};

function collectStreamingResponse(opts: StreamCollectOpts): AsyncIterable<string> {
  const queue: string[] = [];
  let done = false;
  let waiter: ((value: IteratorResult<string, void>) => void) | null = null;
  let idleTimer: NodeJS.Timeout | null = null;

  const channel: PendingResponse = {
    chatId: opts.channelId,
    fromHandle: opts.fromHandle,
    emit(text: string) {
      if (done) return;
      // Reset idle timer on every chunk.
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => channel.end(), opts.idleMs);
      if (waiter) {
        const w = waiter;
        waiter = null;
        w({ value: text, done: false });
      } else {
        queue.push(text);
      }
    },
    end() {
      if (done) return;
      done = true;
      if (idleTimer) {
        clearTimeout(idleTimer);
        idleTimer = null;
      }
      opts.unregister();
      if (waiter) {
        const w = waiter;
        waiter = null;
        w({ value: undefined, done: true });
      }
    },
    ended() {
      return done;
    },
  };

  opts.register(channel);
  // Push the inbound frame to the agent; if the push fails we close out cleanly.
  if (!opts.pushFrame()) {
    channel.end();
  } else {
    // Arm the idle timer for the case where the agent never replies.
    idleTimer = setTimeout(
      () => channel.end(),
      opts.idleMs * INITIAL_REPLY_IDLE_MULTIPLIER,
    );
  }

  return {
    [Symbol.asyncIterator](): AsyncIterator<string, void> {
      return {
        next(): Promise<IteratorResult<string, void>> {
          if (queue.length > 0) {
            return Promise.resolve({ value: queue.shift() as string, done: false });
          }
          if (done) {
            return Promise.resolve({ value: undefined, done: true });
          }
          return new Promise((resolve) => {
            waiter = resolve;
          });
        },
        return(): Promise<IteratorResult<string, void>> {
          channel.end();
          return Promise.resolve({ value: undefined, done: true });
        },
      };
    },
  };
}

