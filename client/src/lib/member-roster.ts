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
 * Status the transcript pip would draw for this author. Same rule
 * `messageAuthors` uses: a missing field is `null`, not "online".
 */
export function authorPipStatus(
  members: readonly Pick<ServerMember, "id" | "status">[],
  authorId: string,
): UserStatus | null {
  return members.find((member) => member.id === authorId)?.status ?? null;
}
