/**
 * Wire types for the agent-socket protocol.
 *
 * Agent adapter (client) ↔ this bridge (server):
 *   client → server: hello, send, edit, typing, pong
 *   server → client: welcome, message, ack, ping, error
 *
 * On Hermes' side this protocol is currently exposed via a plugin named
 * `wschat` — it implements this exact wire format.
 */

export type HelloFrame = {
  type: "hello";
  agent: string;
  version: number;
  token?: string;
};

export type WelcomeFrame = {
  type: "welcome";
  agentId: string;
  /** Capabilities advertised to the Hermes plugin. */
  supports: ("edit" | "typing")[];
};

export type IncomingMessageFrame = {
  type: "message";
  msgId: string;
  from: string;
  fromName?: string;
  chatId: string;
  chatName?: string;
  chatType?: "dm" | "group" | "channel" | "thread";
  text: string;
};

export type SendFrame = {
  type: "send";
  msgId: string;
  chatId: string;
  text: string;
  replyTo?: string | null;
};

export type EditFrame = {
  type: "edit";
  msgId: string;
  chatId: string;
  text: string;
};

export type TypingFrame = {
  type: "typing";
  chatId: string;
};

export type AckFrame = {
  type: "ack";
  refMsgId: string;
};

export type PingFrame = {
  type: "ping";
  ts: number;
};

export type PongFrame = {
  type: "pong";
  ts: number;
};

export type ErrorFrame = {
  type: "error";
  code: string;
  message: string;
};

export type ServerToClient =
  | WelcomeFrame
  | IncomingMessageFrame
  | AckFrame
  | PingFrame
  | ErrorFrame;

export type ClientToServer =
  | HelloFrame
  | SendFrame
  | EditFrame
  | TypingFrame
  | PongFrame;
