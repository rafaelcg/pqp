import {
  hasPermission,
  parsePermissions,
  Permission,
  stageModeClosesTheFloor,
  canPerformWatchPartyAction,
  canTransitionWatchParty,
  resolveWatchPartyHost,
  watchPartyOptionsSchema,
  watchPartyRole,
  WATCH_PARTY_DEFAULT_OPTIONS,
  type WatchParty,
  type WatchPartyAction,
  type WatchPartyOptions,
  type WatchPartyRole,
  type WatchPartyPhase,
  type WatchPartyStage,
} from "@pqp/shared";
import { getPool } from "../db.js";
import { logEvent } from "../lib/log.js";
import { getEveryoneRoleId } from "./permissions.js";
import {
  deleteChannelOverwrite,
  upsertChannelOverwrite,
} from "./roles.js";

/**
 * Imported lazily, at the two call sites, and deliberately.
 *
 * `ws/voice.ts` imports this module (a host's socket closing starts the grace
 * clock), so a static import here would close the cycle. ESM would probably
 * cope, since both sides only ever call each other at runtime, but "probably
 * copes" is not a property worth relying on in the file that decides whether a
 * room can talk.
 */
async function reevaluateVoiceSpeak(serverId: string): Promise<void> {
  const voice = await import("../ws/voice.js");
  await voice.reevaluateVoiceSpeak(serverId);
}

/**
 * The watch party as an event object: who owns it, what state it is in, and
 * every legal move between states.
 *
 * THE ROW IS A `channel_sessions` ROW. There is no second table; see the
 * schema block and `docs/WATCH_PARTY.md` for why. Everything this module does
 * is scoped to the columns that block added (`host_user_id`, `options`,
 * `went_live_at`, `ended_at`, `host_disconnected_at`) plus the `draft` status,
 * so the scheduling half that shipped in PR #352 keeps working unchanged: a
 * party created with a `startsAt` IS a scheduled session, reminders and all.
 *
 * THE RULES ARE NOT IN THIS FILE. `packages/shared/src/watch-party-session.ts`
 * owns the transition table and the role table, and it is imported here rather
 * than restated, so the server and the client cannot drift about who may press
 * what. This module owns the SQL and the side effects; that one owns the
 * answers.
 *
 * WHAT THIS DELIBERATELY DOES NOT OWN. The stream. `pushLiveHls` and
 * `reconcileLiveHls` decide whether a transcode exists, keyed on a peer with
 * the stage bit, and they knew nothing about a host before this and still do
 * not. A party is live because somebody pressed Ir ao vivo; a picture appears
 * because somebody is sharing. They are two facts and the UI shows both,
 * because conflating them is how you get a party that says LIVE with a black
 * rectangle under it, or a share nobody can find.
 */

export class WatchPartyError extends Error {
  constructor(
    public readonly code:
      | "not_found"
      | "conflict"
      | "forbidden"
      | "illegal_transition",
    message: string,
  ) {
    super(message);
  }
}

// ------------------------------------------------------------------ the rows

export interface WatchPartyRow {
  id: string;
  channel_id: string;
  server_id: string | null;
  title: string;
  description: string | null;
  starts_at: Date | null;
  status: WatchPartyPhase;
  options: unknown;
  host_user_id: string;
  host_display_name: string;
  host_avatar_url: string | null;
  host_disconnected_at: Date | null;
  went_live_at: Date | null;
  ended_at: Date | null;
  created_by: string;
  created_at: Date;
  updated_at: Date;
}

/**
 * The host's name and picture come back on the row, not from a second call.
 * The sidebar's live block draws a face beside the party's name for a viewer
 * who may not even be looking at a member list, and an N+1 there is an N+1 on
 * the hottest surface this feature has.
 */
const PARTY_SELECT = `
  s.id, s.channel_id, s.server_id, s.title, s.description, s.starts_at,
  s.status, s.options, s.host_user_id, s.host_disconnected_at,
  s.went_live_at, s.ended_at, s.created_by, s.created_at, s.updated_at,
  h.display_name AS host_display_name, h.avatar_url AS host_avatar_url
`;

const PARTY_FROM = `
  FROM channel_sessions s
  JOIN users h ON h.id = s.host_user_id
`;

/** States a party occupies while it still matters to anybody. */
const ACTIVE_STATES = "('draft', 'scheduled', 'live')";

function parseOptions(raw: unknown): WatchPartyOptions {
  const parsed = watchPartyOptionsSchema.safeParse(raw ?? {});
  // A row written by an older build, or by hand, must not take a channel's
  // sidebar down. Unknown or broken options read as the defaults.
  return parsed.success ? parsed.data : { ...WATCH_PARTY_DEFAULT_OPTIONS };
}

export interface WatchPartyCohostRow {
  user_id: string;
  display_name: string;
  avatar_url: string | null;
}

/** One party's co-hosts, in the order they were added. */
export async function loadCohostRows(
  sessionId: string,
): Promise<WatchPartyCohostRow[]> {
  return (await loadCohosts([sessionId])).get(sessionId) ?? [];
}

async function loadCohosts(
  sessionIds: readonly string[],
): Promise<Map<string, WatchPartyCohostRow[]>> {
  const byParty = new Map<string, WatchPartyCohostRow[]>();
  if (sessionIds.length === 0) {
    return byParty;
  }
  const result = await getPool().query<
    WatchPartyCohostRow & { session_id: string }
  >(
    `SELECT c.session_id, c.user_id, u.display_name, u.avatar_url
       FROM channel_session_cohosts c
       JOIN users u ON u.id = c.user_id
      WHERE c.session_id = ANY($1::uuid[])
      ORDER BY c.added_at ASC`,
    [sessionIds],
  );
  for (const row of result.rows) {
    const list = byParty.get(row.session_id);
    const entry = {
      user_id: row.user_id,
      display_name: row.display_name,
      avatar_url: row.avatar_url,
    };
    if (list) {
      list.push(entry);
    } else {
      byParty.set(row.session_id, [entry]);
    }
  }
  return byParty;
}

export function mapWatchParty(
  row: WatchPartyRow,
  cohosts: readonly WatchPartyCohostRow[],
  viewerRole: WatchPartyRole,
  reminding: boolean,
  stage: WatchPartyStage = { invited: [], hands: [], handRaised: false },
): WatchParty {
  return {
    id: row.id,
    channelId: row.channel_id,
    serverId: row.server_id,
    name: row.title,
    description: row.description,
    state: row.status,
    startsAt: row.starts_at ? row.starts_at.toISOString() : null,
    wentLiveAt: row.went_live_at ? row.went_live_at.toISOString() : null,
    endedAt: row.ended_at ? row.ended_at.toISOString() : null,
    hostUserId: row.host_user_id,
    hostDisplayName: row.host_display_name,
    hostAvatarUrl: row.host_avatar_url,
    hostDisconnectedAt: row.host_disconnected_at
      ? row.host_disconnected_at.toISOString()
      : null,
    cohosts: cohosts.map((c) => ({
      userId: c.user_id,
      displayName: c.display_name,
      avatarUrl: c.avatar_url,
    })),
    options: parseOptions(row.options),
    viewerRole,
    reminding,
    stage,
  };
}

// ------------------------------------------------------------------- reading

export async function getWatchPartyRow(
  sessionId: string,
): Promise<WatchPartyRow | null> {
  const result = await getPool().query<WatchPartyRow>(
    `SELECT ${PARTY_SELECT} ${PARTY_FROM} WHERE s.id = $1`,
    [sessionId],
  );
  return result.rows[0] ?? null;
}

export async function getActiveWatchPartyRow(
  channelId: string,
): Promise<WatchPartyRow | null> {
  const result = await getPool().query<WatchPartyRow>(
    `SELECT ${PARTY_SELECT} ${PARTY_FROM}
      WHERE s.channel_id = $1 AND s.status IN ${ACTIVE_STATES}`,
    [channelId],
  );
  return result.rows[0] ?? null;
}

export async function listCohostIds(sessionId: string): Promise<string[]> {
  const result = await getPool().query<{ user_id: string }>(
    `SELECT user_id FROM channel_session_cohosts WHERE session_id = $1`,
    [sessionId],
  );
  return result.rows.map((r) => r.user_id);
}

async function isReminding(
  sessionId: string,
  userId: string,
): Promise<boolean> {
  const result = await getPool().query(
    `SELECT 1 FROM channel_session_reminders WHERE session_id = $1 AND user_id = $2`,
    [sessionId, userId],
  );
  return (result.rowCount ?? 0) > 0;
}

/**
 * The row, dressed for one particular person: their role, their reminder, and
 * `null` if this is a draft they are not part of.
 *
 * RETURNING NULL RATHER THAN THROWING IS THE POINT. A draft is invisible, not
 * forbidden: a 403 tells the asker that something is there, which is exactly
 * what a draft must not do. Every read path funnels through here so there is
 * one place that decision is made.
 */
export async function presentWatchParty(
  row: WatchPartyRow,
  viewer: { userId: string; permissions: bigint },
  cohosts?: readonly WatchPartyCohostRow[],
): Promise<WatchParty | null> {
  const list = cohosts ?? (await loadCohosts([row.id])).get(row.id) ?? [];
  const role = watchPartyRole({
    userId: viewer.userId,
    hostUserId: row.host_user_id,
    cohostUserIds: list.map((c) => c.user_id),
    permissions: viewer.permissions,
  });
  if (
    !canPerformWatchPartyAction({ action: "view", role, state: row.status })
  ) {
    return null;
  }
  return mapWatchParty(
    row,
    list,
    role,
    await isReminding(row.id, viewer.userId),
    await presentStage(row.id, role, viewer.userId),
  );
}

/**
 * The stage, as this person may see it.
 *
 * WHO IS UP is public: they are about to be audible, and a viewer wondering
 * why a stranger is talking deserves the answer. WHO IS ASKING is not: a
 * queue an audience can read is a queue where being passed over happens in
 * public, and that makes the room worse rather than better. Everyone is told
 * about their OWN hand, because a raise button that cannot show its own state
 * is a button people press twice.
 */
async function presentStage(
  sessionId: string,
  role: WatchPartyRole,
  userId: string,
): Promise<WatchPartyStage> {
  const { invited, hands } = await loadWatchPartyStage(sessionId);
  const runsTheParty = role === "host" || role === "cohost";
  const person = (r: { user_id: string; display_name: string; avatar_url: string | null }) => ({
    userId: r.user_id,
    displayName: r.display_name,
    avatarUrl: r.avatar_url,
  });
  return {
    invited: invited.map(person),
    hands: runsTheParty ? hands.map(person) : [],
    handRaised: hands.some((h) => h.user_id === userId),
  };
}

/**
 * Every active party in a server, for the sidebar block. One query for the
 * rows and one for every co-host list, never one per party.
 *
 * The caller supplies `permissionsFor` because per-channel overwrites mean
 * "may this person see this party" is a per-channel question, and this module
 * has no business resolving permissions itself.
 */
export async function listActiveWatchPartiesForServer(
  serverId: string,
  viewer: {
    userId: string;
    permissionsFor: (channelId: string) => Promise<bigint>;
  },
): Promise<WatchParty[]> {
  const result = await getPool().query<WatchPartyRow>(
    `SELECT ${PARTY_SELECT} ${PARTY_FROM}
      WHERE s.server_id = $1 AND s.status IN ${ACTIVE_STATES}
      ORDER BY s.went_live_at DESC NULLS LAST, s.starts_at ASC NULLS LAST`,
    [serverId],
  );
  if (result.rows.length === 0) {
    return [];
  }
  const cohosts = await loadCohosts(result.rows.map((r) => r.id));
  const parties: WatchParty[] = [];
  for (const row of result.rows) {
    const permissions = await viewer.permissionsFor(row.channel_id);
    const party = await presentWatchParty(
      row,
      { userId: viewer.userId, permissions },
      cohosts.get(row.id) ?? [],
    );
    if (party) {
      parties.push(party);
    }
  }
  return parties;
}

// --------------------------------------------------------------- authorising

export interface WatchPartyActor {
  userId: string;
  /** Effective permissions on the party's channel. */
  permissions: bigint;
}

/**
 * Resolve the actor's role and refuse the action if it is not theirs.
 *
 * `not_found` rather than `forbidden` when the actor cannot even see the
 * party, for the same reason `presentWatchParty` returns null: a draft that
 * answers 403 has announced itself.
 */
export async function authoriseWatchParty(
  row: WatchPartyRow,
  actor: WatchPartyActor,
  action: WatchPartyAction,
): Promise<{ role: WatchPartyRole; cohostIds: string[] }> {
  const cohostIds = await listCohostIds(row.id);
  const role = watchPartyRole({
    userId: actor.userId,
    hostUserId: row.host_user_id,
    cohostUserIds: cohostIds,
    permissions: actor.permissions,
  });
  const canSee = canPerformWatchPartyAction({
    action: "view",
    role,
    state: row.status,
  });
  if (!canSee) {
    throw new WatchPartyError("not_found", "Watch party not found");
  }
  const allowed = canPerformWatchPartyAction({
    action,
    role,
    state: row.status,
    hostDisconnectedAt: row.host_disconnected_at
      ? row.host_disconnected_at.getTime()
      : null,
    now: Date.now(),
  });
  if (!allowed) {
    throw new WatchPartyError(
      "forbidden",
      `A ${role} may not ${action} a ${row.status} watch party`,
    );
  }
  return { role, cohostIds };
}

// -------------------------------------------------------------------- moving

export async function createWatchParty(input: {
  channelId: string;
  serverId: string | null;
  name: string;
  description: string | null;
  /** Present schedules it and announces it; absent leaves it a private draft. */
  startsAt: string | null;
  options: Partial<WatchPartyOptions>;
  hostUserId: string;
}): Promise<WatchPartyRow> {
  const options = watchPartyOptionsSchema.parse({
    ...WATCH_PARTY_DEFAULT_OPTIONS,
    ...input.options,
  });
  const status: WatchPartyPhase = input.startsAt ? "scheduled" : "draft";
  try {
    const inserted = await getPool().query<{ id: string }>(
      `INSERT INTO channel_sessions
         (channel_id, server_id, title, description, starts_at, status,
          created_by, host_user_id, options)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $7, $8::jsonb)
       RETURNING id`,
      [
        input.channelId,
        input.serverId,
        input.name,
        input.description,
        input.startsAt,
        status,
        input.hostUserId,
        JSON.stringify(options),
      ],
    );
    const row = await getWatchPartyRow(inserted.rows[0].id);
    if (!row) {
      throw new WatchPartyError("not_found", "Watch party not found");
    }
    return row;
  } catch (error) {
    // The partial unique index. Two people setting one up in the same room
    // at once is the case, and it is a conflict, not a crash.
    if (
      error &&
      typeof error === "object" &&
      "code" in error &&
      (error as { code?: string }).code === "23505"
    ) {
      throw new WatchPartyError(
        "conflict",
        "This channel already has a watch party being set up, scheduled, or live",
      );
    }
    throw error;
  }
}

export async function updateWatchParty(
  sessionId: string,
  patch: {
    name?: string;
    description?: string | null;
    startsAt?: string | null;
    options?: Partial<WatchPartyOptions>;
  },
): Promise<WatchPartyRow> {
  const existing = await getWatchPartyRow(sessionId);
  if (!existing) {
    throw new WatchPartyError("not_found", "Watch party not found");
  }
  const sets: string[] = ["updated_at = NOW()"];
  const values: unknown[] = [];
  let i = 1;
  if (patch.name !== undefined) {
    sets.push(`title = $${i++}`);
    values.push(patch.name);
  }
  if (patch.description !== undefined) {
    sets.push(`description = $${i++}`);
    values.push(patch.description);
  }
  if (patch.startsAt !== undefined) {
    sets.push(`starts_at = $${i++}`);
    values.push(patch.startsAt);
    // Giving a draft a time publishes it: that is the only way a party
    // becomes something the room can see and set a reminder on. Taking the
    // time off a scheduled party pulls it back to a draft, which is a legal
    // move in the table and the reason `scheduled -> draft` is there.
    if (patch.startsAt !== null && existing.status === "draft") {
      sets.push(`status = 'scheduled'`);
    } else if (patch.startsAt === null && existing.status === "scheduled") {
      sets.push(`status = 'draft'`);
    }
  }
  if (patch.options !== undefined) {
    const merged = watchPartyOptionsSchema.parse({
      ...parseOptions(existing.options),
      ...patch.options,
    });
    sets.push(`options = $${i++}::jsonb`);
    values.push(JSON.stringify(merged));
  }
  values.push(sessionId);
  const result = await getPool().query(
    `UPDATE channel_sessions SET ${sets.join(", ")} WHERE id = $${i}`,
    values,
  );
  if (result.rowCount === 0) {
    throw new WatchPartyError("not_found", "Watch party not found");
  }
  if (patch.startsAt !== undefined && patch.startsAt !== null) {
    // Rescheduling un-fires the T-10 reminder against the new time. Same
    // rule the scheduling PR shipped; restated because the write moved.
    await getPool().query(
      `UPDATE channel_session_reminders SET notified_before_at = NULL
        WHERE session_id = $1`,
      [sessionId],
    );
  }
  const updated = await getWatchPartyRow(sessionId);
  if (!updated) {
    throw new WatchPartyError("not_found", "Watch party not found");
  }
  return updated;
}

/**
 * The one function that changes a party's state, and the only place the
 * transition table is enforced against the database.
 *
 * THE `WHERE status = $from` IS NOT DECORATION. Two hosts pressing Ir ao vivo
 * on the same party, or a sweep ending a party at the same moment a host
 * does, both land here concurrently. Naming the expected current state in the
 * UPDATE makes the loser affect zero rows and hear "conflict", instead of
 * both winning and the second one stamping `went_live_at` over a party that
 * has already ended.
 */
export async function transitionWatchParty(
  sessionId: string,
  to: WatchPartyPhase,
  from: WatchPartyPhase,
): Promise<WatchPartyRow> {
  if (!canTransitionWatchParty(from, to)) {
    throw new WatchPartyError(
      "illegal_transition",
      `A watch party cannot go from ${from} to ${to}`,
    );
  }
  const stamps: string[] = ["status = $1", "updated_at = NOW()"];
  if (to === "live") {
    // Going live clears any stale disconnect stamp from a previous run and
    // records when the show actually started, which is what the "live for
    // 42 min" readout and the recording window both read.
    stamps.push("went_live_at = NOW()", "host_disconnected_at = NULL");
  }
  if (to === "ended" || to === "cancelled") {
    stamps.push("ended_at = NOW()", "host_disconnected_at = NULL");
  }
  const result = await getPool().query(
    `UPDATE channel_sessions SET ${stamps.join(", ")}
      WHERE id = $2 AND status = $3`,
    [to, sessionId, from],
  );
  if (result.rowCount === 0) {
    throw new WatchPartyError(
      "conflict",
      "The watch party moved on before that could be applied",
    );
  }
  const row = await getWatchPartyRow(sessionId);
  if (!row) {
    throw new WatchPartyError("not_found", "Watch party not found");
  }
  return row;
}

// ------------------------------------------------------------- the co-hosts

/**
 * Promote somebody to co-host, and give them the microphone the role implies.
 *
 * THE SPEAK GRANT IS THE HALF THAT WAS MISSING. A closed floor
 * (`stageMode` other than `everyone`, which is the DEFAULT) denies SPEAK to
 * @everyone and grants it back per member, and `applyGoLiveOptions` does that
 * for `stageMemberIds` at the moment the party goes live. A co-host promoted
 * AFTER that moment was never in that list when it ran, so they arrived with
 * the party's controls and no microphone: they could press Assumir and then
 * not be able to say a word to the room they had just taken over. It is the
 * same grant `inviteToWatchPartyStage` has always done for an invited guest,
 * for the same reason, and it lives here rather than in the route so that no
 * second caller can promote without it.
 *
 * Only while the party is LIVE. A draft's options are a plan, not a rule, and
 * writing channel overwrites for a party nobody has been told about would
 * leave SPEAK bits on a room over a show that never happened.
 */
export async function addWatchPartyCohost(
  row: WatchPartyRow,
  userId: string,
  addedBy: string,
): Promise<void> {
  await getPool().query(
    `INSERT INTO channel_session_cohosts (session_id, user_id, added_by)
     VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
    [row.id, userId, addedBy],
  );
  if (row.server_id && row.status === "live") {
    await grantMemberSpeak(row.channel_id, row.server_id, userId);
  }
}

/**
 * Demote a co-host, and take back the microphone the role was holding open.
 *
 * NOT IF THEY ARE STILL ON THE STAGE BY SOME OTHER ROUTE. A co-host the host
 * had also invited up by hand keeps their SPEAK: the demotion is about who
 * runs the party, and revoking here would silence somebody the host put on
 * the stage on purpose. `removeFromWatchPartyStage` guards the mirror image of
 * this and for the mirror image of the reason.
 */
export async function removeWatchPartyCohost(
  row: WatchPartyRow,
  userId: string,
): Promise<void> {
  await getPool().query(
    `DELETE FROM channel_session_cohosts WHERE session_id = $1 AND user_id = $2`,
    [row.id, userId],
  );
  if (!row.server_id) {
    return;
  }
  // Recomputed AFTER the delete, so this reads the roster the demotion left
  // behind rather than the one it started from.
  const stillOnStage = await stageMemberIds(row);
  if (stillOnStage.includes(userId)) {
    return;
  }
  await revokeMemberSpeak(row.channel_id, row.server_id, userId);
}

/**
 * Hand the party over. The outgoing host becomes a co-host, and the incoming
 * one stops being one.
 *
 * THE OLD HOST IS NOT DROPPED. Handing over is a delegation, not an exit: the
 * person who set the party up usually stays in the room, and demoting them to
 * audience in the same click would take away the controls they are still
 * using. If they want out, they leave.
 *
 * ONE STATEMENT, ONE TRANSACTION. A transfer that inserted the old host and
 * then failed to update the row would leave a party with two co-hosts and the
 * wrong owner, so the three writes go together or not at all.
 */
export async function transferWatchPartyHost(
  sessionId: string,
  newHostId: string,
): Promise<WatchPartyRow> {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const current = await client.query<{ host_user_id: string }>(
      `SELECT host_user_id FROM channel_sessions WHERE id = $1 FOR UPDATE`,
      [sessionId],
    );
    const oldHost = current.rows[0]?.host_user_id;
    if (!oldHost) {
      throw new WatchPartyError("not_found", "Watch party not found");
    }
    if (oldHost === newHostId) {
      await client.query("ROLLBACK");
      const row = await getWatchPartyRow(sessionId);
      if (!row) {
        throw new WatchPartyError("not_found", "Watch party not found");
      }
      return row;
    }
    await client.query(
      `DELETE FROM channel_session_cohosts WHERE session_id = $1 AND user_id = $2`,
      [sessionId, newHostId],
    );
    await client.query(
      `INSERT INTO channel_session_cohosts (session_id, user_id, added_by)
       VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
      [sessionId, oldHost, newHostId],
    );
    await client.query(
      `UPDATE channel_sessions
          SET host_user_id = $2, host_disconnected_at = NULL, updated_at = NOW()
        WHERE id = $1`,
      [sessionId, newHostId],
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
  const row = await getWatchPartyRow(sessionId);
  if (!row) {
    throw new WatchPartyError("not_found", "Watch party not found");
  }
  return row;
}

// -------------------------------------------------- the host's connection

/**
 * The host's last socket went away.
 *
 * Stamped rather than acted on, because "gone" and "gone for good" are
 * different things and the difference is five minutes. `sweepWatchPartyHosts`
 * is what eventually ends the party; this only starts the clock, and only for
 * a party that is actually live. A host who drops while their party is still
 * a draft has simply closed a tab.
 *
 * IDEMPOTENT, AND THE `IS NULL` MATTERS. A person with three tabs closes them
 * one at a time; only the transition from "some socket" to "no socket" starts
 * the clock, and re-stamping on each close would push the deadline forward
 * forever. The caller checks the socket count; this refuses to move a stamp
 * that already exists.
 */
export async function markWatchPartyHostGone(userId: string): Promise<string[]> {
  const result = await getPool().query<{ channel_id: string }>(
    `UPDATE channel_sessions SET host_disconnected_at = NOW()
      WHERE host_user_id = $1 AND status = 'live' AND host_disconnected_at IS NULL
      RETURNING channel_id`,
    [userId],
  );
  return result.rows.map((r) => r.channel_id);
}

/** The host came back. Clears the clock wherever it was running for them. */
export async function markWatchPartyHostBack(
  userId: string,
): Promise<string[]> {
  const result = await getPool().query<{ channel_id: string }>(
    `UPDATE channel_sessions SET host_disconnected_at = NULL
      WHERE host_user_id = $1 AND status = 'live' AND host_disconnected_at IS NOT NULL
      RETURNING channel_id`,
    [userId],
  );
  return result.rows.map((r) => r.channel_id);
}

export interface WatchPartySweepResult {
  /** Parties ended because the host never came back. */
  ended: { sessionId: string; channelId: string }[];
}

/**
 * Called from the minute tick beside the reminder job. Ends every live party
 * whose host has been gone longer than the grace window.
 *
 * THE DECISION IS `resolveWatchPartyHost`, NOT AN INTERVAL IN THE SQL. The
 * unit tests drive that function directly with a fake clock, and a `NOW() -
 * interval '5 minutes'` in here would be a second, untested copy of the same
 * rule that could disagree with the button the co-host is looking at.
 */
export async function sweepWatchPartyHosts(
  now: number = Date.now(),
  graceMs?: number,
): Promise<WatchPartySweepResult> {
  const candidates = await getPool().query<{
    id: string;
    channel_id: string;
    status: WatchPartyPhase;
    host_disconnected_at: Date;
  }>(
    `SELECT id, channel_id, status, host_disconnected_at
       FROM channel_sessions
      WHERE status = 'live' AND host_disconnected_at IS NOT NULL`,
  );
  const ended: { sessionId: string; channelId: string }[] = [];
  for (const row of candidates.rows) {
    const outcome = resolveWatchPartyHost({
      state: row.status,
      hostDisconnectedAt: row.host_disconnected_at.getTime(),
      now,
      graceMs,
    });
    if (outcome !== "end") {
      continue;
    }
    try {
      const moved = await transitionWatchParty(row.id, "ended", "live");
      // PUT THE ROOM BACK, exactly as Encerrar does.
      //
      // This sweep is the ONLY end path that used not to. A party ended by a
      // host pressing Encerrar goes through the state route, which calls
      // `applyWatchPartyOptions`; a party ended by the host's five minutes
      // running out went through this loop, which only flipped the row. So the
      // channel kept the slow mode the party set and kept @everyone denied
      // SPEAK, for good, over a show that ended because somebody's wifi died.
      // It is the same restore, it is idempotent, and it is best effort by
      // construction, so a failure here must not stop the sweep ending the
      // next party.
      try {
        await applyWatchPartyOptions(moved, "ended");
      } catch (restoreError) {
        logEvent("voice.watchPartyRestoreFailed", {
          sessionId: row.id,
          error: String(restoreError),
        });
      }
      ended.push({ sessionId: row.id, channelId: row.channel_id });
    } catch (error) {
      // A host who reconnected between the SELECT and the UPDATE, or a
      // co-host who claimed it, both land here as a conflict. Neither is an
      // error: the party is in better hands than the sweep's.
      if (!(error instanceof WatchPartyError)) {
        throw error;
      }
    }
  }
  return { ended };
}

// -------------------------------------------------- the options, applied

/**
 * MAKE THE CHANNEL MATCH THE PARTY, whatever the party currently says.
 *
 * One reconciler rather than an apply-on-go-live and an undo-on-end, because
 * the options are editable WHILE the party runs and a host changing "quem pode
 * falar" from `everyone` to `hosts_only` mid-show has to take effect for the
 * two hundred people already in the room. Two half-functions would have needed
 * a third for that case, and the third is where they drift.
 *
 * It is idempotent. Call it after go-live, after any options edit, and after
 * the end; it computes what the channel should look like now and moves it
 * there. A call that changes nothing writes nothing, which matters because
 * every overwrite write bumps `permissions_version` and re-resolves every
 * seat in the room.
 *
 * WHAT IT OWNS, precisely, so it never clobbers anything else:
 *  - `channels.slowmode_seconds`, remembering the previous value in
 *    `restore_slowmode_seconds`;
 *  - the SPEAK bit of the @everyone overwrite, and only when it was the one
 *    that set it (`stage_speak_applied`);
 *  - the SPEAK allow bit of a member overwrite for the host, the co-hosts and
 *    anyone invited to the stage.
 *
 * It never touches any other bit of any of those overwrites, and it deletes an
 * overwrite row only when the party is the sole reason it existed.
 *
 * BEST EFFORT, AND IT SAYS SO. A failure here must not stop a host going live
 * or, worse, leave a party stuck live because the end path threw. The party's
 * own state is the truth about the show; this is the room around it.
 */
export async function applyWatchPartyOptions(
  row: WatchPartyRow,
  to: WatchPartyPhase,
): Promise<void> {
  if (to === "live") {
    await applyGoLiveOptions(row);
    return;
  }
  if (to === "ended" || to === "cancelled") {
    await restoreChannelAfterParty(row.id);
  }
}

/**
 * The seam an options edit on a LIVE party calls. Re-reads the row, so a
 * caller does not have to hand it a fresh one, and does nothing at all for a
 * party that is not on air: a draft's options are a plan, not a rule.
 */
export async function reconcileLiveWatchPartyOptions(
  sessionId: string,
): Promise<void> {
  const row = await getWatchPartyRow(sessionId);
  if (!row || row.status !== "live") {
    return;
  }
  await applyGoLiveOptions(row);
}

/** Everyone whose microphone this party is holding open. */
async function stageMemberIds(row: WatchPartyRow): Promise<string[]> {
  const cohosts = await listCohostIds(row.id);
  const invited = await getPool().query<{ user_id: string }>(
    `SELECT user_id FROM channel_session_stage_invites WHERE session_id = $1`,
    [row.id],
  );
  return [
    ...new Set([
      row.host_user_id,
      ...cohosts,
      ...invited.rows.map((r) => r.user_id),
    ]),
  ];
}

async function applyGoLiveOptions(row: WatchPartyRow): Promise<void> {
  const options = parseOptions(row.options);
  const channel = await getPool().query<{
    slowmode_seconds: number | null;
    server_id: string | null;
  }>(`SELECT slowmode_seconds, server_id FROM channels WHERE id = $1`, [
    row.channel_id,
  ]);
  const current = channel.rows[0];
  if (!current) {
    return;
  }

  if (
    options.slowModeSeconds > 0 &&
    options.slowModeSeconds !== (current.slowmode_seconds ?? 0)
  ) {
    const remembered = await getPool().query<{
      restore_slowmode_seconds: number | null;
    }>(
      `SELECT restore_slowmode_seconds FROM channel_sessions WHERE id = $1`,
      [row.id],
    );
    await getPool().query(
      `UPDATE channels SET slowmode_seconds = $2 WHERE id = $1`,
      [row.channel_id, options.slowModeSeconds],
    );
    // Only the FIRST change records what to restore. A host who moves slow
    // mode from 30s to 60s mid-show must still get the channel's original
    // value back at the end, not the 30 they picked an hour ago.
    if (remembered.rows[0]?.restore_slowmode_seconds === null) {
      await getPool().query(
        `UPDATE channel_sessions SET restore_slowmode_seconds = $2 WHERE id = $1`,
        [row.id, current.slowmode_seconds ?? 0],
      );
    }
  }

  if (!current.server_id) {
    return;
  }

  if (stageModeClosesTheFloor(options.stageMode)) {
    const applied = await denyEveryoneSpeak(row.channel_id, current.server_id);
    if (applied) {
      await getPool().query(
        `UPDATE channel_sessions SET stage_speak_applied = TRUE WHERE id = $1`,
        [row.id],
      );
    }
    // Closing the floor must never silence the people running the party. A
    // host who is not the server owner has no short circuit through
    // `computePermissions`, so without this the very act of protecting the
    // room takes the host's own microphone away.
    for (const userId of await stageMemberIds(row)) {
      await grantMemberSpeak(row.channel_id, current.server_id, userId);
    }
  } else {
    // The floor is open again. Undo ours and nothing else.
    await openTheFloor(row, current.server_id);
  }
}

async function restoreChannelAfterParty(sessionId: string): Promise<void> {
  const row = await getWatchPartyRow(sessionId);
  // A CTE, and it has to be one. `UPDATE ... RETURNING` hands back the NEW
  // values, so the obvious version of this returned the nulls it had just
  // written and restored nothing: slow mode stayed on after the party ended,
  // silently, which is exactly the class of bug this repo keeps hitting.
  // Caught by driving the real routes on the local stack, not by a type.
  //
  // The `SELECT` reads the snapshot the `UPDATE` is replacing, so this claims
  // the restore and reads what to restore in one statement: an end that runs
  // twice (a host pressing Encerrar as the host sweep fires) puts the channel
  // back once.
  const result = await getPool().query<{
    channel_id: string;
    restore_slowmode_seconds: number | null;
    stage_speak_applied: boolean;
  }>(
    `WITH previous AS (
       SELECT id, channel_id, restore_slowmode_seconds, stage_speak_applied
         FROM channel_sessions
        WHERE id = $1
          FOR UPDATE
     ), cleared AS (
       UPDATE channel_sessions
          SET restore_slowmode_seconds = NULL, stage_speak_applied = FALSE
        WHERE id = (SELECT id FROM previous)
       RETURNING id
     )
     SELECT channel_id, restore_slowmode_seconds, stage_speak_applied
       FROM previous`,
    [sessionId],
  );
  const claimed = result.rows[0];
  if (!claimed) {
    return;
  }
  if (claimed.restore_slowmode_seconds !== null) {
    await getPool().query(
      `UPDATE channels SET slowmode_seconds = $2 WHERE id = $1`,
      [claimed.channel_id, claimed.restore_slowmode_seconds],
    );
  }
  const channel = await getPool().query<{ server_id: string | null }>(
    `SELECT server_id FROM channels WHERE id = $1`,
    [claimed.channel_id],
  );
  const serverId = channel.rows[0]?.server_id;
  if (!serverId || !row) {
    return;
  }
  if (claimed.stage_speak_applied) {
    await allowEveryoneSpeak(claimed.channel_id, serverId);
  }
  // The member grants go whether or not the floor was closed: an invitation
  // to speak is for the length of one show.
  for (const userId of await stageMemberIds(row)) {
    await revokeMemberSpeak(claimed.channel_id, serverId, userId);
  }
  await getPool().query(
    `DELETE FROM channel_session_stage_invites WHERE session_id = $1`,
    [sessionId],
  );
  await getPool().query(
    `DELETE FROM channel_session_raised_hands WHERE session_id = $1`,
    [sessionId],
  );
}

/** The floor was closed and now is not. Lift ours, leave everything else. */
async function openTheFloor(
  row: WatchPartyRow,
  serverId: string,
): Promise<void> {
  const held = await getPool().query<{ stage_speak_applied: boolean }>(
    `SELECT stage_speak_applied FROM channel_sessions WHERE id = $1`,
    [row.id],
  );
  if (held.rows[0]?.stage_speak_applied) {
    await allowEveryoneSpeak(row.channel_id, serverId);
    await getPool().query(
      `UPDATE channel_sessions SET stage_speak_applied = FALSE WHERE id = $1`,
      [row.id],
    );
  }
  for (const userId of await stageMemberIds(row)) {
    await revokeMemberSpeak(row.channel_id, serverId, userId);
  }
}

// ------------------------------------------------------------- the stage

/** Put one person on the stage of a party whose floor is closed. */
export async function inviteToWatchPartyStage(
  row: WatchPartyRow,
  userId: string,
  invitedBy: string,
): Promise<void> {
  await getPool().query(
    `INSERT INTO channel_session_stage_invites (session_id, user_id, invited_by)
     VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
    [row.id, userId, invitedBy],
  );
  await getPool().query(
    `DELETE FROM channel_session_raised_hands WHERE session_id = $1 AND user_id = $2`,
    [row.id, userId],
  );
  if (row.server_id && row.status === "live") {
    await grantMemberSpeak(row.channel_id, row.server_id, userId);
  }
}

/** Take one person back off the stage. */
export async function removeFromWatchPartyStage(
  row: WatchPartyRow,
  userId: string,
): Promise<void> {
  await getPool().query(
    `DELETE FROM channel_session_stage_invites WHERE session_id = $1 AND user_id = $2`,
    [row.id, userId],
  );
  // The host and the co-hosts are on the stage by role, not by invitation,
  // and taking one of them off would be a demotion wearing the wrong button.
  const byRole = await stageMemberIds(row);
  if (byRole.includes(userId)) {
    return;
  }
  if (row.server_id) {
    await revokeMemberSpeak(row.channel_id, row.server_id, userId);
  }
}

export async function setWatchPartyRaisedHand(
  sessionId: string,
  userId: string,
  raised: boolean,
): Promise<void> {
  if (raised) {
    await getPool().query(
      `INSERT INTO channel_session_raised_hands (session_id, user_id)
       VALUES ($1, $2) ON CONFLICT DO NOTHING`,
      [sessionId, userId],
    );
  } else {
    await getPool().query(
      `DELETE FROM channel_session_raised_hands WHERE session_id = $1 AND user_id = $2`,
      [sessionId, userId],
    );
  }
}

export interface WatchPartyStageRow {
  user_id: string;
  display_name: string;
  avatar_url: string | null;
}

/** The queue, oldest hand first, and who is currently up. */
export async function loadWatchPartyStage(sessionId: string): Promise<{
  invited: WatchPartyStageRow[];
  hands: WatchPartyStageRow[];
}> {
  const invited = await getPool().query<WatchPartyStageRow>(
    `SELECT i.user_id, u.display_name, u.avatar_url
       FROM channel_session_stage_invites i
       JOIN users u ON u.id = i.user_id
      WHERE i.session_id = $1
      ORDER BY i.invited_at ASC`,
    [sessionId],
  );
  const hands = await getPool().query<WatchPartyStageRow>(
    `SELECT h.user_id, u.display_name, u.avatar_url
       FROM channel_session_raised_hands h
       JOIN users u ON u.id = h.user_id
      WHERE h.session_id = $1
      ORDER BY h.raised_at ASC`,
    [sessionId],
  );
  return { invited: invited.rows, hands: hands.rows };
}

/**
 * Deny SPEAK to @everyone on this channel, preserving every other bit of an
 * overwrite that may already be there.
 *
 * Returns false when SPEAK was already denied, which is the case that must
 * NOT be undone later: a channel that was already a stage stays one when the
 * party ends.
 */
async function denyEveryoneSpeak(
  channelId: string,
  serverId: string,
): Promise<boolean> {
  const everyoneId = await getEveryoneRoleId(serverId);
  if (!everyoneId) {
    return false;
  }
  const existing = await getPool().query<{ allow: string; deny: string }>(
    `SELECT allow, deny FROM channel_overwrites
      WHERE channel_id = $1 AND target_type = 'role' AND target_id = $2`,
    [channelId, everyoneId],
  );
  const allow = parsePermissions(existing.rows[0]?.allow ?? "0");
  const deny = parsePermissions(existing.rows[0]?.deny ?? "0");
  if (hasPermission(deny, Permission.SPEAK)) {
    return false;
  }
  await upsertChannelOverwrite(
    channelId,
    serverId,
    "role",
    everyoneId,
    allow & ~Permission.SPEAK,
    deny | Permission.SPEAK,
  );
  await reevaluateVoiceSpeak(serverId);
  return true;
}

async function allowEveryoneSpeak(
  channelId: string,
  serverId: string,
): Promise<void> {
  const everyoneId = await getEveryoneRoleId(serverId);
  if (!everyoneId) {
    return;
  }
  const existing = await getPool().query<{ allow: string; deny: string }>(
    `SELECT allow, deny FROM channel_overwrites
      WHERE channel_id = $1 AND target_type = 'role' AND target_id = $2`,
    [channelId, everyoneId],
  );
  if (existing.rows.length === 0) {
    return;
  }
  const allow = parsePermissions(existing.rows[0].allow);
  const deny = parsePermissions(existing.rows[0].deny) & ~Permission.SPEAK;
  if (allow === 0n && deny === 0n) {
    // The party is the only reason this overwrite existed. Leaving an empty
    // row behind would show a channel as "has overwrites" in the settings
    // for ever after one film night.
    await deleteChannelOverwrite(channelId, serverId, "role", everyoneId);
  } else {
    await upsertChannelOverwrite(
      channelId,
      serverId,
      "role",
      everyoneId,
      allow,
      deny,
    );
  }
  await reevaluateVoiceSpeak(serverId);
}


/**
 * Give one member the SPEAK bit back on this channel, on top of whatever else
 * their overwrite already says.
 *
 * Only the one bit is touched, and an overwrite that already allowed SPEAK is
 * left exactly as it was, so the revoke below cannot take away something the
 * server granted for its own reasons.
 */
async function grantMemberSpeak(
  channelId: string,
  serverId: string,
  userId: string,
): Promise<void> {
  const existing = await getPool().query<{ allow: string; deny: string }>(
    `SELECT allow, deny FROM channel_overwrites
      WHERE channel_id = $1 AND target_type = 'member' AND target_id = $2`,
    [channelId, userId],
  );
  const allow = parsePermissions(existing.rows[0]?.allow ?? "0");
  const deny = parsePermissions(existing.rows[0]?.deny ?? "0");
  if (hasPermission(allow, Permission.SPEAK) && !hasPermission(deny, Permission.SPEAK)) {
    return;
  }
  await upsertChannelOverwrite(
    channelId,
    serverId,
    "member",
    userId,
    allow | Permission.SPEAK,
    deny & ~Permission.SPEAK,
  );
  await reevaluateVoiceSpeak(serverId);
}

async function revokeMemberSpeak(
  channelId: string,
  serverId: string,
  userId: string,
): Promise<void> {
  const existing = await getPool().query<{ allow: string; deny: string }>(
    `SELECT allow, deny FROM channel_overwrites
      WHERE channel_id = $1 AND target_type = 'member' AND target_id = $2`,
    [channelId, userId],
  );
  if (existing.rows.length === 0) {
    return;
  }
  const allow = parsePermissions(existing.rows[0].allow) & ~Permission.SPEAK;
  const deny = parsePermissions(existing.rows[0].deny);
  if (allow === 0n && deny === 0n) {
    // The party is the only reason this overwrite existed. Leaving an empty
    // row behind would show a member as "has overwrites" in the channel
    // settings for ever after one film night.
    await deleteChannelOverwrite(channelId, serverId, "member", userId);
  } else {
    await upsertChannelOverwrite(
      channelId,
      serverId,
      "member",
      userId,
      allow,
      deny,
    );
  }
  await reevaluateVoiceSpeak(serverId);
}

// ------------------------------------------------- the server's party room

/**
 * THE HIDDEN CHANNEL EVERY PARTY RUNS IN, found or made.
 *
 * A watch party is no longer something you create a channel for. The channel
 * still exists, because it is the party's voice room, the key the HLS egress
 * and `channel_sessions` are hung on, and the home of the chat during the
 * show. It is just never listed in the sidebar (`channel-list.tsx` filters the
 * type out), so nobody makes one, names one, or drags one about.
 *
 * ONE PER SERVER, REUSED. Making a fresh channel per party would leak a
 * channel row, a set of overwrites and a chat history every time somebody
 * pressed the button, and after a month of film nights the server's channel
 * table would be mostly ghosts. Reusing one also gives the cardinality Rafael
 * described ("the top container", singular): the partial unique index already
 * allows one active party per channel, so one channel per server means one
 * live party per server, which is what the sidebar block assumes.
 *
 * AN EXISTING `watch_party` CHANNEL IS ADOPTED, not replaced. The type is
 * merged and on main, so a server may already have one (or several) from
 * before this change. The oldest by position then id wins, deterministically,
 * so two people pressing the button at the same moment land in the same room
 * rather than racing to make two. The others keep existing, unlisted and
 * unused, with their history intact; nothing is deleted.
 *
 * THE NAME IS NEVER SHOWN, so it is a constant rather than something derived
 * from the party. It still appears in the audit log and the API, which is why
 * it is a sensible word and not a uuid.
 */
export const WATCH_PARTY_ROOM_NAME = "watch-party";

export async function findOrCreateWatchPartyRoom(
  serverId: string,
): Promise<string> {
  const existing = await getPool().query<{ id: string }>(
    `SELECT id FROM channels
      WHERE server_id = $1 AND type = 'watch_party'
      ORDER BY position ASC, id ASC
      LIMIT 1`,
    [serverId],
  );
  if (existing.rows[0]) {
    return existing.rows[0].id;
  }
  const { createChannel } = await import("./servers.js");
  const created = await createChannel(
    serverId,
    WATCH_PARTY_ROOM_NAME,
    "watch_party",
  );
  return created.id;
}
