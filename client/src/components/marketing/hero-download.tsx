import { Download } from "lucide-react";
import { useEffect, useState, type CSSProperties, type ReactNode } from "react";
import {
  DESKTOP_DOCS_URL,
  RELEASES_PAGE_URL,
  detectDownloadPlan,
  resolveLatestAssets,
  type AssetId,
  type AssetUrls,
  type DownloadPlan,
} from "@/lib/downloads";
import { isDesktopApp } from "@/lib/desktop";
import { useTranslation } from "@/lib/i18n";
import { testflightUrl } from "@/lib/testflight";
import { cn } from "@/lib/utils";

/**
 * The desktop download, offered under the hero's real call to action.
 *
 * HIERARCHY: this is deliberately a line of text, not a second button. The web
 * app is the product and the primary action is getting into it; a second filled
 * pill beside "Criar um servidor" would read as an equal choice and split the
 * click on the one screen that has to convert. A quiet underlined link says
 * "there is also a desktop app" without competing — and because the platform is
 * detected, it still names one file rather than opening a matrix.
 *
 * HONESTY: only macOS is signed and notarized. Windows and Linux ship unsigned,
 * and a Windows user meets SmartScreen on first run, so that is said here at
 * the point of download rather than discovered as a scare. Nothing on this
 * component claims an app store, and nothing claims auto-update.
 */

// Cached across mounts: the architecture probe is cheap but the answer never
// changes within a session, and re-running it would re-flash the layout.
let cachedPlan: DownloadPlan | null = null;

interface HeroDownloadProps {
  className?: string;
  style?: CSSProperties;
}

export function HeroDownload({ className, style }: HeroDownloadProps) {
  const { t } = useTranslation();
  const [plan, setPlan] = useState<DownloadPlan | null>(cachedPlan);
  const [assets, setAssets] = useState<AssetUrls>({});

  useEffect(() => {
    if (cachedPlan) {
      return;
    }
    let live = true;
    void detectDownloadPlan().then((resolved) => {
      cachedPlan = resolved;
      if (live) {
        setPlan(resolved);
      }
    });
    return () => {
      live = false;
    };
  }, []);

  /**
   * Ask GitHub for the exact asset URLs — but only once the visitor has reached
   * for the download. Hover and focus both land well before the click on the
   * two input methods that can produce one, so the link is usually already
   * direct by the time it is followed, and a visitor who ignores this line
   * never causes a request to a third party.
   */
  function prefetch() {
    void resolveLatestAssets().then(setAssets);
  }

  // Already running the thing this offers.
  if (!plan || isDesktopApp()) {
    return null;
  }

  const href = (id: AssetId) => assets[id] ?? RELEASES_PAGE_URL;

  if (plan.platform === "mobile") {
    const beta = testflightUrl();
    // Prefer the native beta when we have a join URL; otherwise the PWA is the
    // honest answer (docs/PWA.md) — a .dmg on a phone is a dead end.
    if (beta) {
      return (
        <p
          className={cn("max-w-xs text-sm text-white/60", className)}
          style={style}
        >
          <a
            href={beta}
            target="_blank"
            rel="noopener noreferrer"
            className="underline decoration-white/30 underline-offset-2 hover:text-white hover:decoration-white/60"
          >
            {t("download.mobile.beta")}
          </a>
        </p>
      );
    }
    return (
      <p className={cn("max-w-xs text-sm text-white/60", className)} style={style}>
        {t("download.mobile")}
      </p>
    );
  }

  if (plan.platform === "mac") {
    if (plan.macArch) {
      return (
        <Shell className={className} style={style} onIntent={prefetch}>
          <DownloadLink
            href={href(plan.macArch === "arm64" ? "mac-arm64" : "mac-x64")}
            label={t(
              plan.macArch === "arm64"
                ? "download.mac.appleSilicon"
                : "download.mac.intel",
            )}
            icon
          />
        </Shell>
      );
    }
    // Chip unknown (Safari, Firefox — neither ships userAgentData). Offering
    // both is the only honest move: an Intel build on an M-series Mac runs
    // under Rosetta if it is even installed, and the reverse does not run at
    // all, so a guess here is a broken first run.
    return (
      <Shell className={className} style={style} onIntent={prefetch}>
        <span className="inline-flex flex-wrap items-center gap-x-2 gap-y-1">
          <Download aria-hidden className="h-4 w-4 shrink-0" />
          <span>{t("download.mac.either")}</span>
          <DownloadLink
            href={href("mac-arm64")}
            label={t("download.mac.appleSiliconShort")}
            ariaLabel={t("download.mac.appleSilicon")}
          />
          <Separator />
          <DownloadLink
            href={href("mac-x64")}
            label={t("download.mac.intelShort")}
            ariaLabel={t("download.mac.intel")}
          />
        </span>
        <Note>{t("download.mac.whichChip")}</Note>
      </Shell>
    );
  }

  if (plan.platform === "windows") {
    return (
      <Shell className={className} style={style} onIntent={prefetch}>
        <DownloadLink
          href={href("windows")}
          label={t("download.windows")}
          icon
        />
        <Note>
          {t("download.windows.unsigned")}{" "}
          <DocsLink label={t("download.unsigned.help")} />
        </Note>
      </Shell>
    );
  }

  if (plan.platform === "linux") {
    return (
      <Shell className={className} style={style} onIntent={prefetch}>
        <span className="inline-flex flex-wrap items-center gap-x-2 gap-y-1">
          <Download aria-hidden className="h-4 w-4 shrink-0" />
          <span>{t("download.linux")}</span>
          <DownloadLink
            href={href("linux-appimage")}
            label={t("download.linux.appImage")}
            ariaLabel={t("download.linux.appImage.full")}
          />
          <Separator />
          <DownloadLink
            href={href("linux-deb")}
            label={t("download.linux.deb")}
            ariaLabel={t("download.linux.deb.full")}
          />
        </span>
        <Note>
          {t("download.linux.unsigned")}{" "}
          <DocsLink label={t("download.unsigned.help")} />
        </Note>
      </Shell>
    );
  }

  // Some desktop we could not name. The releases page lists every build, which
  // is a better answer than picking one at random.
  return (
    <Shell className={className} style={style} onIntent={prefetch}>
      <DownloadLink
        href={RELEASES_PAGE_URL}
        label={t("download.other")}
        icon
      />
    </Shell>
  );
}

function Shell({
  className,
  style,
  onIntent,
  children,
}: {
  className?: string;
  style?: CSSProperties;
  onIntent: () => void;
  children: ReactNode;
}) {
  return (
    <div
      className={cn("text-sm text-white/70", className)}
      style={style}
      // `onFocus` bubbles in React, so tabbing to any link inside starts the
      // lookup — which is the keyboard equivalent of hovering it.
      onPointerEnter={onIntent}
      onFocus={onIntent}
    >
      {children}
    </div>
  );
}

function DownloadLink({
  href,
  label,
  ariaLabel,
  icon = false,
}: {
  href: string;
  label: string;
  /** For links whose visible text ("Intel", ".deb") means nothing on its own. */
  ariaLabel?: string;
  icon?: boolean;
}) {
  return (
    <a
      href={href}
      aria-label={ariaLabel}
      // Keeps the landing page open behind the download — the visitor still has
      // an account to create.
      target="_blank"
      rel="noopener"
      className="inline-flex items-center gap-2 font-medium text-white/80 underline decoration-white/30 underline-offset-4 transition-colors hover:text-white hover:decoration-white/70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/60 focus-visible:ring-offset-2 focus-visible:ring-offset-transparent"
    >
      {icon && <Download aria-hidden className="h-4 w-4 shrink-0" />}
      {label}
    </a>
  );
}

function DocsLink({ label }: { label: string }) {
  return (
    <a
      href={DESKTOP_DOCS_URL}
      target="_blank"
      rel="noopener"
      className="underline decoration-white/25 underline-offset-2 hover:text-white/80"
    >
      {label}
    </a>
  );
}

function Separator() {
  return (
    <span aria-hidden className="text-white/30">
      ·
    </span>
  );
}

function Note({ children }: { children: ReactNode }) {
  return <p className="mt-2 max-w-sm text-xs text-white/55">{children}</p>;
}
