import { useEffect, useState } from "react";
import { useTranslation } from "@/lib/i18n";
import {
  sampleVoiceStats,
  type VideoReceiverSample,
} from "@/lib/voice-stats-probe";

/**
 * What is ARRIVING, in words, for the person who cannot change it.
 *
 * WHY THIS EXISTS, AND WHY IT IS NOT A CONTROL. Reported first-hand: a screen
 * share sent from the iOS app looked like 360p on the web client watching it.
 * The viewer opened Settings, found a quality selector, moved it from 360p to
 * 1080p, and the picture did not change. Left the call, rejoined, still did not
 * change. The natural reading is that the setting is broken.
 *
 * It is not. In a full mesh the presenter's browser encodes one stream per peer
 * and what it encodes is what arrives; `scaleResolutionDownBy` and `maxBitrate`
 * are parameters of an `RTCRtpSender`, and `RTCRtpReceiver` has no counterpart
 * to either. A viewer can influence the sender only through congestion
 * feedback, which can lower the picture and can never raise it above what the
 * sender chose to encode. So the selector genuinely governs nothing on the
 * watching side, and the defect was that it was labelled as though it did.
 *
 * The honest repair has two halves. The other half is the label (see
 * `video-quality-menu.tsx` and the Settings copy). This half is the number: a
 * viewer who can read "640x360 at 12 fps, from Rafael" knows immediately
 * whether the softness is real, how bad it is, and — crucially — that the
 * machine to fix it on is the sender's. That sentence is worth more than a
 * control that silently does nothing, which is what they had.
 *
 * Reads the same sampler as the console probe and the outbound readout, so
 * none of the three can disagree. Mesh only: the registry that backs it holds
 * `RTCPeerConnection`s, and an SFU room has none, where it renders nothing
 * rather than something wrong.
 */
const SAMPLE_INTERVAL_MS = 2000;

/** A row worth showing: video that is actually arriving from somebody. */
function isLive(sample: VideoReceiverSample): boolean {
  return (sample.framesDecoded ?? 0) > 0 || (sample.kbps ?? 0) > 0;
}

/**
 * One line per incoming stream, newest reading, sorted so it does not shuffle.
 *
 * Sorted by peer then role rather than by bitrate, which was the first
 * instinct: a list that reorders itself every two seconds is unreadable, and
 * the busiest stream is not a stable identity.
 */
function order(a: VideoReceiverSample, b: VideoReceiverSample): number {
  const name = (a.displayName ?? a.peerId).localeCompare(
    b.displayName ?? b.peerId,
  );
  return name !== 0 ? name : a.role.localeCompare(b.role);
}

export function InboundVideoReadout() {
  const { t } = useTranslation();
  const [rows, setRows] = useState<VideoReceiverSample[] | null>(null);

  useEffect(() => {
    let live = true;
    // Polling for the same reason the outbound readout polls: `getStats()` has
    // no change event, and two seconds is well under the rate at which a person
    // reads a line of text.
    const tick = () => {
      void sampleVoiceStats().then((snapshot) => {
        if (!live) {
          return;
        }
        setRows(snapshot.receivers.filter(isLive).sort(order));
      });
    };
    tick();
    const id = setInterval(tick, SAMPLE_INTERVAL_MS);
    return () => {
      live = false;
      clearInterval(id);
    };
  }, []);

  // Before the first sample lands there is nothing true to say, and "nobody is
  // sending you video" would be a claim rather than a silence.
  if (rows === null) {
    return null;
  }

  if (rows.length === 0) {
    return (
      <p className="mt-1 text-xs text-paper-muted">
        {t("call.quality.receiving.none")}
      </p>
    );
  }

  return (
    <div className="mt-1 space-y-0.5" role="status">
      {rows.map((row, index) => {
        const who = row.displayName ?? t("voice.share.someone");
        // Keyed by position as well as identity: `role` is "unknown" for the
        // moment between a track arriving and the roster saying what it is, and
        // two unknowns from one peer would otherwise share a key.
        const key = `${row.peerId}:${row.role}:${index}`;
        // No size yet means the decoder has bytes but no decoded frame, which
        // is the first second of every stream. "0x0" would read as a fault.
        if (!row.width || !row.height) {
          return (
            <p key={key} className="text-xs text-paper-muted">
              {t("call.quality.receiving.measuring", { name: who })}
            </p>
          );
        }
        // Three phrasings rather than two. "Unknown" is a real state — the
        // classification comes off the roster and the track can beat it here —
        // and calling an unclassified stream "their screen" is a guess printed
        // as a fact, in a readout whose entire job is to stop guessing.
        const line =
          row.role === "camera"
            ? "call.quality.receiving.camera"
            : row.role === "screen"
              ? "call.quality.receiving.screen"
              : "call.quality.receiving.video";
        return (
          <p key={key} className="text-xs text-paper-muted">
            {t(line, {
              name: who,
              size: `${row.width}x${row.height}`,
              fps: Math.round(row.fps ?? 0),
              kbps: row.kbps ?? 0,
            })}
          </p>
        );
      })}
      {/* The one sentence that turns a number into an explanation. Deliberately
          present whenever anything is arriving, not only when it looks bad:
          "why can I not change this" is asked at exactly the moment the picture
          disappoints, and by then the person has already tried the wrong knob. */}
      <p className="text-xs text-paper-muted">
        {t("call.quality.receiving.sendersChoice")}
      </p>
    </div>
  );
}
