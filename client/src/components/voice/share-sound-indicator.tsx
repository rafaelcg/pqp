import { Volume2, VolumeX } from "lucide-react";
import { useTranslation } from "@/lib/i18n";
import { cn } from "@/lib/utils";

/**
 * What the PRESENTER sees about their own share's sound, at a glance.
 *
 * A share that went out silent looked exactly like one that did not (the
 * viewers' stage says "no sound", the presenter's own stage said nothing), and
 * the presenter was the last to find out. This is the small answer on their own
 * stage: the sound is going out, or it is not, in words and with an icon so it
 * does not hang on colour.
 *
 * Off is the one that needs an action, and the action is the one the share bar
 * already has: stop, then share again and leave the sound on. A one-click
 * "share again" was left out on purpose: it would stop the share and open the
 * picker in one motion, and that chain is not one the app offers anywhere else.
 *
 * Only for the local presenter; what a VIEWER is told about a silent share is
 * `voice.share.noAudioShort` beside the presenter's name.
 */
export function ShareSoundIndicator({
  on,
  className,
}: {
  /** The published share carries a live audio track. */
  on: boolean;
  className?: string;
}) {
  const { t } = useTranslation();
  const Icon = on ? Volume2 : VolumeX;
  return (
    <span
      role="status"
      data-testid="share-sound-indicator"
      data-state={on ? "on" : "off"}
      title={on ? undefined : t("voice.share.soundOffHint")}
      className={cn(
        "ml-2 inline-flex items-center gap-1 rounded-full bg-ink-3/60 px-2 py-0.5 text-xs",
        on ? "text-paper-muted" : "text-warning",
        className,
      )}
    >
      <Icon className="h-3 w-3 shrink-0" aria-hidden="true" />
      <span>{on ? t("voice.share.soundOn") : t("voice.share.soundOff")}</span>
      {!on && <span className="sr-only">{t("voice.share.soundOffHint")}</span>}
    </span>
  );
}
