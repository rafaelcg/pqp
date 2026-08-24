import { useEffect, useState } from "react";
import { useTranslation, type MessageKey } from "@/lib/i18n";
import {
  sampleVoiceStats,
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
 * disagree. Mesh only, because that is where the registry lives; on an SFU
 * room it simply shows nothing rather than something wrong.
 */
const SAMPLE_INTERVAL_MS = 2000;

/** Which limitation reasons get a plain-language name of their own. */
function limitKey(reason: string) {
  if (reason === "bandwidth") {
    return "settings.voice.videoQuality.limit.bandwidth" as const;
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
   * cannot be measured from here (an SFU room keeps no local sender registry).
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
        setCamera(
          snapshot.senders.find((sender) => sender.role === "camera") ?? null,
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

  const limited =
    camera.limitedBy && camera.limitedBy !== "none" ? camera.limitedBy : null;

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
          <span className="text-warning">
            {t("settings.voice.videoQuality.limited", {
              reason: t(limitKey(limited)),
            })}
          </span>
        </>
      )}
    </p>
  );
}
