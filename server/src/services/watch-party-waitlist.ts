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
  // THE RACE WITH THE OPERATOR'S FLIP. The availability check above and this
  // INSERT are two statements, and "Ativar" can land between them: its
  // approval sweep ran before this row existed, so the row would sit
  // `waiting` on a server that is on. Asking again afterwards closes it: if
  // the server is on now, approving is idempotent and tells this person the
  // same way the sweep would have.
  if (input.serverId && row.status === "waiting" && (await watchPartyAvailableFor(input.serverId))) {
    await approveWatchPartyWaitlist(input.serverId);
    const settled = await readEntry(userId, input.serverId);
    if (settled) {
      return settled;
    }
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

/**
 * People per bus frame and per push lookup. 150 uuids is about 5.6 KB of
 * JSON, which keeps a frame under NOTIFY's 8000-byte payload with room for
 * the envelope and a long server name.
 */
const APPROVAL_BATCH = 150;

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
  const serverName = result.rows[0]!.name;
  const userIds = result.rows.map((row) => row.user_id);
  // In bounded batches: a big community's waitlist can be thousands of
  // people, and one bus frame or one push lookup carrying all of them is an
  // oversized frame (the Postgres bus spills anything past NOTIFY's 8000
  // bytes to a table) and an unbounded `ANY($1)`. The durable half is already
  // written above, so a batch that fails to deliver costs a live notice,
  // never the approval.
  //
  // This machine's own sockets are walked ONCE, with every recipient: that is
  // an in-memory set lookup per socket and has no payload to bound, while a
  // walk per batch would be one full scan of the socket map per 150 people.
  try {
    deliverApproved({ serverId, serverName, userIds });
  } catch (error) {
    console.error("[waitlist] approval notice failed:", error);
  }
  for (let start = 0; start < userIds.length; start += APPROVAL_BATCH) {
    const event: ApprovedEvent = {
      serverId,
      serverName,
      userIds: userIds.slice(start, start + APPROVAL_BATCH),
    };
    try {
      if (isBusEnabled()) {
        publishToCluster(APPROVED_TOPIC, event);
      }
      pushWatchPartyWaitlistApproved(event);
    } catch (error) {
      console.error("[waitlist] approval notice failed:", error);
    }
  }
  logEvent("watchParty.waitlistApproved", {
    serverId,
    people: userIds.length,
  });
  return userIds.length;
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
  /** The newest requests, at most `OPERATOR_WAITLIST_REQUESTS_PER_SERVER`. */
  requests: OperatorWaitlistRequest[];
  /** Every request this server has, which `requests` may be a slice of. */
  requestCount: number;
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

/** Servers on the dashboard's list, and requests shown per server. */
export const OPERATOR_WAITLIST_SERVER_LIMIT = 200;
export const OPERATOR_WAITLIST_REQUESTS_PER_SERVER = 20;

/**
 * The dashboard's "Lista de espera": one line per server, waiting rooms first,
 * the biggest first within each.
 *
 * BOUNDED BY CONSTRUCTION. Interest, the status counts and the audience
 * histogram are aggregated in SQL, so a community with thousands of members
 * saying "eu também quero" is one row here, not thousands. Requests carry
 * the requester's name, their note and their channel because the operator
 * may want to look before switching a room on, and only the newest
 * `OPERATOR_WAITLIST_REQUESTS_PER_SERVER` of them come back, with the full
 * count beside them.
 */
export async function listWatchPartyWaitlistForOperator(): Promise<OperatorWaitlist> {
  const pool = getPool();
  const [aggregates, serverless, totals] = await Promise.all([
    pool.query<{
      server_id: string;
      name: string;
      is_community: boolean;
      live_hls_enabled: boolean | null;
      live_hls_ll_enabled: boolean | null;
      member_count: string;
      waiting: string;
      approved: string;
      interest: string;
      requests: string;
      buckets: Record<string, number> | null;
      first_at: Date;
      last_at: Date;
    }>(
      `WITH per_server AS (
         SELECT server_id,
                COUNT(*) FILTER (WHERE status = 'waiting') AS waiting,
                COUNT(*) FILTER (WHERE status = 'approved') AS approved,
                COUNT(*) FILTER (WHERE kind = 'interest') AS interest,
                COUNT(*) FILTER (WHERE kind = 'request') AS requests,
                MIN(created_at) AS first_at,
                MAX(created_at) AS last_at
           FROM watch_party_waitlist
          WHERE server_id IS NOT NULL
          GROUP BY server_id
       ), histogram AS (
         SELECT server_id, jsonb_object_agg(audience_bucket, n) AS buckets
           FROM (SELECT server_id, audience_bucket, COUNT(*)::int AS n
                   FROM watch_party_waitlist
                  WHERE server_id IS NOT NULL AND audience_bucket IS NOT NULL
                  GROUP BY server_id, audience_bucket) b
          GROUP BY server_id
       )
       SELECT p.server_id, s.name, s.is_community, s.live_hls_enabled,
              s.live_hls_ll_enabled,
              (SELECT COUNT(*) FROM server_members m WHERE m.server_id = p.server_id)::text
                AS member_count,
              p.waiting::text, p.approved::text, p.interest::text, p.requests::text,
              h.buckets, p.first_at, p.last_at
         FROM per_server p
         JOIN servers s ON s.id = p.server_id
         LEFT JOIN histogram h ON h.server_id = p.server_id
        ORDER BY (p.waiting > 0) DESC,
                 (SELECT COUNT(*) FROM server_members m WHERE m.server_id = p.server_id) DESC,
                 s.name ASC
        LIMIT ${OPERATOR_WAITLIST_SERVER_LIMIT}`,
    ),
    pool.query<{ n: string }>(
      `SELECT COUNT(*)::text AS n FROM watch_party_waitlist WHERE server_id IS NULL`,
    ),
    pool.query<{ status: WatchPartyWaitlistStatus; n: string }>(
      `SELECT status, COUNT(*)::text AS n FROM watch_party_waitlist GROUP BY status`,
    ),
  ]);

  const serverIds = aggregates.rows.map((row) => row.server_id);
  const requests =
    serverIds.length === 0
      ? { rows: [] }
      : await pool.query<{
          server_id: string;
          audience_bucket: WatchPartyAudienceBucket | null;
          note: string | null;
          twitch_or_kick: string | null;
          created_at: Date;
          username: string;
          discriminator: string | null;
        }>(
          `SELECT r.server_id, r.audience_bucket, r.note, r.twitch_or_kick,
                  r.created_at, u.username, u.discriminator
             FROM (SELECT w.*,
                          ROW_NUMBER() OVER (PARTITION BY w.server_id
                                             ORDER BY w.created_at DESC) AS rn
                     FROM watch_party_waitlist w
                    WHERE w.server_id = ANY($1::uuid[]) AND w.kind = 'request') r
             JOIN users u ON u.id = r.user_id
            WHERE r.rn <= ${OPERATOR_WAITLIST_REQUESTS_PER_SERVER}
            ORDER BY r.server_id, r.created_at ASC`,
          [serverIds],
        );
  const requestsByServer = new Map<string, OperatorWaitlistRequest[]>();
  for (const row of requests.rows) {
    const list = requestsByServer.get(row.server_id) ?? [];
    list.push({
      username: row.discriminator
        ? `${row.username}#${row.discriminator}`
        : row.username,
      audienceBucket: row.audience_bucket,
      note: row.note,
      streamChannel: row.twitch_or_kick,
      createdAt: row.created_at.toISOString(),
    });
    requestsByServer.set(row.server_id, list);
  }

  const servers: OperatorWaitlistServer[] = aggregates.rows.map((row) => ({
    serverId: row.server_id,
    name: row.name,
    memberCount: Number(row.member_count),
    isCommunity: row.is_community,
    liveHlsOverride: row.live_hls_enabled,
    liveHlsLlOverride: row.live_hls_ll_enabled,
    status:
      Number(row.waiting) > 0
        ? "waiting"
        : Number(row.approved) > 0
          ? "approved"
          : "declined",
    requests: requestsByServer.get(row.server_id) ?? [],
    requestCount: Number(row.requests),
    interest: Number(row.interest),
    buckets: (row.buckets ?? {}) as OperatorWaitlistServer["buckets"],
    firstAt: row.first_at.toISOString(),
    lastAt: row.last_at.toISOString(),
  }));

  const totalMap = new Map(totals.rows.map((row) => [row.status, Number(row.n)]));
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

