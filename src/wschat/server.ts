/**
 * Local wschat WebSocket server. Hermes' wschat plugin connects here as a
 * client (one connection per Hermes process). We expose a small typed
 * surface for the bridge: forward inbound HelloAgent messages → wschat
 * `message` frames; receive Hermes outbound `send`/`edit` frames → notify
 * subscribers.
 *
 * Wire protocol matches the Hermes wschat plugin; frame shapes live in
 * ./types.ts.
 */
import { WebSocketServer, type WebSocket } from "ws";

import { logger } from "../core/logger.js";
import type {
  ClientToServer,
  IncomingMessageFrame,
  ServerToClient,
  WelcomeFrame,
} from "./types.js";

const log = logger("wschat/server");

export type WschatServerOptions = {
  /** Bind host. Default 127.0.0.1. */
  host?: string;
  /** Bind port. Default 8770. */
  port?: number;
  /** Identifier we send back in `welcome.agentId`. */
  agentId: string;
  /** Capabilities advertised in `welcome.supports`. */
  supports?: ("edit" | "typing")[];
  /** Optional shared secret; if set, Hermes' hello.token must match. */
  authToken?: string;
};

/**
 * Frames the bridge wants to know about. We do NOT surface ping/pong here —
 * server handles those itself.
 */
export type ClientFrameHandler = (frame: ClientToServer) => void;

export type WschatServer = {
  start(): Promise<void>;
  stop(): Promise<void>;
  /** Push an inbound HelloAgent message to the connected Hermes. */
  pushIncoming(msg: IncomingMessageFrame): boolean;
  /** Emit an ack for a Hermes-sent msgId. */
  ack(refMsgId: string): boolean;
  /** Subscribe to Hermes-sent frames (send/edit/typing/pong). */
  onClientFrame(handler: ClientFrameHandler): void;
  /** True iff a Hermes plugin has completed the hello/welcome handshake. */
  isReady(): boolean;
};

export function createWschatServer(opts: WschatServerOptions): WschatServer {
  const host = opts.host ?? "127.0.0.1";
  const port = opts.port ?? 8770;
  const supports = opts.supports ?? ["typing"];
  const handlers: ClientFrameHandler[] = [];

  let wss: WebSocketServer | null = null;
  let active: WebSocket | null = null;
  let activeReady = false;
  let pingTimer: NodeJS.Timeout | null = null;

  function start(): Promise<void> {
    return new Promise((resolve, reject) => {
      const server = new WebSocketServer({ host, port });
      server.once("listening", () => {
        log.info(`listening on ws://${host}:${port}`);
        wss = server;
        resolve();
      });
      server.once("error", (err) => reject(err));
      server.on("connection", (socket, req) => attachClient(socket, req.socket.remoteAddress));
    });
  }

  function attachClient(socket: WebSocket, remote?: string): void {
    if (active && active.readyState === active.OPEN) {
      log.warn("rejecting second client connection — single-tenant server");
      safeJson(socket, {
        type: "error",
        code: "already_connected",
        message: "wschat bridge accepts a single Hermes connection",
      });
      socket.close();
      return;
    }
    log.info(`client connected from ${remote ?? "?"}`);
    active = socket;
    activeReady = false;

    socket.on("message", (raw) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw.toString("utf8"));
      } catch {
        safeJson(socket, {
          type: "error",
          code: "bad_json",
          message: "frames must be JSON",
        });
        return;
      }
      if (!isClientFrame(parsed)) {
        safeJson(socket, {
          type: "error",
          code: "bad_frame",
          message: "missing/invalid 'type'",
        });
        return;
      }
      handleClientFrame(socket, parsed);
    });

    socket.on("close", () => {
      log.info("client disconnected");
      if (active === socket) {
        active = null;
        activeReady = false;
        if (pingTimer) {
          clearInterval(pingTimer);
          pingTimer = null;
        }
      }
    });

    socket.on("error", (err) => {
      log.warn(`socket error: ${err instanceof Error ? err.message : String(err)}`);
    });
  }

  function handleClientFrame(socket: WebSocket, frame: ClientToServer): void {
    if (frame.type === "hello") {
      if (opts.authToken && frame.token !== opts.authToken) {
        safeJson(socket, {
          type: "error",
          code: "auth_failed",
          message: "hello.token did not match server token",
        });
        socket.close();
        return;
      }
      const welcome: WelcomeFrame = {
        type: "welcome",
        agentId: opts.agentId,
        supports,
      };
      safeJson(socket, welcome);
      activeReady = true;
      log.info(`handshake complete (agent=${frame.agent}, version=${frame.version})`);
      // Start app-level keepalive ping every 25 s (the plugin replies pong).
      if (!pingTimer) {
        pingTimer = setInterval(() => {
          if (active && active.readyState === active.OPEN) {
            safeJson(active, { type: "ping", ts: Date.now() });
          }
        }, 25_000);
      }
      return;
    }
    if (frame.type === "pong") {
      // Absorb silently.
      return;
    }
    // send / edit / typing — surface to subscribers.
    for (const handler of handlers) {
      try {
        handler(frame);
      } catch (err) {
        log.error(
          `client frame handler threw: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  }

  function pushIncoming(msg: IncomingMessageFrame): boolean {
    if (!active || !activeReady || active.readyState !== active.OPEN) {
      return false;
    }
    return safeJson(active, msg);
  }

  function ack(refMsgId: string): boolean {
    if (!active || active.readyState !== active.OPEN) return false;
    return safeJson(active, { type: "ack", refMsgId });
  }

  function onClientFrame(handler: ClientFrameHandler): void {
    handlers.push(handler);
  }

  function isReady(): boolean {
    return active !== null && activeReady && active.readyState === active.OPEN;
  }

  async function stop(): Promise<void> {
    if (pingTimer) {
      clearInterval(pingTimer);
      pingTimer = null;
    }
    if (active && active.readyState === active.OPEN) {
      try {
        active.close(1001, "bridge shutting down");
      } catch {
        /* best-effort */
      }
    }
    active = null;
    activeReady = false;

    if (!wss) return;
    await new Promise<void>((resolve) => wss?.close(() => resolve()));
    wss = null;
    log.info(`stopped (was ws://${host}:${port})`);
  }

  return { start, stop, pushIncoming, ack, onClientFrame, isReady };
}

function safeJson(socket: WebSocket, payload: ServerToClient | object): boolean {
  try {
    socket.send(JSON.stringify(payload));
    return true;
  } catch {
    return false;
  }
}

function isClientFrame(v: unknown): v is ClientToServer {
  if (typeof v !== "object" || v === null) return false;
  const t = (v as { type?: unknown }).type;
  return typeof t === "string" && (
    t === "hello" || t === "send" || t === "edit" || t === "typing" || t === "pong"
  );
}
