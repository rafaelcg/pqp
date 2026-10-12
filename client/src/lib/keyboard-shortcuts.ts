/**
 * The app's keyboard shortcut table.
 *
 * One list of actions and default chords. The overlay, the Settings rows and
 * the window listener all read from here, so a key shown in the map is the
 * same key the handler will fire. Bindings are `KeyBinding` (the PTT type):
 * a physical `code` plus the chord, stored in `pqp-local-settings`.
 *
 * Push-to-talk is listed next to these in the overlay, but it is still a
 * hold-to-talk binding owned by `pushToTalkKey` — it is not a fire-once
 * action in this table.
 */

import {
  isTextEntryTarget,
  matchesBinding,
  parseBinding,
  type KeyBinding,
  type KeyEventLike,
} from "@/components/voice/push-to-talk";

export const SHORTCUT_ACTIONS = [
  "toggleMute",
  "toggleDeafen",
  "openUserSettings",
  "previousChannel",
  "nextChannel",
  "previousUnreadChannel",
  "nextUnreadChannel",
  "toggleOverlay",
  "openNewDm",
] as const;

export type ShortcutAction = (typeof SHORTCUT_ACTIONS)[number];

/** Overlay / Settings grouping. Order is the reading order. */
export const SHORTCUT_GROUPS: ReadonlyArray<{
  id: "voice" | "navigation" | "app";
  actions: readonly ShortcutAction[];
}> = [
  { id: "voice", actions: ["toggleMute", "toggleDeafen"] },
  {
    id: "navigation",
    actions: [
      "previousChannel",
      "nextChannel",
      "previousUnreadChannel",
      "nextUnreadChannel",
    ],
  },
  { id: "app", actions: ["openUserSettings", "toggleOverlay", "openNewDm"] },
];

export type BindableId = ShortcutAction | "pushToTalk";

export type ShortcutOverrides = Partial<Record<ShortcutAction, KeyBinding>>;

function primaryMod(isMac: boolean): Pick<KeyBinding, "ctrl" | "meta"> {
  return { ctrl: !isMac, meta: isMac };
}

/** Discord-style defaults. Cmd on Apple, Ctrl everywhere else. */
export function defaultShortcutBindings(
  isMac: boolean,
): Record<ShortcutAction, KeyBinding> {
  const mod = primaryMod(isMac);
  return {
    toggleMute: {
      code: "KeyM",
      label: "M",
      ...mod,
      alt: false,
      shift: true,
    },
    toggleDeafen: {
      code: "KeyD",
      label: "D",
      ...mod,
      alt: false,
      shift: true,
    },
    openUserSettings: {
      code: "Comma",
      label: ",",
      ...mod,
      alt: false,
      shift: false,
    },
    toggleOverlay: {
      code: "Slash",
      label: "/",
      ...mod,
      alt: false,
      shift: false,
    },
    previousChannel: {
      code: "ArrowUp",
      label: "↑",
      ctrl: false,
      meta: false,
      alt: true,
      shift: false,
    },
    nextChannel: {
      code: "ArrowDown",
      label: "↓",
      ctrl: false,
      meta: false,
      alt: true,
      shift: false,
    },
    previousUnreadChannel: {
      code: "ArrowUp",
      label: "↑",
      ctrl: false,
      meta: false,
      alt: true,
      shift: true,
    },
    nextUnreadChannel: {
      code: "ArrowDown",
      label: "↓",
      ctrl: false,
      meta: false,
      alt: true,
      shift: true,
    },
    // The spec this ships against asked for Cmd/Ctrl+Shift+M — "Ctrl/Cmd+K is
    // taken by search, so Shift+M" — but that chord is already `toggleMute`
    // above, is Electron's own View → Toggle Mute app-menu accelerator (see
    // `electron/main.js`, `CommandOrControl+Shift+M`), and a chord two
    // actions share is a chord `matchShortcut` can only ever resolve to the
    // first of them, so the new one would never fire at all. Shift+N is free
    // everywhere this app runs; see `docs/plans/DM_NOTIFICATIONS_POLISH.md`
    // §2.4 for the ask and this file's history for the correction.
    openNewDm: {
      code: "KeyN",
      label: "N",
      ...mod,
      alt: false,
      shift: true,
    },
  };
}

export function bindingsEqual(a: KeyBinding, b: KeyBinding): boolean {
  return (
    a.code === b.code &&
    a.ctrl === b.ctrl &&
    a.alt === b.alt &&
    a.shift === b.shift &&
    a.meta === b.meta
  );
}

export function parseShortcutOverrides(value: unknown): ShortcutOverrides {
  if (!value || typeof value !== "object") {
    return {};
  }
  const raw = value as Partial<Record<ShortcutAction, unknown>>;
  const next: ShortcutOverrides = {};
  for (const action of SHORTCUT_ACTIONS) {
    const parsed = parseBinding(raw[action]);
    if (parsed) {
      next[action] = parsed;
    }
  }
  return next;
}

export function resolveShortcutBindings(
  overrides: ShortcutOverrides | undefined,
  isMac: boolean,
): Record<ShortcutAction, KeyBinding> {
  return { ...defaultShortcutBindings(isMac), ...overrides };
}

/**
 * Which other row already owns this chord.
 *
 * Used by Settings before a remap is stored, so two actions cannot share a
 * key and the overlay cannot list a lie.
 */
export function findBindingConflict(
  bindings: Partial<Record<BindableId, KeyBinding>>,
  action: BindableId,
  next: KeyBinding,
): BindableId | null {
  for (const [id, binding] of Object.entries(bindings) as Array<
    [BindableId, KeyBinding | undefined]
  >) {
    if (id === action || !binding) {
      continue;
    }
    if (bindingsEqual(binding, next)) {
      return id;
    }
  }
  return null;
}

/**
 * First action whose binding matches this keydown.
 *
 * IME composition and auto-repeat still fail via `matchesBinding`. The
 * text-entry trap only applies to bindings that have neither Ctrl nor Meta:
 * Alt+↑ would steal the caret, and a remapped letter would type into the
 * composer. Discord's mute and deafen chords are Cmd/Ctrl+Shift+M and
 * Cmd/Ctrl+Shift+D, which must fire while the composer is focused.
 */
export function matchShortcut(
  event: KeyEventLike,
  bindings: Record<ShortcutAction, KeyBinding>,
): ShortcutAction | null {
  const typing = isTextEntryTarget(event.target);
  for (const action of SHORTCUT_ACTIONS) {
    const binding = bindings[action];
    if (!matchesBinding(event, binding)) {
      continue;
    }
    if (typing && !binding.ctrl && !binding.meta) {
      continue;
    }
    return action;
  }
  return null;
}

/** The bits of a channel the sidebar order needs. */
export interface NavigableChannel {
  id: string;
  type: string;
  parentId?: string | null;
  position: number;
}

function sortByPosition<T extends { position: number }>(list: T[]): T[] {
  return [...list].sort((a, b) => a.position - b.position);
}

/**
 * Sidebar order without personal pins (those would duplicate) and without
 * category headers. Same grouping ChannelList paints: top-level text,
 * top-level voice, then each category's children.
 *
 * The list the API already filtered is the list the user can see.
 */
export function navigableChannelIds(
  channels: readonly NavigableChannel[],
): string[] {
  const ids: string[] = [];
  // A forum sits in the Texto group with the text channels, as the sidebar
  // draws it, so Alt+arrow walks the list in the order the eye reads it.
  const topLevelText = sortByPosition(
    channels.filter(
      (channel) =>
        (channel.type === "text" || channel.type === "forum") &&
        !channel.parentId,
    ),
  );
  const topLevelVoice = sortByPosition(
    channels.filter((channel) => channel.type === "voice" && !channel.parentId),
  );
  const categories = sortByPosition(
    channels.filter((channel) => channel.type === "category"),
  );
  for (const channel of topLevelText) {
    ids.push(channel.id);
  }
  for (const channel of topLevelVoice) {
    ids.push(channel.id);
  }
  for (const category of categories) {
    const kids = sortByPosition(
      channels.filter(
        (channel) =>
          channel.parentId === category.id && channel.type !== "category",
      ),
    );
    for (const channel of kids) {
      ids.push(channel.id);
    }
  }
  return ids;
}

export function stepChannelId(
  ids: readonly string[],
  currentId: string | null,
  direction: 1 | -1,
): string | null {
  if (ids.length === 0) {
    return null;
  }
  const index = currentId ? ids.indexOf(currentId) : -1;
  if (index === -1) {
    return direction === 1 ? ids[0]! : ids[ids.length - 1]!;
  }
  return ids[(index + direction + ids.length) % ids.length]!;
}

export function stepUnreadChannelId(
  ids: readonly string[],
  currentId: string | null,
  isUnread: (id: string) => boolean,
  direction: 1 | -1,
): string | null {
  const start = currentId ? ids.indexOf(currentId) : -1;
  for (let offset = 1; offset <= ids.length; offset += 1) {
    const index =
      ((start === -1 ? (direction === 1 ? -1 : 0) : start) +
        direction * offset +
        ids.length) %
      ids.length;
    const id = ids[index]!;
    if (isUnread(id) && id !== currentId) {
      return id;
    }
  }
  return null;
}

export function channelIsUnread(
  unread: Readonly<Record<string, { count: number; mentions: number }>>,
  channelId: string,
): boolean {
  const counts = unread[channelId];
  return Boolean(counts && (counts.count > 0 || counts.mentions > 0));
}

// ------------------------------------------------------------------ forum

/**
 * The forum's single keys (the forum UX study, section 3.1). Context keys,
 * not bindings: they mean something only while a forum list or a post is on
 * screen, so they are not rebindable and are not in `SHORTCUT_ACTIONS`. The
 * overlay lists them as their own group (`FORUM_KEY_ROWS`).
 *
 *   list   J / ↓ next, K / ↑ previous, Home / End, Enter / O open,
 *          C new post, / search
 *   post   Esc / U back to the list, R reply
 */
export type ForumKeyAction =
  | "next"
  | "previous"
  | "first"
  | "last"
  | "open"
  | "newPost"
  | "search"
  | "back"
  | "reply";

/** A key event as far as the forum keys need it. */
export interface ForumKeyEventLike {
  key: string;
  ctrlKey: boolean;
  altKey: boolean;
  metaKey: boolean;
  isComposing?: boolean;
  target?: unknown;
}

/**
 * Inside a dialog, a menu or a listbox the arrows and letters belong to that
 * surface: the composer's tag chips, the sort menu, the similar-posts list.
 * `data-forum-keys-off` lets any other surface opt out the same way.
 */
const OWN_KEYBOARD_SURFACES =
  '[role="dialog"], [role="menu"], [role="listbox"], [role="radiogroup"], [data-forum-keys-off]';

function insideOwnKeyboardSurface(target: unknown): boolean {
  const element = target as { closest?: (selector: string) => unknown } | null;
  if (!element || typeof element.closest !== "function") {
    return false;
  }
  return Boolean(element.closest(OWN_KEYBOARD_SURFACES));
}

/**
 * Which forum action this keydown asks for, or null. Never fires while typing
 * (a `j` in the search box is a letter), with Ctrl, Cmd or Alt held (those are
 * the app's own chords, and Alt+arrow is channel navigation), during IME
 * composition, or inside a dialog or a menu. Shift is allowed, so `/` on a
 * layout that needs Shift for it still focuses search.
 */
export function forumKeyAction(
  event: ForumKeyEventLike,
  where: "list" | "post",
): ForumKeyAction | null {
  if (event.ctrlKey || event.metaKey || event.altKey || event.isComposing) {
    return null;
  }
  if (isTextEntryTarget(event.target) || insideOwnKeyboardSurface(event.target)) {
    return null;
  }
  const key = event.key.length === 1 ? event.key.toLowerCase() : event.key;
  if (where === "post") {
    if (key === "Escape" || key === "u") {
      return "back";
    }
    if (key === "r") {
      return "reply";
    }
    return null;
  }
  switch (key) {
    case "j":
    case "ArrowDown":
      return "next";
    case "k":
    case "ArrowUp":
      return "previous";
    case "Home":
      return "first";
    case "End":
      return "last";
    case "Enter":
    case "o":
      return "open";
    case "c":
      return "newPost";
    case "/":
      return "search";
    default:
      return null;
  }
}

export type ForumKeyRowId =
  | "forumMove"
  | "forumOpen"
  | "forumNew"
  | "forumSearch"
  | "forumBack"
  | "forumReply";

/**
 * The overlay's "Fórum" group: what each key does, with the caps to draw.
 * Read by `shortcut-overlay.tsx`; the labels are catalogue keys there.
 */
export const FORUM_KEY_ROWS: ReadonlyArray<{
  id: ForumKeyRowId;
  keys: readonly string[];
}> = [
  { id: "forumMove", keys: ["J", "K"] },
  { id: "forumOpen", keys: ["Enter"] },
  { id: "forumNew", keys: ["C"] },
  { id: "forumSearch", keys: ["/"] },
  { id: "forumBack", keys: ["Esc"] },
  { id: "forumReply", keys: ["R"] },
];
