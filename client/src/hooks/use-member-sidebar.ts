import { useCallback, useEffect, useState } from "react";
import {
  MEMBER_SIDEBAR_MIN_WIDTH,
  loadMemberSidebarPreference,
  memberSidebarVisible,
  saveMemberSidebarPreference,
  type MemberSidebarPreference,
} from "@/lib/member-sidebar-preference";

/**
 * Is the member sidebar showing, and is there room for it beside the transcript.
 *
 * Lives in the shell rather than in the sidebar because the *button* is in the
 * channel header, several hundred lines away from the panel it toggles — the
 * same split `mobileNavOpen` already has. The sidebar reads `wide` to decide
 * whether it is a column or a drawer; nothing else needs the media query.
 *
 * `matchMedia` is queried rather than `innerWidth` watched: it fires only when
 * the answer changes, so dragging a window across the threshold costs two
 * renders instead of one per frame. Guarded because a jsdom render (and, in
 * principle, an old Electron shell) may not have it — no media query means "not
 * wide", which is the state that still has a working toggle.
 */

const QUERY = `(min-width: ${MEMBER_SIDEBAR_MIN_WIDTH}px)`;

function wideNow(): boolean {
  return typeof window !== "undefined" && typeof window.matchMedia === "function"
    ? window.matchMedia(QUERY).matches
    : false;
}

export interface MemberSidebarControls {
  /** Whether the panel is on screen at all. */
  open: boolean;
  /** Whether it is a column beside the chat (true) or a drawer over it. */
  wide: boolean;
  toggle: () => void;
  close: () => void;
}

export function useMemberSidebar(): MemberSidebarControls {
  const [preference, setPreference] = useState<MemberSidebarPreference>(
    loadMemberSidebarPreference,
  );
  const [wide, setWide] = useState(wideNow);

  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
      return;
    }
    const query = window.matchMedia(QUERY);
    // Re-read on mount: between the initial `useState` and this effect the
    // window may have been resized (Electron restores its geometry after the
    // first paint), and a stale answer here is a sidebar in the wrong mode.
    setWide(query.matches);
    const onChange = (event: MediaQueryListEvent) => setWide(event.matches);
    query.addEventListener("change", onChange);
    return () => query.removeEventListener("change", onChange);
  }, []);

  const open = memberSidebarVisible(preference, wide);

  const set = useCallback((next: boolean) => {
    // Written on every change, so the *next* window inherits the choice rather
    // than the width. Only an explicit click gets here — resizing never writes.
    saveMemberSidebarPreference(next);
    setPreference(next);
  }, []);

  const toggle = useCallback(() => set(!open), [open, set]);
  const close = useCallback(() => set(false), [set]);

  return { open, wide, toggle, close };
}
