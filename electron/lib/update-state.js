/**
 * What the shell's updater is doing, as one value the page can draw.
 *
 * The pure half of `updater.js`: events from electron-updater go in, a state
 * comes out, and the page's update button (`client/src/lib/desktop-update.ts`)
 * renders it. Same shape as T3 Code's update pill: up to date, an update to
 * download, downloading with a percentage, downloaded and waiting for a
 * restart, or a failure with what failed.
 *
 * Two rules keep a background check from undoing what the person already has:
 *  - a check, or a check that fails, never takes away an update that is
 *    available, downloading or downloaded;
 *  - "available" for the version already downloaded keeps it downloaded
 *    (electron-updater reports the staged version as available again on every
 *    later check).
 *
 * @typedef {"check" | "download"} UpdateErrorContext
 * @typedef {(
 *   | { status: "disabled" }
 *   | { status: "idle" }
 *   | { status: "checking" }
 *   | { status: "up-to-date"; checkedAt: number }
 *   | { status: "available"; version: string }
 *   | { status: "downloading"; version: string; percent: number }
 *   | { status: "downloaded"; version: string }
 *   | { status: "error"; context: UpdateErrorContext; version: string | null }
 * )} UpdateState
 * @typedef {(
 *   | { type: "check" }
 *   | { type: "not-available"; at: number }
 *   | { type: "available"; version: string }
 *   | { type: "download" }
 *   | { type: "progress"; percent: number }
 *   | { type: "downloaded"; version: string }
 *   | { type: "error" }
 * )} UpdateEvent
 */

/** @type {UpdateState} */
const DISABLED = Object.freeze({ status: "disabled" });
/** @type {UpdateState} */
const IDLE = Object.freeze({ status: "idle" });

/** @param {UpdateState} state */
function heldVersion(state) {
  return state.status === "available" ||
    state.status === "downloading" ||
    state.status === "downloaded"
    ? state.version
    : null;
}

/** @param {unknown} value */
function clampPercent(value) {
  const n = typeof value === "number" && Number.isFinite(value) ? value : 0;
  return Math.max(0, Math.min(100, Math.round(n)));
}

/**
 * @param {UpdateState} state
 * @param {UpdateEvent} event
 * @returns {UpdateState}
 */
function nextUpdateState(state, event) {
  if (state.status === "disabled") {
    return state;
  }
  const held = heldVersion(state);
  switch (event.type) {
    case "check":
      return held ? state : { status: "checking" };
    case "not-available":
      return held ? state : { status: "up-to-date", checkedAt: event.at };
    case "available":
      if (state.status === "downloaded" && state.version === event.version) {
        return state;
      }
      if (state.status === "downloading" && state.version === event.version) {
        return state;
      }
      return { status: "available", version: event.version };
    case "download": {
      const version =
        held ?? (state.status === "error" ? state.version : null);
      return version ? { status: "downloading", version, percent: 0 } : state;
    }
    case "progress":
      return state.status === "downloading"
        ? { ...state, percent: clampPercent(event.percent) }
        : state;
    case "downloaded":
      return { status: "downloaded", version: event.version };
    case "error": {
      // A background check that fails while an update is in hand is not the
      // person's problem: they keep the button they had.
      if (state.status === "available" || state.status === "downloaded") {
        return state;
      }
      if (state.status === "downloading") {
        return { status: "error", context: "download", version: state.version };
      }
      if (state.status === "error") {
        return state;
      }
      return { status: "error", context: "check", version: null };
    }
    default:
      return state;
  }
}

/**
 * A copy safe to send over IPC: plain fields only, nothing from
 * electron-updater's own objects.
 *
 * @param {UpdateState} state
 */
function serializeUpdateState(state) {
  return JSON.parse(JSON.stringify(state));
}

module.exports = { DISABLED, IDLE, nextUpdateState, serializeUpdateState };
