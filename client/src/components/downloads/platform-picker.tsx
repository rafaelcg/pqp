import { type CSSProperties, type ReactNode, useEffect } from "react";
import { Link } from "react-router-dom";
import { useDownloadAssets } from "@/components/downloads/use-download-assets";
import {
  AndroidMark,
  DesktopMark,
  IosMark,
} from "@/components/downloads/platform-marks";
import { useTranslation, type MessageKey } from "@/lib/i18n";
import { cn } from "@/lib/utils";

/**
 * Three equal choices: this computer, iPhone, Android.
 *
 * The in-app download dialog used to offer the detected desktop file as a
 * sentence and bury the phones. Desktop users asking "tem no celular?"
 * never saw an answer. Three marks, staggered in, one job each.
 */

function stagger(i: number): CSSProperties {
  return { "--stagger": i } as CSSProperties;
}

export function PlatformPicker({
  onNavigate,
}: {
  /** Fired when a choice leaves this dialog (phone landings). */
  onNavigate?: () => void;
}) {
  const { t } = useTranslation();
  const { plan, prefetch, href } = useDownloadAssets();

  useEffect(() => {
    prefetch();
  }, [prefetch]);

  const platform = plan?.platform ?? "unknown";
  let desktopHref: string;
  let desktopLabel: MessageKey = "downloadPicker.desktop";
  if (platform === "windows") {
    desktopHref = href("windows");
    desktopLabel = "downloadPicker.windows";
  } else if (platform === "mac") {
    desktopLabel = "downloadPicker.mac";
    if (plan?.macArch === "x64") {
      desktopHref = href("mac-x64");
    } else if (plan?.macArch === "arm64") {
      desktopHref = href("mac-arm64");
    } else {
      desktopHref = "/download";
    }
  } else if (platform === "linux") {
    desktopHref = href("linux-appimage");
    desktopLabel = "downloadPicker.linux";
  } else {
    desktopHref = "/download";
  }

  return (
    <ul className="grid grid-cols-3 gap-2">
      <Choice
        index={0}
        href={desktopHref}
        external={desktopHref.startsWith("http")}
        label={t(desktopLabel)}
        hint={t("downloadPicker.desktop.hint")}
        mark={<DesktopMark className="h-8 w-8" />}
      />
      <Choice
        index={1}
        href="/beta"
        label={t("downloadPicker.ios")}
        hint={t("downloadPicker.ios.hint")}
        mark={<IosMark className="h-8 w-8" />}
        onNavigate={onNavigate}
      />
      <Choice
        index={2}
        href="/android"
        label={t("downloadPicker.android")}
        hint={t("downloadPicker.android.hint")}
        mark={<AndroidMark className="h-8 w-8" />}
        onNavigate={onNavigate}
      />
    </ul>
  );
}

function Choice({
  index,
  href,
  label,
  hint,
  mark,
  external = false,
  onNavigate,
}: {
  index: number;
  href: string;
  label: string;
  hint: string;
  mark: ReactNode;
  external?: boolean;
  onNavigate?: () => void;
}) {
  const className = cn(
    "cta-lift animate-rise group flex flex-col items-center gap-2 rounded-2xl border border-ink-4 bg-ink/40 px-2 py-4 text-center outline-none",
    "hover:border-signal/50 hover:bg-ink-2 focus-visible:ring-2 focus-visible:ring-signal/60",
  );

  const inner = (
    <>
      <span className="flex h-14 w-14 items-center justify-center rounded-2xl bg-ink-2 text-paper transition-colors group-hover:bg-signal/12 group-hover:text-signal">
        {mark}
      </span>
      <span className="text-sm font-medium text-paper">{label}</span>
      <span className="text-[11px] leading-snug text-paper-muted">{hint}</span>
    </>
  );

  if (external) {
    return (
      <li className="min-w-0">
        <a
          href={href}
          className={className}
          style={stagger(index)}
        >
          {inner}
        </a>
      </li>
    );
  }

  return (
    <li className="min-w-0">
      <Link
        to={href}
        className={className}
        style={stagger(index)}
        onClick={onNavigate}
      >
        {inner}
      </Link>
    </li>
  );
}
