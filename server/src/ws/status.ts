import type { WebSocket } from "ws";
import {
  DEFAULT_MANUAL_STATUS,
  manualStatusSchema,
  type ManualStatus,
  type UserStatus,
} from "@pqp/shared";
import {
  isBusEnabled,
  publishToCluster,
  subscribeToCluster,
} from "../lib/bus.js";
import { getPreferences } from "../services/preferences.js";

/**
 * Per-user status: online / idle / do-not-disturb / offline, plus the invisible
 * choice that resolves to offline for everybody else.
 *
 * SEPARATE FROM `channelPresence` IN chat.ts, WHICH IS A DIFFERENT QUESTION.
 * That map answers "who is looking at channel X right now" and is keyed by
 * channel; this one answers "is this person around at all" and is keyed by user.
 * A person is in exactly one channel's presence and in this registry the whole
 * time they are connected.
 *
 * NOTHING DERIVED IS EVER STORED. `online` is "there is a live socket", `idle`
 * is "every live socket has told us its client went quiet", `offline` is the
 * absence of a socket. A column for any of those would go stale the instant a
 * process died holding the connection, and it would go stale in the direction
 * that matters — showing somebody as present when they are gone. The only thing
 * that reaches Postgres is the manual choice, in `user_preferences.settings`,
 * read once per socket. See `userPreferencesSchema` for why it lives there.
 *
 * THIS IS A PULL SURFACE, NOT A PUSH ONE. There is no `status-update` frame and
 * no subscription. `GET /api/servers/:id/members` resolves status out of this
 * registry, and the members panel re-reads it while it is open. That is a
 * deliberate answer to the fan-out cost: a push design has to reach every member
 * of every server a person shares, so one idle transition at 1,000 concurrent
 * users is a membership query plus a fan-out to hundreds of sockets, tens of
 * times a second, almost all of it delivered to clients with no member list on
 * screen. Pulling makes the cost proportional to the number of people actually
 * *looking* at a member list, which is a much smaller number, and it makes the
 * cost zero when nobody is.
 */

/**
 * The unit that crosses the bus and the unit a merge operates on. Deliberately
 * NOT the resolved `UserStatus`: two instances holding two tabs of one person
 * have to be combined, and "idle here, active there" is only resolvable from the
 * parts.
 */
interface StatusContribution {
  manual: ManualStatus;
  /** True only when every socket this instance holds for the user is idle. */
  idle: boolean;
}

interface LocalEntry {
  /** socket → whether that client has reported itself idle. */
  sockets: Map<WebSocket, boolean>;
  manual: ManualStatus;
}

/** Users with at least one socket on THIS process. */
const local = new Map<string, LocalEntry>();
/** Reverse index so a close handler needs nothing but the socket. */
const socketOwner = new Map<WebSocket, string>();

/**
 * What other instances have told us they are holding: instance id → its whole
 * contribution, with the timestamp it last spoke.
 *
 * Same shape and same reasoning as `remotePresence` in chat.ts — every instance
 * publishes only its own users and every instance merges, so nobody owns a
 * global roster and an instance dying is bounded: its contribution stops being
 * refreshed and ages out. Without the TTL, a SIGKILLed instance would leave
 * every user it was holding showing as online forever, which is the one failure
 * mode a status registry must not have.
 */
const remote = new Map<
  string,
  { users: Map<string, StatusContribution>; at: number }
>();

const STATUS_TOPIC = "status.presence";

/**
 * Re-announce interval and expiry. Matched to the channel-presence pair in
 * chat.ts so the two ageing behaviours cannot drift apart in an operator's head.
 *
 * The cost is one frame per instance per interval — NOT one per user — because
 * the periodic frame is a whole snapshot of this instance's users rather than a
 * per-user heartbeat. At 1,000 concurrent users over four instances that is 4
 * frames every 20 seconds, each carrying ~250 short entries. Real-time changes
 * ride separate one-user `update` frames, so the snapshot is only ever repairing
 * drift and proving liveness.
 */
const STATUS_REFRESH_MS = 20_000;
const STATUS_TTL_MS = 60_000;

// ------------------------------------------------------------------ merging

interface Merged {
  manual: ManualStatus;
  idle: boolean;
}

/**
 * PRIVACY FIRST, THEN THE LOUDER CLAIM. When one person's tabs land on
 * different instances and disagree — which happens for the whole window between
 * a manual change and the frame announcing it — `invisible` wins over
 * everything, and `dnd` wins over `online`. Resolving the other way would make
 * the failure mode of a lost or late frame "briefly visible while asking to be
 * hidden", and a privacy control whose failure mode is exposure is not one.
 */
function strongerManual(a: ManualStatus, b: ManualStatus): ManualStatus {
  if (a === "invisible" || b === "invisible") {
    return "invisible";
  }
  if (a === "dnd" || b === "dnd") {
    return "dnd";
  }
  return "online";
}

function fold(into: Merged | undefined, next: StatusContribution): Merged {
  if (!into) {
    return { manual: next.manual, idle: next.idle };
  }
  return {
    manual: strongerManual(into.manual, next.manual),
    // Idle everywhere or idle nowhere: a person typing in one tab is not away
    // because another tab has been open and untouched since this morning.
    idle: into.idle && next.idle,
  };
}

function externalStatus(merged: Merged | undefined): UserStatus {
  if (!merged) {
    // No socket anywhere in the cluster. This is the only way `offline` is ever
    // produced, and it is why offline needs no storage.
    return "offline";
  }
  if (merged.manual === "invisible") {
    return "offline";
  }
  if (merged.manual === "dnd") {
    // Ahead of idle on purpose: "do not interrupt me" is something the person
    // said, and an inactivity timer must not overwrite it with a guess.
    return "dnd";
  }
  return merged.idle ? "idle" : "online";
}

function localContribution(entry: LocalEntry): StatusContribution {
  let idle = entry.sockets.size > 0;
  for (const socketIsIdle of entry.sockets.values()) {
    if (!socketIsIdle) {
      idle = false;
      break;
    }
  }
  return { manual: entry.manual, idle };
}

/**
 * Walk every live contribution for one user. Remote entries past the TTL are
 * skipped rather than deleted — the sweep in `startClusterStatusRefresh` owns
 * deletion, and a read path that mutates would make every status lookup a write.
 */
function mergedFor(userId: string): Merged | undefined {
  let merged: Merged | undefined;
  const entry = local.get(userId);
  if (entry && entry.sockets.size > 0) {
    merged = fold(merged, localContribution(entry));
  }
  if (isBusEnabled()) {
    const cutoff = Date.now() - STATUS_TTL_MS;
    for (const contribution of remote.values()) {
      if (contribution.at < cutoff) {
        continue;
      }
      const theirs = contribution.users.get(userId);
      if (theirs) {
        merged = fold(merged, theirs);
      }
    }
  }
  return merged;
}

// ------------------------------------------------------------- reading it

/** What any third party may be told about this user. Never `invisible`. */
export function resolveStatus(userId: string): UserStatus {
  return externalStatus(mergedFor(userId));
}

/**
 * The bulk form, for a member list. Builds the cluster-wide view once and then
 * looks each id up in it, so a 500-member server costs one pass over the remote
 * contributions instead of 500.
 */
export function resolveStatuses(
  userIds: readonly string[],
): Map<string, UserStatus> {
  const wanted = new Set(userIds);
  const merged = new Map<string, Merged>();

  for (const [userId, entry] of local) {
    if (entry.sockets.size > 0 && wanted.has(userId)) {
      merged.set(userId, fold(merged.get(userId), localContribution(entry)));
    }
  }
  if (isBusEnabled()) {
    const cutoff = Date.now() - STATUS_TTL_MS;
    for (const contribution of remote.values()) {
      if (contribution.at < cutoff) {
        continue;
      }
      for (const [userId, theirs] of contribution.users) {
        if (wanted.has(userId)) {
          merged.set(userId, fold(merged.get(userId), theirs));
        }
      }
    }
  }

  const out = new Map<string, UserStatus>();
  for (const userId of wanted) {
    out.set(userId, externalStatus(merged.get(userId)));
  }
  return out;
}

/**
 * THE LEAK GUARD. Every surface that would reveal a person's presence without
 * them doing anything has to ask this first — channel presence and typing
 * indicators today; anything passive added later.
 *
 * Uses the cluster-wide merge rather than the local entry so a second tab on
 * another instance cannot un-hide somebody, and because `strongerManual`
 * resolves a disagreement towards hidden.
 */
export function isInvisible(userId: string): boolean {
  return mergedFor(userId)?.manual === "invisible";
}

// ------------------------------------------------------------- writing it

function publishUser(userId: string): void {
  if (!isBusEnabled()) {
    return;
  }
  const entry = local.get(userId);
  publishToCluster(STATUS_TOPIC, {
    kind: "update",
    userId,
    // Null is how the other instances learn to forget this user *here*. Without
    // it, disconnecting would only take effect at the TTL, which is a minute of
    // a person showing online after they closed the tab.
    status: entry && entry.sockets.size > 0 ? localContribution(entry) : null,
  });
}

function addSocket(entry: LocalEntry, socket: WebSocket, userId: string): void {
  socketOwner.set(socket, userId);
  entry.sockets.set(socket, false);
  publishUser(userId);
}

/**
 * Register a freshly authenticated socket. THE MANUAL STATUS IS RESOLVED BEFORE
 * THE SOCKET IS VISIBLE TO ANYTHING — that ordering is the whole reason this is
 * async and not a two-line synchronous insert.
 *
 * Registering first and patching in `invisible` a millisecond later would leave
 * a real window in which somebody who asked to be hidden reads as online, and a
 * privacy control that is briefly wrong every time you open the app is not one.
 * The cost of doing it in this order is that a connection is absent from the
 * registry for the length of one primary-key lookup, which shows as offline —
 * the safe direction.
 *
 * The read happens once per *user*, not once per socket: a second tab finds the
 * entry already there. It is the only database access anywhere in this module.
 */
export async function registerStatusSocket(
  socket: WebSocket,
  userId: string,
): Promise<void> {
  const existing = local.get(userId);
  if (existing) {
    addSocket(existing, socket, userId);
    return;
  }

  let manual: ManualStatus = DEFAULT_MANUAL_STATUS;
  try {
    const parsed = manualStatusSchema.safeParse(
      (await getPreferences(userId)).status,
    );
    if (parsed.success) {
      manual = parsed.data;
    }
  } catch (error) {
    // Not worth refusing a connection over: the person is connected either way.
    // Defaulting to the visible value is the safe direction for availability and
    // the unsafe one for privacy, hence the log — a database blip that silently
    // un-hides people has to be findable afterwards.
    console.error(`[status] could not read manual status for ${userId}:`, error);
  }

  // The socket may have closed while that was in flight; registering it now
  // would leave an entry nothing will ever remove, because its close handler has
  // already run.
  if (socket.readyState !== 1) {
    return;
  }
  // Another tab of the same person may have won the race and created the entry
  // (with the same stored value, from the same read).
  const raced = local.get(userId);
  if (raced) {
    addSocket(raced, socket, userId);
    return;
  }
  const entry: LocalEntry = { sockets: new Map(), manual };
  local.set(userId, entry);
  addSocket(entry, socket, userId);
}

/** Drop a socket. Idempotent — the close path may run more than once. */
export function unregisterStatusSocket(socket: WebSocket): void {
  const userId = socketOwner.get(socket);
  if (!userId) {
    return;
  }
  socketOwner.delete(socket);
  const entry = local.get(userId);
  if (!entry) {
    return;
  }
  entry.sockets.delete(socket);
  if (entry.sockets.size === 0) {
    // The whole entry goes, manual status included. It is not lost — it is in
    // Postgres, and the next socket reads it back. Keeping it cached for a
    // disconnected user would be a slow memory leak keyed by everyone who has
    // ever connected to this process.
    local.delete(userId);
  }
  publishUser(userId);
}

/** A client reporting that its user went quiet, or came back. */
export function setSocketIdle(socket: WebSocket, idle: boolean): void {
  const userId = socketOwner.get(socket);
  if (!userId) {
    return;
  }
  const entry = local.get(userId);
  if (!entry || entry.sockets.get(socket) === idle) {
    // Unchanged: say nothing. A client that re-sends the same value — a
    // reconnect replaying its queue, a buggy timer — must not cost a bus frame.
    return;
  }
  entry.sockets.set(socket, idle);
  publishUser(userId);
}

/**
 * Adopt a manual status the account just chose. Called by the preferences route
 * *after* the write has committed, so the in-memory view can never claim
 * something the database did not accept.
 *
 * THE BUS LEG IS NOT OPTIONAL, and it is a different frame from the ones
 * `publishUser` sends. An HTTP request lands on whichever instance the load
 * balancer picked, which has no relationship at all to the instance holding that
 * person's WebSocket — the two connections are opened minutes apart by different
 * code. Without this, going invisible from a browser whose socket lives on
 * another replica would take effect at the next reconnect: the person would be
 * told they were hidden while every member list still showed them online. That
 * is precisely the "half-working invisibility" failure, and it is invisible in
 * single-instance testing.
 *
 * Published even when nobody here holds a socket for the user, for the same
 * reason: this instance's local state says nothing about where they are.
 */
export function applyManualStatus(userId: string, manual: ManualStatus): void {
  adoptManualStatus(userId, manual);
  if (isBusEnabled()) {
    publishToCluster(STATUS_TOPIC, { kind: "manual", userId, manual });
  }
}

/**
 * The local half, and the only thing a `manual` frame off the bus may call —
 * the same rule chat.ts's handlers follow. It re-publishes an ordinary `update`
 * (via `publishUser`) rather than another `manual`, so a choice propagates in
 * exactly one hop and cannot echo between instances.
 */
function adoptManualStatus(userId: string, manual: ManualStatus): void {
  const entry = local.get(userId);
  if (!entry || entry.manual === manual) {
    // Nobody here is holding a socket for them. Nothing to update: they are
    // already offline on this instance, their choice is in Postgres, and the
    // next socket they open reads it back.
    return;
  }
  entry.manual = manual;
  publishUser(userId);
}

/** Test seam: forget every socket and every remote contribution. */
export function resetStatusRegistry(): void {
  local.clear();
  socketOwner.clear();
  remote.clear();
}

// ------------------------------------------------------------ cluster bus
//
// Inert unless a transport is installed. Same rule as chat.ts: a handler here
// never publishes in response to a frame it received, except for the single
// bounded snapshot answer below, which is only ever triggered by a `hello`.

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * Frames are validated even though they come from our own cluster: a rolling
 * deploy puts two builds on one bus, and a contribution parsed loosely could
 * mark somebody online — or, worse, drop the `invisible` that was keeping them
 * hidden. An entry that does not parse is skipped, never guessed at.
 */
function asContribution(value: unknown): StatusContribution | null {
  const record = asRecord(value);
  if (!record) {
    return null;
  }
  const manual = manualStatusSchema.safeParse(record.manual);
  if (!manual.success || typeof record.idle !== "boolean") {
    return null;
  }
  return { manual: manual.data, idle: record.idle };
}

function snapshotUsers(): Record<string, StatusContribution> {
  const users: Record<string, StatusContribution> = {};
  for (const [userId, entry] of local) {
    if (entry.sockets.size > 0) {
      users[userId] = localContribution(entry);
    }
  }
  return users;
}

function publishSnapshot(hello: boolean): void {
  publishToCluster(STATUS_TOPIC, {
    kind: "snapshot",
    hello,
    users: snapshotUsers(),
  });
}

subscribeToCluster(STATUS_TOPIC, (data, origin) => {
  const frame = asRecord(data);
  if (!frame) {
    return;
  }

  if (frame.kind === "snapshot") {
    const users = asRecord(frame.users);
    if (!users) {
      return;
    }
    const parsed = new Map<string, StatusContribution>();
    for (const [userId, value] of Object.entries(users)) {
      const contribution = asContribution(value);
      if (contribution) {
        parsed.set(userId, contribution);
      }
    }
    // Wholesale replacement, which is the point of a snapshot: it repairs any
    // `update` frame that was dropped while the bus was down, in both
    // directions — a user who should have been removed and one who should have
    // been added.
    remote.set(origin, { users: parsed, at: Date.now() });

    // A booting instance is invisible to its peers until they speak, and their
    // next scheduled snapshot may be a full interval away — twenty seconds of a
    // fresh instance telling every member list that half the cluster is
    // offline. Answering its `hello` closes that window. The answer carries
    // `hello: false`, and only a `hello` is answered, so this terminates after
    // one round trip however many instances are listening.
    if (frame.hello === true && local.size > 0) {
      publishSnapshot(false);
    }
    return;
  }

  if (frame.kind === "manual") {
    // Somebody changed their status over HTTP on another instance. If their
    // socket is here, this is the only thing that will tell us before they
    // reconnect.
    const userId = typeof frame.userId === "string" ? frame.userId : null;
    const manual = manualStatusSchema.safeParse(frame.manual);
    if (!userId || !manual.success) {
      return;
    }
    adoptManualStatus(userId, manual.data);
    return;
  }

  if (frame.kind === "update") {
    const userId = typeof frame.userId === "string" ? frame.userId : null;
    if (!userId) {
      return;
    }
    const contribution =
      frame.status === null ? null : asContribution(frame.status);
    // A malformed non-null status is dropped rather than treated as a removal:
    // guessing "gone" from "unparseable" would flicker somebody offline.
    if (frame.status !== null && !contribution) {
      return;
    }
    const existing = remote.get(origin);
    if (!existing) {
      // First we have heard from this instance. Seed it from this one user
      // rather than ignoring the frame — its snapshot will arrive and replace
      // the map wholesale within an interval.
      if (contribution) {
        remote.set(origin, {
          users: new Map([[userId, contribution]]),
          at: Date.now(),
        });
      }
      return;
    }
    existing.at = Date.now();
    if (contribution) {
      existing.users.set(userId, contribution);
    } else {
      existing.users.delete(userId);
    }
  }
});

/**
 * Announce this instance's users, and forget instances that have stopped
 * announcing theirs.
 *
 * Started only when the bus is on, alongside `startClusterPresenceRefresh`.
 * Without it status would be right for every *clean* transition — connect,
 * disconnect and manual change all publish — and permanently wrong after a
 * crash, because nobody would ever withdraw the dead instance's users. That is
 * exactly the "online forever" failure this whole TTL exists to prevent.
 */
export function startClusterStatusRefresh(
  intervalMs = STATUS_REFRESH_MS,
): () => void {
  publishSnapshot(true);

  const timer = setInterval(() => {
    const cutoff = Date.now() - STATUS_TTL_MS;
    for (const [origin, contribution] of remote) {
      if (contribution.at < cutoff) {
        remote.delete(origin);
      }
    }
    publishSnapshot(false);
  }, intervalMs);
  timer.unref?.();
  return () => clearInterval(timer);
}
