/**
 * Whether the participant rail on a screen-share stage is showing, remembered
 * per device.
 *
 * PURELY LOCAL, on purpose, the same call `member-sidebar-preference` makes:
 * "I want the share full-width on this monitor" describes a window, not a
 * person. It is a boolean rather than a tri-state because the rail has no
 * width-dependent default: it is open unless somebody closed it.
 *
 * The choice is deliberately NOT reset when the presenter changes or a new
 * share starts. Somebody who tucked the rail away in a 100-person watch party
 * did it to watch the share, and a new presenter does not change that.
 */

const STORAGE_KEY = "pqp:participant-rail";

export function loadParticipantRailOpen(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY) !== "false";
  } catch {
    // Storage denied (privacy mode, an Electron partition without quota):
    // the rail is open, which is the app working rather than a missing rail.
    return true;
  }
}

export function saveParticipantRailOpen(open: boolean): void {
  try {
    localStorage.setItem(STORAGE_KEY, open ? "true" : "false");
  } catch {
    // The toggle still works for the session; only the memory of it is lost.
  }
}
