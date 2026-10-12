import { useSyncExternalStore } from "react";

/**
 * What a screen share gives up first when the link (or the bitrate ceiling)
 * cannot carry the whole picture: frames, or pixels.
 *
 * WHY THIS EXISTS. Every share has always run `contentHint = "motion"` with
 * `degradationPreference: "maintain-framerate"`, which is the right trade for
 * what people mostly share here (a match, a film) and the reason a share no
 * longer turns into a slideshow. Its cost is the other half: under pressure the
 * encoder holds 60 fps and walks the size down, 1080 to 720 to 360, and the
 * presenter has no way to say "I am showing code, keep it sharp and drop
 * frames instead". A 3-star rating on 2026-10-09 said exactly that: 55 to 60 fps
 * the whole call, the picture swinging between 720p and 360p, "no way to
 * control it".
 *
 * TWO CHOICES, NOT THREE. `balanced` exists in WebRTC and was left out on
 * purpose: libwebrtc's balanced table is tuned for cameras, and a third row in
 * a menu that already carries size and frame rate is a row most people cannot
 * tell apart from the other two.
 *
 * NEVER APPLIED TO A WATCH PARTY'S HLS SOURCE. That share feeds an egress that
 * stalls every viewer when the framerate collapses (`video-quality.ts`,
 * `screenShareDegradationPreference`), so it stays on motion whatever is chosen
 * here.
 *
 * PURELY LOCAL, like `receive-quality.ts`: it describes what this person shares
 * from this machine, and needs no thread through the stage's props.
 */

export const SHARE_PRIORITIES = ["motion", "detail"] as const;

export type SharePriority = (typeof SHARE_PRIORITIES)[number];

export const DEFAULT_SHARE_PRIORITY: SharePriority = "motion";

const STORAGE_KEY = "pqp:share-priority";

/** Storage hands back `unknown`; this is the only door in. */
export function parseSharePriority(raw: unknown): SharePriority {
  return SHARE_PRIORITIES.includes(raw as SharePriority)
    ? (raw as SharePriority)
    : DEFAULT_SHARE_PRIORITY;
}

/**
 * The capture track's hint. "detail" also switches VP8/VP9 into their
 * screen-content mode in Chromium, which is what keeps small text legible.
 */
export function sharePriorityContentHint(
  priority: SharePriority,
): "motion" | "detail" {
  return priority === "detail" ? "detail" : "motion";
}

/** What the sender gives up first under pressure. */
export function sharePriorityDegradation(
  priority: SharePriority,
): "maintain-framerate" | "maintain-resolution" {
  return priority === "detail" ? "maintain-resolution" : "maintain-framerate";
}

function readStored(): SharePriority {
  try {
    return parseSharePriority(localStorage.getItem(STORAGE_KEY));
  } catch {
    return DEFAULT_SHARE_PRIORITY;
  }
}

let current: SharePriority | null = null;
const listeners = new Set<(priority: SharePriority) => void>();

export function getSharePriority(): SharePriority {
  if (current === null) {
    current = readStored();
  }
  return current;
}

export function setSharePriority(priority: SharePriority): void {
  const previous = getSharePriority();
  current = priority;
  try {
    localStorage.setItem(STORAGE_KEY, priority);
  } catch {
    // The choice still applies for the session; only the memory of it is lost.
  }
  if (previous === priority) {
    return;
  }
  for (const listener of listeners) {
    listener(priority);
  }
}

export function subscribeSharePriority(
  listener: (priority: SharePriority) => void,
): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Test seam: forget the in-memory copy so the next read hits storage again. */
export function resetSharePriorityForTests(): void {
  current = null;
  listeners.clear();
}

export function useSharePriority(): SharePriority {
  return useSyncExternalStore(subscribeSharePriority, getSharePriority);
}
