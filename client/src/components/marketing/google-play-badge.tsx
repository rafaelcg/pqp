import type { Locale } from "@/lib/locale";
import { cn } from "@/lib/utils";

/**
 * Google's official "Get it on Google Play" badge, unaltered per their brand
 * guidelines: no recoloring, no cropping, aspect ratio kept, a floor on how
 * small it may render. The three PNGs in `client/public/images/` are
 * downloaded byte-for-byte from `play.google.com/intl/<locale>/badges/`
 * (the same CDN most sites hotlink; self-hosted here so the button does not
 * depend on a live request to Google at render time) and are never
 * recompressed or re-encoded.
 *
 * One file per catalogue locale (`en`, `pt-BR`, `es`, the last using the
 * es-419 badge to match `intlLocale()`'s Latin American Spanish), matching
 * Google's own localized artwork rather than an English badge with
 * translated copy pasted over it.
 */

const BADGE_ASSET: Record<Locale, string> = {
  en: "/images/google-play-badge-en.png",
  "pt-BR": "/images/google-play-badge-pt-br.png",
  es: "/images/google-play-badge-es-419.png",
};

const BADGE_ALT: Record<Locale, string> = {
  en: "Get it on Google Play",
  "pt-BR": "Disponível no Google Play",
  es: "Disponible en Google Play",
};

interface GooglePlayBadgeProps {
  href: string;
  locale: Locale;
  className?: string;
  onClick?: () => void;
}

export function GooglePlayBadge({
  href,
  locale,
  className,
  onClick,
}: GooglePlayBadgeProps) {
  return (
    <a
      href={href}
      rel="noopener"
      onClick={onClick}
      className={cn(
        "inline-block rounded-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-signal/60 focus-visible:ring-offset-2 focus-visible:ring-offset-ink",
        className,
      )}
    >
      <img
        src={BADGE_ASSET[locale]}
        alt={BADGE_ALT[locale]}
        width={646}
        height={250}
        // Google's guideline: never stretch or squash the badge. Height is
        // set per call site; width follows from the fixed aspect ratio.
        className="h-14 w-auto sm:h-16"
      />
    </a>
  );
}
