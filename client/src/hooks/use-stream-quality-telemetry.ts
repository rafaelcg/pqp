import { useEffect } from "react";
import { isSampledForStreamQualityTelemetry, STREAM_QUALITY_TELEMETRY_SAMPLE_INTERVAL_MS } from "@pqp/shared";
import type { VoiceRoomTransport } from "@pqp/shared";
import { getAuthToken } from "@/lib/api";
import { sampleVoiceStats } from "@/lib/voice-stats-probe";
import {
  presenterSamplesFromSnapshot,
  sendStreamQualityTelemetry,
  viewerSamplesFromSnapshot,
} from "@/lib/stream-quality-telemetry";

/**
 * Beacons screen-share / watch-party video quality to the server, cheaply
 * and only while there is something to say.
 *
 * COST, BY DESIGN. This ticks once per
 * `STREAM_QUALITY_TELEMETRY_SAMPLE_INTERVAL_MS` (20s) for as long as `active`
 * -- not per frame, not on the same 2s cadence the quality bars use — and
 * `sampleVoiceStats()` is the exact call those bars and `useVoiceLinkQuality`
 * already make every 2s while a call is up, so this adds one extra read of
 * an already-cheap function every 20s, not a new poller. A tick that finds
 * no screen-share row (the overwhelmingly common case: most calls never
 * share a screen) sends nothing at all -- no empty batch, no request.
 *
 * The presenter -- there is at most one or two per room -- is always
 * included. A VIEWER is only included on this browser at all if this user
 * id won the deterministic coin flip in `isSampledForStreamQualityTelemetry`,
 * computed once per mount rather than re-rolled every tick, so a long call
 * does not have a viewer's own samples flicker in and out. This is what
 * keeps a large LiveKit voice channel with a live screen share (every
 * listener gets an inbound video row once someone shares) from turning into
 * one request per viewer per tick -- see `stream-quality-telemetry.ts` in
 * `@pqp/shared` for the full reasoning and the worst-case volume math in the
 * PR that added this.
 */
export function useStreamQualityTelemetry(
  active: boolean,
  transport: VoiceRoomTransport | null,
  userId: string | null,
): void {
  useEffect(() => {
    if (!active || !transport) {
      return;
    }
    const sampleViewerRows = userId
      ? isSampledForStreamQualityTelemetry(userId)
      : false;
    let live = true;
    const tick = () => {
      void sampleVoiceStats().then((snapshot) => {
        if (!live) {
          return;
        }
        const presenter = presenterSamplesFromSnapshot(snapshot.senders, transport);
        const viewer = sampleViewerRows
          ? viewerSamplesFromSnapshot(snapshot.receivers, transport)
          : [];
        const samples = [...presenter, ...viewer];
        if (samples.length === 0) {
          return;
        }
        // Read fresh each tick rather than cached: unlike the HLS telemetry
        // queue, this is not an unload-safety-critical flush (losing one
        // 20s-old usage sample on a tab close is nothing to engineer
        // around), so there is no need for the token-caching dance that
        // exists there.
        void getAuthToken().then((token) => {
          if (!live) {
            return;
          }
          sendStreamQualityTelemetry({ samples }, token);
        });
      });
    };
    tick();
    const id = setInterval(tick, STREAM_QUALITY_TELEMETRY_SAMPLE_INTERVAL_MS);
    return () => {
      live = false;
      clearInterval(id);
    };
  }, [active, transport, userId]);
}
