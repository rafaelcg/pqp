import type { StoriesUpdate } from "@pqp/shared";
import { isBusEnabled, publishToCluster, subscribeToCluster } from "../lib/bus.js";
import { listServerMemberIds } from "../services/permissions.js";
import { listFriendIds } from "../services/stories.js";
import { bumpStoryStat } from "../services/story-metrics.js";
import { forEachSocketOfUser } from "./sockets.js";

/**
 * THE `stories-update` FRAME: content-free "refetch this strip".
 *
 * Addressed per person, never to a channel: a server's members, an author's
 * friends, or the author alone. Coalesced so that a burst of posts costs at
 * most one frame per server per 5 s (per author's friends per 5 s, per
 * author's own sockets per 10 s): the first one goes at once, anything inside
 * the window is folded into one trailing frame at its end. Never sent on a
 * view, a reaction or an expiry; clients drop expired rings from `expiresAt`.
 *
 * Crosses instances on `chat.stories`. The publishing process resolves who
 * (member ids are re-read where the frame lands, so each instance reaches its
 * own sockets), and the coalescing happens where the change happened. The
 * worker, which has no sockets, only publishes.
 */

export const STORIES_TOPIC = "chat.stories";
export const SERVER_WINDOW_MS = 5_000;
export const OWN_WINDOW_MS = 10_000;

type Scope =
  | { scope: "server"; serverId: string }
  | { scope: "friends"; authorId: string }
  | { scope: "own"; userId: string };

interface Window {
  /** When the last frame for this key went out. */
  sentAt: number;
  timer: ReturnType<typeof setTimeout> | null;
  removed: Set<string>;
}

const windows = new Map<string, Window>();

function keyOf(target: Scope): string {
  switch (target.scope) {
    case "server":
      return `server:${target.serverId}`;
    case "friends":
      return `friends:${target.authorId}`;
    case "own":
      return `own:${target.userId}`;
  }
}

function windowMs(target: Scope): number {
  return target.scope === "own" ? OWN_WINDOW_MS : SERVER_WINDOW_MS;
}

/**
 * Tell the audience. Never throws and never waits on the network: a lost
 * nudge costs a live update, never data, because the strip is in Postgres.
 */
/** Windows past their length with nothing pending carry no state: drop them. */
function pruneWindows(now: number): void {
  for (const [key, window] of windows) {
    if (!window.timer && now - window.sentAt >= OWN_WINDOW_MS) {
      windows.delete(key);
    }
  }
}

let callsSincePrune = 0;

export function notifyStoriesUpdate(target: Scope, removedStoryIds: string[] = []): void {
  const key = keyOf(target);
  const now = Date.now();
  callsSincePrune += 1;
  if (callsSincePrune >= 100) {
    callsSincePrune = 0;
    pruneWindows(now);
  }
  const existing = windows.get(key);
  if (!existing || now - existing.sentAt >= windowMs(target)) {
    if (existing?.timer) clearTimeout(existing.timer);
    windows.set(key, { sentAt: now, timer: null, removed: new Set() });
    void send(target, removedStoryIds);
    return;
  }
  for (const id of removedStoryIds) existing.removed.add(id);
  if (existing.timer) {
    return;
  }
  existing.timer = setTimeout(
    () => {
      const current = windows.get(key);
      if (!current) return;
      const removed = [...current.removed];
      windows.set(key, { sentAt: Date.now(), timer: null, removed: new Set() });
      void send(target, removed);
    },
    windowMs(target) - (now - existing.sentAt),
  );
  existing.timer.unref?.();
}

/** Every audience of one story: its servers and, when it has one, the friends. */
export function notifyStoryAudiences(
  authorId: string,
  targets: { serverIds: string[]; friends: boolean },
  removedStoryIds: string[] = [],
): void {
  for (const serverId of targets.serverIds) {
    notifyStoriesUpdate({ scope: "server", serverId }, removedStoryIds);
  }
  if (targets.friends) {
    notifyStoriesUpdate({ scope: "friends", authorId }, removedStoryIds);
  }
  // The author's own other tabs and devices redraw "Teu story" too.
  notifyStoriesUpdate({ scope: "own", userId: authorId }, removedStoryIds);
}

interface BusFrame {
  type: "stories-update";
  scope: "server" | "friends" | "own";
  serverId?: string;
  /** friends: the people to tell, resolved where the change happened. own: the author. */
  userIds?: string[];
  removedStoryIds?: string[];
}

async function send(target: Scope, removedStoryIds: string[]): Promise<void> {
  try {
    const frame: StoriesUpdate = {
      type: "stories-update",
      scope: target.scope,
      ...(target.scope === "server" ? { serverId: target.serverId } : {}),
      ...(removedStoryIds.length ? { removedStoryIds: removedStoryIds.slice(0, 50) } : {}),
    };
    if (target.scope === "server") {
      // The other instances resolve their own members, so they are told
      // first: a failed lookup here must not keep the frame from them.
      if (isBusEnabled()) {
        publishToCluster(STORIES_TOPIC, frame satisfies BusFrame);
      }
      deliverToServer(frame, await listServerMemberIds(target.serverId));
      return;
    }
    const userIds =
      target.scope === "friends" ? await listFriendIds(target.authorId) : [target.userId];
    if (isBusEnabled()) {
      publishToCluster(STORIES_TOPIC, { ...frame, userIds } satisfies BusFrame);
    }
    deliverToUsers(userIds, frame);
  } catch (error) {
    console.error(
      "[stories] notify failed:",
      error instanceof Error ? error.message : error,
    );
  }
}

/** Through the per-user socket index: work follows the audience, not the instance. */
function deliverToServer(frame: StoriesUpdate, memberIds: string[]): void {
  deliverToUsers(memberIds, frame);
}

function deliverToUsers(userIds: string[], frame: StoriesUpdate): void {
  const payload = JSON.stringify(frame);
  let sent = 0;
  for (const userId of userIds) {
    forEachSocketOfUser(userId, (socket) => {
      if (socket.readyState === 1) {
        socket.send(payload);
        sent += 1;
      }
    });
  }
  bumpStoryStat("framesSent", sent);
}

subscribeToCluster(STORIES_TOPIC, (data) => {
  const frame = data as Partial<BusFrame> | null;
  if (!frame || frame.type !== "stories-update") {
    return;
  }
  const removed = Array.isArray(frame.removedStoryIds)
    ? frame.removedStoryIds.filter((id): id is string => typeof id === "string").slice(0, 50)
    : [];
  const out: StoriesUpdate = {
    type: "stories-update",
    scope: frame.scope === "friends" || frame.scope === "own" ? frame.scope : "server",
    ...(frame.scope === "server" && typeof frame.serverId === "string"
      ? { serverId: frame.serverId }
      : {}),
    ...(removed.length ? { removedStoryIds: removed } : {}),
  };
  if (out.scope === "server") {
    const serverId = out.serverId;
    if (!serverId) return;
    void listServerMemberIds(serverId)
      .then((memberIds) => deliverToServer(out, memberIds))
      .catch((error: unknown) => {
        console.error("[stories] relay failed:", error instanceof Error ? error.message : error);
      });
    return;
  }
  const userIds = Array.isArray(frame.userIds)
    ? frame.userIds.filter((id): id is string => typeof id === "string")
    : [];
  deliverToUsers(userIds, out);
});

/** Tests only. */
export function resetStoriesNotifyForTests(): void {
  for (const window of windows.values()) {
    if (window.timer) clearTimeout(window.timer);
  }
  windows.clear();
}
