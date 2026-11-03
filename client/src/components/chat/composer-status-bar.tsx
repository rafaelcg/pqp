import type { ReactNode } from "react";
import { useTranslation } from "@/lib/i18n";
import { cn } from "@/lib/utils";

/** The count shows from here on (the text channels canvas, "Passou do limite"). */
export const COMPOSER_COUNT_FROM = 3_800;

/**
 * The 28px line of the composer under the redesign (the text channels
 * canvas, "O compositor: os estados"). Who is typing lives on the left and
 * the character count on the right. `floating` lays it over the bottom of the
 * log, so the main composer reserves no row for it and nothing moves when
 * either appears. Past the limit the count turns red and offers to send the
 * text as a file; `flash` is set for a moment when Enter was refused.
 */
export function ComposerStatusBar({
  typing,
  length,
  max,
  flash,
  onSendAsFile,
  floating = false,
}: {
  typing: ReactNode;
  length: number;
  max: number;
  flash: boolean;
  onSendAsFile?: () => void;
  /** Over the bottom of the log instead of a row of its own. */
  floating?: boolean;
}) {
  const { t, locale } = useTranslation();
  const over = length > max;
  const number = new Intl.NumberFormat(locale);
  return (
    <div
      data-composer-status=""
      className={cn(
        "flex h-7 min-w-0 items-center gap-3 px-3 text-xs text-text-secondary",
        floating &&
          "pointer-events-none absolute inset-x-3 bottom-full bg-gradient-to-t from-[color:var(--color-pane-main)] from-60% to-transparent sm:inset-x-4 [&_button]:pointer-events-auto",
      )}
    >
      <div className="min-w-0 flex-1 truncate">{typing}</div>
      {length >= COMPOSER_COUNT_FROM && (
        <div className="flex shrink-0 items-center gap-2">
          <span
            data-composer-count={over ? "over" : "near"}
            aria-live="polite"
            className={cn(
              "tabular-nums font-medium",
              over ? "text-danger" : "text-text-tertiary",
              flash && "animate-[pqp-count-flash_0.6s_var(--ease-standard)]",
            )}
          >
            {t("composer.count", { length: number.format(length), max: number.format(max) })}
          </span>
          {over && onSendAsFile && (
            <button
              type="button"
              onClick={onSendAsFile}
              className="rounded font-semibold text-[color:var(--color-accent-text)] underline decoration-[color:var(--content-link-line)] underline-offset-2 hover:decoration-current focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
            >
              {t("composer.sendAsFile")}
            </button>
          )}
        </div>
      )}
    </div>
  );
}

/** The text as a .txt file, for a message past the limit. */
export function textAsFile(text: string, name: string): File {
  return new File([text], name, { type: "text/plain" });
}
