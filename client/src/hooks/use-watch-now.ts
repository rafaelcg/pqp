import {
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
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
  // THE CLOCK LIVES AS LONG AS THE STRIP IS ON AND THE SOCKET IS UP, AND NO
  // LONGER. A strip that was off watched nothing, so when it comes on every
  // share already running is unknown to it, and a fresh clock (whose grace
  // window covers exactly that) is how "há 0 min" is never said about a film
  // that is an hour in.
  const active = args.enabled && args.connected;
  const clock = useRef<ShareClock | null>(null);
  if (active && clock.current === null) {
    clock.current = new ShareClock(Date.now());
  } else if (!active && clock.current !== null) {
    clock.current = null;
  }

  // Derived once per roster change, not once per render of the app: it walks
  // every peer of every roster the client holds (the clock and the dismissals
  // must know about shares in OTHER servers too, or a switch would make an
  // hour-old share look new). With the strip off it is not computed at all.
  const liveKeys = useMemo(() => {
    if (!args.enabled) {
      return NO_KEYS;
    }
    const keys = watchNowLiveKeys(args.occupancy, args.parties);
    // Idempotent: a second pass over the same keys changes nothing. `active`
    // is read (and so a dependency) because the clock is born, and reborn on a
    // reconnect, outside this memo: it has to be told what is already live the
    // moment it exists, inside its grace window, or the first roster change
    // after the grace would find every running share "new".
    if (active) {
      clock.current?.observe(keys, Date.now());
    }
    return keys;
  }, [args.enabled, active, args.occupancy, args.parties]);
  const joined = useMemo(() => liveKeys.join("|"), [liveKeys]);

  // Keys this tab has seen live, so an end it WITNESSED is forgotten at once
  // while a stale key from storage waits for the rosters to settle.
  const seenLive = useRef(new Set<string>());
  useEffect(() => {
    if (!args.enabled) {
      // A strip that is off says nothing about streams ending.
      return;
    }
    const keys = joined === "" ? [] : joined.split("|");
    for (const key of keys) {
      seenLive.current.add(key);
    }
    const current = clock.current;
    const now = Date.now();
    pruneWatchNowDismissed(keys, {
      settled: current?.settled(now) ?? false,
      seenLive: seenLive.current,
    });
    if (!current || current.settled(now)) {
      return;
    }
    // Nothing may change by the time the rosters have settled (a reload into a
    // room that is empty), so settling is its own moment to look again.
    const timer = window.setTimeout(
      () =>
        pruneWatchNowDismissed(keys, {
          settled: true,
          seenLive: seenLive.current,
        }),
      current.settledInMs(now) + 50,
    );
    return () => window.clearTimeout(timer);
  }, [joined, args.enabled, args.connected]);

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
