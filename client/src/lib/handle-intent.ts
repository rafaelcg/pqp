import { normalizeJoinRef, parseDiscordTemplateCode } from "@pqp/shared";
import { parseAppRoute } from "./app-route";

/**
 * Intentions that have to survive a sign-up. Three are described here; the
 * Discord import and the invite link's `?ref=` tag, further down, are the same
 * shape with their own reasons.
 *
 * THIS IS THE INVITE BUG AGAIN, in two new shapes. `signedOutRedirectPath`
 * already fixed the version where somebody clicks an invite link, signs up, and
 * lands on an empty hub with the code thrown away — see `lib/app-route.ts`, and
 * note that the fix there works because the intent is IN THE PATH and the path
 * is what Clerk is handed. Neither of these two is in the path:
 *
 *  - CLAIM. Somebody types `neymar` into `pqp.gg/garanta`, likes what they see,
 *    and hits sign-up. The word they typed exists only in a React state that a
 *    hosted auth round trip destroys. Without this they arrive at `/app` with an
 *    auto-generated handle and no memory of the name that brought them.
 *  - ADD. Somebody opens `pqp.gg/@rafa` and hits "Me adiciona no pqp". They have
 *    no account. After signing up they should end up connected to Rafa, which is
 *    the entire reason Rafa shared the link — and the reason this feature can
 *    grow at all.
 *  - JOIN. Somebody opens `pqp.gg/c/valorant-brasil` and hits "Entrar na
 *    comunidade". Same shape as ADD one level up: the thing they came for is a
 *    room, and landing them in an empty hub after they asked to walk into a
 *    specific one is the exact failure `signedOutRedirectPath` was written to
 *    fix for invites. A community slug cannot ride in the path — `/app/c/<slug>`
 *    is not a route this build has, and inventing one would put a public
 *    identifier into the app's own URL space — so it travels the same way the
 *    other two do.
 *
 * A SLUG IS NOT A HANDLE, and the storage does not care. All three values are
 * short opaque strings whose validity only the API can rule on; the TTL, the
 * consume-on-read and the storage-denied behaviour are identical, so they share
 * the machinery and differ only in their key.
 *
 * WHY LOCALSTORAGE. `sessionStorage` survives a same-tab redirect, but not every
 * Clerk configuration is a same-tab redirect: a modal is one tab, a hosted page
 * is a navigation, and an OAuth provider can hand the session back in a new one.
 * `localStorage` is the only store that covers all three.
 *
 * WHY A TTL. `localStorage` is forever, and forever is wrong for an intention.
 * Without an expiry, somebody who abandons a signup in March gets an unexplained
 * friend request sent on their behalf in July. An hour is longer than any signup
 * takes and shorter than anybody's memory of having started one.
 *
 * Every function tolerates storage being denied (Safari private mode, an
 * embedded webview) by doing nothing. Failing closed means the intent is lost,
 * which costs one extra click; failing open would mean acting on somebody's
 * behalf without a record of them asking.
 */

const CLAIM_KEY = "pqp:pending-handle-claim";
const ADD_KEY = "pqp:pending-handle-add";
const JOIN_KEY = "pqp:pending-community-join";

/** Long enough for a slow signup, short enough not to be a surprise later. */
export const HANDLE_INTENT_TTL_MS = 60 * 60 * 1000;

interface StoredIntent {
  handle: string;
  at: number;
}

type WritableStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

function write(
  storage: WritableStorage | null,
  key: string,
  handle: string,
  now: number,
): void {
  if (!storage || !handle) {
    return;
  }
  try {
    storage.setItem(key, JSON.stringify({ handle, at: now } satisfies StoredIntent));
  } catch {
    // Storage denied. One extra click is the whole cost.
  }
}

/**
 * Read and CONSUME. Never a plain read: both of these cause an action, and an
 * intent that survives the action it caused is an action that repeats — a
 * friend request re-sent on every page load, a handle re-claimed on every
 * reload and spending the rename cooldown doing it.
 */
function take(
  storage: WritableStorage | null,
  key: string,
  now: number,
): string | null {
  if (!storage) {
    return null;
  }
  let raw: string | null;
  try {
    raw = storage.getItem(key);
    if (raw !== null) {
      storage.removeItem(key);
    }
  } catch {
    return null;
  }
  if (!raw) {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (
      !parsed ||
      typeof parsed !== "object" ||
      typeof (parsed as StoredIntent).handle !== "string" ||
      typeof (parsed as StoredIntent).at !== "number"
    ) {
      return null;
    }
    const intent = parsed as StoredIntent;
    if (now - intent.at > HANDLE_INTENT_TTL_MS) {
      return null;
    }
    return intent.handle || null;
  } catch {
    // User-writable storage. Anything unreadable is "no intent".
    return null;
  }
}

export function stashHandleClaim(
  storage: WritableStorage | null,
  handle: string,
  now: number = Date.now(),
): void {
  write(storage, CLAIM_KEY, handle, now);
}

export function takeHandleClaim(
  storage: WritableStorage | null,
  now: number = Date.now(),
): string | null {
  return take(storage, CLAIM_KEY, now);
}

export function stashAddIntent(
  storage: WritableStorage | null,
  handle: string,
  now: number = Date.now(),
): void {
  write(storage, ADD_KEY, handle, now);
}

export function takeAddIntent(
  storage: WritableStorage | null,
  now: number = Date.now(),
): string | null {
  return take(storage, ADD_KEY, now);
}

/**
 * The community somebody asked to walk into, stashed before Clerk takes over.
 *
 * The value is a SLUG and never an id — the public page deliberately never had
 * one to give (see `publicCommunitySchema`), so the app resolves it behind auth
 * through `lookupCommunityBySlug` before it can join anything. That is not an
 * extra hop to optimise away later: it is what keeps a stranger from ever
 * holding an identifier the API would accept.
 */
export function stashJoinIntent(
  storage: WritableStorage | null,
  slug: string,
  now: number = Date.now(),
): void {
  write(storage, JOIN_KEY, slug, now);
}

export function takeJoinIntent(
  storage: WritableStorage | null,
  now: number = Date.now(),
): string | null {
  return take(storage, JOIN_KEY, now);
}

/**
 * `?add=rafa` on any `/app` URL.
 *
 * The public profile's CTA sends people to `/app?add=<handle>` when they are
 * already signed in — no storage round trip needed for that case, and a URL is
 * the honest way to express "this navigation means something". Only the shape is
 * checked here; whether the handle exists is the API's answer.
 */
export function addIntentFromSearch(search: string): string | null {
  const raw = new URLSearchParams(search).get("add");
  if (!raw) {
    return null;
  }
  const handle = raw.replace(/^@+/, "").toLowerCase();
  return /^[a-z0-9][a-z0-9_.-]{1,18}[a-z0-9]$/.test(handle) ? handle : null;
}

/** The storage this module wants, or null where there is none. */
export function intentStorage(): WritableStorage | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

/**
 * The community somebody came to CREATE, which is the fourth intention a
 * sign-up has to carry: `pqp.gg/vem` sells "paste your Discord template and the
 * room is born here", and its buttons are sign-up buttons. Without this the new
 * account lands on the onboarding's generic last step and the Discord import,
 * the one thing the page was about, is two menus away.
 *
 * Two values and nothing else. `discord` opens Create community already on the
 * paste step; `new` opens it on the name field. Anything else is no intent,
 * because this string arrives from a URL anybody can type.
 */
export type CreateIntent = "discord" | "new";

const CREATE_KEY = "pqp:pending-create-community";

function asCreateIntent(value: string | null): CreateIntent | null {
  return value === "discord" || value === "new" ? value : null;
}

export function stashCreateIntent(
  storage: WritableStorage | null,
  intent: CreateIntent,
  now: number = Date.now(),
): void {
  write(storage, CREATE_KEY, intent, now);
}

export function takeCreateIntent(
  storage: WritableStorage | null,
  now: number = Date.now(),
): CreateIntent | null {
  return asCreateIntent(take(storage, CREATE_KEY, now));
}

/** `?create=discord` or `?create=new` on any `/app` URL. */
export function createIntentFromSearch(search: string): CreateIntent | null {
  return asCreateIntent(new URLSearchParams(search).get("create"));
// ------------------------------------------------------------ Discord import

const IMPORT_KEY = "pqp:pending-discord-import";

/** The stored value when the intent names no template, only the door. */
const IMPORT_ANY = "discord";

/**
 * IMPORT. Somebody on a "Vem pra pqp" page clicks "trazer meu servidor do
 * Discord". What they came for is the Discord layout copy, which lives inside
 * the create-server dialog after sign-up and after onboarding: three screens
 * that never mention it. `?import=discord` on any URL (or `?import=<code>` /
 * `?import=discord.new/<code>`, which also pre-fills the paste box) is
 * stashed at boot, and the app opens that dialog on the paste step the moment
 * the account is ready and onboarding is out of the way.
 *
 * `source` is null when the intent is the door alone. When it is set it is a
 * `discord.new` link built from a code `parseDiscordTemplateCode` accepted, so
 * nothing the visitor typed into the URL reaches the paste box verbatim.
 */
export interface ImportIntent {
  source: string | null;
}

function importIntentFromValue(raw: string | null): ImportIntent | null {
  const value = raw?.trim() ?? "";
  if (value === "") {
    return null;
  }
  if (["discord", "1", "true"].includes(value.toLowerCase())) {
    return { source: null };
  }
  const code = parseDiscordTemplateCode(value);
  return code ? { source: `https://discord.new/${code}` } : null;
}

/** `?import=...` on a URL, or null when it carries none that makes sense. */
export function importIntentFromSearch(search: string): ImportIntent | null {
  return importIntentFromValue(new URLSearchParams(search).get("import"));
}

export function stashImportIntent(
  storage: WritableStorage | null,
  intent: ImportIntent,
  now: number = Date.now(),
): void {
  write(storage, IMPORT_KEY, intent.source ?? IMPORT_ANY, now);
}

export function takeImportIntent(
  storage: WritableStorage | null,
  now: number = Date.now(),
): ImportIntent | null {
  const stored = take(storage, IMPORT_KEY, now);
  if (!stored) {
    return null;
  }
  return stored === IMPORT_ANY ? { source: null } : importIntentFromValue(stored);
}

/**
 * Stash the page's `?import=` at boot, whatever the page. Runs before routing
 * so a campaign link to `/app?import=discord` survives the sign-in redirect,
 * which keeps the path and drops the query (`signedOutRedirectPath`).
 */
export function rememberImportIntentFromLocation(
  storage: WritableStorage | null,
  location: Pick<Location, "search">,
  now: number = Date.now(),
): void {
  const intent = importIntentFromSearch(location.search);
  if (intent) {
    stashImportIntent(storage, intent, now);
  }
}

// ------------------------------------------------------- invite link ?ref=

const INVITE_REF_KEY = "pqp:pending-invite-ref";

/**
 * REF. `/app/invite/<code>?ref=discord` tells the server which link brought a
 * join (see `shareInviteUrl`). Signed out, the sign-in redirect keeps the
 * invite path and drops the query, so the tag is stashed at boot together
 * with the code it came on, and read back only for that same code.
 * Consumed on read like every other intent here.
 */
export function rememberInviteRefFromLocation(
  storage: WritableStorage | null,
  location: Pick<Location, "search" | "pathname">,
  now: number = Date.now(),
): void {
  const target = parseAppRoute(location.pathname);
  if (target?.kind !== "invite") {
    return;
  }
  stashInviteRef(
    storage,
    target.code,
    new URLSearchParams(location.search).get("ref"),
    now,
  );
}

/**
 * Keep a tag for `code`. Also how a join that FAILED puts back the tag it
 * took, so the retry (the join panel, which the failure opens with the code in
 * it) still sends it.
 */
export function stashInviteRef(
  storage: WritableStorage | null,
  code: string,
  rawRef: string | null,
  now: number = Date.now(),
): void {
  const ref = normalizeJoinRef(rawRef);
  if (ref && code && !code.includes(" ")) {
    // A code is base64url and a ref is `[a-z0-9_-]`, so a space cannot
    // appear in either and splits them unambiguously.
    write(storage, INVITE_REF_KEY, `${code} ${ref}`, now);
  }
}

/**
 * The tag to send with a join through `code`: the URL's own `?ref=` first,
 * otherwise one stashed for this exact code. The stash is consumed either way.
 */
export function takeInviteRef(
  storage: WritableStorage | null,
  code: string,
  search: string,
  now: number = Date.now(),
): string | null {
  const stashed = take(storage, INVITE_REF_KEY, now);
  const fromUrl = normalizeJoinRef(new URLSearchParams(search).get("ref"));
  if (fromUrl) {
    return fromUrl;
  }
  if (!stashed) {
    return null;
  }
  const [stashedCode, stashedRef] = stashed.split(" ");
  return stashedCode === code ? normalizeJoinRef(stashedRef) : null;
}
