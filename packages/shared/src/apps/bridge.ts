import { z } from "zod";
import {
  type AppParticipantConnection,
  appEndReasonSchema,
  appParticipantConnectionSchema,
  appRoleSchema,
  appUserIdSchema,
  eventDataSchema,
  eventNameSchema,
  seatIdSchema,
  stateRevSchema,
  statePatchSchema,
  stateSnapshotSchema,
} from "./common.js";
import {
  APP_AVATAR_MAX_CHARS,
  APP_DISPLAY_NAME_MAX_CHARS,
  APP_MAX_PARTICIPANTS,
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
  .max(APP_MAX_PARTICIPANTS);

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
  "files.pickLocal": z.object({ bytes: arrayBufferSchema }).strip(),
  "ui.resize": z.object({ height: z.number().int() }).strip(),
  "ui.fullscreen": z.object({ on: z.boolean() }).strip(),
  "share.request": z.object({ on: z.boolean() }).strip(),
  "session.end": z.null(),
} as const satisfies Record<BridgeRequestType, z.ZodTypeAny>;

const bridgeResultSchema = z.union([
  bridgeResultSchemas["participants.get"],
  bridgeResultSchemas["state.get"],
  bridgeResultSchemas["state.patch"],
  bridgeResultSchemas["assets.get"],
  bridgeResultSchemas["files.pickLocal"],
  bridgeResultSchemas["ui.resize"],
  bridgeResultSchemas["ui.fullscreen"],
  bridgeResultSchemas["share.request"],
  bridgeResultSchemas["events.send"],
  bridgeResultSchemas["session.end"],
]);

export const bridgeResponseOkSchema = z
  .object({
    id: bridgeRequestIdSchema,
    ok: z.literal(true),
    result: bridgeResultSchema,
  })
  .strip();
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
