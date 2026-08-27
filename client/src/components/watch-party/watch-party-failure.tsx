import {
  Ban,
  ExternalLink,
  FileQuestion,
  RotateCcw,
  ShieldAlert,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  watchOnYouTubeUrl,
  type PlayerFailure,
} from "@/lib/watch-party/player";
import { failurePresentation } from "@/components/watch-party/watch-party-view";
import { useTranslation } from "@/lib/i18n";
import { cn } from "@/lib/utils";

/**
 * One person's player refusing, said plainly.
 *
 * THESE ARE NOT RARE AND THEY ARE NOT BUGS. Embedding disabled by the
 * uploader, age restriction, and error 153 are the ordinary weather of the
 * YouTube IFrame API, and a red "something went wrong" box for any of them
 * teaches people that the app is broken when in fact it is reporting a rule
 * accurately. So the card is quiet, it names the actual cause, and it always
 * carries the one thing that still works: the video, on youtube.com, at
 * roughly where the channel is.
 *
 * IT IS ALSO EXPLICITLY PER PERSON. `watchParty.failure.solo` is not filler.
 * Somebody staring at a stopped panel while their friends carry on talking
 * about the video assumes the party is over; being told in one line that
 * everybody else is still watching is the difference between "this broke" and
 * "this one is not for me".
 *
 * The reason and the raw code both come from `lib/watch-party/player.ts`,
 * which owns the mapping. Nothing here interprets a YouTube error number.
 */
export interface WatchPartyFailureProps {
  failure: PlayerFailure;
  /** The channel's current video, for the fallback link when the failure has none. */
  videoId: string;
  /** The room's last sampled position, so that fallback lands near everybody else. */
  positionMs: number;
  /** Absent when the reason is not one a second attempt can change. */
  onRetry?: () => void;
}

const TONE_ICON = {
  blocked: Ban,
  environment: ShieldAlert,
  gone: FileQuestion,
  flaky: RotateCcw,
} as const;

/**
 * Error 153 is the only one painted as a warning rather than in the muted
 * palette, because it is the only one where something on our side is
 * misconfigured and a person could reasonably tell us about it. The rest are
 * facts about a video and deserve no colour at all.
 */
const TONE_ICON_CLASS = {
  blocked: "text-paper-muted",
  environment: "text-warning",
  gone: "text-paper-muted",
  flaky: "text-paper-muted",
} as const;

export function WatchPartyFailure({
  failure,
  videoId,
  positionMs,
  onRetry,
}: WatchPartyFailureProps) {
  const { t } = useTranslation();
  const presentation = failurePresentation(failure.reason);
  const Icon = TONE_ICON[presentation.tone];
  /**
   * The failure's own link first: it was stamped at the moment things broke and
   * is accurate to where this person was. The channel's current position is the
   * fallback for a failure that arrived before any video was loaded.
   */
  const href =
    failure.watchOnYouTubeUrl ?? watchOnYouTubeUrl(videoId, positionMs);

  return (
    <div
      role="status"
      className="flex flex-1 flex-col items-center justify-center gap-3 p-6 text-center"
    >
      <Icon
        className={cn("h-6 w-6", TONE_ICON_CLASS[presentation.tone])}
        aria-hidden="true"
      />
      <div className="flex max-w-sm flex-col gap-1">
        <p className="text-sm font-semibold text-paper">
          {t(presentation.title)}
        </p>
        <p className="text-xs text-paper-muted">{t(presentation.body)}</p>
        <p className="text-[11px] text-paper-muted/80">
          {t("watchParty.failure.solo")}
        </p>
        {/* Printed rather than folded into the sentence. Nobody needs to read
            "150" to understand "the uploader turned embedding off", but the
            number is the entire content of a useful bug report, and it is the
            only thing identifying a code we have no specific sentence for. */}
        {failure.code !== null && (
          <p className="text-[11px] text-paper-muted/60">
            {t("watchParty.failure.code", { code: failure.code })}
          </p>
        )}
      </div>
      <div className="flex flex-wrap items-center justify-center gap-2">
        {href !== null && (
          <Button asChild variant="secondary" size="sm">
            <a href={href} target="_blank" rel="noopener noreferrer">
              <ExternalLink className="h-3.5 w-3.5" aria-hidden="true" />
              {t("watchParty.failure.watchOnYouTube")}
            </a>
          </Button>
        )}
        {/* Offered only where a second attempt can genuinely end differently.
            A retry button beside "the uploader turned embedding off" is a
            button that is guaranteed to fail, and one of those teaches people
            to stop pressing the ones that work. */}
        {presentation.retryable && onRetry && (
          <Button variant="ghost" size="sm" onClick={onRetry}>
            <RotateCcw className="h-3.5 w-3.5" aria-hidden="true" />
            {t("watchParty.failure.retry")}
          </Button>
        )}
      </div>
    </div>
  );
}
