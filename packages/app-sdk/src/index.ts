/**
 * @pqp/app-sdk: what a pqp app imports to talk to the pqp page.
 *
 *   import { connect } from "@pqp/app-sdk";
 *   const app = await connect();
 *
 * Zero dependencies, runtime or type: the wire types live in `types.ts`, so
 * the published `.d.ts` names nothing outside this package.
 */
export { connect, type ConnectOptions, type HandshakeWindow } from "./connect.js";
export { createApp } from "./app.js";
export {
  type AppEvent,
  type AppEventMap,
  type Participant,
  type PickedFile,
  type PqpApp,
  type StateSnapshot,
  type StoreEntry,
  type StoredValue,
  type StoreUsage,
} from "./app.js";
export { PortClient, REQUEST_TIMEOUT_MS, type Unsubscribe } from "./client.js";
// Saves na conta: its own module, so an app that never imports it builds byte for byte as before (see sync.ts)
export {
  connectWithSync,
  createSyncApi,
  type ActivityApi,
  type ActivityState,
  type SyncApi,
  type SyncEntry,
  type SyncPut,
  type SyncStatus,
} from "./sync.js";
export { PqpAppError } from "./errors.js";
export type {
  AppEndReason,
  AppParticipantConnection,
  AppRole,
  BridgeConnectionStatus,
  BridgeErrorCode,
  BridgeHello,
  BridgeParticipant,
  BridgeTheme,
  JsonValue,
} from "./types.js";
export { applyTheme, type ThemeRoot } from "./theme.js";
