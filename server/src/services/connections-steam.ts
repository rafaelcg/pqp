import { steamProfileUrl } from "@pqp/shared";

/**
 * Steam account linking via OpenID 2.0.
 *
 * Valve documents this as the way a third-party site links a Steam account
 * without becoming a Steamworks partner. It is not OAuth: there is no code to
 * exchange and no access token. Steam redirects back with a signed assertion
 * which this process must POST to `check_authentication`. A library that
 * skipped `return_to` verification (passport-steam, historically) is how
 * people forged logins; the checks below are the ones that bug existed to
 * remind us of.
 *
 * OP endpoint: https://steamcommunity.com/openid/
 * Verify POST: https://steamcommunity.com/openid/login
 * Profile (optional): ISteamUser/GetPlayerSummaries with a Web API key from
 * https://steamcommunity.com/dev — persona name and avatar, not identity.
 */

export const STEAM_OPENID_ENDPOINT = "https://steamcommunity.com/openid/login";
const STEAM_OPENID_NS = "http://specs.openid.net/auth/2.0";
const STEAM_SUMMARIES_URL =
  "https://api.steampowered.com/ISteamUser/GetPlayerSummaries/v2/";

/** SteamID64 for an individual account: 17 digits, universe 1, type 1. */
const STEAM_CLAIMED_ID =
  /^https?:\/\/steamcommunity\.com\/openid\/id\/(7656119\d{10})$/;

const UPSTREAM_TIMEOUT_MS = 8_000;

export class SteamAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SteamAuthError";
  }
}

export function steamWebApiKey(): string | null {
  const key = process.env.STEAM_WEB_API_KEY?.trim();
  if (!key || key.startsWith("your-")) {
    return null;
  }
  return key;
}

export function isSteamConfigured(): boolean {
  return steamWebApiKey() !== null;
}

export function steamAuthorizeUrl(returnTo: string, realm: string): string {
  const url = new URL(STEAM_OPENID_ENDPOINT);
  url.searchParams.set("openid.ns", STEAM_OPENID_NS);
  url.searchParams.set("openid.mode", "checkid_setup");
  url.searchParams.set("openid.return_to", returnTo);
  url.searchParams.set("openid.realm", realm);
  url.searchParams.set(
    "openid.identity",
    "http://specs.openid.net/auth/2.0/identifier_select",
  );
  url.searchParams.set(
    "openid.claimed_id",
    "http://specs.openid.net/auth/2.0/identifier_select",
  );
  return url.toString();
}

export function steamIdFromClaimedId(claimedId: string | undefined): string | null {
  if (!claimedId) {
    return null;
  }
  const match = STEAM_CLAIMED_ID.exec(claimedId.trim());
  return match?.[1] ?? null;
}

/**
 * Verify a Steam OpenID assertion.
 *
 * The six checks, in order, because a later one is meaningless if an earlier
 * one already failed:
 *
 *  1. `openid.mode` is `id_res` (not `cancel`, not a crafted `checkid_setup`).
 *  2. `openid.op_endpoint` is Valve's, not a lookalike.
 *  3. `openid.return_to` equals the URL we put in the authorize request.
 *  4. `openid.claimed_id` is a SteamID64 in Valve's documented form.
 *  5. Steam itself says `is_valid:true` when we POST the assertion back.
 *  6. That POST is made with `openid.mode=check_authentication` and every
 *     original field, because the signature covers `openid.signed`.
 */
export async function verifySteamAssertion(
  params: Record<string, string>,
  expectedReturnTo: string,
): Promise<string> {
  if (params["openid.mode"] !== "id_res") {
    throw new SteamAuthError("Steam did not return a completed assertion");
  }
  if (params["openid.op_endpoint"] !== STEAM_OPENID_ENDPOINT) {
    throw new SteamAuthError("Steam assertion came from an unexpected endpoint");
  }
  const returnTo = params["openid.return_to"];
  if (!returnTo || !returnToEquals(returnTo, expectedReturnTo)) {
    throw new SteamAuthError("Steam return_to did not match the pending request");
  }
  const steamId = steamIdFromClaimedId(params["openid.claimed_id"]);
  if (!steamId) {
    throw new SteamAuthError("Steam assertion did not carry a SteamID");
  }

  const body = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (!key.startsWith("openid.")) {
      continue;
    }
    body.set(key, key === "openid.mode" ? "check_authentication" : value);
  }
  if (!body.has("openid.mode")) {
    throw new SteamAuthError("Steam assertion was missing OpenID fields");
  }

  let response: Response;
  try {
    response = await fetch(STEAM_OPENID_ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        // Steam 403s some datacenter POSTs without these; they are Valve's
        // own host, not a confused-deputy trick.
        Origin: "https://steamcommunity.com",
        Referer: "https://steamcommunity.com/",
      },
      body,
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
      redirect: "error",
    });
  } catch (error) {
    throw new SteamAuthError(
      error instanceof Error ? error.message : "Steam OpenID verify failed",
    );
  }

  if (!response.ok) {
    throw new SteamAuthError(`Steam OpenID verify returned ${response.status}`);
  }
  const text = await response.text();
  if (!/^is_valid\s*:\s*true\s*$/m.test(text)) {
    throw new SteamAuthError("Steam rejected the OpenID assertion");
  }
  return steamId;
}

function returnToEquals(actual: string, expected: string): boolean {
  try {
    const a = new URL(actual);
    const b = new URL(expected);
    if (a.origin !== b.origin || a.pathname !== b.pathname) {
      return false;
    }
    // Steam echoes the return_to we sent, including `state`. Extra OpenID
    // fields are query on the *callback*, not on return_to itself.
    const aState = a.searchParams.get("state");
    const bState = b.searchParams.get("state");
    return aState === bState;
  } catch {
    return actual === expected;
  }
}

export interface SteamProfileSnapshot {
  steamId: string;
  displayName: string;
  avatarUrl: string | null;
  profileUrl: string;
}

export async function fetchSteamProfile(
  steamId: string,
): Promise<SteamProfileSnapshot> {
  const fallback: SteamProfileSnapshot = {
    steamId,
    displayName: `Steam ${steamId.slice(-4)}`,
    avatarUrl: null,
    profileUrl: steamProfileUrl(steamId),
  };
  const key = steamWebApiKey();
  if (!key) {
    return fallback;
  }

  const url = new URL(STEAM_SUMMARIES_URL);
  url.searchParams.set("key", key);
  url.searchParams.set("steamids", steamId);

  try {
    const response = await fetch(url, {
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
      redirect: "error",
    });
    if (!response.ok) {
      return fallback;
    }
    const payload = (await response.json()) as {
      response?: {
        players?: Array<{
          steamid?: string;
          personaname?: string;
          avatarfull?: string;
          profileurl?: string;
        }>;
      };
    };
    const player = payload.response?.players?.[0];
    if (!player || player.steamid !== steamId) {
      return fallback;
    }
    const name = player.personaname?.trim();
    const avatar = httpUrlOrNull(player.avatarfull);
    return {
      steamId,
      displayName: clipName(name) ?? fallback.displayName,
      avatarUrl: avatar,
      profileUrl: httpUrlOrNull(player.profileurl) ?? fallback.profileUrl,
    };
  } catch {
    return fallback;
  }
}

function clipName(value: string | undefined): string | null {
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
