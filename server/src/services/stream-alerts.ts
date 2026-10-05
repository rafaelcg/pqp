import {
  Permission,
  STREAM_ALERT_DEFAULT_MAX_MEMBERS,
  STREAM_ALERT_MAX_RECIPIENTS,
  STREAM_START_CHANNEL_COOLDOWN_MS,
  STREAM_START_STABLE_MS,
  hasPermission,
  streamAlertDefault,
  streamAlertEnabled,
  type StreamAlertSetting,
  type StreamStartedMessage,
  type UserPreferences,
} from "@pqp/shared";
import { getPool } from "../db.js";
import {
  isBusConnected,
  isBusEnabled,
  publishToCluster,
  subscribeToCluster,
} from "../lib/bus.js";
import { flagServerOverrides, isEnabled } from "../lib/flags.js";
import { logEvent } from "../lib/log.js";
import { forEachSocketOfUser } from "../ws/sockets.js";
import { computeMemberPermissionsBulk } from "./permissions.js";
import { pushStreamStarted, resolvePushLevel } from "./push.js";
import { getServerVoiceProfile } from "./servers.js";

/**
 * "Alberto começou a transmitir em #filminho": the start-of-stream notice.
 * `docs/plans/WATCH_NOW.md` section 3 is the spec, this file is the decision.
 *
 * IT IS THE ONE FEATURE HERE THAT CAN INTERRUPT PEOPLE, so every limit is a
 * line of code with a counter beside it rather than a promise in a doc:
 *
 *  - the share must stay on for `STREAM_START_STABLE_MS` (20 s) before anybody
 *    hears about it, and one that stops inside the window costs nobody a thing;
 *  - at most one notice per channel per `STREAM_START_CHANNEL_COOLDOWN_MS`;
 *  - a server above `STREAM_ALERT_DEFAULT_MAX_MEMBERS` members, and every
 *    community, notifies NOBODY who did not turn it on for that server, and
 *    nobody past `STREAM_ALERT_MAX_RECIPIENTS` however many did.
 *
 * NOTHING HERE RUNS PER SOCKET ON THE HOT PATH. `noteStreamStarted` is called
 * from the `set-sharing-screen` handler, reads an in-process flag snapshot and
 * arms one timer. The reads, the decision and the one walk over recipients'
 * sockets all happen 20 s later, off the handler, once per notice.
 *
 * EXACTLY ONCE ACROSS MACHINES. The sharer's socket is on one machine, which
 * holds the timer, but two machines can both see one share (the sharer
 * reconnects to the other one inside the window and re-declares it), so the
 * timer is not the arbiter. The claim is: one upsert on `stream_alert_channels`
 * that only succeeds when the channel's last notice is older than the cooldown
 * (and, for a party, was not for this same session). Whoever it succeeds for
 * decides the recipients, delivers to its own sockets, relays
 * `{ event, userIds }` on the bus so every other machine delivers to ITS
 * sockets, and sends push from here only: a phone has no socket on any machine,
 * so a push sent per machine would be a push per machine.
 *
 * FAILS QUIET. A process that dies inside the 20 s window sends nothing, which
 * is the right way for this to fail, and nothing thrown out of a timer may
 * reach the process (the unhandled-rejection pitfall in CLAUDE.md).
 */

// ------------------------------------------------------------------ counters

export interface StreamAlertMetrics {
  /** Starts that armed a timer. */
  starts: number;
  /** Starts, or fires, where the flag was off for that server. */
  flagOff: number;
  /** A share that was gone (or never stable) when the 20 s were up. */
  debounced: number;
  /** A fire that lost the claim to the cooldown or to the other machine. */
  cooldown: number;
  /** Notices that won the claim and therefore decided recipients. */
  claimed: number;
  /** People told, summed over notices. */
  recipients: number;
  skipped: {
    sharer: number;
    inRoom: number;
    dnd: number;
    muted: number;
    blocked: number;
    noAccess: number;
    optedOut: number;
    overCap: number;
  };
  /** Sockets that were handed the frame on this process. */
  delivered: number;
  /** Notices this process published to the other machines. */
  relayed: number;
  /** People a push was attempted for. */
  pushed: number;
  /** Anything that threw inside the pipeline, and timers refused for lack of room. */
  failures: number;
  /** The slowest claim-to-delivered decision on this process, in ms. */
  decisionMsMax: number;
}

function emptyMetrics(): StreamAlertMetrics {
  return {
    starts: 0,
    flagOff: 0,
    debounced: 0,
    cooldown: 0,
    claimed: 0,
    recipients: 0,
    skipped: {
      sharer: 0,
      inRoom: 0,
      dnd: 0,
      muted: 0,
      blocked: 0,
      noAccess: 0,
      optedOut: 0,
      overCap: 0,
    },
    delivered: 0,
    relayed: 0,
    pushed: 0,
    failures: 0,
    decisionMsMax: 0,
  };
}

let metrics = emptyMetrics();

/** For `GET /api/admin/metrics`: a copy, so a caller cannot move a counter. */
export function streamAlertMetrics(): StreamAlertMetrics {
  return { ...metrics, skipped: { ...metrics.skipped } };
}

// ------------------------------------------------------------- the room seam

/**
 * What the stability check and the "already in the room" exclusion need from
 * the voice layer, handed in rather than imported: `ws/voice.ts` imports this
 * module to report a share, and an import the other way would be a cycle.
 * `null` means the room is not known to be occupied anywhere.
 */
export interface StreamAlertRoom {
  /** Everyone seated, on any machine. */
  userIds: string[];
  /** The seated people whose screen share is on. */
  sharerUserIds: string[];
}

export type StreamAlertRoomReader = (
  channelId: string,
) => Promise<StreamAlertRoom | null>;

let readRoom: StreamAlertRoomReader | null = null;

export function setStreamAlertRoomReader(
  reader: StreamAlertRoomReader | null,
): void {
  readRoom = reader;
}

// ------------------------------------------------------------------ the arm

export interface StreamStart {
  channelId: string;
  /** The person whose share (or whose party) this is. */
  sharerUserId: string;
  /** The name the room already shows for them. Nickname is applied at fire time. */
  sharerName: string;
  kind: "voice" | "party";
  /**
   * What the notice is for, when the thing has an identity of its own: a watch
   * party's session id. A second broadcast about the same party can then never
   * claim again after the cooldown. Absent for a plain share.
   */
  startKey?: string;
  /** A party's own name, shown instead of the (internal) channel name. */
  partyName?: string;
}

interface Armed extends StreamStart {
  timer: ReturnType<typeof setTimeout>;
  startedAt: number;
  /** This notice already had its one second attempt (`fire`'s catch). */
  retried?: boolean;
}

/**
 * ONE retry, a few seconds later, for a notice whose decision threw (a pooled
 * connection that dropped, a statement that timed out). Not a loop: a database
 * that is down for longer is the breaker's business, and a notice about a
 * stream that STARTED is wrong a minute later.
 */
export const STREAM_ALERT_RETRY_MS = 5_000;

/**
 * Bounded: one entry per channel with a share inside its debounce window. The
 * cap is a ceiling on a process that is somehow told about thousands of
 * channels at once, not a number anyone reaches; past it a start is refused
 * (counted in `failures`) rather than growing without limit.
 */
const MAX_ARMED = 2_000;
const armed = new Map<string, Armed>();

/**
 * Work this module has started and not finished (a notice's pipeline, a claim
 * sweep). Only a test asks for it (`whenStreamAlertsIdle`): a suite that
 * truncates tables between cases must not do it under a statement the case
 * before it left running, which is a deadlock and not a failure of anything
 * here.
 */
const inflight = new Set<Promise<unknown>>();

function track<T>(work: Promise<T>): Promise<T> {
  inflight.add(work);
  const forget = () => {
    inflight.delete(work);
  };
  work.then(forget, forget);
  return work;
}

/** Test seam: resolves once nothing this module started is still running. */
export async function whenStreamAlertsIdle(): Promise<void> {
  while (inflight.size > 0) {
    await Promise.allSettled([...inflight]);
  }
}

/**
 * Whether the notice could possibly be on for SOME server: the global answer, or
 * any per-server override set on. The hot path does not know the server (a voice
 * peer carries its channel, not its server), so this is the cheap pre-filter; the
 * exact per-server read happens at fire time.
 */
function noticesPossible(): boolean {
  if (isEnabled("stream_start_notifications")) {
    return true;
  }
  for (const on of flagServerOverrides("stream_start_notifications").values()) {
    if (on) {
      return true;
    }
  }
  return false;
}

/**
 * A share (or a watch party) just began. O(1): one flag read, one map write,
 * one timer. Safe to call from a socket handler, and it never throws.
 */
export function noteStreamStarted(start: StreamStart): void {
  try {
    if (!noticesPossible()) {
      metrics.flagOff += 1;
      return;
    }
    const existing = armed.get(start.channelId);
    if (existing) {
      // A second person sharing in a room already inside its window changes
      // nothing (one notice per channel is the rule), and a repeated call for
      // the same party is the same start.
      if (start.kind !== "party" || existing.startKey === start.startKey) {
        return;
      }
      clearTimeout(existing.timer);
      armed.delete(start.channelId);
    }
    if (armed.size >= MAX_ARMED) {
      metrics.failures += 1;
      return;
    }
    const timer = setTimeout(() => {
      void track(fire(start.channelId)).catch((error: unknown) => {
        metrics.failures += 1;
        logEvent("streamAlert.failed", {
          channelId: start.channelId,
          error: error instanceof Error ? error.message : String(error),
        });
      });
    }, STREAM_START_STABLE_MS);
    // A pending notice must never be why a process refuses to exit.
    timer.unref?.();
    armed.set(start.channelId, { ...start, timer, startedAt: Date.now() });
    metrics.starts += 1;
  } catch (error) {
    metrics.failures += 1;
    logEvent("streamAlert.armFailed", {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * The share ended before it was stable: nobody is told. Called when a peer
 * stops sharing or leaves; a sharer who is not the one armed changes nothing.
 */
export function noteStreamStopped(channelId: string, sharerUserId?: string): void {
  const pending = armed.get(channelId);
  if (!pending) {
    return;
  }
  // A watch party's start is its going live, and "still on" for it is the
  // session's own state (`stillStreaming` asks the table), not a screen share:
  // the host's share restarting inside the window, or a guest's stopping, is
  // not the party ending.
  if (pending.kind === "party") {
    return;
  }
  if (sharerUserId && pending.sharerUserId !== sharerUserId) {
    return;
  }
  clearTimeout(pending.timer);
  armed.delete(channelId);
  metrics.debounced += 1;
}

/** Test seam, and what a graceful shutdown would use. */
export function resetStreamAlertsForTests(): void {
  for (const pending of armed.values()) {
    clearTimeout(pending.timer);
  }
  armed.clear();
  metrics = emptyMetrics();
  relayedNotices.clear();
  readRoom = null;
  lastSweepAt = 0;
  sweeping = false;
}

export function armedStreamAlertCount(): number {
  return armed.size;
}

// ------------------------------------------------------------------ the fire

interface ChannelContext {
  id: string;
  name: string;
  type: string;
  parent_id: string | null;
  server_id: string;
  server_name: string;
  sharer_name: string | null;
}

async function loadChannelContext(
  channelId: string,
  sharerUserId: string,
): Promise<ChannelContext | null> {
  // A conversation has no server and no row in the join, which is what keeps a
  // DM call from ever being a notice, whoever asks.
  const result = await getPool().query<ChannelContext>(
    `SELECT c.id, c.name, c.type, c.parent_id, c.server_id, s.name AS server_name,
            COALESCE(sm.nickname, u.display_name) AS sharer_name
       FROM channels c
       JOIN servers s ON s.id = c.server_id
       LEFT JOIN server_members sm ON sm.server_id = c.server_id AND sm.user_id = $2
       LEFT JOIN users u ON u.id = $2
      WHERE c.id = $1`,
    [channelId, sharerUserId],
  );
  return result.rows[0] ?? null;
}

/**
 * The atomic claim. One statement, so two machines racing on one share cannot
 * both win: the row either is older than the cooldown (and this call moves it
 * forward) or is not (and nothing is returned). `start_key` closes the other
 * door: a watch party that stays live past the cooldown must not claim again
 * for itself.
 */
export async function claimStreamAlert(
  channelId: string,
  startKey: string | null,
  cooldownMs: number = STREAM_START_CHANNEL_COOLDOWN_MS,
): Promise<boolean> {
  const result = await getPool().query<{ channel_id: string }>(
    `INSERT INTO stream_alert_channels (channel_id, last_notified_at, start_key)
     VALUES ($1, NOW(), $2)
     ON CONFLICT (channel_id) DO UPDATE
        SET last_notified_at = NOW(), start_key = EXCLUDED.start_key
      WHERE stream_alert_channels.last_notified_at <= NOW() - make_interval(secs => $3::double precision)
        AND (EXCLUDED.start_key IS NULL
             OR stream_alert_channels.start_key IS DISTINCT FROM EXCLUDED.start_key)
     RETURNING channel_id`,
    [channelId, startKey, cooldownMs / 1000],
  );
  return result.rows.length > 0;
}

/**
 * A winning claim also tidies: a row older than a day only records a date. At
 * most once an hour per process and never two at once, so a busy night of
 * notices is not a busy night of deletes; the table holds one row per channel
 * that ever notified, so an hour's delay costs nothing.
 */
const SWEEP_EVERY_MS = 60 * 60_000;
let lastSweepAt = 0;
let sweeping = false;

function sweepOldClaims(now: number = Date.now()): void {
  if (sweeping || now - lastSweepAt < SWEEP_EVERY_MS) {
    return;
  }
  sweeping = true;
  lastSweepAt = now;
  void track(
    getPool()
      .query(
        `DELETE FROM stream_alert_channels
          WHERE last_notified_at < NOW() - INTERVAL '1 day'`,
      )
      .catch(() => {
        // Housekeeping; an hour from now the next winner tries again.
      })
      .finally(() => {
        sweeping = false;
      }),
  );
}

/**
 * Hand a claim back when the decision it paid for never finished, so a
 * transient failure costs the notice one retry and not 30 silent minutes. Safe
 * against the other machine: while the row is inside its cooldown nobody else
 * can claim it, so nothing can have been sent for it.
 */
export async function releaseStreamAlertClaim(channelId: string): Promise<void> {
  await getPool().query(
    `UPDATE stream_alert_channels
        SET last_notified_at = to_timestamp(0), start_key = NULL
      WHERE channel_id = $1`,
    [channelId],
  );
}

async function stillStreaming(
  pending: Armed,
  context: ChannelContext,
): Promise<{ seated: string[] } | null> {
  if (pending.kind === "party") {
    const live = await getPool().query(
      `SELECT 1 FROM channel_sessions WHERE id = $1 AND status = 'live'`,
      [pending.startKey],
    );
    if (live.rowCount === 0) {
      return null;
    }
    // WHO IS SEATED MUST BE KNOWN, not guessed empty: people already in the
    // party's room are the ones this notice must never reach. An EMPTY room is
    // an answer (nobody seated, tell everybody); a reader that is absent or
    // that failed is not, and then, as everywhere in this file, nothing is sent.
    if (!readRoom) {
      return null;
    }
    let room: StreamAlertRoom | null;
    try {
      room = await readRoom(context.id);
    } catch {
      return null;
    }
    return { seated: room?.userIds ?? [] };
  }
  // A plain share: the sharer must still be in the room and still sharing,
  // anywhere in the cluster. Without a reader (a process with no voice layer)
  // nothing can vouch for the share, so nothing is sent.
  if (!readRoom) {
    return null;
  }
  const room = await readRoom(context.id);
  if (!room || !room.sharerUserIds.includes(pending.sharerUserId)) {
    return null;
  }
  return { seated: room.userIds };
}

async function fire(channelId: string): Promise<void> {
  const pending = armed.get(channelId);
  if (!pending) {
    return;
  }
  armed.delete(channelId);

  // Whether the claim row is ours and nothing has been sent for it yet: the
  // only window in which a failure may hand the claim back.
  let claimedUnsent = false;
  try {
    const context = await loadChannelContext(channelId, pending.sharerUserId);
    if (!context) {
      return;
    }
    const serverId = context.server_id;
    // Not a share channel at all: a watch party's room is handled as a party, a
    // voice room as a share, and anything else (a text channel id from a stale
    // timer) is nothing.
    if (
      (pending.kind === "voice" && context.type !== "voice") ||
      (pending.kind === "party" && context.type !== "watch_party")
    ) {
      return;
    }
    if (!isEnabled("stream_start_notifications", { serverId })) {
      metrics.flagOff += 1;
      return;
    }
    const alive = await stillStreaming(pending, context);
    if (!alive) {
      metrics.debounced += 1;
      return;
    }
    if (!(await claimStreamAlert(channelId, pending.startKey ?? null))) {
      metrics.cooldown += 1;
      return;
    }
    claimedUnsent = true;

    const began = Date.now();
    metrics.claimed += 1;
    sweepOldClaims();

    const userIds = await decideStreamAlertRecipients({
      serverId,
      channel: {
        id: context.id,
        type: context.type,
        parent_id: context.parent_id,
      },
      sharerUserId: pending.sharerUserId,
      seatedUserIds: alive.seated,
    });

    const event: StreamAlertEvent = {
      serverId,
      channelId,
      channelName:
        pending.kind === "party" && pending.partyName
          ? pending.partyName
          : context.name,
      serverName: context.server_name,
      sharerName: context.sharer_name ?? pending.sharerName,
      kind: pending.kind,
      startedAt: pending.startedAt,
      userIds,
    };
    metrics.recipients += userIds.length;
    // From here on something may reach a socket, and handing the claim back
    // would turn a failure in the middle of delivery into a duplicate.
    claimedUnsent = false;
    if (userIds.length > 0) {
      notifyStreamStarted(event);
    }
    const took = Date.now() - began;
    if (took > metrics.decisionMsMax) {
      metrics.decisionMsMax = took;
    }
    logEvent("streamAlert.sent", {
      channelId,
      serverId,
      kind: pending.kind,
      recipients: userIds.length,
      ms: took,
    });
  } catch (error) {
    // The claim goes back BEFORE anything is counted or retried: a retry that
    // ran first would meet its own cooldown, and a failure that reads as
    // counted only once the notice is safe to try again is one an operator
    // can act on.
    if (claimedUnsent) {
      await releaseStreamAlertClaim(channelId).catch(() => {
        // The claim stays spent: the 30 minutes are the price of a database
        // that cannot even take this write.
      });
    }
    metrics.failures += 1;
    logEvent("streamAlert.failed", {
      channelId,
      retried: pending.retried === true,
      error: error instanceof Error ? error.message : String(error),
    });
    if (!pending.retried && !armed.has(channelId)) {
      const timer = setTimeout(() => {
        void track(fire(channelId)).catch((again: unknown) => {
          metrics.failures += 1;
          logEvent("streamAlert.failed", {
            channelId,
            retried: true,
            error: again instanceof Error ? again.message : String(again),
          });
        });
      }, STREAM_ALERT_RETRY_MS);
      timer.unref?.();
      armed.set(channelId, { ...pending, retried: true, timer });
    }
  }
}

// ----------------------------------------------------------- the recipients

interface CandidateRow {
  user_id: string;
  status: string | null;
  notifications: UserPreferences["notifications"] | null;
}

export interface StreamAlertDecisionInput {
  serverId: string;
  channel: { id: string; type: string; parent_id: string | null };
  sharerUserId: string;
  /** Everyone seated in the room now, on any machine. */
  seatedUserIds: readonly string[];
}

/**
 * WHO IS TOLD. The rules are the table in `docs/plans/WATCH_NOW.md`, in the
 * order that keeps the expensive reads for the people who are left: the audience
 * (opted in, or a small server's default), then the free in-memory filters, then
 * the three indexed lookups (blocks, timeouts, permissions) on whoever remains.
 *
 * The bound on a big server is structural, not a check afterwards: above the
 * default's ceiling (or for a community) the candidate query ASKS FOR opted-in
 * members only and stops at the cap, so a 4,000 member community is one count
 * and one query that returns nobody unless somebody asked.
 */
export async function decideStreamAlertRecipients(
  input: StreamAlertDecisionInput,
): Promise<string[]> {
  const { serverId, channel, sharerUserId } = input;
  const profile = await getServerVoiceProfile(serverId);
  if (!profile) {
    return [];
  }
  const defaultOn = streamAlertDefault(profile);
  const pool = getPool();
  const seated = new Set(input.seatedUserIds);

  /**
   * Everything after "who might this be for": the free in-memory filters, then
   * the three indexed lookups (blocks, timeouts, permissions) on whoever
   * remains. Run per page of candidates, because the bound on a big server is
   * on people TOLD, not on people looked at: a page whose members were all in
   * the room or on DND must not be the end of the list.
   */
  const eligible = async (rows: readonly CandidateRow[]): Promise<string[]> => {
    const kept: string[] = [];
    for (const row of rows) {
      const choice = row.notifications?.streamAlerts?.[serverId];
      if (!streamAlertEnabled(choice, profile)) {
        metrics.skipped.optedOut += 1;
        continue;
      }
      if (row.user_id === sharerUserId) {
        metrics.skipped.sharer += 1;
        continue;
      }
      if (seated.has(row.user_id)) {
        metrics.skipped.inRoom += 1;
        continue;
      }
      if (row.status === "dnd") {
        metrics.skipped.dnd += 1;
        continue;
      }
      // A server or channel set to mentions-only or muted says "do not
      // interrupt me for anything but me": a stream starting is not me.
      const level = resolvePushLevel(
        { notifications: row.notifications ?? undefined } as UserPreferences,
        serverId,
        channel.id,
      );
      if (level !== "all") {
        metrics.skipped.muted += 1;
        continue;
      }
      kept.push(row.user_id);
    }
    if (kept.length === 0) {
      return [];
    }

    // Blocks, either direction, in two indexed lookups.
    const blocks = await pool.query<{ other: string }>(
      `SELECT blocked_user_id AS other FROM user_blocks
        WHERE user_id = $1 AND blocked_user_id = ANY($2::uuid[])
       UNION
       SELECT user_id AS other FROM user_blocks
        WHERE blocked_user_id = $1 AND user_id = ANY($2::uuid[])`,
      [sharerUserId, kept],
    );
    const blocked = new Set(blocks.rows.map((row) => row.other));
    const timeouts = await pool.query<{ user_id: string }>(
      `SELECT user_id FROM member_timeouts
        WHERE server_id = $1 AND expires_at > NOW() AND user_id = ANY($2::uuid[])`,
      [serverId, kept],
    );
    const timedOut = new Set(timeouts.rows.map((row) => row.user_id));

    const afterBlocks = kept.filter((userId) => {
      if (blocked.has(userId)) {
        metrics.skipped.blocked += 1;
        return false;
      }
      return true;
    });
    if (afterBlocks.length === 0) {
      return [];
    }

    // VIEW and CONNECT come out of one pass over the same pure rule the join
    // uses, overwrites and private channels included.
    const permissions = await computeMemberPermissionsBulk(
      serverId,
      afterBlocks,
      channel,
      { timedOut },
    );
    return afterBlocks.filter((userId) => {
      const bits = permissions.get(userId) ?? 0n;
      if (
        hasPermission(bits, Permission.VIEW_CHANNEL) &&
        hasPermission(bits, Permission.CONNECT)
      ) {
        return true;
      }
      metrics.skipped.noAccess += 1;
      return false;
    });
  };

  const allowed: string[] = [];
  if (defaultOn) {
    // Every member of a small server, in one read. The LIMIT is a seat belt
    // against a count that moved between the two reads, not a rule.
    const everyone = await pool.query<CandidateRow>(
      `SELECT sm.user_id,
              up.settings->>'status' AS status,
              up.settings->'notifications' AS notifications
         FROM server_members sm
         LEFT JOIN user_preferences up ON up.user_id = sm.user_id
        WHERE sm.server_id = $1
        LIMIT $2`,
      [serverId, STREAM_ALERT_DEFAULT_MAX_MEMBERS * 2],
    );
    allowed.push(...(await eligible(everyone.rows)));
  } else {
    // Opted in, and only opted in, a page at a time by member id: the bound is
    // structural (a page is two caps' worth of rows, and the walk stops at the
    // cap or after `OPT_IN_MAX_PAGES`), so a 4,000 member community with nobody
    // opted in is one query that returns nothing, and one where the first page
    // is all DND still reaches the people behind them.
    let after = "00000000-0000-0000-0000-000000000000";
    for (let page = 0; page < OPT_IN_MAX_PAGES; page += 1) {
      const rows = await pool.query<CandidateRow>(
        `SELECT sm.user_id,
                up.settings->>'status' AS status,
                up.settings->'notifications' AS notifications
           FROM server_members sm
           JOIN user_preferences up ON up.user_id = sm.user_id
          WHERE sm.server_id = $1
            AND sm.user_id > $4::uuid
            AND up.settings #>> ARRAY['notifications', 'streamAlerts', $2::text] = 'true'
          ORDER BY sm.user_id
          LIMIT $3`,
        [serverId, serverId, OPT_IN_PAGE, after],
      );
      if (rows.rows.length === 0) {
        break;
      }
      allowed.push(...(await eligible(rows.rows)));
      if (allowed.length >= STREAM_ALERT_MAX_RECIPIENTS || rows.rows.length < OPT_IN_PAGE) {
        break;
      }
      after = rows.rows[rows.rows.length - 1]!.user_id;
    }
  }

  if (allowed.length > STREAM_ALERT_MAX_RECIPIENTS) {
    metrics.skipped.overCap += allowed.length - STREAM_ALERT_MAX_RECIPIENTS;
    return allowed.slice(0, STREAM_ALERT_MAX_RECIPIENTS);
  }
  return allowed;
}

/** Opted-in members read per page, and how many pages one notice may walk. */
const OPT_IN_PAGE = STREAM_ALERT_MAX_RECIPIENTS * 2;
const OPT_IN_MAX_PAGES = 4;

// ----------------------------------------------------------------- delivery

export interface StreamAlertEvent {
  serverId: string;
  channelId: string;
  /** The voice channel's name, or a party's own name. */
  channelName: string;
  serverName: string;
  sharerName: string;
  kind: "voice" | "party";
  startedAt: number;
  userIds: string[];
}

const STREAM_ALERT_TOPIC = "stream-alert.deliver";

/**
 * The half every machine runs for its own sockets: the claiming process calls it
 * and the bus subscription below calls it on each sibling. One function, so a
 * relayed notice and a local one cannot drift apart. Walks only the recipients'
 * own sockets, never the process's.
 */
export function deliverStreamStarted(event: StreamAlertEvent): number {
  const frame = JSON.stringify({
    type: "stream-started",
    serverId: event.serverId,
    channelId: event.channelId,
    channelName: event.channelName,
    serverName: event.serverName,
    sharerName: event.sharerName,
    kind: event.kind,
    startedAt: event.startedAt,
  } satisfies StreamStartedMessage);
  let sent = 0;
  for (const userId of new Set(event.userIds)) {
    forEachSocketOfUser(userId, (socket) => {
      if (socket.readyState === 1) {
        socket.send(frame);
        sent += 1;
      }
    });
  }
  metrics.delivered += sent;
  return sent;
}

function channelLabelOf(event: StreamAlertEvent): string {
  return event.kind === "party" ? event.channelName : `#${event.channelName}`;
}

/** The winner's delivery: its own sockets, the other machines, then push. */
function notifyStreamStarted(event: StreamAlertEvent): void {
  deliverStreamStarted(event);
  if (isBusEnabled()) {
    publishNotice(event);
  }
  // Push from here and nowhere else: see the module comment.
  pushStreamStarted(
    {
      userIds: event.userIds,
      serverId: event.serverId,
      channelId: event.channelId,
      serverName: event.serverName,
      channelLabel: channelLabelOf(event),
      sharerName: event.sharerName,
    },
    (pushed) => {
      metrics.pushed += pushed;
    },
    () => {
      metrics.failures += 1;
    },
  );
}

/** Notices this process already put on its sockets, so the one retry cannot show twice. */
const RELAYED_MEMORY_MS = 60_000;
const relayedNotices = new Map<string, number>();
const RELAYED_SWEEP_MIN = 500;

function relayKey(event: { channelId: string; startedAt: number }): string {
  return `${event.channelId}:${event.startedAt}`;
}

function rememberRelayed(key: string, now: number): void {
  relayedNotices.set(key, now);
  if (relayedNotices.size > RELAYED_SWEEP_MIN) {
    for (const [old, at] of relayedNotices) {
      if (now - at >= RELAYED_MEMORY_MS) {
        relayedNotices.delete(old);
      }
    }
  }
}

/** The bus is fire-and-forget and drops while it reconnects; one retry covers a blip. */
const REPUBLISH_MS = 3_000;

function publishNotice(event: StreamAlertEvent): void {
  publishToCluster(STREAM_ALERT_TOPIC, event);
  metrics.relayed += 1;
  if (isBusConnected()) {
    return;
  }
  const timer = setTimeout(() => {
    if (isBusEnabled()) {
      publishToCluster(STREAM_ALERT_TOPIC, event);
    }
  }, REPUBLISH_MS);
  timer.unref?.();
}

subscribeToCluster(STREAM_ALERT_TOPIC, (data) => {
  const event = data as Partial<StreamAlertEvent> | null;
  if (
    !event ||
    typeof event !== "object" ||
    typeof event.serverId !== "string" ||
    typeof event.channelId !== "string" ||
    typeof event.channelName !== "string" ||
    typeof event.serverName !== "string" ||
    typeof event.sharerName !== "string" ||
    (event.kind !== "voice" && event.kind !== "party") ||
    typeof event.startedAt !== "number" ||
    !Array.isArray(event.userIds)
  ) {
    return;
  }
  const userIds = event.userIds.filter(
    (id): id is string => typeof id === "string",
  );
  if (userIds.length === 0) {
    return;
  }
  const now = Date.now();
  const key = relayKey({ channelId: event.channelId, startedAt: event.startedAt });
  const seen = relayedNotices.get(key);
  if (seen !== undefined && now - seen < RELAYED_MEMORY_MS) {
    return;
  }
  // No push here: the machine that claimed already sent it.
  const sent = deliverStreamStarted({
    serverId: event.serverId,
    channelId: event.channelId,
    channelName: event.channelName,
    serverName: event.serverName,
    sharerName: event.sharerName,
    kind: event.kind,
    startedAt: event.startedAt,
    userIds,
  });
  if (sent > 0) {
    rememberRelayed(key, now);
  }
});

// ----------------------------------------------------------------- the route

/**
 * `GET /api/servers/:id/stream-alerts`: what this person gets for this server,
 * so the menu can show the real state without guessing a member count. The
 * choice itself is written through the preferences the client already syncs
 * (`notifications.streamAlerts`).
 */
export async function getStreamAlertSetting(
  serverId: string,
  userId: string,
): Promise<StreamAlertSetting | null> {
  const profile = await getServerVoiceProfile(serverId);
  if (!profile) {
    return null;
  }
  const row = await getPool().query<{ choice: string | null }>(
    `SELECT settings #>> ARRAY['notifications', 'streamAlerts', $2::text] AS choice
       FROM user_preferences WHERE user_id = $1`,
    [userId, serverId],
  );
  const raw = row.rows[0]?.choice;
  const choice = raw === "true" ? true : raw === "false" ? false : undefined;
  return {
    flag: isEnabled("stream_start_notifications", { serverId }),
    enabled: streamAlertEnabled(choice, profile),
    default: streamAlertDefault(profile),
    memberCount: profile.memberCount,
  };
}
