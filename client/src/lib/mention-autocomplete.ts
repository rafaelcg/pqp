/**
 * Finding the `@token` a user is typing.
 *
 * Deliberately not the whole-value regex the slash menu uses: a slash command
 * can only ever start at position 0, while a mention happens anywhere in a
 * sentence, so this has to work from the caret outwards.
 */

/** Mirrors the username half of `MENTION_PATTERN` in @pqp/shared. */
const MENTION_TOKEN_CHAR = /[A-Za-z0-9_]/;
/** Same ceiling as `usernameSchema`; past it the token cannot be a handle. */
const MAX_QUERY_LENGTH = 32;
/** Long lists are a scroll, not a picker. */
const MAX_SUGGESTIONS = 8;

export interface MentionQuery {
  /** Index of the `@`. */
  start: number;
  /** Index just past the token — the caret. */
  end: number;
  /** What has been typed after the `@`, possibly empty. */
  query: string;
}

export interface MentionCandidate {
  id: string;
  displayName: string;
  username?: string | null;
  nickname?: string | null;
  avatarUrl: string | null;
  /** Members win ties with @everyone/@here, which win ties with roles. */
  mentionKind?: "member" | "mass" | "role";
}

/**
 * The active mention token at `caret`, or null when the caret is not inside one.
 * The `@` must start a word: `you@example.com` is an address, not a mention.
 */
export function findMentionQuery(
  value: string,
  caret: number,
): MentionQuery | null {
  const end = Math.max(0, Math.min(caret, value.length));

  for (let index = end; index > 0; index -= 1) {
    if (end - index > MAX_QUERY_LENGTH) {
      return null;
    }
    const char = value[index - 1]!;
    if (char === "@") {
      const preceding = index > 1 ? value[index - 2]! : null;
      if (preceding !== null && !/\s/.test(preceding)) {
        return null;
      }
      return { start: index - 1, end, query: value.slice(index, end) };
    }
    if (!MENTION_TOKEN_CHAR.test(char)) {
      return null;
    }
  }

  return null;
}

/**
 * Members matching the token, best first. Anyone without a username is dropped:
 * the wire format is `@username`, so there is nothing to insert for them.
 */
export function filterMentionCandidates<T extends MentionCandidate>(
  candidates: T[],
  query: string,
  limit = MAX_SUGGESTIONS,
): T[] {
  const needle = query.toLowerCase();

  const scored: Array<{ candidate: T; rank: number }> = [];
  for (const candidate of candidates) {
    if (!candidate.username) {
      continue;
    }
    const username = candidate.username.toLowerCase();
    const displayName = candidate.displayName.toLowerCase();
    const nickname = (candidate.nickname ?? "").toLowerCase();

    if (!needle) {
      const rank =
        candidate.mentionKind === "mass"
          ? 0
          : candidate.mentionKind === "role"
            ? 2
            : 1;
      scored.push({ candidate, rank });
      continue;
    }
    if (username.startsWith(needle)) {
      scored.push({ candidate, rank: 0 });
    } else if (nickname.startsWith(needle) || displayName.startsWith(needle)) {
      scored.push({ candidate, rank: 1 });
    } else if (
      username.includes(needle) ||
      displayName.includes(needle) ||
      nickname.includes(needle)
    ) {
      scored.push({ candidate, rank: 2 });
    }
  }

  return scored
    .sort((a, b) => {
      const byRank = a.rank - b.rank;
      if (byRank !== 0) {
        return byRank;
      }
      const byKind =
        kindOrder(a.candidate.mentionKind) - kindOrder(b.candidate.mentionKind);
      if (byKind !== 0) {
        return byKind;
      }
      return a.candidate.displayName.localeCompare(b.candidate.displayName);
    })
    .slice(0, limit)
    .map((entry) => entry.candidate);
}

function kindOrder(kind: MentionCandidate["mentionKind"]): number {
  if (kind === "mass") {
    return 1;
  }
  if (kind === "role") {
    return 2;
  }
  return 0;
}

export interface MentionInsertion {
  value: string;
  /** Where the caret belongs afterwards. */
  caret: number;
}

/** Replace the active token with `@username `, keeping the rest of the draft. */
export function applyMention(
  value: string,
  active: MentionQuery,
  username: string,
): MentionInsertion {
  const inserted = `@${username} `;
  return {
    value: value.slice(0, active.start) + inserted + value.slice(active.end),
    caret: active.start + inserted.length,
  };
}
