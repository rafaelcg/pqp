import { randomBytes } from "node:crypto";
import {
  connectionCallbackPath,
  connectionProviderSchema,
  CONNECTION_PROVIDERS,
  DEFAULT_CONNECTION_VISIBILITY,
  type ConnectionConfig,
  type ConnectionProvider,
  type ConnectionVisibility,
  type OwnConnection,
  type VisibleConnection,
} from "@pqp/shared";
import type { DbUser } from "../db.js";
import { getPool } from "../db.js";
import { HttpError } from "../lib/http.js";
import { noBlockBetweenSql } from "./blocks.js";
import { areFriendsSql } from "./friends.js";
import {
  battlenetAuthorizeUrl,
  exchangeBattlenetCode,
  exchangeTwitchCode,
  isBattlenetConfigured,
  isTwitchConfigured,
  OAuthProviderError,
  twitchAuthorizeUrl,
  createPkcePair,
} from "./connections-oauth.js";
import {
  fetchSteamProfile,
  isSteamConfigured,
  steamAuthorizeUrl,
  SteamAuthError,
  verifySteamAssertion,
} from "./connections-steam.js";

const UNIQUE_VIOLATION = "23505";
const STATE_TTL_MINUTES = 10;
const DISPLAY_NAME_MAX = 64;

export class ConnectionTakenError extends HttpError {
  constructor() {
    super(409, "That account is already connected to another pqp user");
  }
}

export function connectionsConfig(): ConnectionConfig {
  const originsOk = hasAppOriginAllowlist();
  return {
    steam: originsOk && isSteamConfigured(),
    battlenet: originsOk && isBattlenetConfigured(),
    twitch: originsOk && isTwitchConfigured(),
  };
}

export function isProviderEnabled(provider: ConnectionProvider): boolean {
  return connectionsConfig()[provider];
}

function splitOrigins(raw: string | undefined): string[] {
  if (!raw) {
    return [];
  }
  return raw
    .split(",")
    .map((value) => value.trim().replace(/\/$/, ""))
    .filter(Boolean);
}

function publicAppOrigins(): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const origin of [
    ...splitOrigins(process.env.PUBLIC_APP_URL),
    ...splitOrigins(process.env.CORS_ALLOWED_ORIGINS),
  ]) {
    if (seen.has(origin)) {
      continue;
    }
    seen.add(origin);
    out.push(origin);
  }
  return out;
}

function hasAppOriginAllowlist(): boolean {
  if (publicAppOrigins().length > 0) {
    return true;
  }
  return process.env.NODE_ENV !== "production";
}

function isLoopbackOrigin(origin: string): boolean {
  try {
    const url = new URL(origin);
    const host = url.hostname;
    const local =
      host === "localhost" || host === "127.0.0.1" || host === "[::1]";
    return local && (url.protocol === "http:" || url.protocol === "https:");
  } catch {
    return false;
  }
}

/**
 * The SPA origin this OAuth round-trip must return to.
 *
 * Taken from the request Origin when it is on the allowlist, so a Pages
 * preview and localhost both work as long as that origin is in
 * `PUBLIC_APP_URL` or `CORS_ALLOWED_ORIGINS` (and registered at Twitch /
 * Battle.net). An Origin that is present but not allowed is refused rather
 * than silently rewritten: rewriting would send the authorization code to
 * a site the operator did not register.
 */
export function resolveRedirectOrigin(
  requestOrigin: string | undefined,
): string | null {
  const origin = requestOrigin?.trim().replace(/\/$/, "");
  const allowlist = publicAppOrigins();
  const allowLoopback = process.env.NODE_ENV !== "production";

  if (origin) {
    if (allowlist.includes(origin)) {
      return origin;
    }
    if (allowLoopback && isLoopbackOrigin(origin)) {
      return origin;
    }
    return null;
  }

  if (allowlist[0]) {
    return allowlist[0];
  }
  if (allowLoopback) {
    return "http://localhost:5173";
  }
  return null;
}

function requirePerson(user: DbUser): void {
  if (user.is_character) {
    throw new HttpError(403, "This account cannot connect other services");
  }
}

export async function listOwnConnections(
  userId: string,
): Promise<OwnConnection[]> {
  const result = await getPool().query<{
    provider: ConnectionProvider;
    provider_user_id: string;
    display_name: string;
    avatar_url: string | null;
    profile_url: string | null;
    visibility: ConnectionVisibility;
    connected_at: Date;
  }>(
    `SELECT provider, provider_user_id, display_name, avatar_url, profile_url,
            visibility, connected_at
       FROM user_connections
      WHERE user_id = $1
      ORDER BY connected_at ASC`,
    [userId],
  );
  return result.rows.map(toOwn);
}

export async function listVisibleConnections(
  userId: string,
  minimum: "shared" | "public",
): Promise<VisibleConnection[]> {
  const result = await getPool().query<{
    provider: ConnectionProvider;
    display_name: string;
    avatar_url: string | null;
    profile_url: string | null;
  }>(
    `SELECT provider, display_name, avatar_url, profile_url
       FROM user_connections
      WHERE user_id = $1
        AND visibility = ANY($2::text[])
      ORDER BY connected_at ASC`,
    [
      userId,
      minimum === "public" ? ["public"] : ["shared", "public"],
    ],
  );
  return result.rows.map((row) => ({
    provider: row.provider,
    displayName: row.display_name,
    avatarUrl: row.avatar_url,
    profileUrl: row.profile_url,
  }));
}

/**
 * In-app profile card. Same audience as approved depoimentos: self, friends,
 * or a shared server, and never a blocked pair. Outside that, an empty list
 * (not 403). The unauthenticated public page keeps `listVisibleConnections`
 * with `"public"` and does not go through here.
 */
export async function listCardConnections(
  viewerId: string,
  subjectId: string,
): Promise<VisibleConnection[]> {
  if (viewerId !== subjectId) {
    const visible = await getPool().query<{ visible: boolean }>(
      `SELECT ${noBlockBetweenSql("$1::uuid", "$2::uuid")}
              AND (${areFriendsSql("$1::uuid", "$2::uuid")}
                   OR EXISTS (
                     SELECT 1 FROM server_members mine
                     JOIN server_members theirs
                       ON theirs.server_id = mine.server_id
                      AND theirs.user_id = $2
                     WHERE mine.user_id = $1
                   )) AS visible`,
      [viewerId, subjectId],
    );
    if (!visible.rows[0]?.visible) {
      return [];
    }
  }

  return listVisibleConnections(subjectId, "shared");
}

export async function startConnection(
  user: DbUser,
  provider: ConnectionProvider,
  requestOrigin: string | undefined,
): Promise<{ url: string }> {
  requirePerson(user);
  if (!isProviderEnabled(provider)) {
    throw new HttpError(503, "That connection is not configured on this server");
  }
  const origin = resolveRedirectOrigin(requestOrigin);
  if (!origin) {
    throw new HttpError(400, "This origin cannot start a connection");
  }

  await sweepExpiredStates();

  const nonce = randomBytes(32).toString("base64url");
  const callback = `${origin}${connectionCallbackPath(provider)}`;
  let pkceVerifier: string | null = null;
  let url: string;

  if (provider === "steam") {
    const returnTo = `${callback}?state=${encodeURIComponent(nonce)}`;
    url = steamAuthorizeUrl(returnTo, origin);
  } else if (provider === "battlenet") {
    url = battlenetAuthorizeUrl(callback, nonce);
  } else {
    const pkce = createPkcePair();
    pkceVerifier = pkce.verifier;
    url = twitchAuthorizeUrl(callback, nonce, pkce.challenge);
  }

  await getPool().query(
    `INSERT INTO connection_oauth_states
       (nonce, user_id, provider, redirect_origin, pkce_verifier)
     VALUES ($1, $2, $3, $4, $5)`,
    [nonce, user.id, provider, origin, pkceVerifier],
  );

  return { url };
}

export async function completeConnection(
  user: DbUser,
  provider: ConnectionProvider,
  params: Record<string, string>,
): Promise<OwnConnection> {
  requirePerson(user);
  if (!isProviderEnabled(provider)) {
    throw new HttpError(503, "That connection is not configured on this server");
  }

  if (params.error) {
    if (params.error === "access_denied") {
      throw new HttpError(400, "Connection was cancelled");
    }
    throw new HttpError(400, "The provider refused the connection");
  }

  const nonce = params.state;
  if (!nonce) {
    throw new HttpError(400, "Missing connection state");
  }

  const pending = await consumeState(nonce, user.id, provider);
  const callback = `${pending.redirect_origin}${connectionCallbackPath(provider)}`;

  let identity: {
    providerUserId: string;
    displayName: string;
    avatarUrl: string | null;
    profileUrl: string | null;
  };

  try {
    if (provider === "steam") {
      const returnTo = `${callback}?state=${encodeURIComponent(nonce)}`;
      const steamId = await verifySteamAssertion(params, returnTo);
      const profile = await fetchSteamProfile(steamId);
      identity = {
        providerUserId: profile.steamId,
        displayName: profile.displayName,
        avatarUrl: profile.avatarUrl,
        profileUrl: profile.profileUrl,
      };
    } else if (provider === "battlenet") {
      const code = params.code;
      if (!code) {
        throw new HttpError(400, "Missing authorization code");
      }
      identity = await exchangeBattlenetCode(code, callback);
    } else {
      const code = params.code;
      if (!code) {
        throw new HttpError(400, "Missing authorization code");
      }
      if (!pending.pkce_verifier) {
        throw new HttpError(400, "Missing PKCE verifier for this connection");
      }
      identity = await exchangeTwitchCode(code, callback, pending.pkce_verifier);
    }
  } catch (error) {
    if (error instanceof HttpError) {
      throw error;
    }
    if (error instanceof SteamAuthError || error instanceof OAuthProviderError) {
      throw new HttpError(400, error.message);
    }
    throw error;
  }

  return upsertConnection(user.id, provider, identity);
}

export async function updateConnectionVisibility(
  user: DbUser,
  provider: ConnectionProvider,
  visibility: ConnectionVisibility,
): Promise<OwnConnection> {
  requirePerson(user);
  const result = await getPool().query<{
    provider: ConnectionProvider;
    provider_user_id: string;
    display_name: string;
    avatar_url: string | null;
    profile_url: string | null;
    visibility: ConnectionVisibility;
    connected_at: Date;
  }>(
    `UPDATE user_connections
        SET visibility = $3
      WHERE user_id = $1 AND provider = $2
      RETURNING provider, provider_user_id, display_name, avatar_url, profile_url,
                visibility, connected_at`,
    [user.id, provider, visibility],
  );
  const row = result.rows[0];
  if (!row) {
    throw new HttpError(404, "That account is not connected");
  }
  return toOwn(row);
}

export async function disconnectConnection(
  user: DbUser,
  provider: ConnectionProvider,
): Promise<void> {
  requirePerson(user);
  const result = await getPool().query(
    `DELETE FROM user_connections WHERE user_id = $1 AND provider = $2`,
    [user.id, provider],
  );
  if ((result.rowCount ?? 0) === 0) {
    throw new HttpError(404, "That account is not connected");
  }
}

export async function sweepExpiredConnectionStates(): Promise<number> {
  const result = await getPool().query(
    `DELETE FROM connection_oauth_states
      WHERE created_at < NOW() - ($1 || ' minutes')::interval`,
    [STATE_TTL_MINUTES],
  );
  return result.rowCount ?? 0;
}

async function sweepExpiredStates(): Promise<void> {
  await sweepExpiredConnectionStates();
}

async function consumeState(
  nonce: string,
  userId: string,
  provider: ConnectionProvider,
): Promise<{ redirect_origin: string; pkce_verifier: string | null }> {
  const result = await getPool().query<{
    redirect_origin: string;
    pkce_verifier: string | null;
  }>(
    `DELETE FROM connection_oauth_states
      WHERE nonce = $1
        AND user_id = $2
        AND provider = $3
        AND created_at > NOW() - ($4 || ' minutes')::interval
      RETURNING redirect_origin, pkce_verifier`,
    [nonce, userId, provider, STATE_TTL_MINUTES],
  );
  const row = result.rows[0];
  if (!row) {
    throw new HttpError(400, "Connection request expired or was already used");
  }
  return row;
}

export async function upsertConnection(
  userId: string,
  provider: ConnectionProvider,
  identity: {
    providerUserId: string;
    displayName: string;
    avatarUrl: string | null;
    profileUrl: string | null;
  },
): Promise<OwnConnection> {
  const displayName = identity.displayName.slice(0, DISPLAY_NAME_MAX).trim();
  try {
    const result = await getPool().query<{
      provider: ConnectionProvider;
      provider_user_id: string;
      display_name: string;
      avatar_url: string | null;
      profile_url: string | null;
      visibility: ConnectionVisibility;
      connected_at: Date;
    }>(
      `INSERT INTO user_connections (
          user_id, provider, provider_user_id, display_name, avatar_url,
          profile_url, visibility
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7)
        ON CONFLICT (user_id, provider) DO UPDATE SET
          provider_user_id = EXCLUDED.provider_user_id,
          display_name = EXCLUDED.display_name,
          avatar_url = EXCLUDED.avatar_url,
          profile_url = EXCLUDED.profile_url,
          connected_at = NOW(),
          visibility = CASE
            WHEN user_connections.provider_user_id IS DISTINCT FROM EXCLUDED.provider_user_id
            THEN EXCLUDED.visibility
            ELSE user_connections.visibility
          END
        RETURNING provider, provider_user_id, display_name, avatar_url, profile_url,
                  visibility, connected_at`,
      [
        userId,
        provider,
        identity.providerUserId,
        displayName || provider,
        identity.avatarUrl,
        identity.profileUrl,
        DEFAULT_CONNECTION_VISIBILITY,
      ],
    );
    return toOwn(result.rows[0]!);
  } catch (error) {
    if (
      error &&
      typeof error === "object" &&
      "code" in error &&
      error.code === UNIQUE_VIOLATION
    ) {
      throw new ConnectionTakenError();
    }
    throw error;
  }
}

function toOwn(row: {
  provider: ConnectionProvider;
  provider_user_id: string;
  display_name: string;
  avatar_url: string | null;
  profile_url: string | null;
  visibility: ConnectionVisibility;
  connected_at: Date;
}): OwnConnection {
  return {
    provider: row.provider,
    providerUserId: row.provider_user_id,
    displayName: row.display_name,
    avatarUrl: row.avatar_url,
    profileUrl: row.profile_url,
    visibility: row.visibility,
    connectedAt: row.connected_at.toISOString(),
  };
}

export function parseConnectionProvider(
  raw: string | undefined,
): ConnectionProvider {
  const parsed = connectionProviderSchema.safeParse(raw);
  if (!parsed.success) {
    throw new HttpError(404, "Not found");
  }
  return parsed.data;
}

// --------------------------------------------------------------- adoption

export interface ConnectionProviderAdoption {
  provider: ConnectionProvider;
  /** Whether this provider's credentials are set on this instance. */
  enabled: boolean;
  /** Accounts with this provider linked, at any visibility. */
  linked: number;
  /** Of those, the visibility each one chose. The three sum to `linked`. */
  public: number;
  shared: number;
  hidden: number;
}

export interface ConnectionAdoption {
  /**
   * Accounts with at least one provider linked. NOT the sum of the rows: one
   * person who links Steam and Twitch is one account here and two there.
   */
  anyProvider: number;
  /** Of those, how many put at least one connection on their public page. */
  anyProviderPublic: number;
  /** One row per provider, in `CONNECTION_PROVIDERS` order, zeros included. */
  providers: ConnectionProviderAdoption[];
}

/**
 * Connection adoption for the operator dashboard: aggregate counts only.
 *
 * Per provider AND as "any provider", because those answer different questions
 * and the second is not the sum of the first. The visibility split is the
 * other half: `linked` is how many people bothered, `public` is how many are
 * willing to be findable, and the gap between them is the number that says
 * whether the public profile page is doing anything.
 *
 * ONE QUERY, ONE PASS. `GROUPING SETS ((provider), ())` returns the per-
 * provider rows and the rollup from the same scan; `provider` is NOT NULL in
 * the table, so the row that comes back with a null provider is unambiguously
 * the rollup. `COUNT(DISTINCT user_id)` instead of `COUNT(*)` changes nothing
 * within a provider (the primary key is `(user_id, provider)`) and is exactly
 * what makes the rollup a count of people rather than a count of links.
 *
 * Webhook pseudo-accounts and the house cast are excluded so the numerator
 * matches the denominator the dashboard divides by — `users.total` in the same
 * payload, which excludes them too. `requirePerson` already refuses a character
 * account at the API, so that join keeps the two populations identical rather
 * than filtering rows we expect to exist.
 *
 * The caller caches; see services/metrics.ts.
 */
export async function connectionAdoption(): Promise<ConnectionAdoption> {
  const result = await getPool().query<{
    provider: ConnectionProvider | null;
    linked: string;
    public_count: string;
    shared_count: string;
    hidden_count: string;
  }>(
    `SELECT uc.provider,
            COUNT(DISTINCT uc.user_id)::text AS linked,
            COUNT(DISTINCT uc.user_id) FILTER (WHERE uc.visibility = 'public')::text AS public_count,
            COUNT(DISTINCT uc.user_id) FILTER (WHERE uc.visibility = 'shared')::text AS shared_count,
            COUNT(DISTINCT uc.user_id) FILTER (WHERE uc.visibility = 'hidden')::text AS hidden_count
       FROM user_connections uc
       JOIN users u ON u.id = uc.user_id
      WHERE NOT u.is_webhook AND NOT u.is_character
      GROUP BY GROUPING SETS ((uc.provider), ())`,
  );

  const byProvider = new Map<ConnectionProvider, (typeof result.rows)[number]>();
  let rollup: (typeof result.rows)[number] | null = null;
  for (const row of result.rows) {
    if (row.provider === null) {
      rollup = row;
    } else {
      byProvider.set(row.provider, row);
    }
  }

  const config = connectionsConfig();

  return {
    anyProvider: Number(rollup?.linked ?? 0),
    anyProviderPublic: Number(rollup?.public_count ?? 0),
    providers: CONNECTION_PROVIDERS.map((provider) => {
      const row = byProvider.get(provider);
      return {
        provider,
        enabled: config[provider],
        linked: Number(row?.linked ?? 0),
        public: Number(row?.public_count ?? 0),
        shared: Number(row?.shared_count ?? 0),
        hidden: Number(row?.hidden_count ?? 0),
      };
    }),
  };
}
