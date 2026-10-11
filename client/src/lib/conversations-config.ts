import { useSyncExternalStore } from "react";
import { apiFetch } from "@/lib/api";
import { onConfigRefresh } from "@/lib/config-refresh";

/**
 * CONVERSAS: which presentation of conversations to draw.
 *
 * Two runtime flags (global, off by default; `docs/FEATURE_FLAGS.md`),
 * answered by `GET /api/dms/config`:
 *
 * - `home` (`conversations_home`): the labelled rail door with the people
 *   waiting under it, WhatsApp-style rows, Nova conversa with friends listed,
 *   Ctrl/Cmd+K "ir pra".
 * - `phoneTabs` (`conversations_home_phone_tabs`): on a phone-width window,
 *   the bottom bar Conversas / Servidores / Tu instead of the server rail.
 *   The server already answers it false while `home` is off; this file says
 *   so again so an API that forgot cannot turn on half a layout.
 *
 * Off, nothing on screen differs from before. Asked once the age gate has
 * passed and again on every config refresh, so a flip reaches open tabs on
 * focus or within ten minutes.
 */

export interface ConversationsConfig {
  home: boolean;
  phoneTabs: boolean;
}

const OFF: ConversationsConfig = { home: false, phoneTabs: false };

let current: ConversationsConfig = OFF;
const listeners = new Set<() => void>();

function apply(next: ConversationsConfig): void {
  if (next.home === current.home && next.phoneTabs === current.phoneTabs) {
    return;
  }
  current = next;
  for (const listener of listeners) {
    listener();
  }
}

/** Anything but an explicit `true` is off: an older API (404) sends nothing. */
export function conversationsConfigFrom(answer: {
  home?: unknown;
  phoneTabs?: unknown;
}): ConversationsConfig {
  const home = answer.home === true;
  return { home, phoneTabs: home && answer.phoneTabs === true };
}

export const fetchConversationsConfig = () =>
  apiFetch<{ home?: boolean; phoneTabs?: boolean }>("/api/dms/config");

/**
 * Asks can overlap (the first read and a focus refresh); only an answer newer
 * than the last one applied counts, so a slow stale `true` cannot undo a flip.
 */
let asked = 0;
let applied = 0;

export async function loadConversationsConfig(
  fetcher: () => Promise<{ home?: unknown; phoneTabs?: unknown }> = fetchConversationsConfig,
): Promise<void> {
  asked += 1;
  const mine = asked;
  try {
    const next = conversationsConfigFrom(await fetcher());
    if (mine > applied) {
      applied = mine;
      apply(next);
    }
  } catch {
    // An older API (404) or a blip: keep the last answer, and do not let an
    // even older ask that is still in flight apply after this one.
    if (mine > applied) {
      applied = mine;
    }
  }
}

/** Ask now and on every config refresh. Returns the teardown. */
export function startConversationsConfig(): () => void {
  void loadConversationsConfig();
  const stop = onConfigRefresh(() => {
    void loadConversationsConfig();
  });
  return () => {
    stop();
    // The answer belongs to the account that asked.
    asked += 1;
    applied = asked;
    apply(OFF);
  };
}

export function conversationsConfig(): ConversationsConfig {
  return current;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function useConversationsConfig(): ConversationsConfig {
  return useSyncExternalStore(subscribe, () => current, () => OFF);
}

/** The desktop half; most call sites only need this one bit. */
export function useConversationsHome(): boolean {
  return useConversationsConfig().home;
}

/** Test seam. */
export function setConversationsConfigForTests(next: Partial<ConversationsConfig>): void {
  apply(conversationsConfigFrom({ ...current, ...next }));
}
