import * as DropdownMenuPrimitive from "@radix-ui/react-dropdown-menu";
import { Check, ChevronDown, Globe } from "lucide-react";
import { useTranslation, type MessageKey } from "@/lib/i18n";
import { SUPPORTED_LOCALES, setLocalePreference, type Locale } from "@/lib/locale";
import { cn } from "@/lib/utils";

/**
 * Lets a visitor override auto-detected language on any public page.
 *
 * `detectLocale()` already puts a saved `localStorage` choice ahead of the
 * served/browser signals (`lib/locale.ts`), so this component only has to
 * write that preference and reload — it does not need to touch resolution
 * order itself. `I18nProvider` reads the locale once at boot (see
 * `docs/I18N.md` § Boot and switch), so a live in-place swap is not an
 * option; this is the same reload `LanguagePicker` in the authenticated
 * settings modal already does, minus the signed-in profile sync.
 *
 * Canonical URLs and hreflang (`components/marketing/seo.tsx`) never read the
 * stored preference or the current locale — they always emit the bare path
 * plus the three `?lang=` alternates — so choosing a language here creates no
 * new indexable URL and does not touch SEO at all.
 *
 * FLAGS: Portuguese gets Brazil's, because `pt-BR` genuinely is one country's
 * catalogue and that flag is unambiguous. English and Spanish do not get a
 * flag. Both catalogues are deliberately regionless — `docs/I18N.md` writes
 * Spanish for "Mexico, Colombia, Argentina, Chile and US Latinos" as one
 * text, and English serves every English-speaking country the same copy — so
 * a Union Jack, a Stars and Stripes, or any single Spanish-speaking country's
 * flag would claim an ownership the product does not have and could read as
 * a small insult to everyone it left out. A globe glyph says "this language,
 * no particular country" without guessing wrong.
 */

const LOCALE_LABEL_KEY: Record<Locale, MessageKey> = {
  en: "settings.appearance.language.en",
  "pt-BR": "settings.appearance.language.ptBR",
  es: "settings.appearance.language.es",
};

const LOCALE_CODE: Record<Locale, string> = {
  en: "EN",
  "pt-BR": "PT",
  es: "ES",
};

function FlagChip({
  locale,
  className,
}: {
  locale: Locale;
  className?: string;
}) {
  return (
    <span
      aria-hidden
      className={cn(
        "inline-flex h-3.5 w-5 shrink-0 items-center justify-center overflow-hidden rounded-[3px] border border-ink-4/70",
        locale !== "pt-BR" && "bg-ink-3 text-paper-muted",
        className,
      )}
    >
      {locale === "pt-BR" ? (
        <svg viewBox="0 0 20 14" className="h-full w-full" role="presentation">
          <rect width="20" height="14" fill="#049646" />
          <polygon points="10,1.4 18.4,7 10,12.6 1.6,7" fill="#FEDD00" />
          <circle cx="10" cy="7" r="3.1" fill="#08328C" />
          <path
            d="M6.6,5.9 C8.2,7.9 11.8,7.9 13.6,9.4"
            stroke="#fff"
            strokeWidth="0.5"
            fill="none"
          />
          <g fill="#fff">
            <circle cx="8.1" cy="5.5" r="0.24" />
            <circle cx="9.4" cy="4.9" r="0.24" />
            <circle cx="11.1" cy="5.2" r="0.24" />
            <circle cx="12.1" cy="6.1" r="0.24" />
            <circle cx="8.6" cy="8.4" r="0.24" />
            <circle cx="10.4" cy="8.7" r="0.24" />
          </g>
        </svg>
      ) : (
        <Globe className="h-2.5 w-2.5" strokeWidth={2} />
      )}
    </span>
  );
}

interface LanguagePickerProps {
  /** Matches `MarketingNav`'s variant: `hero` sits on a photo, `solid` on a panel. */
  variant?: "hero" | "solid";
  className?: string;
}

/** Drops `?lang=` (it would otherwise outrank the choice just saved) and reloads. */
function applyChoice(next: Locale): void {
  setLocalePreference(next);
  try {
    const url = new URL(window.location.href);
    url.searchParams.delete("lang");
    window.location.href = url.toString();
  } catch {
    window.location.reload();
  }
}

export function LanguagePicker({ variant = "solid", className }: LanguagePickerProps) {
  const { t, locale } = useTranslation();
  const isHero = variant === "hero";

  return (
    <DropdownMenuPrimitive.Root>
      <DropdownMenuPrimitive.Trigger asChild>
        <button
          type="button"
          aria-label={t("nav.language")}
          className={cn(
            "inline-flex shrink-0 items-center gap-1.5 rounded-full border px-2 py-1 text-xs font-medium tracking-wide transition-colors duration-150",
            isHero
              ? "border-white/25 bg-white/5 text-white/80 hover:border-white/45 hover:text-white"
              : "border-ink-4/60 text-paper-muted hover:border-ink-4 hover:text-paper",
            className,
          )}
        >
          <FlagChip locale={locale} />
          <span aria-hidden>{LOCALE_CODE[locale]}</span>
          <ChevronDown aria-hidden className="h-3 w-3 opacity-70" />
        </button>
      </DropdownMenuPrimitive.Trigger>
      <DropdownMenuPrimitive.Portal>
        <DropdownMenuPrimitive.Content
          align="end"
          sideOffset={6}
          collisionPadding={8}
          className="elevation-3 z-[100] min-w-[10.5rem] rounded-[var(--radius-card)] p-1 animate-fade-in"
        >
          {SUPPORTED_LOCALES.map((option) => {
            const selected = option === locale;
            return (
              <DropdownMenuPrimitive.Item
                key={option}
                onSelect={() => applyChoice(option)}
                className={cn(
                  "flex cursor-pointer items-center gap-2.5 rounded-md px-2.5 py-2 text-sm text-paper outline-none transition-colors duration-100",
                  "data-[highlighted]:bg-ink-3 data-[highlighted]:text-paper",
                )}
              >
                <FlagChip locale={option} />
                <span className="flex-1">{t(LOCALE_LABEL_KEY[option])}</span>
                {selected && (
                  <Check aria-hidden className="h-3.5 w-3.5 text-signal" />
                )}
              </DropdownMenuPrimitive.Item>
            );
          })}
        </DropdownMenuPrimitive.Content>
      </DropdownMenuPrimitive.Portal>
    </DropdownMenuPrimitive.Root>
  );
}
