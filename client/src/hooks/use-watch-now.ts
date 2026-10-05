import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import {
  loadLiveHlsConfig,
  settledDeploymentLiveHlsConfig,
  useLiveHlsConfig,
  watchLiveHlsConfig,
} from "@/hooks/use-live-hls-config";
import {
  collectWatchNowStreams,
  dismissedWatchNow,
  pruneWatchNowDismissed,
  ShareClock,
  subscribeWatchNowDismissed,
  visibleWatchNowStreams,
  watchNowLiveKeys,
  withObservedStart,
  type WatchNowInput,
  type WatchNowStream,
} from "@/lib/watch-now";

/**
 * `watch_now_banner` for what is on screen: this server's answer, or, with no
 * server (a conversation), the deployment-wide one. Null until the server has
 * answered, which reads as off: a banner that waits for its flag cannot flash.
 */
export function useWatchNowFlag(serverId: string | null): boolean {
  const perServer = useLiveHlsConfig(serverId);
  const [deployment, setDeployment] = useState(
    () => settledDeploymentLiveHlsConfig()?.watchNowBanner === true,
  );
  useEffect(() => {
    if (serverId) {
      return;
    }
    let cancelled = false;
    void loadLiveHlsConfig()
      .then((answer) => {
        if (!cancelled) {
          setDeployment(answer.watchNowBanner === true);
        }
      })
      .catch(() => {
        // Unknown stays off.
      });
    // The refresh pass re-asks this answer too (key ""), so a flag flipped
    // while somebody sits in a conversation follows without a reload.
    const release = watchLiveHlsConfig("", () =>
      setDeployment(settledDeploymentLiveHlsConfig()?.watchNowBanner === true),
    );
    return () => {
      cancelled = true;
      release();
    };
  }, [serverId]);
  return serverId ? perServer?.watchNowBanner === true : deployment;
}

export interface UseWatchNowArgs extends Omit<WatchNowInput, "viewerId"> {
  enabled: boolean;
  viewerId: string | null;
  /** The realtime socket is up: rosters are arriving. The clock starts here. */
  connected: boolean;
  /** The channel on screen; its own stage is already in front of the person. */
  openChannelId: string | null;
}

/**
 * The banner's list. Everything it needs is already in memory: no request, no
 * frame, no timer except the clock the banner itself runs.
 *
 * Two quiet side effects, both about not lying: the clock notes when a share
 * BEGAN under this tab's eyes (so "há 3 min" is only ever said about a share
 * that was witnessed or dated by the server), and dismissals of streams that
 * have ended are forgotten (never before rosters have settled, or a reload in
 * the middle of a film would forget "agora não" while the occupancy was still
 * empty).
 */
export function useWatchNow(args: UseWatchNowArgs): WatchNowStream[] {
  const dismissed = useSyncExternalStore(
    subscribeWatchNowDismissed,
    dismissedWatchNow,
    dismissedWatchNow,
  );
  const clock = useRef<ShareClock | null>(null);
  if (args.connected && clock.current === null) {
    clock.current = new ShareClock(Date.now());
  }

  // With the flag off this is one boolean, not a walk over every roster the
  // client holds on every render of the app.
  const liveKeys = args.enabled
    ? watchNowLiveKeys(args.occupancy, args.parties)
    : NO_KEYS;
  // Idempotent, so safe in render: a second pass over the same keys changes
  // nothing.
  clock.current?.observe(liveKeys, Date.now());

  // Keys this tab has seen live, so an end it WITNESSED is forgotten at once
  // while a stale key from storage waits for the rosters to settle.
  const seenLive = useRef(new Set<string>());
  const joined = liveKeys.join("|");
  useEffect(() => {
    const keys = joined === "" ? [] : joined.split("|");
    for (const key of keys) {
      seenLive.current.add(key);
    }
    pruneWatchNowDismissed(keys, {
      settled: clock.current?.settled(Date.now()) ?? false,
      seenLive: seenLive.current,
    });
  }, [joined]);

  let list: WatchNowStream[] = EMPTY;
  if (args.enabled && args.viewerId) {
    const collected = collectWatchNowStreams({
      viewerId: args.viewerId,
      scope: args.scope,
      occupancy: args.occupancy,
      parties: args.parties,
      channelLive: args.channelLive,
      blocked: args.blocked,
      canConnect: args.canConnect,
      seatedChannelId: args.seatedChannelId,
    });
    const dated = clock.current
      ? withObservedStart(collected, clock.current)
      : collected;
    list = visibleWatchNowStreams(dated, {
      openChannelId: args.openChannelId,
      dismissed,
    });
  }
  // The same list, by value, is the same array: the banner keeps what it was
  // showing through every unrelated render of the app.
  const signature = JSON.stringify(list);
  const last = useRef<{ signature: string; list: WatchNowStream[] }>({
    signature: "[]",
    list: EMPTY,
  });
  if (last.current.signature !== signature) {
    last.current = { signature, list };
  }
  return last.current.list;
}

const EMPTY: WatchNowStream[] = [];
const NO_KEYS: string[] = [];
