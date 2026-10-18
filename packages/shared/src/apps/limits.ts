/**
 * Caps of the apps platform that the bridge and the WebSocket frames enforce.
 *
 * `manifest.ts` (P1-A) defines the same names for the manifest's ceilings.
 * Both files carry the same numbers on purpose: whichever PR merges second
 * de-duplicates by importing from the other. Until then a test in each file
 * pins the value, so a drift fails CI.
 */

/** Version of the sandbox message API (the bridge) this build speaks. */
export const APP_PLATFORM_API = 1;

/** Largest serialized session state, and largest single state patch, in bytes. */
export const APP_STATE_MAX_BYTES = 16384;

/** Largest serialized payload of one ephemeral app event, in bytes. */
export const APP_EVENT_MAX_BYTES = 1024;

/** Ceiling of events one participant may send per second. */
export const APP_EVENT_MAX_PER_SECOND = 20;

/** Ceiling of state writes per second, across the whole session. */
export const APP_STATE_MAX_WRITES_PER_SECOND = 10;

/** players.max (64) plus maxSpectators (200) is the manifest ceiling; this is the roster cap. */
export const APP_MAX_PARTICIPANTS = 264;

/** Deepest allowed nesting of a JSON value that crosses the bridge or a frame. */
export const APP_JSON_MAX_DEPTH = 32;

/** Longest data URL of a participant avatar, in characters. */
export const APP_AVATAR_MAX_CHARS = 65536;

/** Longest display name that reaches an app, in characters. */
export const APP_DISPLAY_NAME_MAX_CHARS = 64;

/** Most CSS custom properties a theme push may carry. */
export const APP_THEME_MAX_TOKENS = 64;

/** Bounds of `ui.resize`, in CSS pixels. */
export const APP_UI_MIN_HEIGHT = 120;
export const APP_UI_MAX_HEIGHT = 2000;
