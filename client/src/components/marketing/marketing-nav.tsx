import { Link } from "react-router-dom";
import { MarketingAuthCtas } from "@/components/marketing/marketing-auth-ctas";
import { BetaTag } from "@/components/ui/beta-tag";
import { useTranslation } from "@/lib/i18n";
import { cn } from "@/lib/utils";

interface MarketingNavProps {
  variant?: "hero" | "solid";
}

export function MarketingNav({ variant = "solid" }: MarketingNavProps) {
  const { t, locale } = useTranslation();
  const isHero = variant === "hero";
  const linkClass = cn(
    "text-xs font-medium uppercase tracking-[0.18em] transition-opacity hover:opacity-100",
    isHero ? "text-white/70 opacity-90" : "text-paper-muted hover:text-paper",
  );

  return (
    <header
      className={cn(
        "relative z-20 flex h-16 items-center justify-between px-5 sm:px-8",
        !isHero && "border-b border-ink-4/50 bg-ink/80 backdrop-blur-md",
      )}
    >
      <Link
        to="/"
        className={cn(
          "flex items-center gap-2 font-brand text-xl tracking-tight",
          isHero ? "text-white" : "text-paper",
        )}
      >
        pqp
        <BetaTag variant={isHero ? "hero" : "default"} />
      </Link>

      <nav className="hidden items-center gap-8 md:flex">
        <a href="/#how" className={linkClass}>
          {t("nav.howItWorks")}
        </a>
        <a href="/#communities" className={linkClass}>
          {t("nav.communities")}
        </a>
        <a
          href="/#hosting"
          className={linkClass}
          // Deliberately still English in Portuguese — see the catalogue.
          lang={locale === "en" ? undefined : "en"}
        >
          {t("nav.selfHost")}
        </a>
      </nav>

      <MarketingAuthCtas appearance={isHero ? "nav-hero" : "nav-solid"} />
    </header>
  );
}
