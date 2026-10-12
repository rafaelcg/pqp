import { useSyncExternalStore } from "react";

/**
 * CONVERSAS ON A PHONE (`conversations_home_phone_tabs`): the bottom bar
 * Conversas / Servidores / Tu, and the rules for which tab the app opens on.
 *
 * - The app opens on the LAST TAB USED, remembered per browser (a per-viewer
 *   convenience, so `localStorage` is the right store, wrapped so a private
 *   window or blocked storage just means "no memory").
 * - Nobody's habit moves until they move it: an account with no stored
 *   choice, new or old, starts on Servidores, which is what the app has
 *   always opened on.
 * - Somebody who came FOR a person (an `?add=` link, a `/app/dm/...` link
 *   from a push) lands on Conversas, because that is where the thing they
 *   tapped lives.
 */

export type PhoneTab = "conversas" | "servidores" | "tu";

export const PHONE_TAB_STORAGE_KEY = "pqp:phone-tab";

const TABS: readonly PhoneTab[] = ["conversas", "servidores", "tu"];

export function isPhoneTab(value: unknown): value is PhoneTab {
  return typeof value === "string" && (TABS as readonly string[]).includes(value);
}

export function readStoredPhoneTab(): PhoneTab | null {
  try {
    const raw = localStorage.getItem(PHONE_TAB_STORAGE_KEY);
    return isPhoneTab(raw) ? raw : null;
  } catch {
    return null;
  }
}

export function storePhoneTab(tab: PhoneTab): void {
  try {
    localStorage.setItem(PHONE_TAB_STORAGE_KEY, tab);
  } catch {
    // Private window or blocked storage: the tab is simply not remembered.
  }
}

export function landingPhoneTab({
  stored,
  arrivedForPerson,
}: {
  stored: PhoneTab | null;
  arrivedForPerson: boolean;
}): PhoneTab {
  if (arrivedForPerson) {
    return "conversas";
  }
  return stored ?? "servidores";
}

/** Was this page opened for a person: an `?add=` link or a conversation link? */
export function arrivedForPerson(location: { pathname: string; search: string }): boolean {
  if (location.pathname.startsWith("/app/dm/")) {
    return true;
  }
  try {
    return new URLSearchParams(location.search).has("add");
  } catch {
    return false;
  }
}

/** Tailwind's `md`: below it is the phone layout. Must match the `md:` utilities. */
export const PHONE_QUERY = "(max-width: 47.999rem)";

function phoneQuery(): MediaQueryList | null {
  try {
    return window.matchMedia(PHONE_QUERY);
  } catch {
    return null;
  }
}

/** Whether the window is phone width (below `md`). False without matchMedia. */
export function usePhoneWidth(): boolean {
  return useSyncExternalStore(
    (onChange) => {
      const list = phoneQuery();
      if (!list) {
        return () => {};
      }
      list.addEventListener("change", onChange);
      return () => list.removeEventListener("change", onChange);
    },
    () => phoneQuery()?.matches ?? false,
    () => false,
  );
}
