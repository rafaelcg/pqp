import { useEffect, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { Laptop, Monitor, Smartphone } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useDownloadAssets } from "@/components/downloads/use-download-assets";
import {
  DESKTOP_DOCS_URL,
  RELEASES_PAGE_URL,
  isIOSDevice,
} from "@/lib/downloads";
import { useTranslation } from "@/lib/i18n";
import { testflightUrl } from "@/lib/testflight";
import { cn } from "@/lib/utils";

/**
 * Every installable thing, on one page.
 *
 * WHY NOT THE LANDING'S ONE-LINE OFFER. The hero names one file so it does not
 * compete with "create a community". This page is the opposite job: someone
 * was asked "tem app?" and needs a URL that works on the friend's machine,
 * which may not be the sender's. A Mac visitor still has to see the Windows
 * .exe.
 *
 * Android has no store listing and no public APK. The honest card is the
 * browser. iPhone goes to TestFlight via `/beta`, not a silent hop.
 */

export function DownloadCatalog() {
  const { t } = useTranslation();
  const { plan, prefetch, href } = useDownloadAssets();
  const beta = testflightUrl();

  useEffect(() => {
    prefetch();
  }, [prefetch]);

  const platform = plan?.platform;
  const macArch = plan?.macArch ?? null;
  const onIos = platform === "mobile" && isIOSDevice();
  const onAndroid = platform === "mobile" && !onIos;

  return (
    <div className="space-y-4">
      <CatalogCard
        icon={Monitor}
        title={t("downloadPage.windows")}
        current={platform === "windows"}
      >
        <Button asChild>
          <a href={href("windows")} target="_blank" rel="noopener">
            {t("download.windows")}
          </a>
        </Button>
        <Note>
          {t("download.windows.unsigned")}{" "}
          <DocsLink />
        </Note>
      </CatalogCard>

      <CatalogCard
        icon={Laptop}
        title={t("downloadPage.mac")}
        current={platform === "mac"}
      >
        {macArch ? (
          <Button asChild>
            <a
              href={href(macArch === "arm64" ? "mac-arm64" : "mac-x64")}
              target="_blank"
              rel="noopener"
            >
              {t(
                macArch === "arm64"
                  ? "download.mac.appleSilicon"
                  : "download.mac.intel",
              )}
            </a>
          </Button>
        ) : (
          <>
            <div className="flex flex-wrap gap-2">
              <Button asChild>
                <a href={href("mac-arm64")} target="_blank" rel="noopener">
                  {t("download.mac.appleSilicon")}
                </a>
              </Button>
              <Button asChild variant="secondary">
                <a href={href("mac-x64")} target="_blank" rel="noopener">
                  {t("download.mac.intel")}
                </a>
              </Button>
            </div>
            <Note>{t("download.mac.whichChip")}</Note>
          </>
        )}
      </CatalogCard>

      <CatalogCard
        icon={Monitor}
        title={t("downloadPage.linux")}
        current={platform === "linux"}
      >
        <div className="flex flex-wrap gap-2">
          <Button asChild>
            <a href={href("linux-appimage")} target="_blank" rel="noopener">
              {t("download.linux.appImage.full")}
            </a>
          </Button>
          <Button asChild variant="secondary">
            <a href={href("linux-deb")} target="_blank" rel="noopener">
              {t("download.linux.deb.full")}
            </a>
          </Button>
        </div>
        <Note>
          {t("download.linux.unsigned")}{" "}
          <DocsLink />
        </Note>
      </CatalogCard>

      <CatalogCard
        icon={Smartphone}
        title={t("downloadPage.ios")}
        current={onIos}
      >
        <p className="text-sm text-paper-muted">{t("downloadPage.ios.body")}</p>
        {beta && (
          <Button asChild>
            <Link to="/beta">{t("downloadPage.ios.cta")}</Link>
          </Button>
        )}
      </CatalogCard>

      <CatalogCard
        icon={Smartphone}
        title={t("downloadPage.android")}
        current={onAndroid}
      >
        <p className="text-sm text-paper-muted">
          {t("downloadPage.android.body")}
        </p>
        <Button asChild variant="secondary">
          <Link to="/app">{t("downloadPage.web.cta")}</Link>
        </Button>
      </CatalogCard>

      <p className="pt-2 text-center text-xs text-paper-muted">
        <a
          href={RELEASES_PAGE_URL}
          target="_blank"
          rel="noopener"
          className="underline decoration-paper-muted/40 underline-offset-2 hover:text-paper hover:decoration-paper/60"
        >
          {t("download.other")}
        </a>
      </p>
    </div>
  );
}

function CatalogCard({
  icon: Icon,
  title,
  current,
  children,
}: {
  icon: typeof Monitor;
  title: string;
  current: boolean;
  children: ReactNode;
}) {
  const { t } = useTranslation();
  return (
    <section
      className={cn(
        "rounded-2xl border bg-ink-2/60 p-5 sm:p-6",
        current ? "border-signal/50" : "border-ink-4",
      )}
    >
      <div className="flex items-center gap-3">
        <span className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-signal/12 text-signal">
          <Icon aria-hidden className="h-5 w-5" />
        </span>
        <h2 className="font-display text-lg font-bold tracking-tight">
          {title}
        </h2>
        {current && (
          <span className="rounded-full border border-signal/40 bg-signal/10 px-2 py-0.5 text-[11px] font-medium uppercase tracking-[0.12em] text-signal">
            {t("downloadPage.thisDevice")}
          </span>
        )}
      </div>
      <div className="mt-4 flex flex-col items-start gap-3">{children}</div>
    </section>
  );
}

function Note({ children }: { children: ReactNode }) {
  return <p className="max-w-prose text-xs text-paper-muted">{children}</p>;
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
