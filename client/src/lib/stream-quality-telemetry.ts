import type {
  StreamQualityTelemetryBatch,
  StreamQualityTelemetrySample,
} from "@pqp/shared";
import type { VoiceRoomTransport } from "@pqp/shared";
import { getApiBaseUrl } from "./utils";
import {
  senderIsEncoding,
  type VideoReceiverSample,
  type VideoSenderSample,
} from "./voice-stats-probe";

/**
 * Turns the same `getStats()` readings the console probe and quality bars
 * already compute (`voice-stats-probe.ts`) into the compact samples
 * `POST /api/stream-quality/telemetry` accepts.
 *
 * NO NEW MEASUREMENT. `sampleVoiceStats()` already differences bytes into a
 * bitrate and reads `framesPerSecond` / `qualityLimitationReason` straight
 * off the browser -- this module only selects the SCREEN rows out of a
 * snapshot the app was already producing for the quality bars and the video
 * readout, and reshapes them onto the wire schema. Pure and separately
 * testable so the join between "sender/receiver row" and "telemetry sample"
 * can be checked without a browser.
 */

function knownLimitationReason(
  reason: string | null,
): StreamQualityTelemetrySample["qualityLimitationReason"] {
  if (reason === "none" || reason === "cpu" || reason === "bandwidth" || reason === "other") {
    return reason;
  }
  // `null` (nothing reported yet) or any value this build does not
  // recognise: omitted rather than guessed. WebRTC's own enum has stayed
  // these four values across engines to date; a fifth would arrive here as
  // an unrecognised string and be dropped, not misreported.
  return undefined;
}

/**
 * The PRESENTER's own encode: every screen-share sender that is actually
 * encoding right now (`senderIsEncoding` -- a paused simulcast layer keeps
 * `qualityLimitationReason: bandwidth` at 0 fps/0 kbps, which is not a live
 * reading of anything). This is the only side that ever carries a
 * `qualityLimitationReason`, and the field the whole feature exists to
 * capture: whether a choppy share is bandwidth-starved or CPU/encoder-bound.
 */
export function presenterSamplesFromSnapshot(
  senders: readonly VideoSenderSample[],
  transport: VoiceRoomTransport,
): StreamQualityTelemetrySample[] {
  return senders
    .filter((sender) => sender.role === "screen" && senderIsEncoding(sender))
    .map((sender) => ({
      role: "presenter" as const,
      transport,
      ...(sender.fps !== null ? { fps: sender.fps } : {}),
      ...(sender.kbps !== null ? { kbps: sender.kbps } : {}),
      ...(sender.width !== null ? { width: sender.width } : {}),
      ...(sender.height !== null ? { height: sender.height } : {}),
      ...(() => {
        const reason = knownLimitationReason(sender.limitedBy);
        return reason !== undefined ? { qualityLimitationReason: reason } : {};
      })(),
    }));
}

/**
 * What a VIEWER is actually decoding: every screen-share row arriving on
 * this machine. No `qualityLimitationReason` here -- a receiver has nothing
 * on it that can make the picture bigger (see `voice-stats-probe.ts`'s own
 * doc comment on `VideoReceiverSample`), so this side reports size and rate
 * only.
 */
export function viewerSamplesFromSnapshot(
  receivers: readonly VideoReceiverSample[],
  transport: VoiceRoomTransport,
): StreamQualityTelemetrySample[] {
  return receivers
    .filter((receiver) => receiver.role === "screen")
    .map((receiver) => ({
      role: "viewer" as const,
      transport,
      ...(receiver.fps !== null ? { fps: receiver.fps } : {}),
      ...(receiver.kbps !== null ? { kbps: receiver.kbps } : {}),
      ...(receiver.width !== null ? { width: receiver.width } : {}),
      ...(receiver.height !== null ? { height: receiver.height } : {}),
    }));
}

/**
 * The one POST this feature makes. Fire-and-forget by design, the same
 * convention `sendHlsTelemetryBatch` documents: a rejected or failed batch
 * is a no-op the caller never retries, because this is a measurement and
 * not an event anything downstream is waiting on. A no-op on an empty batch
 * too -- the caller should not produce one (both sampler functions above
 * return `[]` when there is nothing to report), but this stays cheap to call
 * unconditionally regardless.
 */
export function sendStreamQualityTelemetry(
  batch: StreamQualityTelemetryBatch,
  token: string | null,
): void {
  if (batch.samples.length === 0) {
    return;
  }
  fetch(`${getApiBaseUrl()}/api/stream-quality/telemetry`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(batch),
  }).catch(() => {
    // Dropped. See the doc comment above.
  });
}
