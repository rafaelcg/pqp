/**
 * The wire types an app sees, written out here instead of imported.
 *
 * They mirror the bridge contract in `@pqp/shared` (`packages/shared/src/apps/`).
 * They are copied, not re-exported, on purpose: `@pqp/shared` is an unpublished
 * workspace package built on zod, and a published `.d.ts` that named it would
 * leave every consumer with a type that does not resolve. `types.parity.test.ts`
 * fails the moment either side drifts, so the copy cannot go stale quietly.
 */

/** A value that survives `JSON.stringify` and `JSON.parse` unchanged. */
export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

/** Every code a rejected call can carry. */
export type BridgeErrorCode =
  | "not-allowed"
  | "not-host"
  | "too-large"
  | "rate-limited"
  | "stale-rev"
  | "cancelled"
  | "unavailable"
  | "ended"
  | "invalid";

/** `online`, or `reconnecting` while the host is trying to get the session back. */
export type BridgeConnectionStatus = "online" | "reconnecting";

/** CSS custom property names (`--color-text`) to their values, at most 64. */
export type BridgeTheme = Record<string, string>;

/** `player`, or `spectator` for somebody past the player limit or under a timeout. */
export type AppRole = "player" | "spectator";

/** `present`, or `reconnecting` while the seat is held for its 90 second resume window. */
export type AppParticipantConnection = "present" | "reconnecting";

/** Why a session ended, as `session.ended` and `app.on("ended")` report it. */
export type AppEndReason =
  | "host"
  | "moderator"
  | "operator"
  | "idle"
  | "host-gone"
  | "app-disabled"
  | "empty"
  | "max-duration"
  | "channel-gone"
  | "flag-off";

/** What the host may tell an app about one person. */
export interface BridgeParticipant {
  seatId: string;
  displayName: string;
  /** A data URL the host already fetched, or null. Never a link the app could load. */
  avatar: string | null;
  role: AppRole;
  isHost: boolean;
  connection: AppParticipantConnection;
  /** Per-app derived id. Present only for people who ticked the consent box. */
  appUserId?: string;
}

/** The first push after the port is handed over. */
export interface BridgeHello {
  type: "hello";
  platformApi: 1;
  app: { id: string; version: string };
  locale: string;
  theme: BridgeTheme;
  reducedMotion: boolean;
  self: { seatId: string; role: AppRole; isHost: boolean };
  connection: BridgeConnectionStatus;
}
