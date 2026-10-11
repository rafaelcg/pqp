import { useSyncExternalStore } from "react";

/**
 * Conversas: who is typing in which conversation, for the LIST.
 *
 * The open channel's typing line is the chat controller's (`use-chat.ts`),
 * which drops every frame for any other channel. Since the server addresses a
 * conversation's typing frame to all of its participants (not only to sockets
 * that have it open), the shell hands every `typing-broadcast` here, and the
 * list reads it to say "digitando…" on a row. Same five second life as the
 * open channel's line; a message from the typist ends it at once.
 */

export const LIST_TYPING_TTL_MS = 5_000;

interface Typist {
  name: string;
  expiresAt: number;
}

/** channelId -> userId -> typist */
const typing = new Map<string, Map<string, Typist>>();
let snapshot: ReadonlyMap<string, readonly string[]> = new Map();
const listeners = new Set<() => void>();
let sweep: ReturnType<typeof setTimeout> | null = null;

function rebuild(now: number): void {
  const next = new Map<string, string[]>();
  let soonest = Infinity;
  for (const [channelId, people] of typing) {
    for (const [userId, typist] of people) {
      if (typist.expiresAt <= now) {
        people.delete(userId);
        continue;
      }
      soonest = Math.min(soonest, typist.expiresAt);
      const names = next.get(channelId) ?? [];
      names.push(typist.name);
      next.set(channelId, names);
    }
    if (people.size === 0) {
      typing.delete(channelId);
    }
  }
  snapshot = next;
  for (const listener of listeners) {
    listener();
  }
  if (sweep) {
    clearTimeout(sweep);
    sweep = null;
  }
  if (soonest !== Infinity) {
    sweep = setTimeout(() => rebuild(Date.now()), Math.max(50, soonest - now));
  }
}

/** A `typing-broadcast` arrived. The viewer's own frames are the caller's to drop. */
export function noteListTyping(
  channelId: string,
  userId: string,
  name: string,
  now: number = Date.now(),
): void {
  const people = typing.get(channelId) ?? new Map<string, Typist>();
  people.set(userId, { name, expiresAt: now + LIST_TYPING_TTL_MS });
  typing.set(channelId, people);
  rebuild(now);
}

/** Their message landed: they are not typing any more. */
export function clearListTyping(channelId: string, userId: string): void {
  const people = typing.get(channelId);
  if (people?.delete(userId)) {
    rebuild(Date.now());
  }
}

export function listTypingSnapshot(): ReadonlyMap<string, readonly string[]> {
  return snapshot;
}

/** channelId -> names typing there right now. */
export function useListTyping(): ReadonlyMap<string, readonly string[]> {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    () => snapshot,
    () => snapshot,
  );
}

/** Test seam. */
export function resetListTypingForTests(): void {
  typing.clear();
  if (sweep) {
    clearTimeout(sweep);
    sweep = null;
  }
  snapshot = new Map();
}
