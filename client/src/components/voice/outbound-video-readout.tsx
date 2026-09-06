import { useEffect, useState } from "react";
import { useTranslation, type MessageKey } from "@/lib/i18n";
import {
  describeLimitation,
  sampleVoiceStats,
  type Limitation,
  type VideoSenderSample,
} from "@/lib/voice-stats-probe";

/**
 * What this machine is actually sending, in words, next to the control that
 * asks for it.
 *
 * WHY. Every quality report this product has received has been adjectival:
 * "the quality was awful". There is no way to act on that, and no way for the
 * person reporting it to know whether they are looking at a bug or at their
 * own uplink. A number beside the selector closes that loop without anybody
 * opening a console: "I asked for 720p and I am sending 320x240, held back by
 * my connection" is a report somebody can do something with.
 *
 * It reads the same sampler the console probe uses, so the two can never
 * disagree. Both transports feed it: the mesh registers its peer connections
 * and the LiveKit session registers a sampler over its own publications, with
 * the ceiling it applied, so "held back by your quality setting" means the
 * same thing on the SFU as on the mesh.
 */
const SAMPLE_INTERVAL_MS = 2000;

/** Which limitation reasons get a plain-language name of their own. */
function limitKey(reason: Limitation) {
  if (reason === "bandwidth") {
    return "settings.voice.videoQuality.limit.bandwidth" as const;
  }
  if (reason === "setting") {
    return "settings.voice.videoQuality.limit.setting" as const;
  }
  if (reason === "cpu") {
    return "settings.voice.videoQuality.limit.cpu" as const;
  }
  return "settings.voice.videoQuality.limit.other" as const;
}

export function OutboundVideoReadout({
  /**
   * What to say when there is no camera sender to read at all.
   *
   * The default is written for the Settings dialog, where the honest answer is
   * "turn your camera on during a call". The in-call menu only exists while the
   * camera *is* on, so that sentence would be a flat contradiction there: with
   * a camera running and no sample, what is actually true is that this call
   * has not produced a reading yet.
   */
  idleKey = "settings.voice.videoQuality.idle",
}: {
  idleKey?: MessageKey;
} = {}) {
  const { t } = useTranslation();
  const [camera, setCamera] = useState<VideoSenderSample | null>(null);

  useEffect(() => {
    let live = true;
    // Polling rather than pushing because there is nothing to push: getStats()
    // has no change event, and a two-second cadence is well under the rate at
    // which a person can read a line of text.
    const tick = () => {
      void sampleVoiceStats().then((snapshot) => {
        if (!live) {
          return;
        }
        // The first camera sender on any peer. In a mesh the same camera goes
        // to everybody, so one row answers the question for all of them, and
        // listing one line per peer would say the same thing several times.
        //
        // FALLS BACK TO THE SCREEN, because the setting this sits under now
        // governs the screen sender too. Somebody presenting with their camera
        // off used to be told there was nothing to measure, which is the same
        // dead end that made the whole readout worthless in Settings, and it
        // landed on exactly the person the sharpness complaint came from.
        // Camera first when both exist: it is the smaller of the two numbers
        // and the one people misread as "the call is broken".
        const senders = snapshot.senders;
        setCamera(
          senders.find((sender) => sender.role === "camera") ??
            senders.find((sender) => sender.role === "screen") ??
            null,
        );
      });
    };
    tick();
    const id = setInterval(tick, SAMPLE_INTERVAL_MS);
    return () => {
      live = false;
      clearInterval(id);
    };
  }, []);

  if (!camera) {
    return (
      <p className="mt-1 text-xs text-paper-muted">
        {t(idleKey)}
      </p>
    );
  }

  // A sender exists but has not encoded a frame yet, which is the first second
  // or two of every camera. Saying "0x0" would read as a fault.
  if (!camera.width || !camera.height) {
    return (
      <p className="mt-1 text-xs text-paper-muted">
        {t("settings.voice.videoQuality.measuring")}
      </p>
    );
  }

  // Not `limitedBy` directly: the encoder calls its own `maxBitrate` a
  // bandwidth limit, so the raw field says "your connection" to somebody on
  // fibre whose only limit is the rung they picked. See `describeLimitation`.
  const limited = describeLimitation(camera);

  return (
    <p className="mt-1 text-xs text-paper-muted" role="status">
      {t("settings.voice.videoQuality.sending", {
        size: `${camera.width}x${camera.height}`,
        fps: Math.round(camera.fps ?? 0),
        kbps: camera.kbps ?? 0,
      })}
      {limited && (
        <>
          {". "}
          {/* Orange only when something is going wrong. Sitting on the ceiling
              you chose is the setting working, not a fault, and colouring it
              like one is how a person ends up rebooting a healthy router. */}
          <span className={limited === "setting" ? undefined : "text-warning"}>
            {t("settings.voice.videoQuality.limited", {
              reason: t(limitKey(limited)),
            })}
          </span>
        </>
      )}
    </p>
  );
}
