import { Check, Copy } from "lucide-react";
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
 * The build line as a button that copies itself, so whoever writes to the team
 * can paste exactly what they are running.
 *
 * - `rail` (default): under the account card in the rail. Small and quiet;
 *   "Copiado" replaces the line for a moment after a copy.
 * - `row`: a row control, Ajuda's "Versão do app". Monospace, the line stays
 *   put and only the icon turns into a check, and it wraps rather than
 *   truncating on a phone.
 *
 * The icon sits after the text in both. No clipboard (plain http, an old
 * webview): the click does nothing and the line stays selectable text.
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
  const { copied, copy } = useCopyText(line);
  const row = variant === "row";

  return (
    <button
      type="button"
      onClick={copy}
      aria-label={t("settings.rail.copyBuild", { build: line })}
      className={cn(
        "inline-flex max-w-full items-center gap-1.5 rounded-[var(--radius-control)] text-left tabular-nums transition-colors duration-[var(--duration-fast)] hover:text-text",
        row
          ? "px-1 py-0.5 font-mono text-xs text-text-secondary"
          : "px-2 py-0.5 text-[11px] text-text-tertiary",
        SETTINGS_FOCUS,
        className,
      )}
    >
      <span aria-hidden className={cn("min-w-0", row ? "break-all" : "truncate")}>
        {copied && !row ? t("settings.rail.copied") : line}
      </span>
      {copied ? (
        <Check
          aria-hidden
          className={cn("shrink-0 animate-icon-swap text-success", row ? "h-3.5 w-3.5" : "h-3 w-3")}
        />
      ) : (
        <Copy aria-hidden className={cn("shrink-0", row ? "h-3.5 w-3.5" : "h-3 w-3")} />
      )}
      {/* Always mounted, so the change is announced: a live region that
          appears together with its text is often not read at all. */}
      <span role="status" className="sr-only">
        {copied ? t("settings.rail.copied") : ""}
      </span>
    </button>
  );
}
