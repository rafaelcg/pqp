import { useEffect, type ReactNode } from "react";
import { Download } from "lucide-react";
import { Link } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { useDownloadAssets } from "@/components/downloads/use-download-assets";
import {
  DESKTOP_DOCS_URL,
  RELEASES_PAGE_URL,
  isAndroidDevice,
  isIOSDevice,
  type AssetId,
} from "@/lib/downloads";
import { useTranslation } from "@/lib/i18n";
import { testflightUrl } from "@/lib/testflight";

/**
 * One primary action, every platform still reachable.
 *
 * WHY NOT FIVE EQUAL CARDS. The visitor's platform is detected, so the page
 * can do what a person handing over a USB stick would do: offer the one file
 * that runs here, big, and keep the rest as a quiet list underneath. The list
 * matters as much as the button — this URL gets pasted into chats, and the
 * friend who opens it may be on any OS — but it does not need to shout.
 *
 * HONESTY, at the point of download and only there: Windows and Linux builds
 * are unsigned (the OS warns on first run), the Mac build is signed and
 * notarized, iPhone is a TestFlight beta reached via `/beta`, and Android is
 * an APK beta reached via `/android`. Nothing here claims an app store or
 * auto-update.
 */

const PRIMARY_CTA = "cta-lift h-12 rounded-full px-7 text-base";
const SECONDARY_CTA = "cta-lift h-12 rounded-full px-6 text-base";

const QUIET_LINK =
  "underline decoration-paper-muted/40 underline-offset-4 transition-colors hover:text-paper hover:decoration-paper/60";

export function DownloadCatalog() {
  const { t } = useTranslation();
  const { plan, prefetch, href } = useDownloadAssets();
  const beta = testflightUrl();

  useEffect(() => {
    prefetch();
  }, [prefetch]);

  const platform = plan?.platform ?? "unknown";
  const macArch = plan?.macArch ?? null;
  const onIos = platform === "mobile" && isIOSDevice();
  const onAndroid = platform === "mobile" && isAndroidDevice();

  let primary: ReactNode;
  let note: ReactNode = null;
  // A second, quieter escape hatch under the note. Only Windows has one, and
  // only because the installer can fail in a way the app itself does not.
  let fallback: ReactNode = null;
  // When the primary action already opens the browser, the quiet "open in the
  // browser" line under it would just repeat the button.
  let primaryIsBrowser = false;

  if (platform === "windows") {
    primary = <AssetButton href={href("windows")} label={t("download.windows")} />;
    note = (
      <>
        {t("download.windows.unsigned")} <DocsLink />
      </>
    );
    // WHY A SECOND WINDOWS LINK. A user hit APPCRASH 0xc0000005 in one of the
    // NSIS plugin DLLs, so the installer died before it ever wrote the app to
    // disk. Not SmartScreen, not Defender: the same machine ran the portable
    // build fine. The portable .exe has always been in the release and was
    // never on this page, so the only path out of that crash was to give up.
    // It stays a link rather than a second button because it is the wrong
    // answer for almost everyone (no Start menu entry, no auto-update), and
    // the person who needs it is reading this line precisely because the
    // button above did not work.
    fallback = (
      <>
        {t("download.windows.portable")}{" "}
        <a
          href={href("windows-portable")}
          target="_blank"
          rel="noopener"
          className={QUIET_LINK}
        >
          {t("download.windows.portable.link")}
        </a>
      </>
    );
  } else if (platform === "mac" && macArch) {
    primary = (
      <AssetButton
        href={href(macArch === "arm64" ? "mac-arm64" : "mac-x64")}
        label={t(
          macArch === "arm64"
            ? "download.mac.appleSilicon"
            : "download.mac.intel",
        )}
      />
    );
    note = t("downloadPage.mac.signed");
  } else if (platform === "mac") {
    // Chip unknown (Safari and Firefox ship no userAgentData). Both builds,
    // never a guess: the wrong binary is a broken first run.
    primary = (
      <div className="flex flex-wrap gap-3">
        <AssetButton
          href={href("mac-arm64")}
          label={t("download.mac.appleSilicon")}
        />
        <AssetButton
          href={href("mac-x64")}
          label={t("download.mac.intel")}
          secondary
        />
      </div>
    );
    note = t("download.mac.whichChip");
  } else if (platform === "linux") {
    primary = (
      <div className="flex flex-wrap gap-3">
        <AssetButton
          href={href("linux-appimage")}
          label={t("download.linux.appImage.full")}
        />
        <AssetButton
          href={href("linux-deb")}
          label={t("download.linux.deb.full")}
          secondary
        />
      </div>
    );
    note = (
      <>
        {t("download.linux.unsigned")} <DocsLink />
      </>
    );
  } else if (onIos && beta) {
    primary = (
      <Button asChild className={PRIMARY_CTA}>
        <Link to="/beta">{t("downloadPage.ios.cta")}</Link>
      </Button>
    );
    note = t("downloadPage.ios.body");
  } else if (onAndroid) {
    primary = (
      <Button asChild className={PRIMARY_CTA}>
        <Link to="/android">{t("downloadPage.android.cta")}</Link>
      </Button>
    );
    note = t("downloadPage.android.body");
  } else if (platform === "mobile") {
    primaryIsBrowser = true;
    primary = (
      <Button asChild className={PRIMARY_CTA}>
        <Link to="/app">{t("downloadPage.web.cta")}</Link>
      </Button>
    );
    note = t("downloadPage.android.body");
  } else {
    // Some device we could not name (Chromebooks land here). The browser is
    // the product; the list below still has every file.
    primaryIsBrowser = true;
    primary = (
      <Button asChild className={PRIMARY_CTA}>
        <Link to="/app">{t("downloadPage.web.cta")}</Link>
      </Button>
    );
  }

  return (
    <div>
      {primary}

      {note && (
        <p className="mt-4 max-w-md text-sm leading-relaxed text-paper-muted">
          {note}
        </p>
      )}

      {fallback && (
        <p className="mt-2 max-w-md text-sm leading-relaxed text-paper-muted">
          {fallback}
        </p>
      )}

      {!primaryIsBrowser && (
        <p className="mt-5 text-sm text-paper-muted">
          <Link to="/app" className={QUIET_LINK}>
            {t("downloadPage.web.cta")}
          </Link>
        </p>
      )}

      <PlatformList href={href} />
    </div>
  );
}

/**
 * The quiet second half: every platform, one row each, always rendered — the
 * shared URL has to work on the friend's machine, whatever it is.
 */
function PlatformList({ href }: { href: (id: AssetId) => string }) {
  const { t } = useTranslation();
  return (
    <section className="mt-16 max-w-md">
      <h2 className="text-[11px] font-medium uppercase tracking-[0.2em] text-paper-muted">
        {t("downloadPage.all")}
      </h2>
      <ul className="mt-3 divide-y divide-ink-4/60 text-sm">
        <PlatformRow name={t("downloadPage.windows")}>
          <RowLink
            href={href("windows")}
            label={t("downloadPage.list.download")}
            ariaLabel={t("download.windows")}
          />
          <Dot />
          {/* The visitor who was sent this link may be the one whose installer
              crashes, and they will never see the Windows note above unless
              they are browsing from Windows. */}
          <RowLink
            href={href("windows-portable")}
            label={t("download.windows.portableShort")}
            ariaLabel={t("download.windows.portable.link")}
          />
        </PlatformRow>
        <PlatformRow name={t("downloadPage.mac")}>
          <RowLink
            href={href("mac-arm64")}
            label={t("download.mac.appleSiliconShort")}
            ariaLabel={t("download.mac.appleSilicon")}
          />
          <Dot />
          <RowLink
            href={href("mac-x64")}
            label={t("download.mac.intelShort")}
            ariaLabel={t("download.mac.intel")}
          />
        </PlatformRow>
        <PlatformRow name={t("downloadPage.linux")}>
          <RowLink
            href={href("linux-appimage")}
            label={t("download.linux.appImage")}
            ariaLabel={t("download.linux.appImage.full")}
          />
          <Dot />
          <RowLink
            href={href("linux-deb")}
            label={t("download.linux.deb")}
            ariaLabel={t("download.linux.deb.full")}
          />
        </PlatformRow>
        <PlatformRow name={t("downloadPage.ios")}>
          <Link to="/beta" className={QUIET_LINK}>
            {t("downloadPage.list.ios")}
          </Link>
        </PlatformRow>
        <PlatformRow name={t("downloadPage.android")}>
          <Link to="/android" className={QUIET_LINK}>
            {t("downloadPage.list.android")}
          </Link>
        </PlatformRow>
      </ul>
      <p className="mt-4 text-xs text-paper-muted">
        <a
          href={RELEASES_PAGE_URL}
          target="_blank"
          rel="noopener"
          className="underline decoration-paper-muted/40 underline-offset-2 hover:text-paper hover:decoration-paper/60"
        >
          {t("download.other")}
        </a>
      </p>
    </section>
  );
}

function PlatformRow({ name, children }: { name: string; children: ReactNode }) {
  return (
    <li className="flex items-baseline justify-between gap-6 py-3">
      <span className="font-medium text-paper">{name}</span>
      <span className="flex flex-wrap items-baseline justify-end gap-x-2 gap-y-1 text-paper-muted">
        {children}
      </span>
    </li>
  );
}

function AssetButton({
  href,
  label,
  secondary = false,
}: {
  href: string;
  label: string;
  secondary?: boolean;
}) {
  return (
    <Button
      asChild
      variant={secondary ? "secondary" : "default"}
      className={secondary ? SECONDARY_CTA : PRIMARY_CTA}
    >
      <a href={href} target="_blank" rel="noopener">
        {!secondary && <Download aria-hidden className="h-4 w-4" />}
        {label}
      </a>
    </Button>
  );
}

function RowLink({
  href,
  label,
  ariaLabel,
}: {
  href: string;
  label: string;
  /** Full label for links whose visible text ("Intel", ".deb") means nothing alone. */
  ariaLabel: string;
}) {
  return (
    <a
      href={href}
      aria-label={ariaLabel}
      target="_blank"
      rel="noopener"
      className={QUIET_LINK}
    >
      {label}
    </a>
  );
}

function Dot() {
  return (
    <span aria-hidden className="text-paper-muted/50">
      ·
    </span>
  );
}

function DocsLink() {
  const { t } = useTranslation();
  return (
    <a
      href={DESKTOP_DOCS_URL}
      target="_blank"
      rel="noopener"
      className="underline decoration-paper-muted/40 underline-offset-2 hover:text-paper"
    >
      {t("download.unsigned.help")}
    </a>
  );
}
