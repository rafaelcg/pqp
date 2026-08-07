import { createClerkClient, verifyToken } from "@clerk/backend";
import {
  DEV_AUTH_TOKEN,
  emailDomainOf,
  normalizeEmailDomain,
} from "@pqp/shared";
import {
  looksLikeEmailAddress,
  placeholderDisplayName,
  upsertUser,
} from "../services/users.js";
import { getAgeGateStatus, type AgeGateStatus } from "../services/age-gate.js";
import type { DbUser } from "../db.js";

const clerk = createClerkClient({
  secretKey: process.env.CLERK_SECRET_KEY,
});

export interface AuthUser {
  clerkId: string;
  displayName: string;
  avatarUrl: string | null;
  /**
   * Domains of every *verified* email on the Clerk account, deduped and sorted.
   * Drives SSO domain joins, so an unverified address must never reach it —
   * see `verifiedEmailDomains`.
   *
   * Optional, and absent means the empty set: the default has to be the one
   * that grants nothing, so a caller that forgets this field fails closed.
   */
  emailDomains?: string[];
}

export { DEV_AUTH_TOKEN };

let warnedAboutBypassInProd = false;

/**
 * The bypass mints a session for a fixed public token, so it must never be
 * reachable on a production deploy — a copied `.env` would otherwise hand every
 * visitor the same account. Refusing at boot is louder than refusing per
 * request, so `assertAuthConfig` runs from the entrypoint too.
 */
export function isDevAuthBypassEnabled(): boolean {
  if (process.env.DEV_AUTH_BYPASS !== "true") {
    return false;
  }
  if (process.env.NODE_ENV === "production") {
    if (!warnedAboutBypassInProd) {
      warnedAboutBypassInProd = true;
      console.error(
        "[auth] DEV_AUTH_BYPASS=true ignored because NODE_ENV=production",
      );
    }
    return false;
  }
  return true;
}

export function assertAuthConfig(): void {
  if (
    process.env.DEV_AUTH_BYPASS === "true" &&
    process.env.NODE_ENV === "production"
  ) {
    throw new Error(
      "DEV_AUTH_BYPASS=true is not allowed when NODE_ENV=production. " +
        "Remove it from the deploy environment.",
    );
  }
  if (!isDevAuthBypassEnabled() && !process.env.CLERK_SECRET_KEY) {
    throw new Error(
      "CLERK_SECRET_KEY is required (or set DEV_AUTH_BYPASS=true for local development).",
    );
  }
}

function getAuthorizedParties(): string[] | undefined {
  const raw = process.env.CLERK_AUTHORIZED_PARTIES;
  if (!raw) {
    return undefined;
  }
  const parties = raw
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  return parties.length > 0 ? parties : undefined;
}

/**
 * Clerk profile lookups are a network round trip, and one would otherwise run
 * on *every* authenticated request. The JWT already proves identity, so the
 * profile is only needed to fill in display name / avatar; cache it briefly.
 */
const PROFILE_TTL_MS = 5 * 60_000;
const profileCache = new Map<string, { user: AuthUser; expiresAt: number }>();
const profileInflight = new Map<string, Promise<AuthUser | null>>();

export function clearAuthCaches(): void {
  profileCache.clear();
  profileInflight.clear();
  userCache.clear();
  userInflight.clear();
}

/**
 * Drop expired entries from both caches.
 *
 * Neither map ever shrank on its own: an expired entry is read through and
 * overwritten on the owner's next request, and deleted only on a profile edit —
 * so an account that signs in once and never returns stays resident forever.
 * Measured at roughly 730 bytes per account, which is ~73MB per 100k distinct
 * users, held for the life of a process that `fly.toml` deliberately never
 * restarts (`auto_stop_machines = "off"`). That is a slow leak whose size is
 * the total number of people who ever signed in, not the number online.
 *
 * Called from the existing 60s sweep timer rather than on a timer of its own,
 * and iterating both maps is cheap next to the request that populated them.
 */
export function sweepAuthCaches(now = Date.now()): void {
  for (const [key, entry] of profileCache) {
    if (entry.expiresAt <= now) {
      profileCache.delete(key);
    }
  }
  for (const [key, entry] of userCache) {
    if (entry.expiresAt <= now) {
      userCache.delete(key);
    }
  }
}

/** Test helper: how many entries each cache is holding. */
export function authCacheSizes(): { profiles: number; users: number } {
  return { profiles: profileCache.size, users: userCache.size };
}

/** Domains the dev-bypass account should present as verified. Dev only. */
function devEmailDomains(): string[] {
  const raw = process.env.DEV_AUTH_EMAIL_DOMAINS;
  if (!raw) {
    return [];
  }
  const domains = raw
    .split(",")
    .map((value) => normalizeEmailDomain(value))
    .filter((value): value is string => value !== null);
  return [...new Set(domains)].sort();
}

/**
 * The domains of the account's verified emails, deduped and sorted.
 *
 * The `status === "verified"` test is the whole security boundary for SSO
 * domain joins: Clerk will happily hold an address nobody proved control of,
 * and trusting one would let anyone type `someone@acme.com` into their profile
 * and walk into Acme's private server.
 */
function verifiedEmailDomains(
  emails: readonly {
    emailAddress: string;
    verification: { status: string } | null;
  }[],
): string[] {
  const domains = new Set<string>();
  for (const email of emails) {
    if (email.verification?.status !== "verified") {
      continue;
    }
    const domain = emailDomainOf(email.emailAddress);
    if (domain) {
      domains.add(domain);
    }
  }
  return [...domains].sort();
}

/**
 * The public name for a Clerk profile. AN EMAIL ADDRESS IS NEVER ONE.
 *
 * This chain used to end `?? user.primaryEmailAddress?.emailAddress ?? "User"`,
 * and a Clerk account with no name set — which is every account created by
 * "continue with email", so the common case — fell straight through to the
 * address. It was then rendered as the author of every message and as the label
 * in the voice roster, written into `users.display_name`, and slugified into the
 * handle other people type to mention them. One missing field published the
 * address to everyone who could see the channel.
 *
 * So the email is not the last resort, it is not a resort at all: it is off the
 * chain entirely, and `looksLikeEmailAddress` additionally screens the two
 * candidates that remain. Screening those matters more than it looks —
 * `fullName` is whatever the identity provider put in `firstName`/`lastName`,
 * and a SAML connection that maps the address into one of them would reintroduce
 * exactly this bug through a field nobody was watching.
 *
 * `emailDomains` still carries the *domain* of each verified address, which is
 * what SSO joining runs on and what the privacy policy describes. That is the
 * line: the domain is a group the account belongs to, the local part is who
 * they are.
 */
function publicDisplayName(
  clerkId: string,
  candidates: readonly (string | null | undefined)[],
): string {
  for (const candidate of candidates) {
    const trimmed = candidate?.trim();
    if (trimmed && !looksLikeEmailAddress(trimmed)) {
      return trimmed;
    }
  }
  return placeholderDisplayName(clerkId);
}

async function loadProfile(clerkId: string): Promise<AuthUser | null> {
  const cached = profileCache.get(clerkId);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.user;
  }

  const existing = profileInflight.get(clerkId);
  if (existing) {
    return existing;
  }

  const request = (async () => {
    try {
      const user = await clerk.users.getUser(clerkId);
      const profile: AuthUser = {
        clerkId,
        displayName: publicDisplayName(clerkId, [user.fullName, user.username]),
        avatarUrl: user.imageUrl ?? null,
        emailDomains: verifiedEmailDomains(user.emailAddresses),
      };
      profileCache.set(clerkId, {
        user: profile,
        expiresAt: Date.now() + PROFILE_TTL_MS,
      });
      return profile;
    } catch (error) {
      console.error("[auth] Clerk profile lookup failed:", error);
      // The token verified, so the identity is real — keep an existing session
      // alive through a Clerk blip. But never invent a profile for someone we
      // have never seen: upsertUser would create their account permanently
      // carrying the placeholder name, with a username derived from it.
      return cached?.user ?? null;
    } finally {
      profileInflight.delete(clerkId);
    }
  })();

  profileInflight.set(clerkId, request);
  return request;
}

/**
 * The DB row for a Clerk id. Cached because `resolveAuthUser` runs on every
 * request and would otherwise issue an UPDATE each time.
 */
const USER_TTL_MS = 30_000;
const userCache = new Map<string, { user: DbUser; expiresAt: number }>();
const userInflight = new Map<string, Promise<DbUser>>();

/** Called after a profile write so the next request sees fresh data. */
export function invalidateUserCache(clerkId: string): void {
  userCache.delete(clerkId);
}

/**
 * Drop *every* cached trace of an identity — the DB row and the Clerk profile.
 *
 * `invalidateUserCache` is not enough for a deleted account: `profileCache`
 * holds a display name and avatar for up to five minutes, and `loadProfile`
 * deliberately falls back to that cached copy when a Clerk lookup fails. A
 * deleted Clerk user *is* a failing lookup, so without this the account keeps
 * authenticating from cache for the rest of the TTL — and `resolveDbUser` would
 * then call `upsertUser` and recreate the row we just deleted.
 */
export function forgetAuthUser(clerkId: string): void {
  profileCache.delete(clerkId);
  profileInflight.delete(clerkId);
  userCache.delete(clerkId);
  userInflight.delete(clerkId);
}

/** A Clerk user id that no longer exists there — see `deleteClerkUser`. */
export class ClerkUserGoneError extends Error {}

/**
 * Delete the identity at Clerk. This is the half of account deletion that
 * cannot be rolled back and cannot be done from SQL.
 *
 * Treated as *success* when Clerk answers 404: the only way to reach that state
 * is that the user is already gone (a retry, the sweeper, or the person
 * deleting themselves from Clerk's own account portal first), and the caller's
 * job is to make the account absent, not to have been the one who removed it.
 * Making a retry fail here is what would strand a half-deleted account forever.
 *
 * A dev-bypass identity has no Clerk user at all and is skipped, so local
 * development can exercise the whole flow without a Clerk secret key.
 */
export async function deleteClerkUser(clerkId: string): Promise<void> {
  if (isDevAuthBypassEnabled() && clerkId.startsWith("dev_local_user")) {
    forgetAuthUser(clerkId);
    return;
  }
  try {
    await clerk.users.deleteUser(clerkId);
  } catch (error) {
    if (isClerkNotFound(error)) {
      forgetAuthUser(clerkId);
      return;
    }
    throw error;
  }
  forgetAuthUser(clerkId);
}

/**
 * Clerk's SDK throws its own error shape rather than an HTTP status, and the
 * shape has changed across major versions — so this reads defensively and
 * treats anything it cannot recognise as "not a 404", which fails closed: an
 * unrecognised error aborts the deletion instead of silently pretending the
 * Clerk user was already gone.
 */
function isClerkNotFound(error: unknown): boolean {
  if (!error || typeof error !== "object") {
    return false;
  }
  const status = (error as { status?: unknown }).status;
  return status === 404;
}

async function resolveDbUser(auth: AuthUser): Promise<DbUser> {
  const cached = userCache.get(auth.clerkId);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.user;
  }

  const existing = userInflight.get(auth.clerkId);
  if (existing) {
    return existing;
  }

  const request = upsertUser(auth)
    .then((user) => {
      userCache.set(auth.clerkId, {
        user,
        expiresAt: Date.now() + USER_TTL_MS,
      });
      return user;
    })
    .finally(() => {
      userInflight.delete(auth.clerkId);
    });

  userInflight.set(auth.clerkId, request);
  return request;
}

/** An authenticated identity, plus where it stands with the 18+ age gate. */
export interface AuthSession {
  user: DbUser;
  ageGate: AgeGateStatus;
}

/**
 * Identity WITHOUT the age gate applied.
 *
 * Only `handleApi` may use this, and only because it is the one caller that can
 * see the request path and therefore make the exemption decision — a pending
 * account still has to be able to read `/api/me`, submit its date of birth, and
 * exercise its LGPD rights (see `isAgeGateExempt`). Every other caller wants
 * `resolveAuthUser` below, which refuses.
 */
export async function resolveAuthSession(
  authorization: string | undefined,
): Promise<AuthSession | null> {
  const auth = await verifyAuthHeader(authorization);
  if (!auth) {
    return null;
  }
  const user = await resolveDbUser(auth);
  return { user, ageGate: await getAgeGateStatus(user.id) };
}

/**
 * An identity that has cleared every gate — the only thing most of the server
 * should ever ask for.
 *
 * This is the age gate's chokepoint for everything that is not the HTTP router,
 * which today means the WebSocket handshake in `ws/index.ts`. It refuses by
 * returning null, so the socket takes the path it already had for a bad token
 * and closes 4401: no new branch to add there, and nothing for a future
 * connection type to forget. Failing closed is the point — an account that has
 * not answered the age question is not a session, and the WebSocket carries
 * chat, presence and voice, every one of which puts the account in front of
 * other people.
 */
export async function resolveAuthUser(
  authorization: string | undefined,
): Promise<{ user: DbUser } | null> {
  const session = await resolveAuthSession(authorization);
  if (!session || session.ageGate !== "passed") {
    return null;
  }
  return { user: session.user };
}

/**
 * The dev bypass token, optionally carrying `:suffix` to name a distinct local
 * identity.
 *
 * One fixed account is enough to click around in, but not to load test with:
 * the message, typing and reaction limits are all keyed on the user id, so N
 * simulated clients sharing one account measure the rate limiter rather than
 * the server. The suffix is held to a short, safe alphabet because it is
 * concatenated into an identifier — and returns null on anything else, so a
 * near-miss is a rejected token rather than a surprise account.
 *
 * Only ever consulted behind `isDevAuthBypassEnabled()`, which refuses to
 * return true under NODE_ENV=production and makes the process fail at boot if
 * the bypass is switched on there.
 */
function devBypassIdentity(
  token: string,
): { clerkId: string; displayName: string } | null {
  if (token === DEV_AUTH_TOKEN) {
    return { clerkId: "dev_local_user", displayName: "Dev User" };
  }
  const prefix = `${DEV_AUTH_TOKEN}:`;
  if (!token.startsWith(prefix)) {
    return null;
  }
  const suffix = token.slice(prefix.length);
  if (!/^[a-z0-9_-]{1,32}$/.test(suffix)) {
    return null;
  }
  return {
    clerkId: `dev_local_user_${suffix}`,
    displayName: `Dev User ${suffix}`,
  };
}

export async function verifyAuthHeader(
  authorization: string | undefined,
): Promise<AuthUser | null> {
  if (!authorization?.startsWith("Bearer ")) {
    return null;
  }

  const token = authorization.slice(7);

  const devIdentity = isDevAuthBypassEnabled() ? devBypassIdentity(token) : null;
  if (devIdentity) {
    return {
      clerkId: devIdentity.clerkId,
      displayName: devIdentity.displayName,
      avatarUrl: null,
      // The bypass proves no email, so it grants no domain by default — a
      // local dev account must not walk into an SSO-gated server for free.
      // `DEV_AUTH_EMAIL_DOMAINS` exists because there is otherwise no way to
      // exercise domain joining locally at all: every request re-runs this and
      // overwrites `users.email_domains`, so setting the column by hand does
      // not survive the next call. Reachable only under the bypass, which
      // already refuses to run when NODE_ENV=production.
      emailDomains: devEmailDomains(),
    };
  }

  try {
    const payload = await verifyToken(token, {
      secretKey: process.env.CLERK_SECRET_KEY,
      // Reject tokens minted for a different origin/app when configured.
      authorizedParties: getAuthorizedParties(),
    });

    const clerkId = payload.sub;
    if (!clerkId) {
      return null;
    }

    return await loadProfile(clerkId);
  } catch (error) {
    if (process.env.NODE_ENV !== "production") {
      console.error("[auth] Token verification failed:", error);
    }
    return null;
  }
}
