/**
 * Library entry — programmatic embedders.
 *
 * Most users go through the CLI. The exports here are the minimum surface
 * needed to compose the bridge in a Node program: pair an account, then
 * start a bridge with the persisted creds.
 */

// Bridge orchestration
export { createBridge, type Bridge, type BridgeOptions } from "./bridge.js";
export type { ResolvedAccount } from "./core/types.js";

// Auth
export { importToken, type ImportTokenOptions } from "./auth/import-token.js";
export { hasAnyAuth } from "./auth/presence.js";

// Credential storage
export {
  DEFAULT_ACCOUNT_ID,
  type Creds,
  readCreds,
  writeCreds,
  deleteCreds,
  listLinkedAccountIds,
} from "./auth/store.js";
