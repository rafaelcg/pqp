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
 * What arrived after `sinceId` (the newest message when the chat was hidden;
 * null when the channel had none). Own messages never count. A `sinceId` that
 * is no longer in the list (the page was replaced, a jump) counts nothing
 * rather than everything: a wrong "37 novas" is worse than a missing dot.
 */
export function chatUnreadSince(
  messages: readonly UnreadMessage[],
  sinceId: string | null,
  viewer: { id: string | null; username: string | null },
): ChatUnread {
  let start = 0;
  if (sinceId !== null) {
    // From the end: the mark is the newest message when the chat went away, so
    // it sits right before the unread tail.
    let index = -1;
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      if (messages[i]!.id === sinceId) {
        index = i;
        break;
      }
    }
    if (index === -1) return NO_UNREAD;
    start = index + 1;
  }
  let count = 0;
  let mention = false;
  for (let i = start; i < messages.length; i += 1) {
    const message = messages[i]!;
    if (viewer.id && message.authorId === viewer.id) continue;
    count += 1;
    if (!mention && messageMentionsYou(message, viewer.username, viewer.id)) {
      mention = true;
    }
  }
  return { count, mention };
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
