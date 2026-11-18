/**
 * Whether the apps origin actually serves an app's entry document, asked from
 * the PAGE (never from the frame) while the frame loads.
 *
 * Why it exists: a frame whose entry is missing gives the page nothing to go
 * on. A cross-origin `<iframe>` fires `load` for a 404 page exactly as for the
 * app, its status is invisible, and the only signal left is the app never
 * saying hello, 20 seconds later. Meanwhile the person looks at the apps
 * origin's own white 404 document under "Abrindo...". That happened in
 * production on 2026-11-12, when the version an app was pinned to was no longer
 * on the apps site (docs/APPS.md, "Deploy").
 *
 * The apps origin answers every file with `Access-Control-Allow-Origin: *`
 * (`tools/apps-build/src/headers.mts`), so a plain CORS GET reads the status.
 * No credentials, no referrer: the apps origin is cookieless and learns
 * nothing it does not already learn from the frame's own request.
 *
 * Only a real HTTP answer that is not 2xx counts as `missing`. No answer at all
 * (offline, a self-host that serves the bundles without the CORS header, an
 * extension blocking the request, an abort) is `unknown`, and the frame is
 * left to the hello timeout as before: a probe that cannot see must never take
 * down a frame that may well be working.
 */
export type EntryProbeResult =
  | { kind: "ok" }
  | { kind: "missing"; status: number }
  | { kind: "unknown" };

export type EntryProbe = (url: string, signal: AbortSignal) => Promise<EntryProbeResult>;

function sameOrigin(a: string, b: string): boolean {
  try {
    return new URL(a).origin === new URL(b).origin;
  } catch {
    return false;
  }
}

export async function probeAppEntry(
  url: string,
  signal: AbortSignal,
  fetchImpl?: typeof fetch,
): Promise<EntryProbeResult> {
  const doFetch: typeof fetch | null =
    fetchImpl ?? (typeof globalThis.fetch === "function" ? (input, init) => globalThis.fetch(input, init) : null);
  if (!doFetch) return { kind: "unknown" };
  try {
    const response = await doFetch(url, {
      method: "GET",
      mode: "cors",
      credentials: "omit",
      referrerPolicy: "no-referrer",
      redirect: "follow",
      signal,
    });
    // the status is all that is wanted; the body is the frame's to load
    void response.body?.cancel().catch(() => {});
    // Pages' own redirect (`/index.html` to `/`) stays on the apps origin. An answer that ended anywhere else is
    // not the apps origin speaking, so it says nothing either way (the frame, which follows the same redirect
    // under its own sandbox and the page's frame-src, is left to the hello timeout).
    if (response.redirected && !sameOrigin(response.url, url)) return { kind: "unknown" };
    return response.ok ? { kind: "ok" } : { kind: "missing", status: response.status };
  } catch {
    return { kind: "unknown" };
  }
}
