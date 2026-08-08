/**
 * Whether the member sidebar is showing — remembered per device.
 *
 * PURELY LOCAL, deliberately. It is not in `user_preferences` because it is a
 * statement about a window, not about a person: the same account on a laptop and
 * on a 13" secondary display wants two different answers, and syncing it would
 * make one of them wrong every time you switched machines. Same call the
 * collapsed-category set makes, and it uses the same storage shape.
 *
 * THREE STATES, NOT TWO. `null` means "never chosen", which is not the same as
 * `false`: an unchosen sidebar follows the width (open on a wide window, closed
 * on a narrow one), and that default has to keep working when the window
 * changes size. Storing a boolean at first paint would freeze whichever width
 * the app happened to boot at into a choice the person never made.
 */

const STORAGE_KEY = "pqp:member-sidebar";

/**
 * The width at which the sidebar is worth its 15rem by default.
 *
 * 1100 rather than a Tailwind breakpoint because the number that matters is what
 * is left for the transcript: the rail (72px) plus the channel list (256px) plus
 * this (240px) is 568px of chrome, so at 1100 the messages still get ~530px —
 * about the width of a paperback, and the point below which lines start
 * wrapping mid-thought. Below it the sidebar is still available, as a drawer
 * over the transcript rather than a column beside it.
 */
export const MEMBER_SIDEBAR_MIN_WIDTH = 1100;

export type MemberSidebarPreference = boolean | null;

export function loadMemberSidebarPreference(): MemberSidebarPreference {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw === "true") {
      return true;
    }
    if (raw === "false") {
      return false;
    }
    return null;
  } catch {
    // Storage can be denied outright (privacy mode, an Electron partition with
    // no quota). Falling back to "never chosen" means the width decides, which
    // is a working app rather than a missing sidebar.
    return null;
  }
}

export function saveMemberSidebarPreference(open: boolean): void {
  try {
    localStorage.setItem(STORAGE_KEY, open ? "true" : "false");
  } catch {
    // The toggle still works for the rest of the session; only the memory of it
    // is lost. Not worth surfacing.
  }
}

/**
 * The one rule that decides whether the sidebar is on screen. Pure so the test
 * can pin the "unchosen follows the width" behaviour without a DOM.
 */
export function memberSidebarVisible(
  preference: MemberSidebarPreference,
  wideViewport: boolean,
): boolean {
  return preference ?? wideViewport;
}
