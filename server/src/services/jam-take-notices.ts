import {
  JAM_INSTRUMENTS,
  type JamInstrument,
  type JamTakeNotice,
  type JamTakeNoticesResponse,
} from "@pqp/shared";
import { getPool } from "../db.js";
import { isEnabled } from "../lib/flags.js";
import { notifyJamTakeDecision } from "./jam-public-notify.js";
import { pushJamTake } from "./push.js";

/**
 * TELLING THE STARTER (runtime flag `jam_take_notices`, docs/JAM_PUBLIC.md).
 *
 * The launch user test (round 2, finding N1): a stranger sent a part to a
 * public song and its starter needed 376 seconds, by luck, to find it. Nothing
 * had told them. The mechanism that exists for "somebody needs to know a thing
 * that happened while they were away" is the one the story notices and the
 * watch party waitlist use: a DURABLE ROW the app reads at boot and a card
 * draws until it is answered, a LIVE FRAME for the sockets that are open (over
 * `CLUSTER_BUS`, `jam-public-notify.ts`), and a PUSH for the phone that is
 * closed (`push.ts`, with its own DND, mute and live-socket rules). This is
 * that, for takes. No email, no broadcast push.
 *
 * THREE KINDS (packages/shared/src/jam-public.ts, TAKE NOTICES):
 *   take      to the starter: an outside take waits for their answer.
 *   accepted  to the sender: it went in the mix.
 *   refused   to the sender: the starter declined it.
 *
 * BATCHING IS THE UNIQUE INDEX. One open row per (person, song, kind): the
 * second take on a song while the first notice is unanswered raises its count
 * instead of making another item, and only the take that CLAIMS the push (one
 * atomic upsert, `pushed_at`, at most one per half hour per item) pushes, which
 * is also what keeps two API machines from sending two. A take lands on exactly
 * one machine (it is that machine's HTTP request), so the frame is sent once
 * and crosses to the sibling on the bus.
 *
 * WHO IS NEVER TOLD. The person who recorded it (the starter is told about
 * other people's takes only, the sender about the starter's decisions only);
 * the recipient who blocked the actor (one direction, `notBlockedSql`'s rule:
 * whose feed it may enter). The push additionally respects live sockets, DND
 * and an explicit mute. The card and the frame do not: they are in-app, and
 * the starter's decision list is not a sound.
 *
 * Nothing here is between BEGIN and COMMIT, and nothing throws into the
 * caller: the take was already stored, a notice that fails is a nudge not
 * given (the starter's inbox still lists the take).
 */

/** The push for one item repeats at most this often. */
export const JAM_TAKE_PUSH_REPEAT_MS = 30 * 60 * 1000;

/** An answered item is kept this long, an unanswered one this much longer, then swept. */
const KEEP_ACKED_DAYS = 7;
const KEEP_OPEN_DAYS = 60;

const counters = {
  /** A new open item written. */
  created: 0,
  /** A take folded into an item that was already open (the burst case). */
  merged: 0,
  /** Items refused because the recipient had blocked the actor. */
  skippedBlocked: 0,
  /** Writes skipped because the flag is off. */
  skippedFlagOff: 0,
  /** Live decision frames sent to a sender (the starter's frame is `jam-public-notice`). */
  decisionFrames: 0,
  /** Pushes the item claimed and handed to the push pipeline. */
  pushClaimed: 0,
  /** Of those, the ones that reached a device attempt (the rest hit DND, a mute, a live socket). */
  pushTried: 0,
  /** Folded takes that did not claim a push (one went out less than half an hour ago). */
  pushHeldBack: 0,
  /** Items the person tapped or dismissed. */
  acked: 0,
  /** Writes that failed (logged). */
  failed: 0,
  /** By kind, created plus merged. */
  byKind: { take: 0, accepted: 0, refused: 0 },
};

export function jamTakeNoticeCounters(): typeof counters {
  return { ...counters, byKind: { ...counters.byKind } };
}

export function resetJamTakeNoticeCountersForTests(): void {
  for (const key of Object.keys(counters) as Array<keyof typeof counters>) {
    if (key === "byKind") {
      counters.byKind = { take: 0, accepted: 0, refused: 0 };
    } else {
      (counters as Record<string, unknown>)[key] = 0;
    }
  }
}

export function jamTakeNoticesEnabled(): boolean {
  return isEnabled("jam_take_notices");
}

function sortedInstruments(list: readonly string[]): JamInstrument[] {
  const known = (one: string): JamInstrument =>
    (JAM_INSTRUMENTS as readonly string[]).includes(one) ? (one as JamInstrument) : "other";
  const rank = (one: JamInstrument) => JAM_INSTRUMENTS.indexOf(one);
  return [...new Set(list.map(known))].sort((a, b) => rank(a) - rank(b));
}

async function recipientBlockedActor(recipientId: string, actorId: string): Promise<boolean> {
  const result = await getPool().query(
    `SELECT 1 FROM user_blocks WHERE user_id = $1 AND blocked_user_id = $2`,
    [recipientId, actorId],
  );
  return (result.rowCount ?? 0) > 0;
}

interface NoticeInput {
  recipientId: string;
  /** The other person: who sent the take (to the starter), who answered (to the sender). */
  actorId: string;
  kind: "take" | "accepted" | "refused";
  songId: string;
  title: string;
  instrument: JamInstrument;
  serverId: string | null;
  channelId: string | null;
}

/**
 * One take, folded into the recipient's open item for the song (or a new one),
 * and the push when this call claims it. Returns the live count and
 * instruments of the item, or null when nothing was written (flag off, the
 * recipient and the actor are the same person, a block, a failure).
 */
async function upsertNotice(input: NoticeInput): Promise<{ id: string; count: number; instruments: JamInstrument[] } | null> {
  if (!jamTakeNoticesEnabled()) {
    counters.skippedFlagOff += 1;
    return null;
  }
  if (input.recipientId === input.actorId) {
    return null;
  }
  try {
    if (await recipientBlockedActor(input.recipientId, input.actorId)) {
      counters.skippedBlocked += 1;
      return null;
    }
    // ONE statement is the whole claim. A fresh row is stamped as pushed now;
    // a folded take refreshes the stamp only when the last push is old enough.
    // `pushed_at = updated_at` afterwards (both are this statement's NOW())
    // says THIS call moved the stamp, which is the only way to learn it from
    // an upsert's RETURNING, since the old value is gone by then.
    const result = await getPool().query<{
      id: string;
      count: number;
      instruments: string[];
      inserted: boolean;
      push_due: boolean;
    }>(
      `INSERT INTO jam_take_notices (user_id, kind, song_id, title, instruments, count, pushed_at)
       VALUES ($1, $2, $3, $4, ARRAY[$5::text], 1, NOW())
       ON CONFLICT (user_id, song_id, kind) WHERE acked_at IS NULL DO UPDATE SET
         title = EXCLUDED.title,
         count = jam_take_notices.count + 1,
         instruments = ARRAY(SELECT DISTINCT i FROM unnest(jam_take_notices.instruments || EXCLUDED.instruments) AS i),
         updated_at = NOW(),
         pushed_at = CASE
           WHEN jam_take_notices.pushed_at IS NULL
             OR jam_take_notices.pushed_at < NOW() - make_interval(secs => $6::double precision)
           THEN NOW() ELSE jam_take_notices.pushed_at END
       RETURNING id, count, instruments, (xmax = 0) AS inserted, (pushed_at = updated_at) AS push_due`,
      [
        input.recipientId,
        input.kind,
        input.songId,
        input.title,
        input.instrument,
        JAM_TAKE_PUSH_REPEAT_MS / 1000,
      ],
    );
    const row = result.rows[0];
    if (!row) {
      return null;
    }
    counters.byKind[input.kind] += 1;
    if (row.inserted) {
      counters.created += 1;
    } else {
      counters.merged += 1;
    }
    const instruments = sortedInstruments(row.instruments);
    if (row.push_due) {
      counters.pushClaimed += 1;
      pushJamTake(
        {
          userId: input.recipientId,
          kind: input.kind,
          songId: input.songId,
          title: input.title,
          count: row.count,
          instrument: instruments.length === 1 ? instruments[0]! : null,
          serverId: input.serverId,
          channelId: input.channelId,
        },
        (tried) => {
          if (tried) {
            counters.pushTried += 1;
          }
        },
      );
    } else {
      counters.pushHeldBack += 1;
    }
    return { id: row.id, count: row.count, instruments };
  } catch (error) {
    counters.failed += 1;
    console.error("[jam-public] take notice failed:", error instanceof Error ? error.message : error);
    return null;
  }
}

/** An outside take arrived on a song: the durable item (and the push) for its starter. */
export async function recordTakeForStarter(input: {
  starterId: string;
  takerId: string;
  songId: string;
  title: string;
  instrument: JamInstrument;
  serverId: string | null;
  channelId: string | null;
}): Promise<void> {
  await upsertNotice({
    recipientId: input.starterId,
    actorId: input.takerId,
    kind: "take",
    songId: input.songId,
    title: input.title,
    instrument: input.instrument,
    serverId: input.serverId,
    channelId: input.channelId,
  });
}

/** What a decision needs to know about the take it answers, read BEFORE the decision changes it. */
export interface TakeDecisionTarget {
  senderId: string;
  starterId: string;
  songId: string;
  title: string;
  instrument: JamInstrument;
  serverId: string | null;
  channelId: string | null;
}

/**
 * The take, when it is an outside take still waiting (public, from outside, out
 * of the mix, not removed): the only kind a starter's accept or refusal is an
 * ANSWER to. Null for everything else (a take already in the mix, the
 * starter's own, a private song) and when the flag is off, so the callers pay
 * no query for a switch that is off.
 */
export async function describeTakeForDecision(trackId: string): Promise<TakeDecisionTarget | null> {
  if (!jamTakeNoticesEnabled()) {
    return null;
  }
  try {
    const result = await getPool().query<{
      author_id: string;
      starter_id: string | null;
      song_id: string;
      instrument: string;
      title: string;
      server_id: string | null;
      channel_id: string | null;
    }>(
      `SELECT t.author_id, s.author_id AS starter_id, t.song_id, t.instrument, s.title, s.server_id, s.channel_id
         FROM jam_tracks t
         JOIN jam_public_tracks pt ON pt.track_id = t.id AND pt.outside AND pt.removed_at IS NULL
         JOIN jam_songs s ON s.id = t.song_id AND s.deleted_at IS NULL
        WHERE t.id = $1 AND NOT t.in_mix AND t.deleted_at IS NULL`,
      [trackId],
    );
    const row = result.rows[0];
    if (!row || !row.starter_id || row.starter_id === row.author_id) {
      return null;
    }
    return {
      senderId: row.author_id,
      starterId: row.starter_id,
      songId: row.song_id,
      title: row.title,
      instrument: sortedInstruments([row.instrument])[0]!,
      serverId: row.server_id,
      channelId: row.channel_id,
    };
  } catch (error) {
    counters.failed += 1;
    console.error("[jam-public] take decision lookup failed:", error instanceof Error ? error.message : error);
    return null;
  }
}

/** The starter answered (or auto-accept did, late): the sender's item, frame and push. */
export async function recordTakeDecision(
  target: TakeDecisionTarget,
  decision: "accepted" | "refused",
): Promise<void> {
  const written = await upsertNotice({
    recipientId: target.senderId,
    actorId: target.starterId,
    kind: decision,
    songId: target.songId,
    title: target.title,
    instrument: target.instrument,
    serverId: target.serverId,
    channelId: target.channelId,
  });
  if (!written) {
    return;
  }
  counters.decisionFrames += 1;
  notifyJamTakeDecision(target.senderId, {
    decision,
    songId: target.songId,
    title: target.title,
    instrument: target.instrument,
  });
}

/** The open items of one person, newest first. See `JamTakeNotice` for what each kind means. */
export async function listJamTakeNotices(userId: string): Promise<JamTakeNoticesResponse> {
  if (!jamTakeNoticesEnabled()) {
    return { notices: [] };
  }
  const result = await getPool().query<{
    id: string;
    kind: string;
    song_id: string;
    title: string;
    instruments: string[];
    count: number;
    created_at: Date;
    updated_at: Date;
    pending: number | null;
    live_instruments: string[] | null;
  }>(
    `SELECT n.id, n.kind, n.song_id, s.title, n.instruments, n.count, n.created_at, n.updated_at,
            live.pending, live.instruments AS live_instruments
       FROM jam_take_notices n
       JOIN jam_songs s ON s.id = n.song_id AND s.deleted_at IS NULL
       LEFT JOIN LATERAL (
         -- A 'take' item says what is waiting NOW: its count and instruments are
         -- the takes still out of the mix, so answering them empties it.
         SELECT COUNT(*)::int AS pending, COALESCE(array_agg(DISTINCT t.instrument), '{}') AS instruments
           FROM jam_tracks t
           JOIN jam_public_tracks pt ON pt.track_id = t.id
          WHERE t.song_id = n.song_id AND pt.outside AND NOT t.in_mix
            AND t.deleted_at IS NULL AND pt.removed_at IS NULL
       ) live ON n.kind = 'take'
      WHERE n.user_id = $1 AND n.acked_at IS NULL
      ORDER BY n.updated_at DESC
      LIMIT 50`,
    [userId],
  );
  const notices: JamTakeNotice[] = [];
  const settled: string[] = [];
  for (const row of result.rows) {
    const take = row.kind === "take";
    if (take && (row.pending ?? 0) === 0) {
      settled.push(row.id);
      continue;
    }
    const count = take ? row.pending! : row.count;
    notices.push({
      id: row.id,
      kind: row.kind === "accepted" || row.kind === "refused" ? row.kind : "take",
      songId: row.song_id,
      title: row.title,
      instruments: sortedInstruments(take ? (row.live_instruments ?? []) : row.instruments),
      count,
      createdAt: row.created_at.toISOString(),
      updatedAt: row.updated_at.toISOString(),
    });
  }
  if (settled.length > 0) {
    // Everything on the song was answered: the item has done its job.
    await getPool()
      .query(`UPDATE jam_take_notices SET acked_at = NOW() WHERE id = ANY($1::uuid[]) AND acked_at IS NULL`, [settled])
      .catch(() => undefined);
  }
  return { notices };
}

/** The person tapped or dismissed an item. Idempotent, and never anybody else's. */
export async function ackJamTakeNotice(userId: string, id: string): Promise<void> {
  const result = await getPool().query(
    `UPDATE jam_take_notices SET acked_at = NOW() WHERE id = $1 AND user_id = $2 AND acked_at IS NULL`,
    [id, userId],
  );
  if ((result.rowCount ?? 0) > 0) {
    counters.acked += 1;
  }
}

/** The minute sweep: answered items after a week, unanswered ones after sixty days. */
export async function sweepJamTakeNotices(): Promise<number> {
  const result = await getPool().query(
    `DELETE FROM jam_take_notices
      WHERE (acked_at IS NOT NULL AND acked_at < NOW() - make_interval(days => $1::int))
         OR updated_at < NOW() - make_interval(days => $2::int)`,
    [KEEP_ACKED_DAYS, KEEP_OPEN_DAYS],
  );
  return result.rowCount ?? 0;
}

/** Open items right now, for the dashboard's table half. */
export async function jamTakeNoticeTableMetrics(): Promise<{ open: number }> {
  const result = await getPool().query<{ open: number }>(
    `SELECT COUNT(*)::int AS open FROM jam_take_notices WHERE acked_at IS NULL`,
  );
  return { open: result.rows[0]?.open ?? 0 };
}
