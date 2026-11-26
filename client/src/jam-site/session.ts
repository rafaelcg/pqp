import { useSyncExternalStore } from "react";
import { adoptSignedParam, readSignedIn, type JamSignedIn } from "@/lib/jam-signed-in";
import { withLanguage } from "./language";
import { mainOrigin } from "./router";

/**
 * Does the app say this browser is signed in? The public site loads no auth
 * (`docs/JAM_SITE.md`), so this is a HINT the app wrote (`lib/jam-signed-in.ts`:
 * a `.pqp.gg` cookie on the hosted instance, the app's stored copy on a
 * same-origin mount, `?signed=1` on a link from the app). It changes what the
 * site DRAWS (the header, and whether record goes straight on instead of
 * through the account sheet). It grants nothing: the app authorises every
 * request the site hands over, and a stale hint ends on the app's sign-in.
 */

/** Once, at the site's boot, before anything navigates: take a `?signed=1` off the address. */
export function rememberSignedArrival(): void {
  adoptSignedParam();
}

let last: JamSignedIn | null = null;

/** The current hint; the same object while nothing changed, as a store snapshot needs. */
export function currentSignedIn(): JamSignedIn | null {
  const next = readSignedIn();
  if (next === null || last === null ? next === last : next.name === last.name) {
    return last;
  }
  last = next;
  return last;
}

function subscribe(listener: () => void): () => void {
  // Signing in or out in another tab: the cookie and the storage change under this page.
  window.addEventListener("storage", listener);
  window.addEventListener("focus", listener);
  document.addEventListener("visibilitychange", listener);
  return () => {
    window.removeEventListener("storage", listener);
    window.removeEventListener("focus", listener);
    document.removeEventListener("visibilitychange", listener);
  };
}

export function useSignedIn(): JamSignedIn | null {
  return useSyncExternalStore(subscribe, currentSignedIn, () => null);
}

/** A link to a path of the app, in the language the visitor chose. No attribution: this person has an account. */
export function appHref(path: string): string {
  return withLanguage(`${mainOrigin()}${path}`);
}
