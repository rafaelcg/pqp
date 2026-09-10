import { logEvent } from "../lib/log.js";

/**
 * WHETHER A CHANNEL'S WATCH PARTY IS OVER, as far as this process has seen.
 *
 * `pickHlsSharer` asks three questions (`watchParty && sharingScreen &&
 * canStream`) and none of them is "is a party live". That separation is
 * deliberate and documented in `services/watch-parties.ts`: a party is live
 * because somebody pressed Ir ao vivo, a picture exists because somebody is
 * sharing, and conflating them is how you get a party that says LIVE with a
 * black rectangle under it.
 *
 * The half of that nobody argued for is the reverse. **A picture with no
 * party.** A `watch_party` channel is an ordinary voice room between shows, so
 * a host who presses Encerrar and leaves their screen share running keeps a
 * two-rung transcode alive: about 1.4 cores of a four core box that also
 * carries the SFU and the TURN relay, segments written to storage for as long
 * as it runs, and a `channel-live` frame telling every member of the server
 * there is something to watch. Observed in production on 2026-09-09: three
 * `channel_sessions` rows for one channel, all `ended`, the last at 13:24, and
 * a transcode still running at 13:56.
 *
 * FAIL OPEN, AND THAT IS THE WHOLE DESIGN. This records only what it has
 * positively seen END. A channel it knows nothing about transcodes exactly as
 * it does today, so a process that restarted mid-party, a party ended by the
 * no-show sweep (which runs on `pqp-worker`, a different process with a
 * different memory), and any path that never reaches `broadcastWatchParty`
 * all behave as before. The failure this must never have is refusing to
 * transcode a real party, which costs an event; the failure it accepts is
 * missing a leak, which costs a core.
 */
const endedChannels = new Set<string>();

export type WatchPartyLiveListener = (channelId: string) => void;
let changeListener: WatchPartyLiveListener | null = null;

/** `ws/voice.ts` registers its reconcile here, once, when it is imported. */
export function setWatchPartyLiveListener(
  listener: WatchPartyLiveListener | null,
): void {
  changeListener = listener;
}

/**
 * Every watch party state change passes through `broadcastWatchParty`, which
 * is called by every state route and by the no-show sweep, so this is the one
 * place that has to be told.
 *
 * Only `live` clears the mark. A new `draft` in a channel whose last party
 * ended must not clear it: a draft is somebody thinking, and nothing is
 * broadcast until they press the one button.
 */
export function noteWatchPartyState(channelId: string, status: string): void {
  const was = endedChannels.has(channelId);
  if (status === "live") {
    endedChannels.delete(channelId);
  } else if (status === "ended" || status === "cancelled") {
    endedChannels.add(channelId);
  } else {
    return;
  }
  if (endedChannels.has(channelId) === was) {
    return;
  }
  // THE MARK ALONE IS NOT ENOUGH, and this is the half that is easy to leave
  // out. `pushLiveHls` runs on roster events, so a host who presses Encerrar
  // and changes nothing else leaves the transcode running until somebody
  // happens to join or leave the room. Ending a show has to reconcile the
  // stream by itself. Registered by `ws/voice.ts` the same way
  // `setLiveHlsChangeListener` is, because this module must not import the
  // media path it is telling about.
  const listener = changeListener;
  if (!listener) {
    return;
  }
  try {
    listener(channelId);
  } catch (error) {
    logEvent("voice.watchPartyLiveListenerFailed", {
      channelId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/** True only when this process saw the channel's party end and none go live since. */
export function watchPartyKnownOver(channelId: string): boolean {
  return endedChannels.has(channelId);
}

/**
 * The share outlived the party, and the transcode is being stopped for it.
 *
 * Logged where it happens rather than counted, because it is a thing a HOST
 * did (ended the show and kept sharing) and the useful question afterwards is
 * "when, and in which channel", not "how many times".
 */
export function logWatchPartyOverStop(
  channelId: string,
  presenterPeerId: string,
): void {
  logEvent("voice.hlsPartyOver", { channelId, presenterPeerId });
}

/**
 * The marks only. NOT the listener: `ws/voice.ts` registers that once when it
 * is imported, so clearing it here would leave every test after the first one
 * with a mark nothing acts on, which is the shape of a suite that passes while
 * the mechanism is dead.
 */
export function resetWatchPartyLiveForTests(): void {
  endedChannels.clear();
}
