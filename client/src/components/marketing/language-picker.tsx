import * as DropdownMenuPrimitive from "@radix-ui/react-dropdown-menu";
import { Check, ChevronDown } from "lucide-react";
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
 * Canonical URLs and hreflang (`components/marketing/seo.tsx`,
 * `marketingUrlsFor`) follow the language the document was served in, one
 * self-referencing canonical per language (`?lang=en`, `?lang=es`, the bare
 * path for Portuguese). They never read the stored preference, so choosing a
 * language here creates no new indexable URL beyond those three.
 *
 * FLAGS: one per language, owner's call (2026-09-28): Brazil for Portuguese,
 * the United Kingdom for English, Spain for Spanish. Drawn as inline SVG
 * because emoji flags render as bare letters on Windows, and simplified for a
 * 20px chip (no Spanish coat of arms, no counterchange on the Union Jack's red
 * diagonals), which is how flags read at that size anyway.
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
        className,
      )}
    >
      {locale === "pt-BR" ? (
        <svg viewBox="0 0 20 14" className="h-full w-full" role="presentation">
          <rect width="20" height="14" className="fill-flag-br-green" />
          <polygon
            points="10,1.4 18.4,7 10,12.6 1.6,7"
            className="fill-flag-br-yellow"
          />
          <circle cx="10" cy="7" r="3.1" className="fill-flag-br-blue" />
          <path
            d="M6.6,5.9 C8.2,7.9 11.8,7.9 13.6,9.4"
            className="stroke-flag-br-white"
            strokeWidth="0.5"
            fill="none"
          />
          <g className="fill-flag-br-white">
            <circle cx="8.1" cy="5.5" r="0.24" />
            <circle cx="9.4" cy="4.9" r="0.24" />
            <circle cx="11.1" cy="5.2" r="0.24" />
            <circle cx="12.1" cy="6.1" r="0.24" />
            <circle cx="8.6" cy="8.4" r="0.24" />
            <circle cx="10.4" cy="8.7" r="0.24" />
          </g>
        </svg>
      ) : locale === "en" ? (
        <svg
          viewBox="0 0 60 30"
          preserveAspectRatio="xMidYMid slice"
          className="h-full w-full"
          role="presentation"
        >
          <rect width="60" height="30" className="fill-flag-uk-blue" />
          <path d="M0,0 L60,30 M60,0 L0,30" className="stroke-flag-uk-white" strokeWidth="6" />
          <path d="M0,0 L60,30 M60,0 L0,30" className="stroke-flag-uk-red" strokeWidth="2.5" />
          <path d="M30,0 V30 M0,15 H60" className="stroke-flag-uk-white" strokeWidth="10" />
          <path d="M30,0 V30 M0,15 H60" className="stroke-flag-uk-red" strokeWidth="6" />
        </svg>
      ) : (
        <svg viewBox="0 0 20 14" className="h-full w-full" role="presentation">
          <rect width="20" height="14" className="fill-flag-es-red" />
          <rect y="3.5" width="20" height="7" className="fill-flag-es-yellow" />
        </svg>
      )}
    </span>
  );
}

interface LanguagePickerProps {
  /** Matches `MarketingNav`'s variant: `hero` sits on a photo, `solid` on a panel. */
  variant?: "hero" | "solid";
  className?: string;
}

/**
 * Persists the choice and reloads to it.
 *
 * `?lang=` would outrank the stored preference on the very reload meant to
 * apply it, so it is dropped — but only once the preference actually landed.
 * Storage can be blocked (private mode, an embedded webview): `setLocalePreference`
 * says so, and when it does, `?lang=` becomes the only way THIS reload can
 * still honour the pick. It will not survive the next visit — there is
 * nothing left to survive it with — but a click that visibly does nothing is
 * worse than a preference that does not stick.
 */
function applyChoice(next: Locale): void {
  const persisted = setLocalePreference(next);
  try {
    const url = new URL(window.location.href);
    if (persisted) {
      url.searchParams.delete("lang");
    } else {
      url.searchParams.set("lang", next);
    }
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
          // WCAG 2.5.3 (label in name): the visible text is the two-letter
          // code, so the accessible name has to start with it. "PT, Idioma"
          // is read as the current choice and what the control is for.
          aria-label={`${LOCALE_CODE[locale]}, ${t("nav.language")}`}
          className={cn(
            "inline-flex shrink-0 items-center gap-1.5 rounded-full border px-2 py-1 text-xs font-medium tracking-wide transition-colors duration-150",
            isHero
              ? "border-white/25 bg-white/5 text-white/80 hover:border-white/45 hover:text-white"
              : "border-ink-4/60 text-paper-muted hover:border-ink-4 hover:text-paper",
            className,
          )}
        >
          <FlagChip locale={locale} />
          <span>{LOCALE_CODE[locale]}</span>
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
