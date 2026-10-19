import type {
  APP_ERROR_CODES,
  AppCapabilities,
  AppEndReason,
  AppRole,
  BridgeConnectionStatus,
  JsonValue,
} from "@pqp/shared";

/** The `app-error` codes the server speaks. */
export type AppErrorCode = (typeof APP_ERROR_CODES)[number];

/**
 * One app as the frame host needs it: the slice of an entry of
 * `GET /api/apps/config` that decides what the app may do, plus what it may
 * fetch. The host enforces these again on the client; the server enforces them
 * for real.
 */
export interface AppRuntimeConfig {
  id: string;
  version: string;
  entry: { url: string };
  capabilities: Pick<AppCapabilities, "share" | "localFiles">;
  /** The manifest's caps. Missing means the hard platform caps. */
  state?: { maxBytes: number; maxWritesPerSecond?: number; writers?: "host" | "participants" };
  events?: { maxPerSecond: number; maxBytes: number };
  /** The manifest's `assets[]` with the URL the host fetches them from. */
  assets?: Array<{ name: string; url: string; sha256: string; bytes: number }>;
  /** `appShareAllowed(serverId, app)` for this server, as the config answered it. */
  shareAllowed?: boolean;
}

/** One seated person, as the `app-session` frame carries it (pqp user id included). */
export interface SessionParticipant {
  seatId: string;
  userId: string;
  role: AppRole;
  isHost: boolean;
  connection: "present" | "reconnecting";
  appUserId?: string;
}

/** What `join` answers and what a refresh of the seat delivers: the `app-session` frame, mapped. */
export interface SessionSnapshot {
  sessionId: string;
  seatId: string;
  role: AppRole;
  isHost: boolean;
  state: { rev: number; value: JsonValue };
  participants: SessionParticipant[];
}

/** A rejected transport call: one of the `app-error` codes the server speaks. */
export class AppTransportError extends Error {
  readonly code: AppErrorCode;
  constructor(code: AppErrorCode) {
    super(`app session call failed: ${code}`);
    this.name = "AppTransportError";
    this.code = code;
  }
}

export interface AppSessionHandlers {
  /**
   * A fresh `app-session` snapshot for this seat: after `join`, after a resume,
   * and whenever the roster changes. The host diffs it against what it last
   * sent, so a snapshot that changes nothing costs nothing.
   */
  onSession(snapshot: SessionSnapshot): void;
  /** `app-state` for this session, in revision order. */
  onState(rev: number, value: JsonValue): void;
  /** `app-event` from another seat. */
  onEvent(event: { fromSeatId: string; name: string; data: JsonValue }): void;
  /** The `/ws` link to the session dropped (`reconnecting`) or came back (`online`). */
  onConnection(status: BridgeConnectionStatus): void;
  /** `app-ended`, or the seat being refused for good. */
  onEnded(reason: AppEndReason): void;
}

/**
 * What the bridge host needs from the session on the server. Track U wires it to
 * the `/ws` frames of `packages/shared/src/apps/frames.ts` and to
 * `POST /api/app-sessions/:id/end`; tests wire it to a fake. Every method that
 * can be refused rejects with an `AppTransportError`.
 */
export interface AppSessionTransport {
  /** Send `app-join`; resolves with the `app-session` snapshot. */
  join(options: { asSpectator?: boolean }): Promise<SessionSnapshot>;
  /** Send `app-leave`. The seat is released, not held. */
  leave(): void;
  /** Send `app-state-patch`; resolves with the revision the server gave this write. */
  patchState(patch: JsonValue, baseRev: number | undefined): Promise<{ rev: number }>;
  /** Send `app-event-send`. Not acknowledged: events are ephemeral. */
  sendEvent(name: string, data: JsonValue): void;
  /** End the session for everybody (host, or somebody with MANAGE_CHANNELS). */
  end(): Promise<void>;
  /** Start listening. Returns the unsubscribe. */
  subscribe(handlers: AppSessionHandlers): () => void;
}

/** Who a user id is, for drawing a seat: a name and where the avatar lives. */
export interface AppUserInfo {
  displayName: string;
  /** An http(s) or same-origin URL, or null. Fetched by the host, never given to the app. */
  avatarUrl: string | null;
}

export interface AppUserDirectory {
  resolve(userId: string): AppUserInfo | null;
}
