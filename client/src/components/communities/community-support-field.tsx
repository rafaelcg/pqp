import { parseCommunitySupport } from "@pqp/shared";
import { useId, useState } from "react";
import { Input } from "@/components/ui/input";
import { useTranslation } from "@/lib/i18n";
import { cn } from "@/lib/utils";

/**
 * The one "Apoiar o criador" box of a community's editor, in both places the
 * official links are edited (the Baú page in place, and Server settings).
 *
 * It is a plain text box on purpose: a Pix key, a Pix copia e cola and a
 * payment page are all things a person pastes, and `parseCommunitySupport`
 * decides which one it is. The server runs the same function and is the real
 * judge; this only tells the person before Save.
 *
 * ONE LINK PER SERVER. The locked VIP card has room for one button.
 */
export function CommunitySupportField({
  value,
  onChange,
  disabled = false,
  labelClassName,
  hintClassName,
}: {
  value: string;
  onChange: (next: string) => void;
  disabled?: boolean;
  /** The two surfaces have different type tokens; the structure is shared. */
  labelClassName?: string;
  hintClassName?: string;
}) {
  const { t } = useTranslation();
  const inputId = useId();
  const hintId = useId();
  const errorId = useId();
  // The error waits for the first blur: a half-typed link is not a mistake yet.
  const [touched, setTouched] = useState(false);
  const trimmed = value.trim();
  const invalid = trimmed !== "" && parseCommunitySupport(trimmed) === null;
  const showError = invalid && touched;
  return (
    <div data-support-field>
      <label
        htmlFor={inputId}
        className={cn("block text-sm font-semibold text-text", labelClassName)}
      >
        {t("communities.support.label")}
      </label>
      <p
        id={hintId}
        className={cn(
          "mb-2 mt-1 text-xs leading-5 text-text-tertiary",
          hintClassName,
        )}
      >
        {t("communities.support.hint")}
      </p>
      <Input
        id={inputId}
        value={value}
        disabled={disabled}
        maxLength={2000}
        autoComplete="off"
        spellCheck={false}
        placeholder={t("communities.support.placeholder")}
        aria-invalid={showError || undefined}
        aria-describedby={showError ? `${hintId} ${errorId}` : hintId}
        onChange={(event) => onChange(event.target.value)}
        onBlur={() => setTouched(true)}
        data-support-input
      />
      {showError && (
        <p
          id={errorId}
          role="alert"
          className="mt-2 text-xs leading-5 text-danger"
          data-support-error
        >
          {t("communities.support.invalid")}
        </p>
      )}
      {trimmed !== "" && !invalid && (
        <p className={cn("mt-2 text-xs leading-5 text-text-tertiary", hintClassName)}>
          {t("communities.support.visibility")}
        </p>
      )}
    </div>
  );
}

/** What the box starts with: the stored support link as the owner would type it. */
export function supportDraftOf(
  link: { url?: string; pix?: string } | null | undefined,
): string {
  return link?.url ?? link?.pix ?? "";
}
