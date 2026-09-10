/**
 * How the message list is drawn: density, body font size and the gap above a
 * new message group.
 *
 * The values are published as CSS custom properties on the root element and a
 * `data-density` attribute, so the message list and the preview block in
 * Settings both follow a change the moment it happens. Own storage key so the
 * boot script can paint the right size before the bundle loads.
 */

import type { ChatDisplayPreferences } from "@pqp/shared";
import { queuePreferenceSync } from "@/lib/preferences";

export type ChatDensity = "cozy" | "compact";

export interface ChatDisplay {
  density: ChatDensity;
  /** Body size in CSS pixels. */
  fontSize: number;
  /** Space above a new group, in pixels. */
  groupSpacing: number;
}

export const CHAT_DISPLAY_STORAGE_KEY = "pqp-chat-display";

export const CHAT_FONT_SIZE_MIN = 12;
export const CHAT_FONT_SIZE_MAX = 24;
export const CHAT_GROUP_SPACING_MIN = 0;
export const CHAT_GROUP_SPACING_MAX = 24;

/** The list as it has always been drawn: 15px on a 22px line, 8px between groups. */
export const DEFAULT_CHAT_DISPLAY: ChatDisplay = {
  density: "cozy",
  fontSize: 15,
  groupSpacing: 8,
};

/** The list's line height has always been 22/15 of its font size. */
const LINE_HEIGHT_RATIO = 22 / 15;

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, Math.round(value)));
}

function isDensity(value: unknown): value is ChatDensity {
  return value === "cozy" || value === "compact";
}

/** Fill a partial (a stored blob, a server patch) against the defaults. */
export function normalizeChatDisplay(
  input: Partial<ChatDisplay> | ChatDisplayPreferences | null | undefined,
  base: ChatDisplay = DEFAULT_CHAT_DISPLAY,
): ChatDisplay {
  return {
    density: isDensity(input?.density) ? input.density : base.density,
    fontSize: clampInt(
      input?.fontSize,
      CHAT_FONT_SIZE_MIN,
      CHAT_FONT_SIZE_MAX,
      base.fontSize,
    ),
    groupSpacing: clampInt(
      input?.groupSpacing,
      CHAT_GROUP_SPACING_MIN,
      CHAT_GROUP_SPACING_MAX,
      base.groupSpacing,
    ),
  };
}

export function lineHeightFor(fontSize: number): number {
  return Math.round(fontSize * LINE_HEIGHT_RATIO);
}

export function readStoredChatDisplay(): Partial<ChatDisplay> | null {
  try {
    const raw = localStorage.getItem(CHAT_DISPLAY_STORAGE_KEY);
    if (!raw) {
      return null;
    }
    const parsed: unknown = JSON.parse(raw);
    return parsed !== null && typeof parsed === "object"
      ? (parsed as Partial<ChatDisplay>)
      : null;
  } catch {
    return null;
  }
}

export function storeChatDisplay(display: ChatDisplay): void {
  try {
    localStorage.setItem(CHAT_DISPLAY_STORAGE_KEY, JSON.stringify(display));
  } catch {
    // Persistence is a convenience.
  }
}

/**
 * Publish the display to the DOM. The boot script in `index.html` does the
 * same three writes from the stored blob, so keep the two in step.
 */
export function applyChatDisplay(display: ChatDisplay): void {
  if (typeof document === "undefined") {
    return;
  }
  const root = document.documentElement;
  root.style.setProperty("--chat-font-size", `${display.fontSize}px`);
  root.style.setProperty(
    "--chat-line-height",
    `${lineHeightFor(display.fontSize)}px`,
  );
  root.style.setProperty("--chat-group-gap", `${display.groupSpacing}px`);
  if (display.density === "compact") {
    root.dataset.density = "compact";
  } else {
    delete root.dataset.density;
  }
}

const listeners = new Set<() => void>();

let state: ChatDisplay = normalizeChatDisplay(readStoredChatDisplay());

export function getChatDisplay(): ChatDisplay {
  return state;
}

export function subscribeChatDisplay(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function commit(next: ChatDisplay): void {
  if (
    next.density === state.density &&
    next.fontSize === state.fontSize &&
    next.groupSpacing === state.groupSpacing
  ) {
    return;
  }
  state = next;
  storeChatDisplay(next);
  applyChatDisplay(next);
  for (const listener of listeners) {
    listener();
  }
}

/**
 * A user change. `immediate` is for the density toggle, one click; the two
 * sliders emit per pixel and ride the debounce.
 */
export function setChatDisplay(
  patch: Partial<ChatDisplay>,
  { immediate = false }: { immediate?: boolean } = {},
): void {
  const next = normalizeChatDisplay(patch, state);
  commit(next);
  queuePreferenceSync({ chatDisplay: next }, { immediate });
}

/** A value that arrived from the server. Applied locally, never sent back. */
export function adoptChatDisplay(patch: ChatDisplayPreferences): void {
  commit(normalizeChatDisplay(patch, state));
}

if (typeof document !== "undefined") {
  applyChatDisplay(state);
}
