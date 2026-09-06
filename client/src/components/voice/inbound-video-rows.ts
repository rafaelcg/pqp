import type { VideoReceiverSample } from "@/lib/voice-stats-probe";

/**
 * Which receiver rows the "Video you receive" readout shows, and in what order.
 *
 * Pure, and separate from the component, because the one bug this readout has
 * shipped was in exactly this filter: it kept only rows with decoded frames or
 * measured bytes, which is the right test for a mesh `getStats()` report (one
 * idle `inbound-rtp` row per video m-line, whether or not anything arrives)
 * and the wrong test for an SFU room, where the sampler had no rows at all and
 * the readout said "nobody is sending you video" over a playing share.
 */

/** A row worth showing: video that is actually arriving from somebody. */
export function isLiveReceiver(sample: VideoReceiverSample): boolean {
  // The transport vouching for the track outranks the counters: an SFU
  // subscription exists only while the server is forwarding it, and for its
  // first second the decoder has nothing to report yet.
  if (sample.attached) {
    return true;
  }
  return (sample.framesDecoded ?? 0) > 0 || (sample.kbps ?? 0) > 0;
}

/**
 * Sorted by peer then role rather than by bitrate, which was the first
 * instinct: a list that reorders itself every two seconds is unreadable, and
 * the busiest stream is not a stable identity.
 */
export function orderReceivers(
  a: VideoReceiverSample,
  b: VideoReceiverSample,
): number {
  const name = (a.displayName ?? a.peerId).localeCompare(
    b.displayName ?? b.peerId,
  );
  return name !== 0 ? name : a.role.localeCompare(b.role);
}

/** The rows the readout renders, from one snapshot's receivers. */
export function liveReceiverRows(
  receivers: VideoReceiverSample[],
): VideoReceiverSample[] {
  return receivers.filter(isLiveReceiver).sort(orderReceivers);
}
