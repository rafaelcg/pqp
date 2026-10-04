import { Check, CircleX, Copy } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Tooltip } from "@/components/ui/tooltip";
import { BUILD_ID, BUILD_TIME, DEV_BUILD_ID } from "@/lib/build-info";
import { isDesktopApp } from "@/lib/desktop";
import { useTranslation } from "@/lib/i18n";
import { SETTINGS_FOCUS } from "@/components/settings/kit/classes";
import {
  SETTINGS_COPIED_MS,
  useCopyText,
} from "@/components/settings/kit/copy-button";
import { cn } from "@/lib/utils";

/** How long "Copiado" replaces the line after a copy. Kept for callers. */
export const BUILD_LINE_COPIED_MS = SETTINGS_COPIED_MS;

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

/**
 * Which build this is, in one line a person can paste into a bug report:
 * `pqp web · 2026.10.03 · a1b2c3d`. The shell is "pqp desktop" inside the
 * Electron app. A `vite dev` session (id "dev", time 0) says `pqp web · dev`.
 *
 * The date is the build's UTC day, so two people on the same deploy read the
 * same line whatever their timezone.
 */
export function formatBuildLine({
  build = BUILD_ID,
  builtAt = BUILD_TIME,
  desktop = isDesktopApp(),
}: { build?: string; builtAt?: number; desktop?: boolean } = {}): string {
  const shell = desktop ? "pqp desktop" : "pqp web";
  if (build === DEV_BUILD_ID || !builtAt) {
    return `${shell} · ${DEV_BUILD_ID}`;
  }
  const date = new Date(builtAt);
  const day = `${date.getUTCFullYear()}.${pad(date.getUTCMonth() + 1)}.${pad(date.getUTCDate())}`;
  return `${shell} · ${day} · ${build.slice(0, 7)}`;
}

/**
 * The build line, copyable, so whoever writes to the team can paste exactly
 * what they are running. Both variants carry the tooltip "Copiar versão pra
 * mandar no suporte", so the line says what it is for.
 *
 * - `rail` (default): under the account card in the rail. Small and quiet: the
 *   whole line is the button and "Copiado" replaces it for a moment after a
 *   copy.
 * - `row`: a row control, Ajuda's "Versão do app". The line is plain
 *   monospace text a person can select, next to an icon copy button; only the
 *   icon turns into a check. It wraps rather than truncating on a phone.
 *
 * The text is selectable in both. When nothing can copy (plain http with the
 * old path refused too, a denied permission), the line is selected for the
 * person and "Não deu pra copiar, seleciona o texto." shows under it.
 */
export function SettingsBuildLine({
  className,
  variant = "rail",
}: {
  className?: string;
  variant?: "rail" | "row";
}) {
  const { t } = useTranslation();
  const line = formatBuildLine();
  const name = t("settings.rail.copyBuild", { build: line });
  const hint = t("settings.buildCopyHint");
  const failure = (failed: boolean) =>
    failed ? (
      <span
        data-copy-failed=""
        className={cn(
          "flex items-center gap-1.5 text-xs text-danger",
          variant === "row" && "justify-end",
        )}
      >
        <CircleX aria-hidden className="h-3.5 w-3.5 shrink-0" />
        {t("settings.status.copyFailed")}
      </span>
    ) : null;

  if (variant === "row") {
      return (
      <BuildLineRow line={line} name={name} hint={hint} className={className} failure={failure} />
    );
  }

  return (
    <BuildLineRail line={line} name={name} hint={hint} className={className} failure={failure} />
  );
}

interface VariantProps {
  line: string;
  name: string;
  hint: string;
  className?: string;
  failure: (failed: boolean) => ReactNode;
}

function BuildLineRow({ line, name, hint, className, failure }: VariantProps) {
  const textRef = useRef<HTMLSpanElement>(null);
  const [failed, setFailed] = useState(false);
  return (
    <span className={cn("inline-flex max-w-full flex-col items-end gap-1", className)}>
      <span className="inline-flex max-w-full items-center gap-1">
        <span
          ref={textRef}
          data-build-line=""
          className="min-w-0 select-all break-all px-1 py-0.5 font-mono text-xs tabular-nums text-text-secondary"
        >
          {line}
        </span>
        <BuildCopyButton
          line={line}
          name={name}
          hint={hint}
          selectOnFail={() => textRef.current}
          onFailedChange={setFailed}
        />
      </span>
      {failure(failed)}
    </span>
  );
}

/** The kit's copy button, reporting a failure so the row can say it in words. */
function BuildCopyButton({
  line,
  name,
  hint,
  selectOnFail,
  onFailedChange,
}: {
  line: string;
  name: string;
  hint: string;
  selectOnFail: () => HTMLElement | null;
  onFailedChange: (failed: boolean) => void;
}) {
  const { t } = useTranslation();
  const { copied, failed, copy } = useCopyText(line, { selectOnFail });
  useEffect(() => onFailedChange(failed), [failed, onFailedChange]);
  return (
    <>
      <Tooltip label={hint} name={name}>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={copy}
          className="w-[var(--control-sm)] shrink-0 px-0"
        >
          {copied ? (
            <Check aria-hidden className="h-3.5 w-3.5 shrink-0 animate-icon-swap text-success" />
          ) : failed ? (
            <CircleX aria-hidden className="h-3.5 w-3.5 shrink-0 animate-icon-swap text-danger" />
          ) : (
            <Copy aria-hidden className="h-3.5 w-3.5 shrink-0" />
          )}
        </Button>
      </Tooltip>
      {/* Always mounted, so the change is announced: a live region that
          appears together with its text is often not read at all. */}
      <span role="status" className="sr-only">
        {copied ? t("settings.rail.copied") : failed ? t("settings.status.copyFailed") : ""}
      </span>
    </>
  );
}

function BuildLineRail({
  line,
  name,
  hint,
  className,
  failure,
}: VariantProps) {
  const { t } = useTranslation();
  const textRef = useRef<HTMLSpanElement>(null);
  const { copied, failed, copy } = useCopyText(line, {
    selectOnFail: () => textRef.current,
  });
  return (
    <span className={cn("inline-flex max-w-full flex-col items-start gap-1", className)}>
      <Tooltip label={hint} name={name} side="top" align="start">
        <button
          type="button"
          onClick={copy}
          className={cn(
            "inline-flex max-w-full items-center gap-1.5 rounded-[var(--radius-control)] px-2 py-0.5 text-left text-[11px] tabular-nums text-text-tertiary transition-colors duration-[var(--duration-fast)] hover:text-text",
            SETTINGS_FOCUS,
          )}
        >
          <span
            ref={textRef}
            aria-hidden
            data-build-line=""
            className="min-w-0 select-text truncate"
          >
            {copied ? t("settings.rail.copied") : line}
          </span>
          {copied ? (
            <Check aria-hidden className="h-3 w-3 shrink-0 animate-icon-swap text-success" />
          ) : failed ? (
            <CircleX aria-hidden className="h-3 w-3 shrink-0 animate-icon-swap text-danger" />
          ) : (
            <Copy aria-hidden className="h-3 w-3 shrink-0" />
          )}
        </button>
      </Tooltip>
      {/* Always mounted, so the change is announced. */}
      <span role="status" className="sr-only">
        {copied ? t("settings.rail.copied") : failed ? t("settings.status.copyFailed") : ""}
      </span>
      {failure(failed)}
    </span>
  );
}
