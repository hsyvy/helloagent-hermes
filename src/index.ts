/**
 * Library entry — programmatic embedders.
 *
 * Most users go through the CLI (./cli.ts). The exports here let you
 * compose the bridge in your own Node program (e.g., embedding it in a
 * larger orchestrator).
 */
export { createBridge, type Bridge, type BridgeOptions } from "./bridge.js";
export { HaClient, type HaClientOptions, type ClientStatus } from "./core/ha-client.js";
export {
  createWschatServer,
  type WschatServer,
  type WschatServerOptions,
} from "./wschat/server.js";

// Auth surface
export { pairWithBrowser, type PairOptions } from "./auth/login.js";
export { pairWithDeviceCode, type DevicePairOptions } from "./auth/login-device.js";
export { importToken, type ImportTokenOptions } from "./auth/import-token.js";
export { hasAnyAuth } from "./auth/presence.js";
export {
  CREDS_VERSION,
  DEFAULT_ACCOUNT_ID,
  type Creds,
  readCreds,
  writeCreds,
  deleteCreds,
  listLinkedAccountIds,
  resolveStateDir,
  resolveAuthDir,
  accountAuthDir,
} from "./auth/store.js";

// Types
export type { ResolvedAccount } from "./core/types.js";
export type {
  ClientToServer,
  ServerToClient,
  IncomingMessageFrame,
  SendFrame,
  EditFrame,
  TypingFrame,
  WelcomeFrame,
  HelloFrame,
} from "./wschat/types.js";
