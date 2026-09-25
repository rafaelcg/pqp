import { z } from "zod";
import {
  Permission,
  type WatchPartyAudienceBucket,
  type WatchPartyWaitlistApproval,
  type WatchPartyWaitlistEntry,
  type WatchPartyWaitlistKind,
  type WatchPartyWaitlistState,
  type WatchPartyWaitlistStatus,
} from "@pqp/shared";
import { getPool } from "../db.js";
import { publishToCluster, isBusEnabled, subscribeToCluster } from "../lib/bus.js";
import { HttpError } from "../lib/http.js";
import { logEvent } from "../lib/log.js";
import { forEachAuthenticatedSocket } from "../ws/sockets.js";
import {
  isLiveHlsEnabled,
  liveHlsServerOverride,
  resolveLiveHlsForServer,
} from "../voice/hls-egress.js";
import { memberHasPermission } from "./permissions.js";
import { pushWatchPartyWaitlistApproved } from "./push.js";
import { getMemberRole } from "./users.js";

/**
 * The watch party waitlist. See `docs/WATCH_PARTY.md` §"The waitlist" and
 * `packages/shared/src/watch-party-waitlist.ts` for the two kinds of row.
 *
 * NOTHING HERE TOUCHES A PARTY. The teaser only ever shows where
 * `resolveLiveHlsForServer` already says no, joining refuses a server where it
 * says yes, and the one write that reaches the live path is the operator's own
 * availability flip (`setServerLiveHls`), which calls `approveWatchPartyWaitlist`
 * after the column is written and never waits on it.
 */

/**
 * `WATCH_PARTY_WAITLIST`: `on` / `off`, and unset follows `LIVE_HLS_ENABLED`
 * (plus LiveKit and the bucket, which is what `isLiveHlsEnabled` means). A
 * deployment that cannot run a watch party at all must not advertise one, so
 * the default for a self-host is off without anybody having to know the
 * variable exists; the hosted deployment runs parties, so it is on there
 * until somebody sets `off`.
 */
export function watchPartyWaitlistCampaignEnabled(): boolean {
  const raw = (process.env.WATCH_PARTY_WAITLIST ?? "").trim().toLowerCase();
  if (raw === "on" || raw === "true" || raw === "1") {
    return true;
  }
  if (raw === "off" || raw === "false" || raw === "0") {
    return false;
  }
  return isLiveHlsEnabled();
}

interface WaitlistRow {
  server_id: string | null;
  kind: WatchPartyWaitlistKind;
  status: WatchPartyWaitlistStatus;
  audience_bucket: WatchPartyAudienceBucket | null;
  note: string | null;
  twitch_or_kick: string | null;
  created_at: Date;
  decided_at: Date | null;
}

const ENTRY_COLUMNS = `server_id, kind, status, audience_bucket, note,
  twitch_or_kick, created_at, decided_at`;

function toEntry(row: WaitlistRow): WatchPartyWaitlistEntry {
  return {
    serverId: row.server_id,
    kind: row.kind,
    status: row.status,
    audienceBucket: row.audience_bucket,
    note: row.note,
    streamChannel: row.twitch_or_kick,
    createdAt: row.created_at.toISOString(),
    decidedAt: row.decided_at ? row.decided_at.toISOString() : null,
  };
}

/**
 * Who may ASK for a server: the owner, or anybody holding MANAGE_CHANNELS or
 * MANAGE_SERVER there. A watch party lives in a channel of its own, and the
 * person asking is the person who would set it up; everybody else registers
 * interest, which is counted and never acted on.
 */
async function canRequestFor(serverId: string, userId: string): Promise<boolean> {
  const role = await getMemberRole(serverId, userId);
  if (!role) {
    return false;
  }
  if (role === "owner" || role === "admin") {
    return true;
  }
  return (
    (await memberHasPermission(serverId, userId, Permission.MANAGE_CHANNELS)) ||
    (await memberHasPermission(serverId, userId, Permission.MANAGE_SERVER))
  );
}

/** 404 for a non-member, same as every other server route. */
async function requireMember(serverId: string, userId: string): Promise<void> {
  if (!(await getMemberRole(serverId, userId))) {
    throw new HttpError(404, "Server not found");
  }
}

async function watchPartyAvailableFor(serverId: string): Promise<boolean> {
  return resolveLiveHlsForServer(serverId, await liveHlsServerOverride(serverId));
}

async function readEntry(
  userId: string,
  serverId: string | null,
): Promise<WatchPartyWaitlistEntry | null> {
  const result = await getPool().query<WaitlistRow>(
    serverId
      ? `SELECT ${ENTRY_COLUMNS} FROM watch_party_waitlist
          WHERE server_id = $2 AND user_id = $1`
      : `SELECT ${ENTRY_COLUMNS} FROM watch_party_waitlist
          WHERE server_id IS NULL AND user_id = $1`,
    serverId ? [userId, serverId] : [userId],
  );
  const row = result.rows[0];
  return row ? toEntry(row) : null;
}

/** `GET /api/watch-party/waitlist?serverId=`. Only ever the caller's own row. */
export async function getWatchPartyWaitlistState(
  userId: string,
  serverId: string | null,
): Promise<WatchPartyWaitlistState> {
  if (serverId) {
    await requireMember(serverId, userId);
  }
  const [canRequest, available, entry] = await Promise.all([
    serverId ? canRequestFor(serverId, userId) : Promise.resolve(false),
    serverId ? watchPartyAvailableFor(serverId) : Promise.resolve(false),
    readEntry(userId, serverId),
  ]);
  return {
    campaign: watchPartyWaitlistCampaignEnabled(),
    canRequest,
    available,
    entry,
  };
}

/**
 * Join, or update what you told us. One row per person per server; a second
 * submit edits the first rather than failing, which is what a person who
 * picked the wrong audience range expects.
 *
 * THE STATUS NEVER MOVES FROM HERE. A declined row stays declined and an
 * approved one stays approved; only the operator decides. A member who was
 * later made a moderator is promoted from `interest` to `request` on their
 * next submit, and never the other way: a request somebody made is not
 * withdrawn because a role changed under them.
 */
export async function joinWatchPartyWaitlist(
  userId: string,
  input: {
    serverId: string | null;
    audienceBucket: WatchPartyAudienceBucket | null;
    note: string | null;
    streamChannel: string | null;
  },
): Promise<WatchPartyWaitlistEntry> {
  if (!watchPartyWaitlistCampaignEnabled()) {
    throw new HttpError(404, "Not found");
  }
  let kind: WatchPartyWaitlistKind = "interest";
  if (input.serverId) {
    await requireMember(input.serverId, userId);
    if (await watchPartyAvailableFor(input.serverId)) {
      throw new HttpError(409, "Watch parties are already on for this server");
    }
    kind = (await canRequestFor(input.serverId, userId)) ? "request" : "interest";
  }
  if (kind === "request" && !input.audienceBucket) {
    throw new HttpError(400, "Pick roughly how many people would watch");
  }

  const pool = getPool();
  const values = [
    input.serverId,
    userId,
    kind,
    input.audienceBucket,
    input.note,
    input.streamChannel,
  ];
  const result = input.serverId
    ? await pool.query<WaitlistRow>(
        `INSERT INTO watch_party_waitlist
           (server_id, user_id, kind, audience_bucket, note, twitch_or_kick)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (server_id, user_id) WHERE server_id IS NOT NULL
         DO UPDATE SET
           kind = CASE WHEN watch_party_waitlist.kind = 'request'
                       THEN 'request' ELSE EXCLUDED.kind END,
           audience_bucket = COALESCE(EXCLUDED.audience_bucket,
                                      watch_party_waitlist.audience_bucket),
           note = EXCLUDED.note,
           twitch_or_kick = EXCLUDED.twitch_or_kick,
           updated_at = NOW()
         RETURNING ${ENTRY_COLUMNS}, (xmax = 0) AS inserted`,
        values,
      )
    : await pool.query<WaitlistRow>(
        `INSERT INTO watch_party_waitlist
           (server_id, user_id, kind, audience_bucket, note, twitch_or_kick)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (user_id) WHERE server_id IS NULL
         DO UPDATE SET
           audience_bucket = COALESCE(EXCLUDED.audience_bucket,
                                      watch_party_waitlist.audience_bucket),
           note = EXCLUDED.note,
           twitch_or_kick = EXCLUDED.twitch_or_kick,
           updated_at = NOW()
         RETURNING ${ENTRY_COLUMNS}, (xmax = 0) AS inserted`,
        values,
      );
  const row = result.rows[0] as WaitlistRow & { inserted: boolean };
  if (row.inserted) {
    logEvent("watchParty.waitlistJoined", {
      serverId: input.serverId,
      kind: row.kind,
      audienceBucket: row.audience_bucket,
    });
  }
  return toEntry(row);
}

/**
 * Servers the caller waited for that the operator has switched on, and whose
 * "liberado" card they have not dismissed. Only servers they are still a
 * member of: a person who left is not told about a room they are no longer in.
 */
export async function listUnseenWatchPartyApprovals(
  userId: string,
): Promise<WatchPartyWaitlistApproval[]> {
  const result = await getPool().query<{
    server_id: string;
    name: string;
    kind: WatchPartyWaitlistKind;
    decided_at: Date;
  }>(
    `SELECT w.server_id, s.name, w.kind, w.decided_at
       FROM watch_party_waitlist w
       JOIN servers s ON s.id = w.server_id
       JOIN server_members m ON m.server_id = w.server_id AND m.user_id = w.user_id
      WHERE w.user_id = $1 AND w.status = 'approved' AND w.seen_at IS NULL
      ORDER BY w.decided_at DESC
      LIMIT 10`,
    [userId],
  );
  return result.rows.map((row) => ({
    serverId: row.server_id,
    serverName: row.name,
    kind: row.kind,
    decidedAt: row.decided_at.toISOString(),
  }));
}

export async function ackWatchPartyApproval(
  userId: string,
  serverId: string,
): Promise<void> {
  await getPool().query(
    `UPDATE watch_party_waitlist SET seen_at = NOW()
      WHERE user_id = $1 AND server_id = $2 AND status = 'approved'
        AND seen_at IS NULL`,
    [userId, serverId],
  );
}

// ------------------------------------------------------------ approval

const APPROVED_TOPIC = "watch-party.waitlist-approved";

interface ApprovedEvent {
  serverId: string;
  serverName: string;
  userIds: string[];
}

/** The local half: this process's sockets for each approved person. */
function deliverApproved(event: ApprovedEvent): void {
  const recipients = new Set(event.userIds);
  const frame = JSON.stringify({
    type: "watch-party-waitlist-approved",
    serverId: event.serverId,
    serverName: event.serverName,
  });
  forEachAuthenticatedSocket((socket, user) => {
    if (socket.readyState === 1 && recipients.has(user.id)) {
      socket.send(frame);
    }
  });
}

subscribeToCluster(APPROVED_TOPIC, (data) => {
  const event = data as Partial<ApprovedEvent> | null;
  if (
    !event ||
    typeof event.serverId !== "string" ||
    typeof event.serverName !== "string" ||
    !Array.isArray(event.userIds)
  ) {
    return;
  }
  deliverApproved({
    serverId: event.serverId,
    serverName: event.serverName,
    userIds: event.userIds.filter((id): id is string => typeof id === "string"),
  });
});

/**
 * Every waiting row of a server, approved at once, and the people behind them
 * told: a socket frame now, a push for the ones with a subscription, and the
 * durable row `listUnseenWatchPartyApprovals` reads for anybody offline.
 *
 * Called by `setServerLiveHls` when a write leaves `live_hls_enabled` TRUE,
 * which is the dashboard's "Ativar" and its plain "ligar". Idempotent: a
 * second flip finds nothing waiting and tells nobody twice.
 */
export async function approveWatchPartyWaitlist(
  serverId: string,
): Promise<number> {
  const result = await getPool().query<{ user_id: string; name: string }>(
    `UPDATE watch_party_waitlist w
        SET status = 'approved', decided_at = NOW(), updated_at = NOW()
       FROM servers s
      WHERE w.server_id = $1 AND s.id = w.server_id AND w.status = 'waiting'
      RETURNING w.user_id, s.name`,
    [serverId],
  );
  if (result.rows.length === 0) {
    return 0;
  }
  const event: ApprovedEvent = {
    serverId,
    serverName: result.rows[0]!.name,
    userIds: result.rows.map((row) => row.user_id),
  };
  deliverApproved(event);
  if (isBusEnabled()) {
    publishToCluster(APPROVED_TOPIC, event);
  }
  pushWatchPartyWaitlistApproved(event);
  logEvent("watchParty.waitlistApproved", {
    serverId,
    people: event.userIds.length,
  });
  return event.userIds.length;
}

/** The dashboard's "Recusar": the server's waiting rows, declined. Silent. */
export async function declineWatchPartyWaitlist(serverId: string): Promise<number> {
  const result = await getPool().query(
    `UPDATE watch_party_waitlist
        SET status = 'declined', decided_at = NOW(), updated_at = NOW()
      WHERE server_id = $1 AND status = 'waiting'`,
    [serverId],
  );
  logEvent("watchParty.waitlistDeclined", {
    serverId,
    rows: result.rowCount ?? 0,
  });
  return result.rowCount ?? 0;
}

// ------------------------------------------------------------ operator

export const OPERATOR_WAITLIST_PATH = "/api/admin/watch-party-waitlist";
export const OPERATOR_WAITLIST_DECLINE_PATH =
  "/api/admin/watch-party-waitlist/decline";

export const declineWatchPartyWaitlistSchema = z.object({
  serverId: z.string().uuid(),
});

export interface OperatorWaitlistRequest {
  username: string;
  audienceBucket: WatchPartyAudienceBucket | null;
  note: string | null;
  streamChannel: string | null;
  createdAt: string;
}

export interface OperatorWaitlistServer {
  serverId: string;
  name: string;
  memberCount: number;
  isCommunity: boolean;
  /** `servers.live_hls_enabled` and `live_hls_ll_enabled`, as the operator left them. */
  liveHlsOverride: boolean | null;
  liveHlsLlOverride: boolean | null;
  /** The status most of its rows are in: waiting until somebody decided. */
  status: WatchPartyWaitlistStatus;
  requests: OperatorWaitlistRequest[];
  /** Members who said they would watch. A count, never a list of names. */
  interest: number;
  /** Every row's audience range, requests and interest together. */
  buckets: Partial<Record<WatchPartyAudienceBucket, number>>;
  firstAt: string;
  lastAt: string;
}

export interface OperatorWaitlist {
  servers: OperatorWaitlistServer[];
  /** People who said they would watch with no server to ask for. */
  serverless: number;
  totals: { waiting: number; approved: number; declined: number };
}

/**
 * The dashboard's "Lista de espera": one line per server, the biggest waiting
 * rooms first. Requests carry the requester's name, their note and their
 * channel, because the operator may want to look before switching a room on;
 * interest is only ever a count.
 */
export async function listWatchPartyWaitlistForOperator(): Promise<OperatorWaitlist> {
  const pool = getPool();
  const [rows, serverless, totals] = await Promise.all([
    pool.query<{
      server_id: string;
      name: string;
      is_community: boolean;
      live_hls_enabled: boolean | null;
      live_hls_ll_enabled: boolean | null;
      member_count: string;
      kind: WatchPartyWaitlistKind;
      status: WatchPartyWaitlistStatus;
      audience_bucket: WatchPartyAudienceBucket | null;
      note: string | null;
      twitch_or_kick: string | null;
      created_at: Date;
      username: string;
      discriminator: string | null;
    }>(
      `WITH listed AS (
         SELECT DISTINCT server_id FROM watch_party_waitlist
          WHERE server_id IS NOT NULL
       ), ranked AS (
         SELECT l.server_id,
                (SELECT COUNT(*) FROM server_members m
                  WHERE m.server_id = l.server_id) AS member_count
           FROM listed l
          ORDER BY member_count DESC
          LIMIT 200
       )
       SELECT r.server_id, s.name, s.is_community, s.live_hls_enabled,
              s.live_hls_ll_enabled, r.member_count::text AS member_count,
              w.kind, w.status, w.audience_bucket, w.note, w.twitch_or_kick,
              w.created_at, u.username, u.discriminator
         FROM ranked r
         JOIN servers s ON s.id = r.server_id
         JOIN watch_party_waitlist w ON w.server_id = r.server_id
         JOIN users u ON u.id = w.user_id
        ORDER BY r.member_count DESC, s.name ASC, w.created_at ASC`,
    ),
    pool.query<{ n: string }>(
      `SELECT COUNT(*)::text AS n FROM watch_party_waitlist WHERE server_id IS NULL`,
    ),
    pool.query<{ status: WatchPartyWaitlistStatus; n: string }>(
      `SELECT status, COUNT(*)::text AS n FROM watch_party_waitlist GROUP BY status`,
    ),
  ]);

  const byServer = new Map<string, OperatorWaitlistServer>();
  const statusCounts = new Map<string, Record<WatchPartyWaitlistStatus, number>>();
  for (const row of rows.rows) {
    let entry = byServer.get(row.server_id);
    const at = row.created_at.toISOString();
    if (!entry) {
      entry = {
        serverId: row.server_id,
        name: row.name,
        memberCount: Number(row.member_count),
        isCommunity: row.is_community,
        liveHlsOverride: row.live_hls_enabled,
        liveHlsLlOverride: row.live_hls_ll_enabled,
        status: "waiting",
        requests: [],
        interest: 0,
        buckets: {},
        firstAt: at,
        lastAt: at,
      };
      byServer.set(row.server_id, entry);
      statusCounts.set(row.server_id, { waiting: 0, approved: 0, declined: 0 });
    }
    statusCounts.get(row.server_id)![row.status] += 1;
    if (row.kind === "request") {
      entry.requests.push({
        username: row.discriminator
          ? `${row.username}#${row.discriminator}`
          : row.username,
        audienceBucket: row.audience_bucket,
        note: row.note,
        streamChannel: row.twitch_or_kick,
        createdAt: at,
      });
    } else {
      entry.interest += 1;
    }
    if (row.audience_bucket) {
      entry.buckets[row.audience_bucket] =
        (entry.buckets[row.audience_bucket] ?? 0) + 1;
    }
    if (at < entry.firstAt) {
      entry.firstAt = at;
    }
    if (at > entry.lastAt) {
      entry.lastAt = at;
    }
  }
  for (const [serverId, counts] of statusCounts) {
    const entry = byServer.get(serverId)!;
    entry.status =
      counts.waiting > 0 ? "waiting" : counts.approved > 0 ? "approved" : "declined";
  }

  const totalMap = new Map(totals.rows.map((row) => [row.status, Number(row.n)]));
  // Waiting rooms first, then the ones already decided, each biggest first.
  const servers = [...byServer.values()].sort((a, b) => {
    const rank = (s: OperatorWaitlistServer) => (s.status === "waiting" ? 0 : 1);
    return rank(a) - rank(b) || b.memberCount - a.memberCount;
  });
  return {
    servers,
    serverless: Number(serverless.rows[0]?.n ?? 0),
    totals: {
      waiting: totalMap.get("waiting") ?? 0,
      approved: totalMap.get("approved") ?? 0,
      declined: totalMap.get("declined") ?? 0,
    },
  };
}

/** `watchPartyWaitlist` on `GET /api/admin/metrics`. */
export interface WatchPartyWaitlistMetrics {
  joinsTotal: number;
  joins7d: number;
  requestsTotal: number;
  interestTotal: number;
  /** Servers with at least one row still waiting. */
  serversWaiting: number;
  approvedTotal: number;
}

export async function watchPartyWaitlistMetrics(): Promise<WatchPartyWaitlistMetrics> {
  const result = await getPool().query<{
    joins_total: string;
    joins_7d: string;
    requests_total: string;
    interest_total: string;
    servers_waiting: string;
    approved_total: string;
  }>(
    `SELECT COUNT(*)::text AS joins_total,
            COUNT(*) FILTER (WHERE created_at > NOW() - INTERVAL '7 days')::text AS joins_7d,
            COUNT(*) FILTER (WHERE kind = 'request')::text AS requests_total,
            COUNT(*) FILTER (WHERE kind = 'interest')::text AS interest_total,
            COUNT(DISTINCT server_id) FILTER (WHERE status = 'waiting')::text AS servers_waiting,
            COUNT(*) FILTER (WHERE status = 'approved')::text AS approved_total
       FROM watch_party_waitlist`,
  );
  const row = result.rows[0];
  return {
    joinsTotal: Number(row?.joins_total ?? 0),
    joins7d: Number(row?.joins_7d ?? 0),
    requestsTotal: Number(row?.requests_total ?? 0),
    interestTotal: Number(row?.interest_total ?? 0),
    serversWaiting: Number(row?.servers_waiting ?? 0),
    approvedTotal: Number(row?.approved_total ?? 0),
  };
}

