import { z } from "zod";
import {
  type AppParticipantConnection,
  appEndReasonSchema,
  appParticipantConnectionSchema,
  appRoleSchema,
  appUserIdSchema,
  eventDataSchema,
  eventNameSchema,
  jsonValueSchema,
  seatIdSchema,
  stateRevSchema,
  statePatchSchema,
  stateSnapshotSchema,
} from "./common.js";
import {
  APP_AVATAR_MAX_CHARS,
  APP_DISPLAY_NAME_MAX_CHARS,
  APP_MAX_PARTICIPANTS,
  APP_PARTICIPANTS_AVATAR_BUDGET_CHARS,
  APP_STORE_KEY_PATTERN,
  APP_STORE_LIST_MAX,
  APP_STORE_META_MAX_BYTES,
  APP_STORE_PREFIX_PATTERN,
  APP_THEME_MAX_TOKENS,
  APP_UI_MAX_HEIGHT,
  APP_UI_MIN_HEIGHT,
} from "./limits.js";
import { APP_PLATFORM_API } from "./manifest.js";

/**
 * The bridge: the sandbox message API v1 between the pqp page (the host) and a
 * sandboxed app frame. The app is untrusted.
 *
 * What the app NEVER sees, by construction of these schemas: a pqp user id, an
 * email, a token, a server id or a channel id. It sees a display name, an
 * avatar as a data URL, a random per-session seat id and, only for people who
 * consented, a per-app derived id. `bridge.test.ts` walks every schema here and
 * fails if a key that could carry one of those ever appears.
 *
 * Transport
 * ---------
 * 1. Handshake, on `window.postMessage` (the only messages not on the port):
 *    the app posts `app-hello` to its parent; the host answers `app-port`
 *    with one end of a `MessageChannel` transferred. The host MUST check
 *    `event.source === iframe.contentWindow` and ignore everything else, and
 *    the app MUST check that the port message came from `window.parent`.
 *    The frame is an opaque origin, so there is no origin to compare.
 * 2. Everything after that travels on the port: requests from the app
 *    (`bridgeAppMessageSchema`), and responses and pushes from the host
 *    (`bridgeHostMessageSchema`).
 *
 * Strict toward the less trusted side, tolerant toward a newer peer
 * -------------------------------------------------------------------
 * Messages FROM the app (`app-hello`, every request) are strict: an unknown
 * key is a rejection, because the app is untrusted and must not smuggle
 * anything past the host. Messages TO the app (`app-port`, responses, pushes)
 * use zod's default strip: an unknown key is dropped, never passed through, so
 * a field added later does not make an app pinned to platform API 1 reject the
 * whole message, and an unknown key can never reach the app either.
 */

// ---------------------------------------------------------------------------
// Handshake (window.postMessage)

/** App to parent. `platformApi` is what the app was written against. */
export const bridgeAppHelloSchema = z
  .object({
    pqp: z.literal("app-hello"),
    platformApi: z.number().int().min(1).max(1000),
  })
  .strict();
export type BridgeAppHello = z.infer<typeof bridgeAppHelloSchema>;

/**
 * Parent to app. The schema covers the data object; the `MessagePort` rides
 * in the `transfer` list of `postMessage`, which no schema can see.
 */
export const bridgeAppPortSchema = z
  .object({
    pqp: z.literal("app-port"),
    platformApi: z.literal(APP_PLATFORM_API),
  })
  .strip();
export type BridgeAppPort = z.infer<typeof bridgeAppPortSchema>;

// ---------------------------------------------------------------------------
// App to host (on the port)

/** Correlates a request with its response. */
export const bridgeRequestIdSchema = z.string().min(1).max(32);

/** Binary payloads are transferred, not copied; checked without `instanceof` (realms differ). */
const arrayBufferByteLength = Object.getOwnPropertyDescriptor(
  ArrayBuffer.prototype,
  "byteLength",
)?.get;

/** The native getter is a brand check that works across realms and cannot be spoofed with a tag. */
function isArrayBuffer(value: unknown): value is ArrayBuffer {
  if (typeof value !== "object" || value === null || !arrayBufferByteLength) return false;
  try {
    arrayBufferByteLength.call(value);
    return true;
  } catch {
    return false;
  }
}

const arrayBufferSchema = z.custom<ArrayBuffer>(isArrayBuffer, {
  message: "expected an ArrayBuffer",
});

function request<T extends string, S extends z.ZodRawShape>(type: T, params: S) {
  return z
    .object({ id: bridgeRequestIdSchema, type: z.literal(type), ...params })
    .strict();
}

export const bridgeParticipantsGetSchema = request("participants.get", {});
export const bridgeStateGetSchema = request("state.get", {});
/**
 * `patch` is a JSON Merge Patch (RFC 7396) over the session state. `baseRev`
 * makes the write conditional: the host answers `stale-rev` when the state has
 * moved on.
 */
export const bridgeStatePatchSchema = request("state.patch", {
  patch: statePatchSchema,
  baseRev: stateRevSchema.optional(),
});
export const bridgeEventsSendSchema = request("events.send", {
  name: eventNameSchema,
  data: eventDataSchema,
});
/** `name` is one of the manifest's `assets[]`. */
export const bridgeAssetsGetSchema = request("assets.get", {
  name: z.string().regex(/^[a-z0-9][a-z0-9._-]{0,63}$/),
});
/** The manifest decides the accept list and the size cap; the file name never crosses. */
export const bridgeFilesPickLocalSchema = request("files.pickLocal", {});

/**
 * The device store (`capabilities.deviceStore`): named blobs the app keeps on
 * the person's device, in the host's own IndexedDB database, one object store
 * per app id. An old host does not know these types and answers `invalid`
 * (strict union), a new host answers `not-allowed` to an app that did not
 * declare the capability. `meta` is small JSON the app may attach to a value.
 */
const storeKeySchema = z.string().regex(APP_STORE_KEY_PATTERN);
const storeMetaSchema = jsonValueSchema(APP_STORE_META_MAX_BYTES);
export const bridgeStoreGetSchema = request("store.get", { key: storeKeySchema });
export const bridgeStorePutSchema = request("store.put", {
  key: storeKeySchema,
  bytes: arrayBufferSchema,
  meta: storeMetaSchema.optional(),
});
export const bridgeStoreDeleteSchema = request("store.delete", { key: storeKeySchema });
export const bridgeStoreListSchema = request("store.list", {
  prefix: z.string().regex(APP_STORE_PREFIX_PATTERN),
});
export const bridgeStoreUsageSchema = request("store.usage", {});
/**
 * Hands the person a file to keep (the host triggers the download). `ext` must
 * be on the platform's closed list AND in the manifest's `localFiles.accept`;
 * the file name is the host's, never the app's.
 */
export const bridgeFilesSaveLocalSchema = request("files.saveLocal", {
  bytes: arrayBufferSchema,
  ext: z.string().regex(/^\.[a-z0-9]{1,8}$/),
});
/**
 * SAVES NA CONTA (`sync.*`, Locadora only, flag `locadora_save_sync`). The app
 * hands the host the SHA-256 of the game file it holds (`game`, which never
 * leaves the device: the host turns it into an account-salted key) and the
 * bytes of one battery save or one save state; the host talks to the API with
 * the person's own token, which the app never sees. A host that does not know
 * these answers `invalid` (strict union), a host that has them answers
 * `not-allowed` to any other app and wherever the flag is off. What the app
 * hands over here is a save and its picture, never the game: there is no field
 * a game file could ride in, and `bytes` is capped at 1 MiB.
 */
const syncGameSchema = z.string().regex(/^[0-9a-f]{64}$/);
/** A save on the account. Named `save`, never `id`, in a request: `id` is the request's own. */
const syncIdSchema = z.string().uuid();
const syncTagSchema = z.string().regex(/^[A-Za-z0-9._+-]{1,32}$/);
const syncKindSchema = z.enum(["sram", "state"]);
const syncSlotSchema = z.number().int().min(0).max(4);
export const BRIDGE_SYNC_MAX_BYTES = 1024 * 1024;
export const BRIDGE_SYNC_THUMB_MAX_BYTES = 16 * 1024;
const syncBytesSchema = arrayBufferSchema.refine(
  (bytes) => arrayBufferByteLength!.call(bytes) <= BRIDGE_SYNC_MAX_BYTES,
  { message: `a save is at most ${BRIDGE_SYNC_MAX_BYTES} bytes` },
);
const syncThumbSchema = arrayBufferSchema.refine(
  (bytes) => arrayBufferByteLength!.call(bytes) <= BRIDGE_SYNC_THUMB_MAX_BYTES,
  { message: `a thumbnail is at most ${BRIDGE_SYNC_THUMB_MAX_BYTES} bytes` },
);
export const bridgeSyncStatusSchema = request("sync.status", {});
export const bridgeSyncListSchema = request("sync.list", { game: syncGameSchema });
export const bridgeSyncGetSchema = request("sync.get", { save: syncIdSchema });
export const bridgeSyncPutSchema = request("sync.put", {
  game: syncGameSchema,
  kind: syncKindSchema,
  slot: syncSlotSchema,
  /** The rev this write replaces, 0 for "none on the account". The host answers `stale-rev` when it moved. */
  baseRev: z.number().int().min(0),
  bytes: syncBytesSchema,
  thumb: syncThumbSchema.optional(),
  platform: syncTagSchema,
  core: syncTagSchema,
  coreVersion: syncTagSchema,
});
export const bridgeSyncDeleteSchema = request("sync.delete", { save: syncIdSchema });
/** Brings back the newest older version of a battery save (the account keeps three). */
export const bridgeSyncRestoreSchema = request("sync.restore", {
  save: syncIdSchema,
  baseRev: z.number().int().min(1),
});
/** Deletes this game's saves from the account, or every one of them without `game`. */
export const bridgeSyncClearSchema = request("sync.clear", { game: syncGameSchema.optional() });

export const bridgeUiResizeSchema = request("ui.resize", {
  height: z.number().int().min(APP_UI_MIN_HEIGHT).max(APP_UI_MAX_HEIGHT),
});
export const bridgeUiFullscreenSchema = request("ui.fullscreen", { on: z.boolean() });
export const bridgeShareRequestSchema = request("share.request", { on: z.boolean() });
export const bridgeSessionEndSchema = request("session.end", {});

export const bridgeAppMessageSchema = z.discriminatedUnion("type", [
  bridgeParticipantsGetSchema,
  bridgeStateGetSchema,
  bridgeStatePatchSchema,
  bridgeEventsSendSchema,
  bridgeAssetsGetSchema,
  bridgeFilesPickLocalSchema,
  bridgeStoreGetSchema,
  bridgeStorePutSchema,
  bridgeStoreDeleteSchema,
  bridgeStoreListSchema,
  bridgeStoreUsageSchema,
  bridgeFilesSaveLocalSchema,
  bridgeSyncStatusSchema,
  bridgeSyncListSchema,
  bridgeSyncGetSchema,
  bridgeSyncPutSchema,
  bridgeSyncDeleteSchema,
  bridgeSyncRestoreSchema,
  bridgeSyncClearSchema,
  bridgeUiResizeSchema,
  bridgeUiFullscreenSchema,
  bridgeShareRequestSchema,
  bridgeSessionEndSchema,
]);
export type BridgeAppMessage = z.infer<typeof bridgeAppMessageSchema>;
export type BridgeRequestType = BridgeAppMessage["type"];

// ---------------------------------------------------------------------------
// Host to app: shared pieces

export const bridgeParticipantConnectionSchema = appParticipantConnectionSchema;
export type BridgeParticipantConnection = AppParticipantConnection;

/** What an app may be told about one person in the session. */
export const bridgeParticipantSchema = z
  .object({
    seatId: seatIdSchema,
    displayName: z.string().min(1).max(APP_DISPLAY_NAME_MAX_CHARS),
    /** A data URL fetched by the host, or null. Never a link the app could load. */
    avatar: z
      .string()
      .max(APP_AVATAR_MAX_CHARS)
      .regex(/^data:image\/[a-z0-9.+-]+[;,]/)
      .nullable(),
    role: appRoleSchema,
    isHost: z.boolean(),
    /** `reconnecting` while the seat is held for its 90 second resume window. */
    connection: bridgeParticipantConnectionSchema,
    /** Per-app derived id. Present only for people who ticked the consent box. */
    appUserId: appUserIdSchema.optional(),
  })
  .strip();
export type BridgeParticipant = z.infer<typeof bridgeParticipantSchema>;

export const bridgeParticipantListSchema = z
  .array(bridgeParticipantSchema)
  .max(APP_MAX_PARTICIPANTS)
  .refine(
    (list) =>
      list.reduce((total, person) => total + (person.avatar?.length ?? 0), 0) <=
      APP_PARTICIPANTS_AVATAR_BUDGET_CHARS,
    { message: `avatars of one list add up to at most ${APP_PARTICIPANTS_AVATAR_BUDGET_CHARS} characters` },
  );

/** CSS custom property names to values, applied by the app on its own root. */
export const bridgeThemeSchema = z
  .record(
    z.string().regex(/^--[A-Za-z0-9_-]{1,64}$/),
    z.string().max(256),
  )
  .refine((theme) => Object.keys(theme).length <= APP_THEME_MAX_TOKENS, {
    message: `a theme carries at most ${APP_THEME_MAX_TOKENS} tokens`,
  });
export type BridgeTheme = z.infer<typeof bridgeThemeSchema>;

export const bridgeConnectionStatusSchema = z.enum(["online", "reconnecting"]);
export type BridgeConnectionStatus = z.infer<typeof bridgeConnectionStatusSchema>;

export const bridgeErrorCodeSchema = z.enum([
  "not-allowed",
  "not-host",
  "too-large",
  "rate-limited",
  "stale-rev",
  "cancelled",
  "unavailable",
  "ended",
  "invalid",
]);
export type BridgeErrorCode = z.infer<typeof bridgeErrorCodeSchema>;

// ---------------------------------------------------------------------------
// Host to app: responses (carry the request id)

/** `used` and `cap` in bytes; `persisted` is whether the browser promised not to evict the store. */
function bridgeStoreUsageResult() {
  return z
    .object({
      used: z.number().int().min(0),
      cap: z.number().int().min(0),
      persisted: z.boolean(),
    })
    .strip();
}

/** What the account holds for Locadora, in bytes, of the 8 MB it may. */
function bridgeSyncUsageFields() {
  return { used: z.number().int().min(0), cap: z.number().int().min(0) };
}

/** One save on the account, as the app is told about it: never a key, an object name or an account id. */
export const bridgeSyncEntrySchema = z
  .object({
    id: syncIdSchema,
    kind: syncKindSchema,
    slot: syncSlotSchema,
    rev: z.number().int().min(1),
    size: z.number().int().min(0),
    /** SHA-256 of the stored bytes, so two copies that are the same are not called a conflict. */
    hash: z.string().regex(/^[0-9a-f]{64}$/),
    /** Epoch ms of the write. */
    savedAt: z.number().int().min(0),
    device: z.enum(["computer", "phone", "tablet"]),
    /** Written from this very browser. */
    thisDevice: z.boolean(),
    thumb: z.boolean(),
    platform: syncTagSchema,
    core: syncTagSchema,
    coreVersion: syncTagSchema,
    /** Older versions kept (battery saves only), so `sync.restore` has something to bring back. */
    history: z.number().int().min(0),
  })
  .strip();
export type BridgeSyncEntry = z.infer<typeof bridgeSyncEntrySchema>;

/**
 * The `result` of a successful call, per request type. Calls with nothing to
 * return answer `null`, so no result shape is an empty object that would
 * swallow a malformed one in the response union.
 */
export const bridgeResultSchemas = {
  "participants.get": z.object({ participants: bridgeParticipantListSchema }).strip(),
  "state.get": stateSnapshotSchema,
  "state.patch": z.object({ rev: stateRevSchema }).strip(),
  "events.send": z.null(),
  "assets.get": z
    .object({ name: z.string().min(1).max(64), bytes: arrayBufferSchema })
    .strip(),
  /**
   * `ext` is the picked file's lower-cased extension, with its dot, taken from
   * the manifest's closed `localFiles.accept` list (never from the file name),
   * so an app can pick a decoder without the name crossing the bridge.
   */
  "files.pickLocal": z
    .object({ bytes: arrayBufferSchema, ext: z.string().regex(/^\.[a-z0-9]{1,8}$/) })
    .strip(),
  /** `null` when the key holds nothing. `meta` is `null` when none was stored. */
  "store.get": z.object({ bytes: arrayBufferSchema, meta: storeMetaSchema }).strip().nullable(),
  "store.put": z.object({ usage: bridgeStoreUsageResult() }).strip(),
  "store.delete": z.null(),
  "store.list": z
    .array(
      z
        .object({
          key: storeKeySchema,
          size: z.number().int().min(0),
          meta: storeMetaSchema,
          /** Epoch milliseconds of the last write. */
          updatedAt: z.number().int().min(0),
        })
        .strip(),
    )
    .max(APP_STORE_LIST_MAX),
  "store.usage": bridgeStoreUsageResult(),
  "files.saveLocal": z.null(),
  /** `read-only`: the flag went off and the saves can still be taken back (and deleted) for 30 days. */
  "sync.status": z
    .object({
      mode: z.enum(["on", "read-only"]),
      ...bridgeSyncUsageFields(),
      /** What this device is called to the person, so the app can say "deste celular". */
      device: z.enum(["computer", "phone", "tablet"]),
    })
    .strip(),
  "sync.list": z.object({ entries: z.array(bridgeSyncEntrySchema).max(16) }).strip(),
  "sync.get": z
    .object({ rev: z.number().int().min(1), bytes: arrayBufferSchema, thumb: arrayBufferSchema.nullable() })
    .strip(),
  "sync.put": z.object({ id: syncIdSchema, rev: z.number().int().min(1), ...bridgeSyncUsageFields() }).strip(),
  "sync.delete": z.object(bridgeSyncUsageFields()).strip(),
  "sync.restore": z.object({ id: syncIdSchema, rev: z.number().int().min(1) }).strip(),
  "sync.clear": z.object({ deleted: z.number().int().min(0), ...bridgeSyncUsageFields() }).strip(),
  "ui.resize": z.object({ height: z.number().int() }).strip(),
  "ui.fullscreen": z.object({ on: z.boolean() }).strip(),
  "share.request": z.object({ on: z.boolean() }).strip(),
  "session.end": z.null(),
} as const satisfies Record<BridgeRequestType, z.ZodTypeAny>;

/** One successful response schema per request type. */
function okResponse<T extends BridgeRequestType>(type: T) {
  return z
    .object({
      id: bridgeRequestIdSchema,
      ok: z.literal(true),
      /** The request type this answers, so the result is never guessed from its shape. */
      type: z.literal(type),
      result: bridgeResultSchemas[type],
    })
    .strip();
}

/**
 * A successful response echoes the request `type`, so it is told apart by that
 * key and a newer host that adds a field to one result can never make it parse
 * as another call's result.
 */
export const bridgeResponseOkSchema = z.discriminatedUnion("type", [
  okResponse("participants.get"),
  okResponse("state.get"),
  okResponse("state.patch"),
  okResponse("events.send"),
  okResponse("assets.get"),
  okResponse("files.pickLocal"),
  okResponse("store.get"),
  okResponse("store.put"),
  okResponse("store.delete"),
  okResponse("store.list"),
  okResponse("store.usage"),
  okResponse("files.saveLocal"),
  okResponse("sync.status"),
  okResponse("sync.list"),
  okResponse("sync.get"),
  okResponse("sync.put"),
  okResponse("sync.delete"),
  okResponse("sync.restore"),
  okResponse("sync.clear"),
  okResponse("ui.resize"),
  okResponse("ui.fullscreen"),
  okResponse("share.request"),
  okResponse("session.end"),
]);
export const bridgeResponseErrorSchema = z
  .object({
    id: bridgeRequestIdSchema,
    ok: z.literal(false),
    error: bridgeErrorCodeSchema,
  })
  .strip();
export const bridgeResponseSchema = z.union([
  bridgeResponseOkSchema,
  bridgeResponseErrorSchema,
]);
export type BridgeResponse = z.infer<typeof bridgeResponseSchema>;

// ---------------------------------------------------------------------------
// Host to app: pushes (no id)

function push<T extends string, S extends z.ZodRawShape>(type: T, fields: S) {
  return z.object({ type: z.literal(type), ...fields }).strip();
}

/** Sent once, right after the port is handed over. */
export const bridgeHelloPushSchema = push("hello", {
  platformApi: z.literal(APP_PLATFORM_API),
  app: z
    .object({
      id: z.string().regex(/^[a-z][a-z0-9-]{1,30}[a-z0-9]$/),
      version: z.string().max(64),
    })
    .strip(),
  locale: z.string().regex(/^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8}){0,3}$/),
  theme: bridgeThemeSchema,
  reducedMotion: z.boolean(),
  self: z
    .object({ seatId: seatIdSchema, role: appRoleSchema, isHost: z.boolean() })
    .strip(),
  connection: bridgeConnectionStatusSchema,
});
export const bridgeParticipantsPushSchema = push("participants", {
  participants: bridgeParticipantListSchema,
});
export const bridgeStatePushSchema = push("state", {
  rev: stateRevSchema,
  value: stateSnapshotSchema.shape.value,
});
export const bridgeEventPushSchema = push("event", {
  fromSeatId: seatIdSchema,
  name: eventNameSchema,
  data: eventDataSchema,
});
export const bridgeConnectionPushSchema = push("connection", {
  status: bridgeConnectionStatusSchema,
});
export const bridgeSessionEndedPushSchema = push("session.ended", {
  reason: appEndReasonSchema,
});
export const bridgeThemePushSchema = push("theme", { theme: bridgeThemeSchema });

export const bridgePushSchema = z.discriminatedUnion("type", [
  bridgeHelloPushSchema,
  bridgeParticipantsPushSchema,
  bridgeStatePushSchema,
  bridgeEventPushSchema,
  bridgeConnectionPushSchema,
  bridgeSessionEndedPushSchema,
  bridgeThemePushSchema,
]);
export type BridgePush = z.infer<typeof bridgePushSchema>;
export type BridgeHello = z.infer<typeof bridgeHelloPushSchema>;

/**
 * Everything the host sends on the port. A response has `id` and `ok`, a push
 * has `type`, so the two halves are told apart by shape, not by one key.
 */
export const bridgeHostMessageSchema = z.union([
  bridgeResponseOkSchema,
  bridgeResponseErrorSchema,
  bridgePushSchema,
]);
export type BridgeHostMessage = z.infer<typeof bridgeHostMessageSchema>;
