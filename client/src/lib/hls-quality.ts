/**
 * The watch-mode viewer's own rendition choice, remembered between streams
 * and between sessions.
 *
 * WHY IT EXISTS. The stream now carries a ladder (a master playlist with
 * several renditions) and hls.js picks between them on its own, which is the
 * right default: it measures the link and it re-measures it as the link
 * changes. But automatic is not always what the person wants. Someone on
 * mobile data who can see 1080p arriving and does not want to pay for it has
 * no way to say so, and a measurement that is briefly optimistic costs them
 * real money. So: Auto by default, and a deliberate pin that sticks.
 *
 * The pin is stored as a HEIGHT, not as a level index. Indices belong to one
 * master playlist: a restarted egress, a rung refused for budget, or an
 * operator changing `LIVE_HLS_LADDER` all renumber them, and a pin that
 * meant 480p on Tuesday would mean 1080p on Wednesday. A height either
 * exists in the new ladder or it does not, and when it does not the viewer
 * falls back to Auto rather than to a surprise.
 *
 * Per viewer and per browser, like the volume preference beside it: nothing
 * here is worth a round trip, and one person pinning 480p must not pin it
 * for the room.
 */

const STORAGE_KEY = "pqp:hls-quality";

export interface HlsQualityPref {
  /** The rendition height the viewer pinned, or null for Auto. */
  height: number | null;
}

export const AUTO_HLS_QUALITY: HlsQualityPref = { height: null };

/** The subset of an hls.js `Level` this file needs. */
export interface HlsLevelLike {
  height?: number;
  width?: number;
  bitrate?: number;
}

/** Tolerant on purpose: a corrupt or half-written entry is not worth an error. */
export function parseHlsQuality(raw: string | null): HlsQualityPref {
  if (!raw) {
    return AUTO_HLS_QUALITY;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return AUTO_HLS_QUALITY;
  }
  if (!parsed || typeof parsed !== "object") {
    return AUTO_HLS_QUALITY;
  }
  const height = (parsed as Record<string, unknown>).height;
  if (typeof height !== "number" || !Number.isFinite(height) || height <= 0) {
    return AUTO_HLS_QUALITY;
  }
  return { height: Math.round(height) };
}

export function readHlsQuality(): HlsQualityPref {
  try {
    return parseHlsQuality(window.localStorage.getItem(STORAGE_KEY));
  } catch {
    // Private mode, or storage disabled. Auto is a working player.
    return AUTO_HLS_QUALITY;
  }
}

export function writeHlsQuality(pref: HlsQualityPref): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(pref));
  } catch {
    // Nothing to do: the control still works for this session.
  }
}

/**
 * The rungs to offer, tallest first, deduplicated by height.
 *
 * Tallest first because that is how every video player in the world lists
 * them and because Auto sits above the list rather than inside it. A ladder
 * with fewer than two rungs offers nothing: a menu with one entry is a menu
 * that lies about having a choice.
 */
export function offeredHlsLevels(
  levels: readonly HlsLevelLike[],
): { height: number; index: number }[] {
  const seen = new Set<number>();
  const offered: { height: number; index: number }[] = [];
  levels.forEach((level, index) => {
    const height = level.height;
    if (typeof height !== "number" || height <= 0 || seen.has(height)) {
      return;
    }
    seen.add(height);
    offered.push({ height, index });
  });
  return offered.sort((a, b) => b.height - a.height);
}

/**
 * The hls.js level index a preference names, or `-1` for Auto.
 *
 * `-1` is hls.js's own value for "you choose", so this returns exactly what
 * `hls.currentLevel` wants and the caller does no translating. A pinned
 * height that this ladder does not have also comes back as `-1`: the rung
 * was refused for budget, or the ladder changed, and Auto is the honest
 * answer rather than the nearest neighbour, which would silently give
 * someone who asked for 480p a 1080p bill.
 */
export function levelIndexFor(
  levels: readonly HlsLevelLike[],
  pref: HlsQualityPref,
): number {
  if (pref.height === null) {
    return -1;
  }
  const match = offeredHlsLevels(levels).find(
    (level) => level.height === pref.height,
  );
  return match ? match.index : -1;
}

/** `720` becomes `720p`. What the button and the menu rows say. */
export function describeHlsLevel(height: number): string {
  return `${height}p`;
}
