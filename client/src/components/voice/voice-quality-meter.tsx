import { useTranslation, type MessageKey } from "@/lib/i18n";
import type { VoiceLinkQuality } from "@/lib/voice-link-quality";
import { Tooltip } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

const BAR_HEIGHT = ["h-1.5", "h-2.5", "h-3.5"] as const;

function barFill(bars: VoiceLinkQuality["bars"]): string {
  if (bars === 1) {
    return "bg-danger";
  }
  if (bars === 2) {
    return "bg-warning";
  }
  return "bg-success";
}

function lossLabel(lossPct: number): string {
  return lossPct < 1 && lossPct > 0
    ? lossPct.toFixed(1)
    : String(Math.round(lossPct));
}

function tooltipDetail(
  quality: VoiceLinkQuality,
  t: (key: MessageKey, vars?: { rtt?: string; loss?: string }) => string,
): string | undefined {
  if (quality.rttMs !== null && quality.lossPct !== null) {
    return t("voice.quality.detail", {
      rtt: String(quality.rttMs),
      loss: lossLabel(quality.lossPct),
    });
  }
  if (quality.rttMs !== null) {
    return t("voice.quality.rtt", { rtt: String(quality.rttMs) });
  }
  if (quality.lossPct !== null) {
    return t("voice.quality.loss", { loss: lossLabel(quality.lossPct) });
  }
  return undefined;
}

/**
 * Three quiet bars, plus Relayed when the nominated pair is TURN.
 *
 * Discord's language: the bars are a glance, the tooltip holds the numbers,
 * and Relayed is a chip rather than a paragraph. Nothing here is a control,
 * so the tooltip is the accessible name.
 */
export function VoiceQualityMeter({
  quality,
  compact = false,
  className,
}: {
  quality: VoiceLinkQuality | null;
  /** Status-bar size: bars only, Relayed as a sibling chip. */
  compact?: boolean;
  className?: string;
}) {
  const { t } = useTranslation();
  if (!quality) {
    return null;
  }

  const barsLabel = t("voice.quality.bars", { count: quality.bars });
  const label = quality.relayed
    ? `${barsLabel}. ${t("voice.quality.relayed")}`
    : barsLabel;
  const detail = tooltipDetail(quality, t);
  const fill = barFill(quality.bars);

  return (
    <span className={cn("inline-flex items-center gap-1", className)}>
      <Tooltip label={label} detail={detail}>
        <span
          className="inline-flex h-4 items-end gap-px"
          aria-label={detail ? `${label}. ${detail}` : label}
        >
          {BAR_HEIGHT.map((height, index) => (
            <span
              key={height}
              className={cn(
                "w-[3px] rounded-[1px]",
                height,
                index < quality.bars ? fill : "bg-ink-3",
              )}
              aria-hidden="true"
            />
          ))}
        </span>
      </Tooltip>
      {quality.relayed && (
        <span
          className={cn(
            "rounded bg-ink-3 font-medium uppercase tracking-wide text-paper-muted",
            compact ? "px-1 py-px text-[9px]" : "px-1.5 py-0.5 text-[10px]",
          )}
        >
          {t("voice.quality.relayed")}
        </span>
      )}
    </span>
  );
}
