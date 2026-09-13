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
 * PER BROWSER *AND* PER ACCOUNT (2026-09-13, postmortem B7). Still nothing
 * worth a round trip, so still `localStorage` rather than a server column —
 * but a shared computer with `pqp:dev-user-suffix`-style separate accounts,
 * or two people signed into the same browser profile at different times,
 * used to hand the second host whatever the first had picked. She came back
 * on 1080p three times on 2026-09-12 for exactly this reason: the key carried
 * no identity, so the previous host's opt-in outlived the previous host. The
 * storage key now carries the account id (`storageKey` below); `userId: null`
 * (signed out, or a caller with none to give) falls back to the old bare key
 * so the function never throws for want of one.
 *
 * RESET ON EVERY NEW PARTY (`resetWatchPartyStreamQualityForNewParty`). The
 * opt-in is scoped to the share that earned it — a host who confirmed their
 * uplink survives 1080p once must confirm it again for the next show, rather
 * than a stale preference silently reappearing on a worse connection or a
 * different machine's session cache.
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

/** The account-scoped key, or the old bare one when there is no account to scope it to. */
function storageKey(userId: string | null): string {
  return userId ? `${STORAGE_KEY}:${userId}` : STORAGE_KEY;
}

export function readWatchPartyStreamQuality(
  userId: string | null = null,
): WatchPartyStreamQuality {
  try {
    return parseWatchPartyStreamQuality(
      window.localStorage.getItem(storageKey(userId)),
    );
  } catch {
    // Private mode, or storage disabled. The default is a safe share.
    return DEFAULT_WATCH_PARTY_STREAM_QUALITY;
  }
}

export function writeWatchPartyStreamQuality(
  quality: WatchPartyStreamQuality,
  userId: string | null = null,
): void {
  try {
    window.localStorage.setItem(storageKey(userId), quality);
  } catch {
    // Nothing to do: the control still works for this session.
  }
}

/**
 * A fresh party starts back at the safe default, whatever this account chose
 * last time. Called once, from `handleCreateWatchParty`.
 */
export function resetWatchPartyStreamQualityForNewParty(
  userId: string | null,
): void {
  writeWatchPartyStreamQuality(DEFAULT_WATCH_PARTY_STREAM_QUALITY, userId);
}
