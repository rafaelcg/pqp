import { createHash, randomBytes } from "node:crypto";
import { twitchProfileUrl } from "@pqp/shared";

/**
 * Battle.net and Twitch authorization-code grants.
 *
 * Both are self-serve OAuth 2.0. Twitch is used with PKCE (S256) because
 * Twitch documents it and it means the authorization code is useless without
 * the verifier we stored. Battle.net's public docs do not promise PKCE, so
 * that leg is client-secret only.
 *
 * Tokens are used once, to read identity, and thrown away. Refreshing a
 * display name is "Connect" again, not a stored refresh token.
 *
 * Scopes are the minimum that returns a person:
 *  - Battle.net: `openid` (userinfo: id + battletag). No wow.profile.
 *  - Twitch: none. `GET /helix/users` with a user token returns id, login,
 *    display_name and profile_image_url without `user:read:email`. Asking
 *    for email would be a ToS and LGPD problem we do not have.
 */

const UPSTREAM_TIMEOUT_MS = 8_000;

const BATTLENET_AUTHORIZE = "https://oauth.battle.net/authorize";
const BATTLENET_TOKEN = "https://oauth.battle.net/token";
const BATTLENET_USERINFO = [
  "https://oauth.battle.net/oauth/userinfo",
  "https://oauth.battle.net/userinfo",
];

const TWITCH_AUTHORIZE = "https://id.twitch.tv/oauth2/authorize";
const TWITCH_TOKEN = "https://id.twitch.tv/oauth2/token";
const TWITCH_USERS = "https://api.twitch.tv/helix/users";

export class OAuthProviderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OAuthProviderError";
  }
}

function envPair(idName: string, secretName: string): { id: string; secret: string } | null {
  const id = process.env[idName]?.trim();
  const secret = process.env[secretName]?.trim();
  if (!id || !secret || id.startsWith("your-") || secret.startsWith("your-")) {
    return null;
  }
  return { id, secret };
}

export function battlenetCredentials(): { id: string; secret: string } | null {
  return envPair("BATTLENET_CLIENT_ID", "BATTLENET_CLIENT_SECRET");
}

export function twitchCredentials(): { id: string; secret: string } | null {
  return envPair("TWITCH_CLIENT_ID", "TWITCH_CLIENT_SECRET");
}

export function isBattlenetConfigured(): boolean {
  return battlenetCredentials() !== null;
}

export function isTwitchConfigured(): boolean {
  return twitchCredentials() !== null;
}

export function createPkcePair(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

export function battlenetAuthorizeUrl(
  redirectUri: string,
  state: string,
): string {
  const creds = battlenetCredentials();
  if (!creds) {
    throw new OAuthProviderError("Battle.net is not configured");
  }
  const url = new URL(BATTLENET_AUTHORIZE);
  url.searchParams.set("client_id", creds.id);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", "openid");
  url.searchParams.set("state", state);
  return url.toString();
}

export function twitchAuthorizeUrl(
  redirectUri: string,
  state: string,
  challenge: string,
): string {
  const creds = twitchCredentials();
  if (!creds) {
    throw new OAuthProviderError("Twitch is not configured");
  }
  const url = new URL(TWITCH_AUTHORIZE);
  url.searchParams.set("client_id", creds.id);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("state", state);
  url.searchParams.set("code_challenge", challenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("force_verify", "true");
  return url.toString();
}

export interface LinkedIdentity {
  providerUserId: string;
  displayName: string;
  avatarUrl: string | null;
  profileUrl: string | null;
}

export async function exchangeBattlenetCode(
  code: string,
  redirectUri: string,
): Promise<LinkedIdentity> {
  const creds = battlenetCredentials();
  if (!creds) {
    throw new OAuthProviderError("Battle.net is not configured");
  }
  const token = await postForm(BATTLENET_TOKEN, {
    grant_type: "authorization_code",
    code,
    redirect_uri: redirectUri,
  }, basicAuth(creds.id, creds.secret));
  const accessToken = readAccessToken(token);

  let lastStatus = 0;
  for (const endpoint of BATTLENET_USERINFO) {
    const response = await fetch(endpoint, {
      headers: { Authorization: `Bearer ${accessToken}` },
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
      redirect: "error",
    });
    lastStatus = response.status;
    if (!response.ok) {
      continue;
    }
    const payload = (await response.json()) as {
      id?: number | string;
      sub?: string;
      battletag?: string;
    };
    const id = payload.id ?? payload.sub;
    if (id === undefined || id === null || String(id).length === 0) {
      throw new OAuthProviderError("Battle.net userinfo had no id");
    }
    const tag = clipName(payload.battletag) ?? `Battle.net ${String(id).slice(-4)}`;
    return {
      providerUserId: String(id),
      displayName: tag,
      avatarUrl: null,
      profileUrl: null,
    };
  }
  throw new OAuthProviderError(`Battle.net userinfo returned ${lastStatus}`);
}

export async function exchangeTwitchCode(
  code: string,
  redirectUri: string,
  pkceVerifier: string,
): Promise<LinkedIdentity> {
  const creds = twitchCredentials();
  if (!creds) {
    throw new OAuthProviderError("Twitch is not configured");
  }
  const token = await postForm(TWITCH_TOKEN, {
    client_id: creds.id,
    client_secret: creds.secret,
    grant_type: "authorization_code",
    code,
    redirect_uri: redirectUri,
    code_verifier: pkceVerifier,
  });
  const accessToken = readAccessToken(token);

  const response = await fetch(TWITCH_USERS, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Client-Id": creds.id,
    },
    signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    redirect: "error",
  });
  if (!response.ok) {
    throw new OAuthProviderError(`Twitch users returned ${response.status}`);
  }
  const payload = (await response.json()) as {
    data?: Array<{
      id?: string;
      login?: string;
      display_name?: string;
      profile_image_url?: string;
    }>;
  };
  const user = payload.data?.[0];
  if (!user?.id) {
    throw new OAuthProviderError("Twitch users returned no user");
  }
  const login = user.login?.trim() ?? "";
  return {
    providerUserId: user.id,
    displayName:
      clipName(user.display_name) ??
      clipName(login) ??
      `Twitch ${user.id.slice(-4)}`,
    avatarUrl: httpUrlOrNull(user.profile_image_url),
    profileUrl: login ? twitchProfileUrl(login) : null,
  };
}

function basicAuth(id: string, secret: string): Record<string, string> {
  const token = Buffer.from(`${id}:${secret}`, "utf8").toString("base64");
  return { Authorization: `Basic ${token}` };
}

async function postForm(
  url: string,
  fields: Record<string, string>,
  extraHeaders: Record<string, string> = {},
): Promise<unknown> {
  const body = new URLSearchParams(fields);
  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        ...extraHeaders,
      },
      body,
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
      redirect: "error",
    });
  } catch (error) {
    throw new OAuthProviderError(
      error instanceof Error ? error.message : "Token request failed",
    );
  }
  if (!response.ok) {
    throw new OAuthProviderError(`Token endpoint returned ${response.status}`);
  }
  return response.json() as Promise<unknown>;
}

function readAccessToken(payload: unknown): string {
  if (
    payload &&
    typeof payload === "object" &&
    "access_token" in payload &&
    typeof payload.access_token === "string" &&
    payload.access_token.length > 0
  ) {
    return payload.access_token;
  }
  throw new OAuthProviderError("Token endpoint returned no access_token");
}

function clipName(value: string | undefined | null): string | null {
  if (!value) {
    return null;
  }
  const clipped = value.slice(0, 64).trim();
  return clipped.length > 0 ? clipped : null;
}

function httpUrlOrNull(value: string | undefined): string | null {
  if (!value) {
    return null;
  }
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" && url.protocol !== "http:") {
      return null;
    }
    return url.toString();
  } catch {
    return null;
  }
}
