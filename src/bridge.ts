/**
 * Bridge wiring: HelloAgent relay ↔ wschat server ↔ Hermes plugin.
 *
 * Direction 1 (inbound to Hermes):
 *   relay → HaClient.onMessage(IncomingMessage)
 *     → translate to wschat `message` frame
 *     → push to Hermes via wschat server
 *     → wait for Hermes' streamed reply (one or more `send` frames keyed
 *       by chatId, AsyncIterable<string> back to the relay)
 *
 * Direction 2 (outbound from Hermes):
 *   Hermes → wschat `send`/`edit` frame
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
 * Edits: we advertise `supports: ["typing"]` only — the Hermes streamer
 * auto-downgrades to send-fresh chunks. If we ever advertise "edit" we'd
 * need to coalesce mid-stream edits into a single chunk per turn.
 */
import { randomUUID } from "node:crypto";
import type { IncomingMessage } from "@helloagent/sdk";

import { HaClient } from "./core/ha-client.js";
import { logger } from "./core/logger.js";
import type { ResolvedAccount } from "./core/types.js";
import { MessageDedup } from "./wschat/dedup.js";
import {
  createWschatServer,
  type WschatServer,
} from "./wschat/server.js";
import type {
  ClientToServer,
  IncomingMessageFrame,
  SendFrame,
} from "./wschat/types.js";

const log = logger("bridge");

export type BridgeOptions = {
  account: ResolvedAccount;
  /** wschat server bind. Default 127.0.0.1:8770. */
  host?: string;
  port?: number;
  /** Optional shared secret the Hermes plugin must echo in hello.token. */
  wschatToken?: string;
  /** ms of silence after which we consider Hermes' reply complete. Default 1500. */
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

  const server = createWschatServer({
    host: opts.host,
    port: opts.port,
    agentId: opts.account.handle,
    supports: ["typing"], // see module doc — we don't claim edit support
    authToken: opts.wschatToken,
  });

  let haClient: HaClient | null = null;

  // Outbound: Hermes wschat frames → relay sends.
  server.onClientFrame((frame: ClientToServer) => {
    if (frame.type === "send") {
      handleHermesSend(frame);
      return;
    }
    if (frame.type === "edit") {
      // We didn't advertise edit; treat any stray edit as a chunk anyway
      // so we don't lose data, but log a warning.
      log.warn("received edit frame though edit was not advertised; treating as chunk");
      handleHermesSend({
        type: "send",
        msgId: frame.msgId,
        chatId: frame.chatId,
        text: frame.text,
      });
      return;
    }
    if (frame.type === "typing") {
      // No relay-side typing indicator yet; logged for visibility.
      log.debug(`hermes typing on ${frame.chatId}`);
      return;
    }
  });

  function handleHermesSend(frame: SendFrame): void {
    server.ack(frame.msgId);
    const channel = pending.get(frame.chatId);
    if (channel && !channel.ended()) {
      // We're inside a streamed response — push the chunk through the
      // SDK's onMessage AsyncIterable.
      channel.emit(frame.text);
      return;
    }
    // No pending stream — Hermes is sending unsolicited (or the response
    // already closed). Send via the relay as a fresh message.
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

  // Inbound: relay messages → wschat `message` frame, then yield chunks
  // back from the wschat side as Hermes streams its reply.
  function onIncoming(msg: IncomingMessage): AsyncIterable<string> | string {
    if (!dedup.tryRecord(msg.messageId)) {
      log.debug(`duplicate message ${msg.messageId}, skipping`);
      return "";
    }
    if (!server.isReady()) {
      log.warn(
        `inbound from @${msg.fromHandle} dropped — Hermes not connected to wschat yet`,
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
    log.info(`bridge ready: relay=${opts.account.relayWs}, wschat=${opts.host ?? "127.0.0.1"}:${opts.port ?? 8770}`);
    haClient = new HaClient({
      account: opts.account,
      onIncoming,
      onStatus: (status, detail) => {
        if (status === "needs_repairing") {
          log.error(`relay rejected token (${detail ?? "?"}). Re-pair.`);
        }
      },
    });
    await haClient.ready;
    log.info(`linked to relay as @${opts.account.handle}`);
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
  // Push the inbound frame to Hermes; if the push fails we close out cleanly.
  if (!opts.pushFrame()) {
    channel.end();
  } else {
    // Arm the idle timer for the case where Hermes never replies.
    idleTimer = setTimeout(() => channel.end(), opts.idleMs * 5);
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

export { randomUUID as newMsgId };
