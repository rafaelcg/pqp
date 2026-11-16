import { useState } from "react";
import {
  DEFAULT_POLL_DURATION_SECONDS,
  POLL_DURATION_SECONDS,
  POLL_MAX_OPTIONS,
  POLL_MIN_OPTIONS,
  POLL_OPTION_MAX_LENGTH,
  POLL_QUESTION_MAX_LENGTH,
  pollRequestSchema,
  type PollRequest,
} from "@pqp/shared";
import { ChartBar, X as XGlyph } from "@phosphor-icons/react";
import { BarChart3, Plus, X } from "lucide-react";
import { CONTENT_CARD_REDESIGN } from "@/components/ui/content-card";
import { Icon } from "@/components/ui/icon";
import { Button } from "@/components/ui/button";
import { useTranslation, type MessageKey } from "@/lib/i18n";
import { cn } from "@/lib/utils";

interface PollComposerProps {
  onSubmit: (request: PollRequest) => void;
  onClose: () => void;
}

/** Filled field, no hard border: recessed ink well with a signal focus ring. */
const FIELD_CLASS =
  "h-10 w-full rounded-lg bg-ink-2 px-3 text-sm text-paper placeholder:text-paper-muted/70 shadow-[var(--shadow-inset-field)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-signal/50 redesign:rounded-[var(--input-radius)] redesign:border redesign:border-[color:var(--input-border)] redesign:bg-[color:var(--input-bg)] redesign:text-text redesign:shadow-none redesign:placeholder:text-[color:var(--input-placeholder)] redesign:hover:border-[color:var(--input-hover-border)] redesign:focus-visible:ring-accent";

/** A duration chip under the redesign: a pill; the chosen one ringed in the accent. */
const CHIP_REDESIGN = "redesign:h-8 redesign:px-3.5 redesign:text-[0.8125rem] redesign:focus-visible:ring-accent";
const CHIP_ON_REDESIGN =
  "redesign:bg-accent-soft redesign:text-on-accent-soft redesign:shadow-[inset_0_0_0_1.5px_var(--color-accent)]";
const CHIP_OFF_REDESIGN =
  "redesign:bg-[color:var(--content-glyph-bg)] redesign:text-text-secondary redesign:hover:bg-[color:var(--content-card-hover)] redesign:hover:text-text";

const DURATION_KEYS: Record<number, MessageKey> = {
  3600: "poll.composer.duration.3600",
  14_400: "poll.composer.duration.14400",
  28_800: "poll.composer.duration.28800",
  86_400: "poll.composer.duration.86400",
  259_200: "poll.composer.duration.259200",
  604_800: "poll.composer.duration.604800",
};

export function PollComposer({ onSubmit, onClose }: PollComposerProps) {
  const { t } = useTranslation();
  const [question, setQuestion] = useState("");
  const [options, setOptions] = useState(["", ""]);
  const [durationSeconds, setDurationSeconds] = useState(
    DEFAULT_POLL_DURATION_SECONDS,
  );
  const [allowMultiselect, setAllowMultiselect] = useState(false);

  const parsed = pollRequestSchema.safeParse({
    question,
    options: options.map((option) => option.trim()).filter(Boolean),
    durationSeconds,
    allowMultiselect,
  });

  return (
    <div className={cn("mb-2 rounded-2xl bg-[linear-gradient(165deg,color-mix(in_oklab,var(--color-signal)_6%,var(--color-surface-2)),var(--color-surface-2)_72%)] p-4 shadow-[var(--shadow-chance-highlight),var(--shadow-popover)]", CONTENT_CARD_REDESIGN)}>
      <div className="flex items-center gap-2.5">
        <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-signal/15 text-signal redesign:bg-accent-soft redesign:text-on-accent-soft">
          <BarChart3 className="h-4 w-4 redesign:hidden" aria-hidden />
          <Icon icon={ChartBar} size="sm" className="hidden redesign:block" />
        </span>
        <p className="min-w-0 flex-1 truncate font-display text-base font-semibold text-paper">
          {t("poll.composer.title")}
        </p>
        <button
          type="button"
          onClick={onClose}
          aria-label={t("poll.composer.cancel")}
          className="shrink-0 rounded p-1 text-paper-muted hover:text-paper focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-signal/60 redesign:flex redesign:h-8 redesign:w-8 redesign:items-center redesign:justify-center redesign:rounded-full redesign:p-0 redesign:text-text-secondary redesign:hover:bg-[color:var(--button-ghost-hover)] redesign:hover:text-text redesign:focus-visible:ring-accent"
        >
          <X className="h-4 w-4 redesign:hidden" />
          <Icon icon={XGlyph} kind="symbol" size="sm" className="hidden redesign:block" />
        </button>
      </div>

      <label className="mt-3 block">
        <span className="text-xs font-medium text-paper-muted redesign:text-[0.8125rem] redesign:text-text-secondary">
          {t("poll.composer.question")}
        </span>
        <input
          value={question}
          maxLength={POLL_QUESTION_MAX_LENGTH}
          onChange={(event) => setQuestion(event.target.value)}
          placeholder={t("poll.composer.questionPlaceholder")}
          className={cn("mt-1", FIELD_CLASS)}
        />
      </label>

      <fieldset className="mt-3">
        <legend className="text-xs font-medium text-paper-muted redesign:text-[0.8125rem] redesign:text-text-secondary">
          {t("poll.composer.options")}
        </legend>
        <div className="mt-1 space-y-1.5">
          {options.map((option, index) => (
            <div key={index} className="flex items-center gap-2">
              <span
                aria-hidden
                className="flex h-10 w-5 shrink-0 items-center justify-center font-mono text-xs text-paper-muted"
              >
                {index + 1}
              </span>
              <input
                value={option}
                maxLength={POLL_OPTION_MAX_LENGTH}
                aria-label={t("poll.composer.option", { n: index + 1 })}
                onChange={(event) => {
                  const next = [...options];
                  next[index] = event.target.value;
                  setOptions(next);
                }}
                className={FIELD_CLASS}
              />
            </div>
          ))}
        </div>
        {options.length < POLL_MAX_OPTIONS && (
          <button
            type="button"
            onClick={() => setOptions([...options, ""])}
            className="ml-7 mt-1.5 inline-flex items-center gap-1 text-xs font-medium text-signal hover:underline redesign:text-[0.8125rem] redesign:font-semibold redesign:text-accent-text"
          >
            <Plus className="h-3.5 w-3.5" aria-hidden />
            {t("poll.composer.addOption")}
          </button>
        )}
      </fieldset>

      <div className="mt-3">
        <p id="poll-composer-duration" className="text-xs font-medium text-paper-muted redesign:text-[0.8125rem] redesign:text-text-secondary">
          {t("poll.composer.duration")}
        </p>
        <div
          role="radiogroup"
          aria-labelledby="poll-composer-duration"
          className="mt-1 flex flex-wrap gap-1.5"
        >
          {POLL_DURATION_SECONDS.map((seconds) => {
            const active = durationSeconds === seconds;
            return (
              <button
                key={seconds}
                type="button"
                role="radio"
                aria-checked={active}
                onClick={() => setDurationSeconds(seconds)}
                className={cn(
                  "h-8 rounded-full px-3 text-xs transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-signal/60",
                  active
                    ? "bg-[color-mix(in_oklab,var(--color-signal)_26%,var(--color-surface-1))] font-semibold text-paper"
                    : "bg-[color-mix(in_oklab,var(--color-paper)_5%,var(--color-surface-1))] font-medium text-paper-muted hover:text-paper",
                  CHIP_REDESIGN,
                  active ? CHIP_ON_REDESIGN : CHIP_OFF_REDESIGN,
                )}
              >
                {t(DURATION_KEYS[seconds] ?? "poll.composer.duration.604800")}
              </button>
            );
          })}
        </div>
      </div>

      <button
        type="button"
        role="switch"
        aria-checked={allowMultiselect}
        onClick={() => setAllowMultiselect((value) => !value)}
        className="mt-3 flex items-center gap-2 text-xs text-paper focus-visible:outline-none"
      >
        <span
          aria-hidden
          className={cn(
            "relative h-5 w-9 shrink-0 rounded-full shadow-[var(--shadow-inset-switch)] transition-colors",
            allowMultiselect ? "bg-signal" : "bg-ink-2",
          )}
        >
          <span
            className={cn(
              "absolute left-0.5 top-0.5 h-4 w-4 rounded-full shadow-[var(--shadow-switch-thumb)] transition-transform",
              allowMultiselect ? "translate-x-4 bg-ink" : "bg-paper",
            )}
          />
        </span>
        {t("poll.composer.multiple")}
      </button>

      <div className="mt-4 flex items-center justify-end gap-2">
        <Button type="button" variant="ghost" className="h-10" onClick={onClose}>
          {t("poll.composer.cancel")}
        </Button>
        <Button
          type="button"
          className="h-10"
          disabled={
            !parsed.success ||
            options.filter((o) => o.trim()).length < POLL_MIN_OPTIONS
          }
          onClick={() => {
            if (parsed.success) {
              onSubmit(parsed.data);
            }
          }}
        >
          {t("poll.composer.post")}
        </Button>
      </div>
    </div>
  );
}
