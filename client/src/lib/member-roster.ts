import type { UserStatus } from "@pqp/shared";
import type { ServerMember } from "@/lib/api";

/**
 * Apply a later `GET /api/servers/:id/members` payload to the roster already
 * on screen.
 *
 * Status is a pull from the live socket registry, not a `presence-update`
 * frame. That frame is only `{id, name, avatarUrl}[]` — who is looking at a
 * channel — and must never be fed in here: being in the viewer list is not
 * the same as being online (invisible people exist).
 *
 * Only `status` is patched on people we already know, so a `profile-update`
 * (name / avatar) or a local nickname edit is not wiped by the next poll.
 * The incoming list is still the roster: newcomers are appended, leavers
 * drop. A payload that does not carry `status` leaves the pip alone.
 */
export function mergeMemberStatuses(
  current: readonly ServerMember[],
  incoming: readonly ServerMember[],
): ServerMember[] {
  if (current.length === 0) {
    return incoming.slice();
  }
  const currentById = new Map(current.map((member) => [member.id, member]));
  let changed = current.length !== incoming.length;
  const next = incoming.map((fresh) => {
    const known = currentById.get(fresh.id);
    if (!known) {
      changed = true;
      return fresh;
    }
    if (fresh.status === undefined || fresh.status === known.status) {
      return known;
    }
    changed = true;
    return { ...known, status: fresh.status };
  });
  return changed ? next : (current as ServerMember[]);
}

/**
 * Rosters at most this big are polled with the whole list, exactly as before:
 * their payload is a few KB, and the lean read buys nothing there. Past it, the
 * poll reads `/members/status` (see `readMemberStatusesIfSame`).
 */
export const LEAN_STATUS_POLL_MIN_MEMBERS = 100;

/**
 * Apply a `GET /members/status` answer to the roster on screen.
 *
 * The answer lists only people who are NOT offline, so everybody it does not
 * name is offline (the floor, and what an invisible member resolves to). Only
 * `status` is touched, exactly like `mergeMemberStatuses`, so a name, avatar or
 * local nickname edit is not wiped by the next poll. Returns `current` itself
 * when nothing changed, so React does not re-render a 6000-row list for nothing.
 */
export function applyMemberStatuses<
  T extends { id: string; status?: UserStatus },
>(current: readonly T[], statuses: Readonly<Record<string, UserStatus>>): T[] {
  let changed = false;
  const next = current.map((member) => {
    const status = statuses[member.id] ?? "offline";
    if (member.status === status) {
      return member;
    }
    changed = true;
    return { ...member, status };
  });
  return changed ? next : (current as T[]);
}

/**
 * The lean read, or `null` when it cannot be trusted and the whole list must be
 * read instead.
 *
 * Trusted only when the answer carries the same `roster` token as the list the
 * caller holds and the same member count: that is "nobody joined or left", and
 * with the same people the only thing that can have moved is their status. Any
 * other answer (a different token, a count that disagrees with what is on
 * screen, an API without the route, a failed read) returns `null`, and the caller
 * does what it always did: read `/members`.
 */
export async function readMemberStatusesIfSame(
  read: () => Promise<{
    roster: string;
    count: number;
    statuses: Record<string, UserStatus>;
  }>,
  held: { token: string | null; size: number },
): Promise<Record<string, UserStatus> | null> {
  if (!held.token || held.size <= LEAN_STATUS_POLL_MIN_MEMBERS) {
    return null;
  }
  try {
    const answer = await read();
    if (answer.roster !== held.token || answer.count !== held.size) {
      return null;
    }
    return answer.statuses;
  } catch {
    return null;
  }
}

/**
 * Status the transcript pip would draw for this author. Same rule
 * `messageAuthors` uses: a missing field is `null`, not "online".
 */
export function authorPipStatus(
  members: readonly Pick<ServerMember, "id" | "status">[],
  authorId: string,
): UserStatus | null {
  return members.find((member) => member.id === authorId)?.status ?? null;
}
