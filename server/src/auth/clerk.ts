import { createClerkClient, verifyToken } from "@clerk/backend";
import {
  DEV_AUTH_TOKEN,
  emailDomainOf,
  normalizeEmailDomain,
} from "@pqp/shared";
import { upsertUser } from "../services/users.js";
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
        displayName:
          user.fullName ??
          user.username ??
          user.primaryEmailAddress?.emailAddress ??
          "User",
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
      // named "User", with a username derived from it.
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

export async function resolveAuthUser(
  authorization: string | undefined,
): Promise<{ user: DbUser } | null> {
  const auth = await verifyAuthHeader(authorization);
  if (!auth) {
    return null;
  }
  return { user: await resolveDbUser(auth) };
}

export async function verifyAuthHeader(
  authorization: string | undefined,
): Promise<AuthUser | null> {
  if (!authorization?.startsWith("Bearer ")) {
    return null;
  }

  const token = authorization.slice(7);

  if (isDevAuthBypassEnabled() && token === DEV_AUTH_TOKEN) {
    return {
      clerkId: "dev_local_user",
      displayName: "Dev User",
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
