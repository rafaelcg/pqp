import { Check, CircleHelp, Minus, X, type LucideIcon } from "lucide-react";
import { sourceLabel, type FactStatus } from "@/content/compare-facts";
import { useTranslation, type MessageKey } from "@/lib/i18n";
import { cn } from "@/lib/utils";

/**
 * One cell of a comparison table, shared by `/vs-discord` and `/compare`: a
 * small colour-coded icon, the sentence, and where the sentence came from.
 *
 * The icon is decorative. The sentence answers the cell on its own, except
 * where it does not literally start with the verdict word, where a
 * visually-hidden prefix restores for a screen reader what the colour coding
 * tells everyone else. A cell nobody verified says so in words ("Not
 * verified"), never only in a colour.
 */
const VERDICT: Record<
  FactStatus,
  { icon: LucideIcon; label: MessageKey; className: string }
> = {
  yes: {
    icon: Check,
    label: "vsDiscord.chip.yes",
    className: "bg-success/15 text-success",
  },
  no: {
    icon: X,
    label: "vsDiscord.chip.no",
    className: "bg-ink-3 text-paper-muted",
  },
  partial: {
    icon: Minus,
    label: "vsDiscord.chip.partial",
    className: "bg-warning/15 text-warning",
  },
  unknown: {
    icon: CircleHelp,
    label: "vsDiscord.chip.unknown",
    className: "bg-ink-3 text-paper-muted",
  },
};

export function SourceLinks({ urls }: { urls: readonly string[] }) {
  const { t } = useTranslation();
  return (
    <span className="mt-1.5 flex flex-wrap items-baseline gap-x-2 gap-y-0.5 text-xs text-paper-muted">
      <span>{t("vsDiscord.table.source")}:</span>
      {urls.map((url) => (
        <a
          key={url}
          href={url}
          target="_blank"
          rel="noopener noreferrer"
          className="break-all underline decoration-paper-muted/40 underline-offset-2 transition-colors duration-150 hover:text-paper hover:decoration-paper/60"
        >
          {sourceLabel(url)}
        </a>
      ))}
    </span>
  );
}

export function VerdictCell({
  status,
  body,
  muted = false,
  sources,
}: {
  status: FactStatus;
  body: string;
  muted?: boolean;
  sources?: readonly string[];
}) {
  const { t } = useTranslation();
  const { icon: Icon, label, className } = VERDICT[status];
  const verdictWord = t(label);
  return (
    <div className="flex items-start gap-2.5">
      <span
        aria-hidden
        className={cn(
          "mt-px flex h-5 w-5 shrink-0 items-center justify-center rounded-full",
          className,
        )}
      >
        <Icon className="h-3 w-3" strokeWidth={3} />
      </span>
      <div className="min-w-0">
        <p
          className={cn(
            "text-sm leading-snug",
            muted ? "text-paper-muted" : "text-paper",
          )}
        >
          {!body.toLowerCase().startsWith(verdictWord.toLowerCase()) && (
            <span className="sr-only">{verdictWord}: </span>
          )}
          {body}
        </p>
        {sources && sources.length > 0 && <SourceLinks urls={sources} />}
      </div>
    </div>
  );
}
