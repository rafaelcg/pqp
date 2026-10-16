import { fetchMembers, memberDisplayName } from "@/lib/api";
import { fetchFriends } from "@/components/friends/friends-api";

/**
 * Who a story can @mention: the people who will be able to see it. That is the
 * members of the servers it goes to, and the author's friends when it goes to
 * Amigos. The server checks the same rule when the story is posted (a mention
 * of somebody who cannot see it is refused), so the list only offers what will
 * be accepted.
 */

export interface MentionPerson {
  id: string;
  displayName: string;
  avatarUrl: string | null;
}

/** More than this many servers is a lot of requests for a picker; the first few are enough. */
export const MENTION_SERVER_LIMIT = 3;

export function mergePeople(
  lists: readonly (readonly MentionPerson[])[],
  meId: string,
): MentionPerson[] {
  const seen = new Map<string, MentionPerson>();
  for (const list of lists) {
    for (const person of list) {
      if (person.id !== meId && !seen.has(person.id)) {
        seen.set(person.id, person);
      }
    }
  }
  return [...seen.values()].sort((a, b) => a.displayName.localeCompare(b.displayName));
}

export function filterPeople(people: readonly MentionPerson[], query: string): MentionPerson[] {
  const needle = query.trim().toLowerCase().replace(/^@/, "");
  if (!needle) {
    return [...people];
  }
  return people.filter((person) => person.displayName.toLowerCase().includes(needle));
}

export async function loadMentionPeople(
  audience: { serverIds: readonly string[]; friends: boolean },
  meId: string,
): Promise<MentionPerson[]> {
  const lists: MentionPerson[][] = [];
  const jobs: Promise<void>[] = audience.serverIds.slice(0, MENTION_SERVER_LIMIT).map(async (serverId) => {
    try {
      const { members } = await fetchMembers(serverId);
      lists.push(
        members
          .filter((member) => !member.isCharacter)
          .map((member) => ({ id: member.id, displayName: memberDisplayName(member), avatarUrl: member.avatarUrl })),
      );
    } catch {
      // One server failing to answer leaves the rest of the list.
    }
  });
  if (audience.friends) {
    jobs.push(
      (async () => {
        try {
          const { friends } = await fetchFriends();
          lists.push(friends.map((friend) => ({ id: friend.id, displayName: friend.displayName, avatarUrl: friend.avatarUrl ?? null })));
        } catch {
          // Same.
        }
      })(),
    );
  }
  await Promise.all(jobs);
  return mergePeople(lists, meId);
}
