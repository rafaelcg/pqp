/**
 * Whether the channel list is a 16rem column or a strip of icons.
 *
 * WHY. The rail plus the channel list is 328px of chrome on the left of every
 * window. While you are watching somebody's screen that is 328px the picture
 * does not get, and the picture is the thing you are there for. Icons keep
 * every channel one click away and give the call back most of the width.
 *
 * THREE STATES, NOT TWO, for the reason `member-sidebar-preference` has three:
 * `auto` is "never chosen", and it is not the same as "open". An unchosen
 * sidebar follows the share — collapsed while somebody else is presenting,
 * back to full width when they stop — because that is the only moment the
 * width is worth more elsewhere, and it is a moment that starts and ends on
 * its own.
 *
 * SOMEBODY ELSE'S SHARE, not any share; `App.tsx` decides which is which. A
 * presenter is looking at the thing they are sharing rather than at pqp, and
 * they are the person most likely to be running the room from the voice seats
 * in that very list. Taking the list away from the one person using it, at
 * the moment they start using it, is not a saving.
 *
 * THE FIRST CLICK ENDS THE AUTOMATION. Touch the toggle and the answer is
 * yours for good: nothing moves under the pointer afterwards, in either
 * direction. That is the whole justification for having automation at all —
 * it is a default, not a behaviour, and a default stops applying the moment
 * somebody expresses a preference.
 *
 * NEVER ON A DRAWER. Below the `md` breakpoint the list is not a column, it is
 * a drawer over the chat that is already fully hidden. Collapsing a drawer to
 * icons saves nothing and costs the labels, so the rule returns false there
 * whatever is stored.
 */

export type ChannelSidebarPreference = "auto" | "open" | "icons";

const STORAGE_KEY = "pqp:channel-sidebar";

export function loadChannelSidebarPreference(): ChannelSidebarPreference {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw === "open" || raw === "icons") {
      return raw;
    }
    return "auto";
  } catch {
    // Storage denied (privacy mode, an Electron partition with no quota).
    // "Never chosen" is a working sidebar, which is the safe answer.
    return "auto";
  }
}

export function saveChannelSidebarPreference(
  preference: ChannelSidebarPreference,
): void {
  try {
    localStorage.setItem(STORAGE_KEY, preference);
  } catch {
    // The toggle still works for this session; only the memory is lost.
  }
}

/**
 * The one rule that decides whether the list is icons. Pure, so "unchosen
 * follows the share" can be pinned without a browser.
 */
export function channelSidebarIconsOnly(
  preference: ChannelSidebarPreference,
  input: { watchingAShare: boolean; columnLayout: boolean },
): boolean {
  if (!input.columnLayout) {
    return false;
  }
  if (preference === "icons") {
    return true;
  }
  if (preference === "open") {
    return false;
  }
  return input.watchingAShare;
}

/**
 * What the toggle writes. Always an explicit `open` or `icons`, never back to
 * `auto`: a click is a choice, and re-arming the automation behind somebody's
 * back is how a control stops meaning anything.
 */
export function toggledChannelSidebarPreference(
  iconsNow: boolean,
): ChannelSidebarPreference {
  return iconsNow ? "open" : "icons";
}
