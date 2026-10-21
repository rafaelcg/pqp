import { messageMentionsYou, type MentionCheckMessage } from "@/lib/message-mentions-you";

/**
 * THE CHAT BESIDE AN APP, AND WHETHER IT IS SHOWN (`app_pane_layout_v2`).
 *
 * While an app session is on screen the channel is three things: the app (the
 * stage), the call (if there is one) and the chat. The person may put the chat
 * away to give the app the room, and get it back with the same control. This
 * file is the part of that with no React in it: the stored choice, the unread
 * count shown on the control while the chat is away, and the layout the
 * column takes in each case, so `app-session-layout.tsx` only draws.
 *
 * ONE CHOICE PER DEVICE, NOT PER SESSION. Somebody who hides the chat to play
 * hides it every time they play on that machine, and the phone (where the
 * column is the bottom third of the screen) starts with it away. A per session
 * key would forget the choice at every new session, which is every evening.
 */

export const APP_CHAT_HIDDEN_KEY = "pqp:apps:chat-hidden";

/** The stored choice, or the device default (hidden on a phone) when none. */
export function readAppChatHidden(phone: boolean): boolean {
  try {
    const stored = window.localStorage.getItem(APP_CHAT_HIDDEN_KEY);
    if (stored === "1") return true;
    if (stored === "0") return false;
  } catch {
    // storage blocked: the default stands
  }
  return phone;
}

export function writeAppChatHidden(hidden: boolean): void {
  try {
    window.localStorage.setItem(APP_CHAT_HIDDEN_KEY, hidden ? "1" : "0");
  } catch {
    // storage blocked: the choice lasts this page only
  }
}

export interface UnreadMessage extends MentionCheckMessage {
  id: string;
}

export interface ChatUnread {
  /** Messages from other people since the chat was put away. */
  count: number;
  /** One of them names this person (or @everyone / @here). */
  mention: boolean;
}

export const NO_UNREAD: ChatUnread = { count: 0, mention: false };

/**
 * How far back an update looks for the previous newest message. A burst bigger
 * than this between two renders is not an arrival (it is a page being loaded).
 */
export const UNREAD_APPEND_LIMIT = 50;

/** What the chat toggle has counted so far, and where it last looked. */
export interface UnreadTracker {
  /** The newest message the tracker has seen; null before it has seen any. */
  lastId: string | null;
  unread: ChatUnread;
}

/** A tracker started when the chat goes away: nothing counted, no baseline yet. */
export const FRESH_TRACKER: UnreadTracker = { lastId: null, unread: NO_UNREAD };

/**
 * COUNT ARRIVALS, NOT A RANGE. While the chat is away the toggle counts the
 * messages that arrive: an update whose list ends with new messages right after
 * the newest one seen last time adds those messages, and only those. Anything
 * else (the first list it sees, a page replaced or jumped, history loaded above,
 * a channel opened while away) only moves the baseline and counts nothing: a
 * wrong "37 novas" is worse than a missing dot. No clock is read, so a browser
 * whose time is off cannot shift the line. Own messages never count.
 *
 * Cost: an update with nothing new is one comparison; one with new messages
 * looks back at most `UNREAD_APPEND_LIMIT` messages for the previous newest.
 * Returns `previous` itself when nothing changed, so a caller can keep it.
 */
export function advanceUnread(
  previous: UnreadTracker,
  messages: readonly UnreadMessage[],
  viewer: { id: string | null; username: string | null },
): UnreadTracker {
  // An empty list is a refetch or a page still on its way (another channel
  // gets a fresh tracker from the caller): the boundary waits for it.
  if (messages.length === 0) return previous;
  const newest = messages[messages.length - 1]!.id;
  if (newest === previous.lastId) return previous;
  if (previous.lastId === null) return { lastId: newest, unread: previous.unread };
  const floor = Math.max(0, messages.length - 1 - UNREAD_APPEND_LIMIT);
  let index = -1;
  for (let i = messages.length - 2; i >= floor; i -= 1) {
    if (messages[i]!.id === previous.lastId) {
      index = i;
      break;
    }
  }
  if (index === -1) return { lastId: newest, unread: previous.unread };
  let { count, mention } = previous.unread;
  for (let i = index + 1; i < messages.length; i += 1) {
    const message = messages[i]!;
    if (viewer.id && message.authorId === viewer.id) continue;
    count += 1;
    if (!mention && messageMentionsYou(message, viewer.username, viewer.id)) mention = true;
  }
  return { lastId: newest, unread: { count, mention } };
}

/** "3", "9+": what the badge prints. */
export function unreadBadgeText(count: number): string {
  return count > 9 ? "9+" : String(count);
}

export type AppCallShape = "none" | "compact" | "expanded" | "fullscreen";

export interface AppColumnLayoutInput {
  /** The app is drawn (a seated person, a live session). */
  paneVisible: boolean;
  /** Desktop width (`md` and up): the column is beside the app, not under it. */
  md: boolean;
  chatHidden: boolean;
  /** Connected to this channel's call, so the column carries the call. */
  inCall: boolean;
  /** What the call stage is drawing: a card (`compact`) or pictures. */
  callShape: AppCallShape;
}

export interface AppColumnLayout {
  /**
   * How the app and the column share the body: `row` (column beside the app),
   * `column` (column under it). Only `flex-direction` changes between the two,
   * never the tree, so the call stage keeps its `<video>` bindings.
   */
  direction: "row" | "column";
  /**
   * `side`: the 320 to 352 px column beside the app. `below`: the phone's
   * column under it. `bar`: the chat is away and the call is a card, so the
   * column is a full width bar under the app. `stage`: the chat is away and the
   * call has pictures, which keep the side column. `hidden`: nothing to show
   * (the chat is away and there is no call), the app takes the whole body.
   * `full`: no app on screen, the column is the conversation as always.
   */
  column: "full" | "side" | "below" | "bar" | "stage" | "hidden";
  /** The transcript and composer are put away (the call, if any, stays). */
  chatAway: boolean;
}

export function appColumnLayout(input: AppColumnLayoutInput): AppColumnLayout {
  if (!input.paneVisible) {
    return { direction: "row", column: "full", chatAway: false };
  }
  if (!input.chatHidden) {
    return input.md
      ? { direction: "row", column: "side", chatAway: false }
      : { direction: "column", column: "below", chatAway: false };
  }
  const pictures = input.callShape === "expanded" || input.callShape === "fullscreen";
  if (!input.inCall || input.callShape === "none") {
    return { direction: input.md ? "row" : "column", column: "hidden", chatAway: true };
  }
  if (pictures && input.md) {
    return { direction: "row", column: "stage", chatAway: true };
  }
  // A card (or, on a phone, pictures too): under the app, as wide as it.
  return { direction: "column", column: pictures ? "below" : "bar", chatAway: true };
}
