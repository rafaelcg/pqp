import { Link } from "react-router-dom";
import { LanguagePicker } from "@/components/marketing/language-picker";
import { MarketingAuthCtas } from "@/components/marketing/marketing-auth-ctas";
import { BetaTag } from "@/components/ui/beta-tag";
import { useCommunitiesEnabled } from "@/hooks/use-communities-enabled";
import { useTranslation } from "@/lib/i18n";
import { cn } from "@/lib/utils";

interface MarketingNavProps {
  variant?: "hero" | "solid";
}

export function MarketingNav({ variant = "solid" }: MarketingNavProps) {
  const { t, locale } = useTranslation();
  // The anchor only exists on the landing while the server says the
  // directory is on; a link to a band that is not there is a dead link.
  const communitiesEnabled = useCommunitiesEnabled();
  const isHero = variant === "hero";
  const linkClass = cn(
    "whitespace-nowrap text-xs font-medium uppercase tracking-[0.12em] transition-colors duration-150 lg:tracking-[0.18em]",
    isHero ? "text-white/70 hover:text-white" : "text-paper-muted hover:text-paper",
  );

  return (
    <header
      className={cn(
        "relative z-20 flex h-16 items-center justify-between border-b px-5 sm:px-8 transition-[background-color,border-color] duration-200 ease-out",
        isHero
          ? "border-transparent bg-transparent"
          : "border-ink-4/50 bg-ink/80 backdrop-blur-md",
      )}
    >
      <Link
        to="/"
        className={cn(
          "flex items-center gap-2 font-brand text-xl tracking-tight transition-colors duration-200",
          isHero ? "text-white" : "text-paper",
        )}
      >
        pqp
        <BetaTag variant={isHero ? "hero" : "default"} />
      </Link>

      {/* Five links do not fit beside the language picker and both sign-in
          buttons between 768 and about 900 px (the nav wrapped over the logo
          and pushed "Começar" and "Entrar" off screen), so the two anchors
          that live further down the same page, Communities and Self-host,
          only join from `lg`. Every one of them is in the footer either way.
          `min-w-0` and `shrink` keep the row from ever pushing the CTAs out. */}
      <nav className="hidden min-w-0 shrink items-center gap-5 md:flex lg:gap-8">
        <a href="/#features" className={linkClass}>
          {t("nav.features")}
        </a>
        <Link to="/vs-discord" className={linkClass}>
          {t("footer.vsDiscord")}
        </Link>
        <Link to="/download" className={linkClass}>
          {t("nav.download")}
        </Link>
        {communitiesEnabled && (
          <a href="/#communities" className={cn(linkClass, "hidden lg:inline")}>
            {t("nav.communities")}
          </a>
        )}
        <a
          href="/#hosting"
          className={cn(linkClass, "hidden lg:inline")}
          // Deliberately still English in Portuguese — see the catalogue.
          lang={locale === "en" ? undefined : "en"}
        >
          {t("nav.selfHost")}
        </a>
      </nav>

      <div className="flex shrink-0 items-center gap-3">
        <LanguagePicker variant={isHero ? "hero" : "solid"} />
        <MarketingAuthCtas appearance={isHero ? "nav-hero" : "nav-solid"} />
      </div>
    </header>
  );
}
