import { Check, Copy } from "lucide-react";
import { useEffect, useState } from "react";
import { BUILD_ID, BUILD_TIME, DEV_BUILD_ID } from "@/lib/build-info";
import { isDesktopApp } from "@/lib/desktop";
import { useTranslation } from "@/lib/i18n";
import { SETTINGS_FOCUS } from "@/components/settings/kit/classes";
import { cn } from "@/lib/utils";

/** How long "Copiado" replaces the line after a copy. */
export const BUILD_LINE_COPIED_MS = 1500;

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
 * The build line as a button that copies itself. Shown under the account card
 * in the rail and in Ajuda's "Versão" row, so whoever writes to the team can
 * paste exactly what they are running.
 *
 * No clipboard (plain http, an old webview): the click does nothing and the
 * line stays selectable text.
 */
export function SettingsBuildLine({ className }: { className?: string }) {
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);
  const line = formatBuildLine();

  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), BUILD_LINE_COPIED_MS);
    return () => window.clearTimeout(timer);
  }, [copied]);

  return (
    <button
      type="button"
      onClick={() => {
        void navigator.clipboard
          ?.writeText(line)
          .then(() => setCopied(true))
          .catch(() => undefined);
      }}
      aria-label={t("settings.rail.copyBuild", { build: line })}
      className={cn(
        "inline-flex max-w-full items-center gap-1.5 rounded-[var(--radius-control)] px-2 py-0.5 text-left text-[11px] tabular-nums text-text-tertiary transition-colors duration-[var(--duration-fast)] hover:text-text",
        SETTINGS_FOCUS,
        className,
      )}
    >
      {copied ? (
        <Check aria-hidden className="h-3 w-3 shrink-0 animate-icon-swap text-success" />
      ) : (
        <Copy aria-hidden className="h-3 w-3 shrink-0" />
      )}
      <span aria-hidden className="min-w-0 truncate">
        {copied ? t("settings.rail.copied") : line}
      </span>
      {/* Always mounted, so the change is announced: a live region that
          appears together with its text is often not read at all. */}
      <span role="status" className="sr-only">
        {copied ? t("settings.rail.copied") : ""}
      </span>
    </button>
  );
}
