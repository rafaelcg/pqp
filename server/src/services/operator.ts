import { z } from "zod";
import type { VoiceRoomTransport } from "@pqp/shared";
import { getPool } from "../db.js";
import { logEvent } from "../lib/log.js";
import { logAudit } from "./audit.js";
import {
  isLiveHlsEnabled,
  liveHlsRunningChannelIds,
  liveHlsServerAllowlist,
  resolveLiveHlsForServer,
} from "../voice/hls-egress.js";
import {
  getServerVoiceBackend,
  isLiveKitConfigured,
} from "../voice/backends.js";
import {
  resolveVoiceTransport,
  type VoiceTransportDecision,
} from "../voice/transport-policy.js";
import { getRoomTransport, isRoomPinnedLocally } from "../ws/voice.js";
import { pinnedRoomRegion, sfuRegions } from "../voice/regions.js";
import {
  isLiveHlsLLEnabled,
  liveHlsLLAllowlist,
  liveHlsLLAvailable,
  llPlaylistFrontConfigured,
} from "../voice/hls-remux.js";
import { approveWatchPartyWaitlist } from "./watch-party-waitlist.js";

/**
 * The operator dashboard's WRITE surface: the two levers somebody running an
 * event actually needs, and nothing else.
 *
 *   1. Watch party availability per server (`servers.live_hls_enabled`).
 *   2. A channel's voice transport override (`channels.voice_transport`).
 *
 * Both already existed. The first was a Fly environment variable, so changing
 * it meant a deploy, which restarts `pqp-api` and closes every WebSocket, and
 * nothing showed which servers were on the list. The second was a column only
 * reachable by hand-written SQL against production. Neither was a thing the
 * person running Saturday's event could do himself, which is the whole reason
 * this file exists.
 *
 * WHAT IS DELIBERATELY NOT HERE. No account actions, no bans, no moderation,
 * no server deletion, no reading anybody's messages. The machine token that
 * reaches this surface lives in a Cloudflare Worker behind an HTTP Basic
 * password; the smaller the set of things it can do, the less that pair of
 * secrets is worth. `DELETE /api/admin/users/:id` exists and is deliberately
 * NOT on the machine token's allowlist (see `ADMIN_MACHINE_ROUTES` in
 * api/index.ts): terminating an account stays a thing a signed-in operator
 * does with a Clerk session.
 *
 * EVERY WRITE HERE IS AUDITED. `audit_log` is server-scoped (`server_id` is
 * NOT NULL) and both of these writes are about one server, so unlike the
 * account termination above they have a home in the existing trail and use
 * it. `actor_id` is null for the machine token, which the schema already
 * means as "the system did it"; a signed-in instance moderator's own id is
 * recorded when they come in that way.
 */

/** Servers listed at once. The dashboard searches; it does not browse 908. */
export const OPERATOR_SERVER_LIMIT = 25;

/**
 * The operator surface, as exact pathnames.
 *
 * EXACT, with the target id in the query string or the body rather than in
 * the path, so the machine token's allowlist in api/index.ts is a string
 * comparison and never a pattern. A pattern is a thing somebody widens by
 * accident; this list is the entire blast radius of `ADMIN_METRICS_TOKEN`
 * beyond the two reads it already had, and it is meant to be readable in one
 * glance.
 */
export const OPERATOR_SERVERS_PATH = "/api/admin/servers";
export const OPERATOR_CHANNELS_PATH = "/api/admin/server-channels";
export const OPERATOR_SERVER_LIVE_HLS_PATH = "/api/admin/server-live-hls";
export const OPERATOR_CHANNEL_TRANSPORT_PATH =
  "/api/admin/channel-voice-transport";
export const OPERATOR_CHANNEL_SFU_REGION_PATH = "/api/admin/channel-sfu-region";

export const setServerLiveHlsSchema = z
  .object({
    serverId: z.string().uuid(),
    /**
     * `true` on, `false` off, `null` back to "nobody has decided", which hands
     * the answer back to `LIVE_HLS_SERVER_ALLOWLIST`. Three states because two
     * would make the off switch indistinguishable from never having touched it,
     * and off has to beat the environment variable or there is no kill switch
     * that works without a deploy.
     *
     * OMITTED leaves the column as it is, so a body that only moves low
     * latency does not touch availability. Every body the dashboard sent
     * before `lowLatency` existed carries this field, so it means what it
     * always meant.
     */
    enabled: z.boolean().nullable().optional(),
    /**
     * `servers.live_hls_ll_enabled`, the same three states against
     * `LIVE_HLS_LL_ALLOWLIST`. Omitted leaves it as it is.
     */
    lowLatency: z.boolean().nullable().optional(),
  })
  .refine(
    (body) => body.enabled !== undefined || body.lowLatency !== undefined,
    { message: "Nothing to change" },
  );

export const setChannelVoiceTransportSchema = z.object({
  channelId: z.string().uuid(),
  /** `null` is automatic: size, community and HLS decide, as they always did. */
  transport: z.enum(["mesh", "livekit"]).nullable(),
});

export const setChannelSfuRegionSchema = z.object({
  channelId: z.string().uuid(),
  /**
   * A configured region id (`LIVEKIT_REGIONS`, or the home id), or `null`
   * for automatic: the first joiner's country decides.
   */
  region: z
    .string()
    .regex(/^[a-z][a-z0-9-]{0,15}$/)
    .nullable(),
});

/** The operator asked for a region this deployment does not run. */
export class OperatorBadRequest extends Error {}

export interface OperatorServerSummary {
  id: string;
  name: string;
  memberCount: number;
  isCommunity: boolean;
  /** `servers.live_hls_enabled`: what the operator decided, or null. */
  liveHlsOverride: boolean | null;
  /** What `resolveLiveHlsForServer` answers right now, for this deployment. */
  liveHlsEffective: boolean;
  /** Which of the three inputs produced `liveHlsEffective`. */
  liveHlsSource: "master-off" | "server" | "allowlist" | "open";
  /** `servers.live_hls_ll_enabled`: the low latency decision, or null. */
  liveHlsLlOverride: boolean | null;
  /** What `liveHlsLLAvailable` answers right now for this server. */
  liveHlsLlEffective: boolean;
  /** Same four sources, against `LIVE_HLS_LL` and `LIVE_HLS_LL_ALLOWLIST`. */
  liveHlsLlSource: "master-off" | "server" | "allowlist" | "open";
  /** Watch party channels in this server, so the list says where a party can run. */
  watchPartyChannels: number;
  /** This process is running an egress in one of this server's channels. */
  streaming: boolean;
}

export interface OperatorServerList {
  servers: OperatorServerSummary[];
  /** Servers matching the query, which can exceed what `servers` carries. */
  matched: number;
  /** The deployment-wide switches, so the page can explain a row that is off. */
  liveHls: {
    /** `LIVE_HLS_ENABLED` plus LiveKit plus the dedicated bucket. */
    configured: boolean;
    /** Whether `LIVE_HLS_SERVER_ALLOWLIST` is set at all. */
    envAllowlist: boolean;
    /** How many server ids that variable names. */
    envAllowlistSize: number;
  };
  /** Rows with the column set either way, the proof the data path is in use. */
  overrides: { on: number; off: number };
}

export interface OperatorChannelSummary {
  id: string;
  name: string;
  type: string;
  /** `channels.voice_transport`, the override. Null is automatic. */
  voiceTransport: VoiceRoomTransport | null;
  /** The pin this process is holding, when a room is open. Null when empty. */
  pinnedTransport: VoiceRoomTransport | null;
  /** What a room opening now would be pinned to, and why. */
  wouldOpenOn: VoiceTransportDecision;
  /** `channels.sfu_region`, the region override. Null is automatic. */
  sfuRegion: string | null;
  /** The SFU region this process has the open room pinned to; null when empty or single-region. */
  pinnedRegion: string | null;
  /** This process is running an HLS egress for this channel right now. */
  streaming: boolean;
}

export interface OperatorChannelList {
  serverId: string;
  serverName: string;
  channels: OperatorChannelSummary[];
  /** `getServerVoiceBackend() === "livekit" && isLiveKitConfigured()`. */
  liveKitConfigured: boolean;
  liveHlsEffective: boolean;
  /** Configured SFU region ids, home first; null without `LIVEKIT_REGIONS`. */
  sfuRegions: string[] | null;
}

function liveHlsSourceFor(override: boolean | null): OperatorServerSummary["liveHlsSource"] {
  if (!isLiveHlsEnabled()) {
    return "master-off";
  }
  if (override !== null) {
    return "server";
  }
  return liveHlsServerAllowlist() === null ? "open" : "allowlist";
}

function liveHlsLlSourceFor(
  override: boolean | null,
): OperatorServerSummary["liveHlsLlSource"] {
  if (!isLiveHlsLLEnabled() || !llPlaylistFrontConfigured()) {
    return "master-off";
  }
  if (override !== null) {
    return "server";
  }
  return liveHlsLLAllowlist() === null ? "open" : "allowlist";
}

/** The four low latency fields of a summary, from the row's override. */
function lowLatencyFields(
  serverId: string,
  override: boolean | null,
): Pick<
  OperatorServerSummary,
  "liveHlsLlOverride" | "liveHlsLlEffective" | "liveHlsLlSource"
> {
  return {
    liveHlsLlOverride: override,
    liveHlsLlEffective: liveHlsLLAvailable(serverId, override),
    liveHlsLlSource: liveHlsLlSourceFor(override),
  };
}

/**
 * The set of server ids this process is streaming for.
 *
 * PROCESS-LOCAL, and that is stated rather than hidden: `rooms` in
 * hls-egress.ts is this machine's map. With one machine in gru it is exact;
 * the day there are two it is "what I am running", which is still the honest
 * answer and is what the dashboard's room list already reports.
 */
async function streamingServerIds(): Promise<Set<string>> {
  const channelIds = liveHlsRunningChannelIds();
  if (channelIds.length === 0) {
    return new Set();
  }
  try {
    const result = await getPool().query<{ server_id: string | null }>(
      `SELECT DISTINCT server_id FROM channels WHERE id = ANY($1::uuid[])`,
      [channelIds],
    );
    return new Set(
      result.rows.map((row) => row.server_id).filter((id): id is string => Boolean(id)),
    );
  } catch {
    // A failed lookup costs a badge, never the list.
    return new Set();
  }
}

/**
 * Servers matching a name fragment: the ones somebody has already decided
 * about first, then the biggest, then by name. The decided rows come first
 * because "what have I turned on" is the question this list is opened with as
 * often as "where is Cinemoon".
 *
 * `ILIKE '%q%'` with no index behind it, on purpose: there are 908 servers,
 * the caller is one operator on one page, and a trigram index for a query
 * that runs a handful of times a week is a schema change nobody needs. An
 * empty query answers the largest servers, which is the useful default before
 * an event.
 */
export async function listOperatorServers(
  query: string,
  limit = OPERATOR_SERVER_LIMIT,
): Promise<OperatorServerList> {
  const trimmed = query.trim().slice(0, 80);
  const pool = getPool();
  const filter = trimmed ? `WHERE s.name ILIKE $1` : "";
  const params: unknown[] = trimmed ? [`%${trimmed}%`] : [];

  const [rows, counts, overrides, streaming] = await Promise.all([
    pool.query<{
      id: string;
      name: string;
      is_community: boolean;
      live_hls_enabled: boolean | null;
      live_hls_ll_enabled: boolean | null;
      member_count: string;
      watch_party_channels: string;
    }>(
      `SELECT s.id, s.name, s.is_community, s.live_hls_enabled, s.live_hls_ll_enabled,
              (SELECT COUNT(*) FROM server_members m WHERE m.server_id = s.id) AS member_count,
              (SELECT COUNT(*) FROM channels c
                WHERE c.server_id = s.id AND c.type = 'watch_party') AS watch_party_channels
         FROM servers s
         ${filter}
        ORDER BY s.live_hls_enabled IS NOT NULL DESC,
                 (SELECT COUNT(*) FROM server_members m WHERE m.server_id = s.id) DESC,
                 s.name ASC
        LIMIT ${Math.trunc(Math.max(1, Math.min(Number(limit) || OPERATOR_SERVER_LIMIT, 100)))}`,
      params,
    ),
    pool.query<{ n: string }>(
      `SELECT COUNT(*)::text AS n FROM servers s ${filter}`,
      params,
    ),
    pool.query<{ on: string; off: string }>(
      `SELECT COUNT(*) FILTER (WHERE live_hls_enabled)::text AS on,
              COUNT(*) FILTER (WHERE live_hls_enabled = FALSE)::text AS off
         FROM servers`,
    ),
    streamingServerIds(),
  ]);

  const allowlist = liveHlsServerAllowlist();
  return {
    servers: rows.rows.map((row) => ({
      id: row.id,
      name: row.name,
      memberCount: Number(row.member_count),
      isCommunity: row.is_community,
      liveHlsOverride: row.live_hls_enabled,
      liveHlsEffective: resolveLiveHlsForServer(row.id, row.live_hls_enabled),
      liveHlsSource: liveHlsSourceFor(row.live_hls_enabled),
      ...lowLatencyFields(row.id, row.live_hls_ll_enabled),
      watchPartyChannels: Number(row.watch_party_channels),
      streaming: streaming.has(row.id),
    })),
    matched: Number(counts.rows[0]?.n ?? 0),
    liveHls: {
      configured: isLiveHlsEnabled(),
      envAllowlist: allowlist !== null,
      envAllowlistSize: allowlist?.size ?? 0,
    },
    overrides: {
      on: Number(overrides.rows[0]?.on ?? 0),
      off: Number(overrides.rows[0]?.off ?? 0),
    },
  };
}

/**
 * A server's voice and watch-party channels, each with the override it
 * carries, the pin it is running on, and what a room opening now would be
 * pinned to.
 *
 * The last of those is computed here with `resolveVoiceTransport` and the one
 * server profile this function already read, rather than by calling
 * `decideRoomTransport` once per channel. Same function, same inputs, no
 * per-channel query, and it cannot drift from what a join would decide
 * because it IS what a join decides.
 */
export async function listOperatorChannels(
  serverId: string,
): Promise<OperatorChannelList | null> {
  const pool = getPool();
  const server = await pool.query<{
    id: string;
    name: string;
    is_community: boolean;
    live_hls_enabled: boolean | null;
    member_count: string;
  }>(
    `SELECT s.id, s.name, s.is_community, s.live_hls_enabled,
            (SELECT COUNT(*) FROM server_members m WHERE m.server_id = s.id) AS member_count
       FROM servers s WHERE s.id = $1`,
    [serverId],
  );
  const row = server.rows[0];
  if (!row) {
    return null;
  }

  const channels = await pool.query<{
    id: string;
    name: string;
    type: string;
    voice_transport: VoiceRoomTransport | null;
    sfu_region: string | null;
  }>(
    `SELECT id, name, type, voice_transport, sfu_region
       FROM channels
      WHERE server_id = $1 AND kind = 'server' AND type IN ('voice', 'watch_party')
      ORDER BY position ASC, name ASC`,
    [serverId],
  );

  const liveKitConfigured =
    getServerVoiceBackend() === "livekit" && isLiveKitConfigured();
  const liveHlsEffective = resolveLiveHlsForServer(row.id, row.live_hls_enabled);
  const profile = {
    isCommunity: row.is_community,
    memberCount: Number(row.member_count),
  };
  const running = new Set(liveHlsRunningChannelIds());

  return {
    serverId: row.id,
    serverName: row.name,
    liveKitConfigured,
    liveHlsEffective,
    sfuRegions: sfuRegions()?.map((region) => region.id) ?? null,
    channels: channels.rows.map((channel) => ({
      id: channel.id,
      name: channel.name,
      type: channel.type,
      voiceTransport: channel.voice_transport,
      pinnedTransport: isRoomPinnedLocally(channel.id)
        ? getRoomTransport(channel.id)
        : null,
      wouldOpenOn: resolveVoiceTransport({
        liveKitConfigured,
        liveHlsEnabled: liveHlsEffective,
        channel: {
          kind: "server",
          type: channel.type,
          voiceTransport: channel.voice_transport,
        },
        server: profile,
      }),
      streaming: running.has(channel.id),
      sfuRegion: channel.sfu_region,
      pinnedRegion: pinnedRoomRegion(channel.id),
    })),
  };
}

export class OperatorTargetMissing extends Error {}

/**
 * Turn watch party streaming on or off for one server, or hand the decision
 * back to the environment.
 *
 * Takes effect on the next read, which is the next `join-voice-room` in that
 * channel, the next share reconcile, and the next
 * `GET /api/live-hls/config?serverId=`. No deploy, no restart, no socket
 * closed.
 *
 * ONE CAVEAT WORTH SAYING OUT LOUD, because it is the shape of bug this repo
 * keeps hitting: a browser that is already open cached the config answer for
 * the page's lifetime (`client/src/hooks/use-live-hls-config.ts`), so turning
 * a server ON does not make the share button appear in a tab nobody has
 * reloaded. The server-side capability is immediate either way; it is the
 * affordance that lags. Flip it before the host opens the channel, or tell
 * them to reload.
 */
export async function setServerLiveHls(
  serverId: string,
  change: { enabled?: boolean | null; lowLatency?: boolean | null },
  actorId: string | null,
): Promise<OperatorServerSummary> {
  const setEnabled = change.enabled !== undefined;
  const setLowLatency = change.lowLatency !== undefined;
  const result = await getPool().query<{
    id: string;
    name: string;
    is_community: boolean;
    live_hls_enabled: boolean | null;
    live_hls_ll_enabled: boolean | null;
    previous: boolean | null;
    previous_ll: boolean | null;
  }>(
    `UPDATE servers s
        SET live_hls_enabled = CASE WHEN $3 THEN $2::boolean ELSE s.live_hls_enabled END,
            live_hls_ll_enabled = CASE WHEN $5 THEN $4::boolean ELSE s.live_hls_ll_enabled END
       FROM (SELECT id, live_hls_enabled, live_hls_ll_enabled FROM servers WHERE id = $1) old
      WHERE s.id = old.id
      RETURNING s.id, s.name, s.is_community, s.live_hls_enabled, s.live_hls_ll_enabled,
                old.live_hls_enabled AS previous, old.live_hls_ll_enabled AS previous_ll`,
    [
      serverId,
      change.enabled ?? null,
      setEnabled,
      change.lowLatency ?? null,
      setLowLatency,
    ],
  );
  const row = result.rows[0];
  if (!row) {
    throw new OperatorTargetMissing("Server not found");
  }

  const changes: { key: string; old: boolean | null; new: boolean | null }[] = [];
  if (setEnabled && row.previous !== row.live_hls_enabled) {
    changes.push({
      key: "liveHlsEnabled",
      old: row.previous,
      new: row.live_hls_enabled,
    });
  }
  if (setLowLatency && row.previous_ll !== row.live_hls_ll_enabled) {
    changes.push({
      key: "liveHlsLowLatency",
      old: row.previous_ll,
      new: row.live_hls_ll_enabled,
    });
  }
  if (changes.length > 0) {
    await logAudit({
      serverId: row.id,
      actorId,
      action: "server.live_hls_update",
      targetType: "server",
      targetId: row.id,
      changes,
    }).catch((error: unknown) => {
      // Best effort, like every other call site of logAudit. A trail that
      // failed to write must not undo the change the operator just made and
      // watched land.
      console.error("[operator] audit write failed:", error);
    });
  }

  if (setEnabled) {
    logEvent("operator.liveHlsServerSet", {
      serverId: row.id,
      enabled: row.live_hls_enabled,
      previous: row.previous,
      actorId,
    });
  }
  if (setLowLatency) {
    logEvent("operator.liveHlsLlServerSet", {
      serverId: row.id,
      enabled: row.live_hls_ll_enabled,
      previous: row.previous_ll,
      actorId,
    });
  }

  // THE WAITLIST FOLLOWS THE SWITCH, and never the other way round. A server
  // the operator has just turned on has nobody left to wait for it, so its
  // waiting rows are approved and those people told. After the column is
  // written, best effort, and never awaited by anything the party needs: a
  // failure here costs a notification, not a stream.
  if (row.live_hls_enabled === true) {
    await approveWatchPartyWaitlist(row.id).catch((error: unknown) => {
      console.error("[operator] waitlist approval failed:", error);
    });
  }

  const counts = await getPool().query<{
    member_count: string;
    watch_party_channels: string;
  }>(
    `SELECT (SELECT COUNT(*) FROM server_members m WHERE m.server_id = $1) AS member_count,
            (SELECT COUNT(*) FROM channels c
              WHERE c.server_id = $1 AND c.type = 'watch_party') AS watch_party_channels`,
    [row.id],
  );
  const streaming = await streamingServerIds();

  return {
    id: row.id,
    name: row.name,
    memberCount: Number(counts.rows[0]?.member_count ?? 0),
    isCommunity: row.is_community,
    liveHlsOverride: row.live_hls_enabled,
    liveHlsEffective: resolveLiveHlsForServer(row.id, row.live_hls_enabled),
    liveHlsSource: liveHlsSourceFor(row.live_hls_enabled),
    ...lowLatencyFields(row.id, row.live_hls_ll_enabled),
    watchPartyChannels: Number(counts.rows[0]?.watch_party_channels ?? 0),
    streaming: streaming.has(row.id),
  };
}

/**
 * Pin a voice or watch-party channel's media path, or hand it back to the
 * policy.
 *
 * NOT retroactive, and that is the safety property: `decideRoomTransport`
 * reads this column once, when a room's first peer joins, and a room with
 * anybody in it is already pinned for its lifetime. So a wrong value here
 * cannot move a live call onto another transport or split one in half; it
 * changes what the NEXT room opens on. The dashboard says so beside the
 * control, and shows the current pin next to the override so the difference
 * is visible rather than inferred.
 *
 * Refuses a channel that is not a server voice or watch-party channel: a text
 * channel has no media path and a conversation is not the operator's to pin.
 */
export async function setChannelVoiceTransport(
  channelId: string,
  transport: VoiceRoomTransport | null,
  actorId: string | null,
): Promise<OperatorChannelSummary & { serverId: string }> {
  const result = await getPool().query<{
    id: string;
    server_id: string;
    name: string;
    type: string;
    voice_transport: VoiceRoomTransport | null;
    sfu_region: string | null;
    previous: VoiceRoomTransport | null;
  }>(
    `UPDATE channels c
        SET voice_transport = $2
       FROM (SELECT id, voice_transport FROM channels WHERE id = $1) old
      WHERE c.id = old.id
        AND c.kind = 'server'
        AND c.type IN ('voice', 'watch_party')
      RETURNING c.id, c.server_id, c.name, c.type, c.voice_transport,
                c.sfu_region, old.voice_transport AS previous`,
    [channelId, transport],
  );
  const row = result.rows[0];
  if (!row || !row.server_id) {
    throw new OperatorTargetMissing("Voice channel not found");
  }

  if (row.previous !== transport) {
    await logAudit({
      serverId: row.server_id,
      actorId,
      action: "channel.voice_transport_update",
      targetType: "channel",
      targetId: row.id,
      changes: [{ key: "voiceTransport", old: row.previous, new: transport }],
    }).catch((error: unknown) => {
      console.error("[operator] audit write failed:", error);
    });
  }

  logEvent("operator.channelTransportSet", {
    channelId: row.id,
    serverId: row.server_id,
    transport,
    previous: row.previous,
    actorId,
  });

  const list = await listOperatorChannels(row.server_id);
  const fresh = list?.channels.find((channel) => channel.id === row.id);
  if (fresh) {
    return { ...fresh, serverId: row.server_id };
  }
  // The re-read is a convenience, never the source of truth for whether the
  // write landed: it already did, above.
  return {
    id: row.id,
    serverId: row.server_id,
    name: row.name,
    type: row.type,
    voiceTransport: row.voice_transport,
    pinnedTransport: isRoomPinnedLocally(row.id) ? getRoomTransport(row.id) : null,
    wouldOpenOn: { transport: "mesh", reason: "default" },
    streaming: false,
    sfuRegion: row.sfu_region,
    pinnedRegion: pinnedRoomRegion(row.id),
  };
}

/**
 * Pin a voice channel's SFU region, or hand it back to the first joiner's
 * country.
 *
 * Same safety property as the transport override above: NOT retroactive. The
 * region is read when a room's first peer joins and pinned for the room's
 * life, so a wrong value here cannot move a live call between boxes; it
 * changes where the NEXT room opens.
 *
 * Refuses a region the deployment does not run (a typo would otherwise read
 * as automatic without saying so), and refuses a `watch_party` channel
 * outright: its transcode can only reach the home box, and the policy
 * ignores the override there, so accepting it would be a control that does
 * nothing.
 */
export async function setChannelSfuRegion(
  channelId: string,
  region: string | null,
  actorId: string | null,
): Promise<OperatorChannelSummary & { serverId: string }> {
  if (region !== null) {
    const configured = sfuRegions();
    if (!configured) {
      throw new OperatorBadRequest("SFU regions are not configured");
    }
    if (!configured.some((candidate) => candidate.id === region)) {
      throw new OperatorBadRequest(`Unknown SFU region: ${region}`);
    }
  }
  const result = await getPool().query<{
    id: string;
    server_id: string;
    name: string;
    type: string;
    voice_transport: VoiceRoomTransport | null;
    sfu_region: string | null;
    previous: string | null;
  }>(
    `UPDATE channels c
        SET sfu_region = $2
       FROM (SELECT id, sfu_region FROM channels WHERE id = $1) old
      WHERE c.id = old.id
        AND c.kind = 'server'
        AND c.type = 'voice'
      RETURNING c.id, c.server_id, c.name, c.type, c.voice_transport,
                c.sfu_region, old.sfu_region AS previous`,
    [channelId, region],
  );
  const row = result.rows[0];
  if (!row || !row.server_id) {
    throw new OperatorTargetMissing("Voice channel not found");
  }
  if (row.previous !== region) {
    await logAudit({
      serverId: row.server_id,
      actorId,
      action: "channel.sfu_region_update",
      targetType: "channel",
      targetId: row.id,
      changes: [{ key: "sfuRegion", old: row.previous, new: region }],
    }).catch((error: unknown) => {
      console.error("[operator] audit write failed:", error);
    });
  }
  logEvent("operator.channelSfuRegionSet", {
    channelId: row.id,
    serverId: row.server_id,
    region,
    previous: row.previous,
    actorId,
  });
  // The re-read is a convenience, never the source of truth for whether the
  // write landed: it already did, above. Same rule as the transport setter.
  const list = await listOperatorChannels(row.server_id).catch((error: unknown) => {
    console.error("[operator] channel re-read failed after a region write:", error);
    return null;
  });
  const fresh = list?.channels.find((channel) => channel.id === row.id);
  if (fresh) {
    return { ...fresh, serverId: row.server_id };
  }
  return {
    id: row.id,
    serverId: row.server_id,
    name: row.name,
    type: row.type,
    voiceTransport: row.voice_transport,
    pinnedTransport: isRoomPinnedLocally(row.id) ? getRoomTransport(row.id) : null,
    wouldOpenOn: { transport: "mesh", reason: "default" },
    streaming: false,
    sfuRegion: row.sfu_region,
    pinnedRegion: pinnedRoomRegion(row.id),
  };
}
