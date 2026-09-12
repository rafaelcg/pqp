import { WATCH_PARTY_MAX_PUBLISH_HEIGHT } from "@/lib/video-quality";

/**
 * The host's choice of how tall a watch-party share is published, remembered
 * per browser.
 *
 * WHY IT EXISTS (2026-09-12). The HLS egress always subscribes to the TOP
 * published simulcast layer and cannot be told to take a lower one, so it
 * transcodes from whatever the host publishes. A host on a fast uplink
 * publishing 1080 over a long, lossy path (UK presenter to the São Paulo SFU)
 * delivered a 1080 layer riddled with packet loss; the egress logged hundreds
 * of libav macroblock-decode errors per minute and every viewer saw
 * glass-shard corruption. Halving to 720 roughly halves the packet rate and
 * the layer survives the path. There is no per-frame server lever for this —
 * only what the client publishes — and the watch-party UI has no general
 * quality picker, so the host needs one narrow control.
 *
 * TWO CHOICES, DEFAULT 720. `720p` is the safe default a host gets for doing
 * nothing. `1080p` is an explicit opt-in for a host who knows their uplink is
 * fat and close to the box; even then the measured-uplink gate in
 * `hlsSourceTopHeight` still holds a short uplink at 720, so the worst case of
 * an opt-in is a clean 720 rather than the starved 1080 that started this.
 *
 * NO "AUTO". With the uplink gate always applying above 720, a `1080p` choice
 * is already adaptive (it only reaches 1080 when the uplink clears the bar), so
 * a separate Auto would behave identically to 1080p and only add a third label
 * to get wrong.
 *
 * READ AT SHARE START, not live. The egress binds to the published track when
 * the session begins, so a change made mid-share applies to the NEXT share,
 * not the running one. `use-voice.ts` reads this the moment a watch-party
 * share starts; the selector only writes it.
 *
 * Per browser, like the viewer's `pqp:hls-quality` beside it: nothing here is
 * worth a round trip, and one host's choice must not follow them to another
 * machine or bind the room.
 */

export const WATCH_PARTY_STREAM_QUALITIES = ["720p", "1080p"] as const;

export type WatchPartyStreamQuality =
  (typeof WATCH_PARTY_STREAM_QUALITIES)[number];

/**
 * 720p, the safe default. Named off `WATCH_PARTY_MAX_PUBLISH_HEIGHT` so the
 * default height and the default choice can never drift apart.
 */
export const DEFAULT_WATCH_PARTY_STREAM_QUALITY: WatchPartyStreamQuality =
  WATCH_PARTY_MAX_PUBLISH_HEIGHT >= 1080 ? "1080p" : "720p";

const STORAGE_KEY = "pqp:watch-party-stream-quality";

/** The publish ceiling in picture lines a choice names. */
export function watchPartyPublishCeilingHeight(
  quality: WatchPartyStreamQuality,
): number {
  return quality === "1080p" ? 1080 : WATCH_PARTY_MAX_PUBLISH_HEIGHT;
}

/** Storage and query strings hand back `unknown`; this is the only door in. */
export function parseWatchPartyStreamQuality(
  raw: unknown,
): WatchPartyStreamQuality {
  return WATCH_PARTY_STREAM_QUALITIES.includes(raw as WatchPartyStreamQuality)
    ? (raw as WatchPartyStreamQuality)
    : DEFAULT_WATCH_PARTY_STREAM_QUALITY;
}

export function readWatchPartyStreamQuality(): WatchPartyStreamQuality {
  try {
    return parseWatchPartyStreamQuality(
      window.localStorage.getItem(STORAGE_KEY),
    );
  } catch {
    // Private mode, or storage disabled. The default is a safe share.
    return DEFAULT_WATCH_PARTY_STREAM_QUALITY;
  }
}

export function writeWatchPartyStreamQuality(
  quality: WatchPartyStreamQuality,
): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, quality);
  } catch {
    // Nothing to do: the control still works for this session.
  }
}
