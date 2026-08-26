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
    iceServers?: IceServerConfig | IceServerConfig[];
  };

  /**
   * Cloudflare answers with a single `iceServers` OBJECT, not an array.
   *
   * This used to be typed and handled as an array only, so `.length` on the
   * object was `undefined`, the guard below treated it as empty, and the
   * function returned null every time. The effect was silent and total: with
   * static TURN also configured the caller just used that instead, so a
   * permanently broken integration looked exactly like a working one with a
   * different provider.
   *
   * Both shapes are accepted now. Their docs describe the object; an array is
   * the shape this code already assumed and costs one line to keep. Normalise
   * rather than pick, because being wrong about which one arrives is precisely
   * the failure being fixed, and it is not worth a second silent outage to
   * save a line.
   */
  const raw = data.iceServers;
  const list: IceServerConfig[] = Array.isArray(raw) ? raw : raw ? [raw] : [];

  if (list.length === 0) {
    console.error("[ice] Cloudflare TURN returned empty iceServers");
    return null;
  }

  // Port 53 is blocked in browsers; drop it to avoid long ICE timeouts.
  return list.map((server) => {
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
 * 1. Cloudflare Realtime TURN (CLOUDFLARE_TURN_KEY_ID + CLOUDFLARE_TURN_API_TOKEN)
 * 2. Metered / Open Relay REST (METERED_API_KEY + optional METERED_DOMAIN)
 * 3. Static TURN_* (or VITE_TURN_*) on the API
 * 4. Public STUN only (cross-NAT mesh will fail without TURN)
 *
 * WHY STATIC TURN MOVED FROM FIRST TO LAST.
 *
 * It used to return early, before the dynamic providers were consulted at all.
 * With both configured, as production is today, that had two consequences:
 *
 *  - **The dynamic provider was dead code in production.** Credentials were
 *    deployed, cost something to hold, and were never once handed to a client.
 *  - **There was no failover.** A static relay that is throttled, saturated or
 *    simply down took cross-network voice down with it, because the code
 *    returned its address without ever asking whether anything else was
 *    available. That is pitfall 1 in CLAUDE.md, and it is the failure this
 *    project has already had once.
 *
 * Reordering makes the list a real chain rather than a first-match: dynamic
 * first, static as the thing that catches a dynamic outage. Strictly more
 * resilient than before in every configuration, because the old order could
 * never fall *forward* and the new one can still fall back.
 *
 * The secondary reason is geography, and it is a hypothesis rather than a
 * measurement, so it is written down as one. A relayed path adds the round
 * trip to the relay and back, and WebRTC's congestion controller answers a
 * worse round trip by *lowering the bitrate*, which users see as blurry video
 * rather than as a network problem. An anycast relay with a São Paulo presence
 * should therefore beat a fixed endpoint that may sit outside Brazil, for a
 * Brazilian user base. Nobody has measured this yet. See TURN_PREFER_STATIC
 * below for how to undo it in one command if the hypothesis is wrong.
 *
 * WHAT THIS COSTS, so nobody has to guess later.
 *
 * Cloudflare meters **only what the edge sends to the TURN client**, which is
 * what a relayed participant receives, including TURN overhead. $0.05 per GB,
 * after a free tier of 1,000 GB per month. `stun.cloudflare.com` is free and
 * unlimited, and TURN-to-Cloudflare-SFU traffic is not charged at all, which
 * matters only if their SFU is ever evaluated against LiveKit.
 *
 * Against this codebase's own constants, per relayed participant-hour:
 *
 *   voice only, 4-person room   ~3 Opus streams, ~100 kbps   ~0.045 GB
 *   watching a screen share     SCREEN_UPLOAD_BUDGET_BPS is
 *                               5 Mbps split by peer count,
 *                               so roughly 2 Mbps             ~0.9 GB
 *
 * **Screen share costs about twenty times what voice does**, so voice will
 * never be the relay bill and screen share might. The free tier is therefore
 * roughly 1,100 hours of relayed screen-share viewing per month.
 *
 * The practical conclusion, as of 2026-08-26: this is free at current scale
 * and stays cheap through several doublings, so there is no cost argument for
 * paying a static TURN vendor, and no cost argument for an SFU either. The
 * reasons to want an SFU are the mesh peer ceiling and the fact that every
 * participant uploads their stream N-1 times; relay spend is not one of them.
 *
 * A self-host with only TURN_* set is unaffected: the dynamic lookups return
 * null without a network call when their keys are absent.
 */
export async function getIceServers(): Promise<IceServerConfig[]> {
  const staticTurn = getStaticTurnFromEnv();

  /**
   * The escape hatch, deliberately an env var and not a code change.
   *
   * If preferring the dynamic provider turns out to be wrong, this restores
   * the old behaviour with one `fly secrets set` and a restart, with no
   * revert, no CI run and no wait. Rolling back a voice regression should not
   * require a deploy pipeline.
   */
  if (staticTurn && process.env.TURN_PREFER_STATIC === "true") {
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

  // Not cached: a dynamic provider that is failing right now should be retried
  // on the next call rather than have its absence pinned for an hour.
  if (staticTurn) {
    return [...STUN_SERVERS, ...staticTurn];
  }

  console.warn(
    "[ice] No TURN configured. Cross-network voice will fail. Set CLOUDFLARE_TURN_* , METERED_API_KEY, or TURN_URL/USERNAME/CREDENTIAL on the API.",
  );
  return [...STUN_SERVERS];
}
