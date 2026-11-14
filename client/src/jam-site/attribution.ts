import { currentJamAttribution, jamMainHref, rememberJamAttribution, type JamAttribution } from "@/lib/jam-intent";

/**
 * The browser half of the public site's attribution (`lib/jam-intent.ts` has
 * the rules): remember the `ref` and `utm_*` the site was opened with, and
 * hand them to the app on every link that can end in an account. The site has
 * no analytics tag, so this is how a signup from jam.pqp.gg, or from a clip
 * somebody posted, can be told apart afterwards. The values leave this page
 * only as parameters of a link the person clicks.
 */

function storage(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

/** Once, at the site's boot, before anything navigates. */
export function rememberArrival(): void {
  rememberJamAttribution(storage(), window.location.search);
}

export function jamAttribution(): JamAttribution | null {
  return currentJamAttribution(storage(), window.location.search);
}

/** A link to a path on the main site that keeps where the person came from. */
export function mainHref(path: string, origin: string): string {
  return jamMainHref(path, origin, jamAttribution());
}
