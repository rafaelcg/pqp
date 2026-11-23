import { useSyncExternalStore } from "react";
import {
  POPOUT_CORNERS,
  POPOUT_DEFAULT_WIDTH_FRACTION,
  clampWidthFraction,
  type PopoutCorner,
} from "./popout-geometry";

/**
 * Where the person left the share popout, and how big (issue #1736).
 *
 * Device-local, like the call split: it describes this screen, not the person,
 * and a laptop and a big monitor want different answers. Stored as a corner
 * and a fraction of the conversation area's width (`popout-geometry.ts`), so
 * it survives a resized window. Storage that is blocked or full only means the
 * choice lasts for this session.
 */

export interface SharePopoutPref {
  corner: PopoutCorner;
  widthFraction: number;
}

export const DEFAULT_SHARE_POPOUT_PREF: SharePopoutPref = {
  corner: "bottom-right",
  widthFraction: POPOUT_DEFAULT_WIDTH_FRACTION,
};

const STORAGE_KEY = "pqp:share-popout";

let current: SharePopoutPref | null = null;
const listeners = new Set<() => void>();

/** Anything stored that is not a valid preference reads as the default. */
export function parseSharePopoutPref(raw: string | null): SharePopoutPref {
  if (raw === null) {
    return DEFAULT_SHARE_POPOUT_PREF;
  }
  try {
    const value: unknown = JSON.parse(raw);
    if (typeof value !== "object" || value === null) {
      return DEFAULT_SHARE_POPOUT_PREF;
    }
    const record = value as Record<string, unknown>;
    const corner = POPOUT_CORNERS.includes(record.corner as PopoutCorner)
      ? (record.corner as PopoutCorner)
      : DEFAULT_SHARE_POPOUT_PREF.corner;
    const widthFraction =
      typeof record.widthFraction === "number"
        ? clampWidthFraction(record.widthFraction)
        : DEFAULT_SHARE_POPOUT_PREF.widthFraction;
    return { corner, widthFraction };
  } catch {
    return DEFAULT_SHARE_POPOUT_PREF;
  }
}

function ensureLoaded(): SharePopoutPref {
  if (current === null) {
    let raw: string | null = null;
    try {
      raw = localStorage.getItem(STORAGE_KEY);
    } catch {
      raw = null;
    }
    current = parseSharePopoutPref(raw);
  }
  return current;
}

export function sharePopoutPref(): SharePopoutPref {
  return ensureLoaded();
}

export function setSharePopoutPref(next: Partial<SharePopoutPref>): void {
  const previous = ensureLoaded();
  const merged: SharePopoutPref = {
    corner: next.corner ?? previous.corner,
    widthFraction:
      next.widthFraction === undefined
        ? previous.widthFraction
        : clampWidthFraction(next.widthFraction),
  };
  if (
    merged.corner === previous.corner &&
    merged.widthFraction === previous.widthFraction
  ) {
    return;
  }
  current = merged;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(merged));
  } catch {
    // Not stored is still set for this session.
  }
  for (const listener of [...listeners]) {
    listener();
  }
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function useSharePopoutPref(): SharePopoutPref {
  return useSyncExternalStore(subscribe, ensureLoaded, ensureLoaded);
}

/** Test seam: forget the in-memory copy so the next read hits storage again. */
export function resetSharePopoutPrefForTests(): void {
  current = null;
  listeners.clear();
}
