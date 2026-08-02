/**
 * Reading what somebody typed into the people picker.
 *
 * Two endpoints answer this box: an exact `name#1234` lookup and a prefix
 * search. Which one a given string wants is a decision worth making in one
 * place — asked the wrong way round, a full handle searches for the literal
 * text `ana#0001` and finds nobody, which reads as "that person does not
 * exist" rather than "you were asked the wrong question".
 */

import {
  parseUserTag,
  USER_SEARCH_MAX_LENGTH,
  USER_SEARCH_MIN_LENGTH,
  type PublicUser,
} from "@pqp/shared";

export type UserQuery =
  | { kind: "idle" }
  | { kind: "tag"; tag: string }
  | { kind: "prefix"; query: string };

/**
 * What to ask for, or nothing at all.
 *
 * `idle` covers everything the server would refuse: too short to be worth
 * matching most of the directory against, and too long to be a handle. Refusing
 * here rather than sending it keeps a typo out of the rate-limit bucket that
 * protects this endpoint from enumeration.
 */
export function readUserQuery(raw: string): UserQuery {
  const parsed = parseUserTag(raw);
  if (parsed) {
    return { kind: "tag", tag: `${parsed.username}#${parsed.discriminator}` };
  }

  // A leading `@` is how people write a handle, and it is not part of one.
  const query = raw.trim().replace(/^@/, "");
  if (
    query.length < USER_SEARCH_MIN_LENGTH ||
    query.length > USER_SEARCH_MAX_LENGTH
  ) {
    return { kind: "idle" };
  }
  return { kind: "prefix", query };
}

/**
 * Drop people the caller has already accounted for — themselves, and anybody
 * already added to the group being assembled.
 *
 * Removed from the list rather than shown greyed out: a result you cannot pick
 * still costs a row and a read, and the one case that matters is your own
 * account, which is never a valid answer to "who do you want to talk to".
 */
export function excludeUsers(
  users: readonly PublicUser[],
  excludedIds: readonly string[],
): PublicUser[] {
  const excluded = new Set(excludedIds);
  return users.filter((user) => !excluded.has(user.id));
}
