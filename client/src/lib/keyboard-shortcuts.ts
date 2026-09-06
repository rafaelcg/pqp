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
  { id: "app", actions: ["openUserSettings", "toggleOverlay"] },
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
  const topLevelText = sortByPosition(
    channels.filter((channel) => channel.type === "text" && !channel.parentId),
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
