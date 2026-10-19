/**
 * Caps of the apps platform that the bridge and the WebSocket frames enforce
 * beyond the ones `manifest.ts` owns (`APP_PLATFORM_API`, `APP_STATE_MAX_BYTES`,
 * `APP_EVENT_MAX_BYTES`, `APP_EVENT_MAX_PER_SECOND`,
 * `APP_STATE_MAX_WRITES_PER_SECOND`), which `common.ts` and `bridge.ts` import
 * from there.
 */

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
