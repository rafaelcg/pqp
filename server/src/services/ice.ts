import type { IceServerConfig } from "@pqp/shared";

interface CachedIceServers {
  servers: IceServerConfig[];
  expiresAt: number;
}

let cachedDynamic: CachedIceServers | null = null;

const STUN_SERVERS: IceServerConfig[] = [
  { urls: "stun:stun.l.google.com:19302" },
  { urls: "stun:stun1.l.google.com:19302" },
  { urls: "stun:stun.cloudflare.com:3478" },
];

function getStaticTurnFromEnv(): IceServerConfig[] | null {
  const turnUrl = process.env.TURN_URL ?? process.env.VITE_TURN_URL;
  const turnUsername =
    process.env.TURN_USERNAME ?? process.env.VITE_TURN_USERNAME;
  const turnCredential =
    process.env.TURN_CREDENTIAL ?? process.env.VITE_TURN_CREDENTIAL;

  if (!turnUrl || !turnUsername || !turnCredential) {
    return null;
  }

  // Ignore placeholder values from .env.example copies
  if (
    turnUrl.includes("example.com") ||
    turnUsername.includes("your-") ||
    turnCredential.includes("your-")
  ) {
    return null;
  }

  const urls = turnUrl
    .split(",")
    .map((u) => u.trim())
    .filter(Boolean);

  return [
    {
      urls: urls.length === 1 ? urls[0]! : urls,
      username: turnUsername,
      credential: turnCredential,
    },
  ];
}

async function fetchCloudflareIceServers(): Promise<IceServerConfig[] | null> {
  const keyId = process.env.CLOUDFLARE_TURN_KEY_ID;
  const apiToken = process.env.CLOUDFLARE_TURN_API_TOKEN;
  if (!keyId || !apiToken) {
    return null;
  }

  const response = await fetch(
    `https://rtc.live.cloudflare.com/v1/turn/keys/${keyId}/credentials/generate-ice-servers`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ ttl: 86_400 }),
    },
  );

  if (!response.ok) {
    console.error(
      `[ice] Cloudflare TURN credentials failed: HTTP ${response.status}`,
    );
    return null;
  }

  const data = (await response.json()) as {
    iceServers?: IceServerConfig[];
  };

  if (!data.iceServers || data.iceServers.length === 0) {
    console.error("[ice] Cloudflare TURN returned empty iceServers");
    return null;
  }

  // Port 53 is blocked in browsers; drop it to avoid long ICE timeouts.
  return data.iceServers.map((server) => {
    const urls = Array.isArray(server.urls) ? server.urls : [server.urls];
    const filtered = urls.filter((url) => !url.includes(":53"));
    return {
      ...server,
      urls: filtered.length === 1 ? filtered[0]! : filtered,
    };
  });
}

async function fetchMeteredIceServers(): Promise<IceServerConfig[] | null> {
  const apiKey = process.env.METERED_API_KEY ?? process.env.OPENRELAY_API_KEY;
  const domain =
    process.env.METERED_DOMAIN ?? process.env.METERED_APP_NAME ?? null;

  if (!apiKey) {
    return null;
  }

  const endpoint = domain
    ? `https://${domain}.metered.live/api/v1/turn/credentials?apiKey=${encodeURIComponent(apiKey)}`
    : `https://openrelay.metered.ca/openrelayproject/turnserver?apiKey=${encodeURIComponent(apiKey)}`;

  const response = await fetch(endpoint);
  if (!response.ok) {
    console.error(`[ice] Metered TURN credentials failed: HTTP ${response.status}`);
    return null;
  }

  const data = (await response.json()) as IceServerConfig[] | {
    iceServers?: IceServerConfig[];
  };

  const servers = Array.isArray(data) ? data : (data.iceServers ?? []);
  if (servers.length === 0) {
    console.error("[ice] Metered TURN returned empty iceServers");
    return null;
  }

  return servers;
}

/**
 * Build ICE server list for WebRTC.
 *
 * Priority:
 * 1. Static TURN_* (or VITE_TURN_*) on the API
 * 2. Cloudflare Realtime TURN (CLOUDFLARE_TURN_KEY_ID + CLOUDFLARE_TURN_API_TOKEN)
 * 3. Metered / Open Relay REST (METERED_API_KEY + optional METERED_DOMAIN)
 * 4. Public STUN only (cross-NAT mesh will fail without TURN)
 */
export async function getIceServers(): Promise<IceServerConfig[]> {
  const staticTurn = getStaticTurnFromEnv();
  if (staticTurn) {
    return [...STUN_SERVERS, ...staticTurn];
  }

  const now = Date.now();
  if (cachedDynamic && cachedDynamic.expiresAt > now) {
    return cachedDynamic.servers;
  }

  try {
    const cloudflare = await fetchCloudflareIceServers();
    if (cloudflare) {
      const servers = [...STUN_SERVERS, ...cloudflare];
      cachedDynamic = {
        servers,
        expiresAt: now + 60 * 60 * 1000,
      };
      return servers;
    }

    const metered = await fetchMeteredIceServers();
    if (metered) {
      const servers = [...STUN_SERVERS, ...metered];
      cachedDynamic = {
        servers,
        expiresAt: now + 60 * 60 * 1000,
      };
      return servers;
    }
  } catch (error) {
    console.error("[ice] Dynamic TURN fetch failed:", error);
  }

  console.warn(
    "[ice] No TURN configured — cross-network voice will fail. Set CLOUDFLARE_TURN_* , METERED_API_KEY, or TURN_URL/USERNAME/CREDENTIAL on the API.",
  );
  return [...STUN_SERVERS];
}
