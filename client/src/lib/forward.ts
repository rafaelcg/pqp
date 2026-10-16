import { useSyncExternalStore } from "react";
import {
  FORWARD_MAX_TARGETS,
  forwardBodyComment,
  parseBauPublicPostPath,
  type MessageForward,
} from "@pqp/shared";
import { fetchForwardConfig } from "@/lib/api";
import { onConfigRefresh } from "@/lib/config-refresh";

/**
 * ENCAMINHAR ON THE WEB: the flag, the recent targets, and the small pure
 * rules the card and the picker share. No React tree of its own, so the
 * message menu, the Baú card and the picker all read one answer.
 *
 * The server is the authority (`server/src/services/forwards.ts`). Off, the
 * action is hidden and the old "quote into the composer" behaviour stays;
 * cards already in history keep rendering either way.
 */

// --------------------------------------------------------------- the flag

let enabled = false;
const listeners = new Set<() => void>();

function applyEnabled(next: boolean): void {
  if (next === enabled) {
    return;
  }
  enabled = next;
  for (const listener of listeners) {
    listener();
  }
}

/** Anything but an explicit `true` is off: an older API answers 404. */
export function forwardEnabledFromConfig(answer: { enabled?: unknown }): boolean {
  return answer.enabled === true;
}

let asked = 0;
let applied = 0;

export async function loadForwardConfig(
  fetcher: () => Promise<{ enabled?: unknown }> = fetchForwardConfig,
): Promise<void> {
  asked += 1;
  const mine = asked;
  try {
    const next = forwardEnabledFromConfig(await fetcher());
    if (mine > applied) {
      applied = mine;
      applyEnabled(next);
    }
  } catch {
    // An older API or a blip: keep the last answer.
  }
}

/** Ask now and on every config refresh. Returns the teardown. */
export function startForwardConfig(): () => void {
  void loadForwardConfig();
  const stop = onConfigRefresh(() => {
    void loadForwardConfig();
  });
  return () => {
    stop();
    asked += 1;
    applied = asked;
    applyEnabled(false);
  };
}

export function isForwardEnabled(): boolean {
  return enabled;
}

export function useForwardEnabled(): boolean {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    () => enabled,
    () => enabled,
  );
}

/** Test seam. */
export function setForwardEnabledForTests(on: boolean): void {
  applyEnabled(on);
}

// ------------------------------------------------- opening a card's source

/**
 * The servers this account is in, set by the app. A card whose source server
 * is not among them has nothing to open for this reader: the tap says so
 * instead of doing nothing. Null (not known yet) never blocks a tap, and there
 * is no public page to fall back to until Part 2 puts one on the card.
 */
let memberServerIds: ReadonlySet<string> | null = null;

export function setForwardMemberServers(ids: Iterable<string> | null): void {
  memberServerIds = ids === null ? null : new Set(ids);
}

export function isKnownNonMember(serverId: string): boolean {
  return memberServerIds !== null && !memberServerIds.has(serverId);
}

let notInServerCount = 0;
const notInServerListeners = new Set<() => void>();

/** "Tu não participa desse servidor": bumps a counter the toast watches. */
export function announceNotInServer(): void {
  notInServerCount += 1;
  for (const listener of notInServerListeners) {
    listener();
  }
}

export function useNotInServerCount(): number {
  return useSyncExternalStore(
    (listener) => {
      notInServerListeners.add(listener);
      return () => {
        notInServerListeners.delete(listener);
      };
    },
    () => notInServerCount,
    () => notInServerCount,
  );
}

// ------------------------------------------------------------- the card

/**
 * What of `body` a forwarded message shows above its card: the forwarder's own
 * words, never the fallback line an older client reads. A followed Baú's
 * delivery that pings a role writes `@Role` on its own line above the fallback;
 * that mention line is what shows (`forwardBodyComment`), so the ping reads as
 * a normal role mention over the card.
 */
export function forwardCommentOf(message: {
  body: string;
  forward?: MessageForward | null;
}): string {
  if (!message.forward) {
    return message.body;
  }
  return forwardBodyComment(message.body, message.forward);
}

/**
 * Where a card's `url` opens. A URL on this instance's own origin, or on the
 * hosted origin while a developer runs locally, is a path the router
 * handles; anything else leaves the app.
 */
export function forwardUrlTarget(
  url: string,
  currentOrigin: string,
): { kind: "app"; path: string } | { kind: "external"; href: string } | null {
  try {
    const parsed = new URL(url);
    if (
      (parsed.origin === currentOrigin || parsed.origin === "https://pqp.gg") &&
      parsed.pathname.startsWith("/app/")
    ) {
      return { kind: "app", path: `${parsed.pathname}${parsed.search}${parsed.hash}` };
    }
    if (parsed.protocol === "https:" || parsed.protocol === "http:") {
      return { kind: "external", href: parsed.toString() };
    }
  } catch {
    // fall through
  }
  return null;
}

/**
 * The link a card's Compartilhar button hands out, or null for no button.
 *
 * Only a free Baú post that HAD a public page when the card was made: the
 * snapshot's `url` is that page (`/c/<slug>/p/<id>`, from `getBauPublicUrl`)
 * and only then, so a url that parses as one is exactly the proof, and the
 * client builds no address of its own (an in-app `/app/...` link is a dead end
 * for anyone outside the source). A restricted card, a forwarded chat message
 * and a post with no page get nothing. The snapshot does not follow its source,
 * so a page taken down since reads as the page's own 404 for whoever opens the
 * shared link, the same as any old link to it.
 */
export function forwardShareUrl(forward: MessageForward): string | null {
  if (forward.kind !== "bau_post" || forward.restricted) {
    return null;
  }
  try {
    return parseBauPublicPostPath(new URL(forward.url).pathname) ? forward.url : null;
  } catch {
    return null;
  }
}

// ------------------------------------------------------- recent targets

const RECENT_KEY = "pqp:forward-recents";
export const FORWARD_RECENTS_MAX = 6;

export function readRecentForwardTargets(): string[] {
  try {
    const raw = localStorage.getItem(RECENT_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed)
      ? parsed
          .filter((id): id is string => typeof id === "string")
          .slice(0, FORWARD_RECENTS_MAX)
      : [];
  } catch {
    return [];
  }
}

/** Newest first, no repeats, capped. Pure, so the order is a test. */
export function mergeRecentForwardTargets(
  previous: readonly string[],
  used: readonly string[],
): string[] {
  const next: string[] = [];
  for (const id of [...used, ...previous]) {
    if (!next.includes(id)) {
      next.push(id);
    }
  }
  return next.slice(0, FORWARD_RECENTS_MAX);
}

export function rememberForwardTargets(used: readonly string[]): void {
  try {
    localStorage.setItem(
      RECENT_KEY,
      JSON.stringify(mergeRecentForwardTargets(readRecentForwardTargets(), used)),
    );
  } catch {
    // A private window: recents are a convenience.
  }
}

// ------------------------------------------------------------ the picker

/**
 * The picker's one-line preview of what is being forwarded, as plain text:
 * mention markup (`<@id>`, `<@&id>`, `<#id>`, even a malformed one) is dropped
 * whole, so no raw id is ever shown. The card the recipient gets has the
 * names resolved by the server; this line has no names to resolve and says
 * only what is readable.
 */
export function plainPreviewText(text: string): string {
  return text
    .replace(/<(?:@&|@!|@|#)[^<>\s]*>/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** The most places one forward goes. Shared with the server. */
export const MAX_FORWARD_TARGETS = FORWARD_MAX_TARGETS;

/** What is being forwarded, as the picker needs to know it. */
export type ForwardSourceRequest =
  | {
      kind: "bau_post";
      id: string;
      serverId: string;
      /** For the preview line in the picker. */
      title: string;
      /** Members-only: only this server's channels are offered. */
      restricted: boolean;
    }
  | {
      kind: "message";
      id: string;
      /** The server the message is in, null in a conversation. */
      serverId: string | null;
      title: string;
      /** In a private channel: only this server's channels are offered. */
      restricted: boolean;
    };

export interface PickerTarget {
  /** Stable key: the channel id. */
  id: string;
  kind: "channel" | "conversation";
  serverId: string | null;
  serverName: string | null;
  /** Channel name (no `#`) or the conversation's title. */
  label: string;
  /** A voice room's chat (drawn with a speaker, not a hash). */
  voice?: boolean;
  /** A thread: the channel it hangs off, for the line under its name. */
  threadOf?: string;
  /** For a conversation: who to draw. */
  avatarName?: string;
  avatarUrl?: string | null;
}

/** Case and accent insensitive, the way a person types into a search box. */
export function normalizeForSearch(text: string): string {
  return text
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .trim();
}

/** Whether a target answers to the query: its name, its parent channel's (a thread) or its server's. */
export function targetMatches(target: PickerTarget, query: string): boolean {
  const needle = normalizeForSearch(query);
  if (!needle) {
    return true;
  }
  return (
    normalizeForSearch(target.label).includes(needle) ||
    normalizeForSearch(target.threadOf ?? "").includes(needle) ||
    normalizeForSearch(target.serverName ?? "").includes(needle)
  );
}

/**
 * Whether a restricted source may go to this target. The server decides for
 * real; this keeps the picker from offering what it would refuse.
 */
export function targetAllowedFor(
  source: Pick<ForwardSourceRequest, "restricted" | "serverId">,
  target: Pick<PickerTarget, "serverId">,
): boolean {
  return (
    !source.restricted ||
    (target.serverId !== null && target.serverId === source.serverId)
  );
}
