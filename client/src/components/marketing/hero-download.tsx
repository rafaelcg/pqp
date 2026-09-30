import { Download } from "lucide-react";
import { type CSSProperties, type ReactNode, useEffect } from "react";
import { Link } from "react-router-dom";
import { useDownloadAssets } from "@/components/downloads/use-download-assets";
import { GooglePlayBadge } from "@/components/marketing/google-play-badge";
import { isDesktopApp } from "@/lib/desktop";
import { DESKTOP_DOCS_URL, RELEASES_PAGE_URL, isAndroidDevice, isIOSDevice } from "@/lib/downloads";
import { useTranslation } from "@/lib/i18n";
import { playStoreUrl, playStoreUrlWithLocale } from "@/lib/play-store";
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
 *
 * `tone` is `hero` on the photograph (white type) and `ink` inside the app,
 * where the same line sits on paper tokens.
 */

type Tone = "hero" | "ink";

const TONE = {
  hero: {
    shell: "text-sm text-white/70",
    muted: "max-w-xs text-sm text-white/60",
    link: "inline-flex items-center gap-2 font-medium [@media(pointer:coarse)]:min-h-11 text-white/80 underline decoration-white/30 underline-offset-4 transition-colors hover:text-white hover:decoration-white/70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/60 focus-visible:ring-offset-2 focus-visible:ring-offset-transparent",
    docs: "underline decoration-white/25 underline-offset-2 hover:text-white/80",
    sep: "text-white/30",
    note: "mt-2 max-w-sm text-xs text-white/55",
    mobileLink:
      "underline decoration-white/30 underline-offset-2 hover:text-white hover:decoration-white/60",
    storePill:
      "cta-lift inline-flex min-h-11 items-center rounded-full px-5 text-base font-medium text-white/90 ring-1 ring-white/40 backdrop-blur-sm hover:bg-white/15 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/70",
  },
  ink: {
    shell: "text-sm text-paper",
    muted: "max-w-xs text-sm text-paper-muted",
    link: "inline-flex items-center gap-2 font-medium [@media(pointer:coarse)]:min-h-11 text-paper underline decoration-paper-muted/40 underline-offset-4 transition-colors hover:text-signal hover:decoration-signal/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-signal/60",
    docs: "underline decoration-paper-muted/40 underline-offset-2 hover:text-paper",
    sep: "text-paper-muted/50",
    note: "mt-2 max-w-sm text-xs text-paper-muted",
    mobileLink:
      "underline decoration-paper-muted/40 underline-offset-2 hover:text-paper hover:decoration-paper/60",
    storePill:
      "cta-lift inline-flex min-h-11 items-center rounded-full px-5 text-base font-medium text-paper ring-1 ring-paper-muted/40 hover:bg-ink-3 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-signal/60",
  },
} as const;

interface HeroDownloadProps {
  className?: string;
  style?: CSSProperties;
  tone?: Tone;
}

export function HeroDownload({
  className,
  style,
  tone = "hero",
}: HeroDownloadProps) {
  const { t, locale } = useTranslation();
  const { plan, prefetch, href } = useDownloadAssets();
  const classes = TONE[tone];
  const platform = plan?.platform;
  const desktopBuild =
    platform === "mac" || platform === "windows" || platform === "linux";

  // Resolve the real installer once the line is on screen, the way /download
  // does, instead of waiting for a hover. Before this, a click that came ahead
  // of any hover or focus (a quick tap, a screen reader activating the link)
  // landed on the releases page while the label promised a .dmg. A failed or
  // rate-limited lookup still degrades to that page.
  useEffect(() => {
    if (desktopBuild && !isDesktopApp()) {
      prefetch();
    }
  }, [desktopBuild, prefetch]);

  // Already running the thing this offers.
  if (!plan || isDesktopApp()) {
    return null;
  }

  if (plan.platform === "mobile") {
    const beta = testflightUrl();
    // The iOS beta is only for iPhones: an Android visitor offered a TestFlight
    // link has nothing to do with it. Anything else on a phone is still the
    // PWA answer (docs/PWA.md).
    //
    // On a phone this is the fold's second action, so it is a real 44 px
    // target rather than a line of small print under the buttons.
    if (beta && isIOSDevice()) {
      return (
        <div className={cn("flex justify-center", className)} style={style}>
          <a
            href={beta}
            target="_blank"
            rel="noopener noreferrer"
            className={classes.storePill}
          >
            {t("download.mobile.beta.short")}
          </a>
        </div>
      );
    }
    if (isAndroidDevice()) {
      // Straight to the listing, not the `/android` landing: this is the
      // hero's one-line CTA, and Google Play is the primary action now.
      // `/android` (with the sideload steps and the honest framing) is still
      // where this same link goes on a self-host that has no Play listing.
      const play = playStoreUrl();
      const playHref = play ? playStoreUrlWithLocale(play, locale) : null;
      if (playHref) {
        // Google's own badge, the component /android and the footer use, so
        // the brand rules (unaltered, aspect ratio kept) live in one place.
        return (
          <div className={cn("flex justify-center", className)} style={style}>
            <GooglePlayBadge href={playHref} locale={locale} />
          </div>
        );
      }
      return (
        <p className={cn(classes.muted, className)} style={style}>
          <Link to="/android" className={classes.mobileLink}>
            {t("download.mobile.android")}
          </Link>
        </p>
      );
    }
    return (
      <p className={cn(classes.muted, className)} style={style}>
        {t("download.mobile")}
      </p>
    );
  }

  let download: ReactNode;
  if (plan.platform === "mac") {
    download = plan.macArch ? (
      <Shell tone={tone} className={className} style={style} onIntent={prefetch}>
        <DownloadLink
          tone={tone}
          href={href(plan.macArch === "arm64" ? "mac-arm64" : "mac-x64")}
          label={t(
            plan.macArch === "arm64"
              ? "download.mac.appleSilicon"
              : "download.mac.intel",
          )}
          icon
        />
      </Shell>
    ) : (
      // Chip unknown (Safari, Firefox — neither ships userAgentData). Offering
      // both is the only honest move: an Intel build on an M-series Mac runs
      // under Rosetta if it is even installed, and the reverse does not run at
      // all, so a guess here is a broken first run.
      <Shell tone={tone} className={className} style={style} onIntent={prefetch}>
        <span className="inline-flex flex-wrap items-center gap-x-2 gap-y-1">
          <Download aria-hidden className="h-4 w-4 shrink-0" />
          <span>{t("download.mac.either")}</span>
          <DownloadLink
            tone={tone}
            href={href("mac-arm64")}
            label={t("download.mac.appleSiliconShort")}
            ariaLabel={t("download.mac.appleSilicon")}
          />
          <Separator tone={tone} />
          <DownloadLink
            tone={tone}
            href={href("mac-x64")}
            label={t("download.mac.intelShort")}
            ariaLabel={t("download.mac.intel")}
          />
        </span>
        <Note tone={tone}>{t("download.mac.whichChip")}</Note>
      </Shell>
    );
  } else if (plan.platform === "windows") {
    download = (
      <Shell tone={tone} className={className} style={style} onIntent={prefetch}>
        <DownloadLink
          tone={tone}
          href={href("windows")}
          label={t("download.windows")}
          icon
        />
        <Note tone={tone}>
          {t("download.windows.unsigned")}{" "}
          <DocsLink tone={tone} label={t("download.unsigned.help")} />
        </Note>
      </Shell>
    );
  } else if (plan.platform === "linux") {
    download = (
      <Shell tone={tone} className={className} style={style} onIntent={prefetch}>
        <span className="inline-flex flex-wrap items-center gap-x-2 gap-y-1">
          <Download aria-hidden className="h-4 w-4 shrink-0" />
          <span>{t("download.linux")}</span>
          <DownloadLink
            tone={tone}
            href={href("linux-appimage")}
            label={t("download.linux.appImage")}
            ariaLabel={t("download.linux.appImage.full")}
          />
          <Separator tone={tone} />
          <DownloadLink
            tone={tone}
            href={href("linux-deb")}
            label={t("download.linux.deb")}
            ariaLabel={t("download.linux.deb.full")}
          />
        </span>
        <Note tone={tone}>
          {t("download.linux.unsigned")}{" "}
          <DocsLink tone={tone} label={t("download.unsigned.help")} />
        </Note>
      </Shell>
    );
  } else {
    // Some desktop we could not name. The releases page lists every build,
    // which is a better answer than picking one at random.
    download = (
      <Shell tone={tone} className={className} style={style} onIntent={prefetch}>
        <DownloadLink
          tone={tone}
          href={RELEASES_PAGE_URL}
          label={t("download.other")}
          icon
        />
      </Shell>
    );
  }

  return download;
}

function Shell({
  className,
  style,
  onIntent,
  tone,
  children,
}: {
  className?: string;
  style?: CSSProperties;
  onIntent: () => void;
  tone: Tone;
  children: ReactNode;
}) {
  return (
    <div
      className={cn(TONE[tone].shell, className)}
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
  tone,
}: {
  href: string;
  label: string;
  /** For links whose visible text ("Intel", ".deb") means nothing on its own. */
  ariaLabel?: string;
  icon?: boolean;
  tone: Tone;
}) {
  return (
    <a
      href={href}
      aria-label={ariaLabel}
      // Keeps the landing page open behind the download — the visitor still has
      // an account to create.
      target="_blank"
      rel="noopener"
      className={TONE[tone].link}
    >
      {icon && <Download aria-hidden className="h-4 w-4 shrink-0" />}
      {label}
    </a>
  );
}

function DocsLink({ label, tone }: { label: string; tone: Tone }) {
  return (
    <a
      href={DESKTOP_DOCS_URL}
      target="_blank"
      rel="noopener"
      className={TONE[tone].docs}
    >
      {label}
    </a>
  );
}

function Separator({ tone }: { tone: Tone }) {
  return (
    <span aria-hidden className={TONE[tone].sep}>
      ·
    </span>
  );
}

function Note({ children, tone }: { children: ReactNode; tone: Tone }) {
  return <p className={TONE[tone].note}>{children}</p>;
}
