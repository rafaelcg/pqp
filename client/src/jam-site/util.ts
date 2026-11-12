import { intlLocale, type Locale } from "@/lib/locale";
import { jt } from "@/lib/i18n/jam-site";
import { asInstrument, type Instrument } from "./instruments";

/**
 * `clsx` without the dependency and without `tailwind-merge`: the site's class
 * lists never conflict, and `@/lib/utils` is not importable here (it pulls the
 * app's whole English catalogue).
 */
export function cn(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(" ");
}

/** "1,2 mil" in Portuguese, "1.2K" in English. */
export function compactCount(value: number, locale: Locale): string {
  try {
    return new Intl.NumberFormat(intlLocale(locale), {
      notation: "compact",
      maximumFractionDigits: value < 10_000 ? 1 : 0,
    }).format(value);
  } catch {
    return String(value);
  }
}

/** "m:ss". */
export function clock(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

/** "há 3 h", "3 hours ago": the browser's own words for it. */
export function ago(iso: string, locale: Locale, now: number = Date.now()): string {
  const then = Date.parse(iso);
  if (!Number.isFinite(then)) {
    return "";
  }
  const seconds = Math.round((then - now) / 1000);
  const units: Array<[Intl.RelativeTimeFormatUnit, number]> = [
    ["year", 31_536_000],
    ["month", 2_592_000],
    ["week", 604_800],
    ["day", 86_400],
    ["hour", 3_600],
    ["minute", 60],
  ];
  try {
    const format = new Intl.RelativeTimeFormat(intlLocale(locale), { numeric: "auto" });
    for (const [unit, size] of units) {
      if (Math.abs(seconds) >= size) {
        return format.format(Math.round(seconds / size), unit);
      }
    }
    return format.format(0, "second");
  } catch {
    return "";
  }
}

/** What a part is called: the person's own word for it ("cavaquinho") or the instrument's name. */
export function partLabel(track: { label: string | null; instrument: string }): string {
  return track.label?.trim() || instrumentName(track.instrument);
}

/** The instrument's name, lower case: "baixo". */
export function instrumentName(instrument: Instrument | string): string {
  return jt(`instrument.${asInstrument(instrument)}` as Parameters<typeof jt>[0]);
}

/** "baixo e voz", in the language's own list grammar. */
export function listOf(items: readonly string[], locale: Locale): string {
  try {
    return new Intl.ListFormat(intlLocale(locale), { style: "long", type: "conjunction" }).format(items);
  } catch {
    return items.join(", ");
  }
}

/** A person's name for a part, with a fallback for an account that has none. */
export function personLabel(person: { name: string; handle: string | null }): string {
  return person.name.trim() || (person.handle ? `@${person.handle}` : "?");
}

export function initials(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  const letters = words.slice(0, 2).map((word) => Array.from(word)[0] ?? "");
  return letters.join("").toUpperCase() || "?";
}
