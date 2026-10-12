import type { DmSummary, Friend, UserStatus } from "@pqp/shared";

/**
 * The contact list's shape, pure so it is tested without a DOM: friends by
 * status in the old order (Disponível, Ocupado, Ausente, Offline), each paired
 * with their 1:1 conversation when one exists, and every other conversation
 * (groups, people who are not friends) under "Outras conversas".
 */

export const CONTACT_GROUP_ORDER = ["online", "dnd", "idle", "offline"] as const;
export type ContactGroupId = UserStatus | "others";

export interface ContactEntry {
  friend: Friend;
  conversation: DmSummary | null;
}

export interface ContactGroup {
  id: UserStatus;
  entries: ContactEntry[];
}

function matches(name: string, query: string): boolean {
  return name
    .toLocaleLowerCase()
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .includes(query);
}

function normalizeQuery(query: string): string {
  return query
    .trim()
    .toLocaleLowerCase()
    .normalize("NFD")
    .replace(/\p{M}/gu, "");
}

export function contactGroups(
  friends: readonly Friend[],
  conversations: readonly DmSummary[],
  query = "",
): { groups: ContactGroup[]; others: DmSummary[] } {
  const q = normalizeQuery(query);
  const oneToOne = new Map<string, DmSummary>();
  for (const conversation of conversations) {
    if (conversation.kind === "dm" && conversation.participants.length === 1) {
      oneToOne.set(conversation.participants[0]!.id, conversation);
    }
  }
  const groups: ContactGroup[] = CONTACT_GROUP_ORDER.map((id) => ({
    id,
    entries: [],
  }));
  const friendIds = new Set<string>();
  for (const friend of friends) {
    friendIds.add(friend.id);
    if (q && !matches(friend.displayName, q)) {
      continue;
    }
    const group = groups.find((one) => one.id === friend.status) ?? groups[3]!;
    group.entries.push({ friend, conversation: oneToOne.get(friend.id) ?? null });
  }
  for (const group of groups) {
    group.entries.sort((a, b) =>
      a.friend.displayName.localeCompare(b.friend.displayName),
    );
  }
  const others = conversations.filter((conversation) => {
    const solo =
      conversation.kind === "dm" && conversation.participants.length === 1
        ? conversation.participants[0]!.id
        : null;
    if (solo && friendIds.has(solo)) {
      return false;
    }
    if (!q) {
      return true;
    }
    return conversation.participants.some((person) =>
      matches(person.displayName, q),
    );
  });
  return { groups, others };
}

/** A recado that starts with a note reads as "Tô ouvindo". */
export function isMusicRecado(recado: string | null | undefined): boolean {
  if (!recado) {
    return false;
  }
  const trimmed = recado.trimStart();
  return trimmed.startsWith("♫") || trimmed.startsWith("🎵") || trimmed.startsWith("♪");
}

export const COLLAPSED_GROUPS_KEY = "pqp-retro-collapsed";

/** Offline starts folded, as it always did. */
export function readCollapsedGroups(): Set<ContactGroupId> {
  try {
    const raw = localStorage.getItem(COLLAPSED_GROUPS_KEY);
    if (raw === null) {
      return new Set<ContactGroupId>(["offline"]);
    }
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      return new Set<ContactGroupId>(["offline"]);
    }
    return new Set(
      parsed.filter((value): value is ContactGroupId =>
        ["online", "dnd", "idle", "offline", "others"].includes(value as string),
      ),
    );
  } catch {
    return new Set<ContactGroupId>(["offline"]);
  }
}

export function storeCollapsedGroups(groups: ReadonlySet<ContactGroupId>): void {
  try {
    localStorage.setItem(COLLAPSED_GROUPS_KEY, JSON.stringify([...groups]));
  } catch {
    // A convenience; the list still works.
  }
}
