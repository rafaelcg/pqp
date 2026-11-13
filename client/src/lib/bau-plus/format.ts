import { intlLocale, type Locale } from "@/lib/locale";

/**
 * Money and dates on the Baú+ screens. The currency is always the real (Pix
 * is Brazil only); the digits follow the reader's language, so pt-BR reads
 * "R$ 9,90" and English "R$9.90".
 */

export function formatBrl(cents: number, locale: Locale): string {
  return new Intl.NumberFormat(intlLocale(locale), {
    style: "currency",
    currency: "BRL",
    minimumFractionDigits: 2,
  }).format(cents / 100);
}

/**
 * "2 de dezembro" / "December 2". Long, so a sentence never ends in "dez..".
 * The year only when it is not this year.
 */
export function formatBauDay(
  iso: string,
  locale: Locale,
  now = new Date(),
): string {
  const date = new Date(iso);
  return new Intl.DateTimeFormat(intlLocale(locale), {
    day: "numeric",
    month: "long",
    ...(date.getFullYear() !== now.getFullYear() ? { year: "numeric" } : {}),
  }).format(date);
}

/** "14:05", the countdown under a Pix code. Never negative. */
export function formatCountdown(msLeft: number): string {
  const total = Math.max(0, Math.ceil(msLeft / 1000));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

/**
 * Where a paid month stands: whole days left (rounded up, so the last few
 * hours still read "1 dia") and how much of the month is still ahead, from 1
 * (just paid) to 0 (ends now). Null without both ends of the period.
 */
export function bauPeriodLeft(
  periodStart: string | null,
  periodEnd: string | null,
  now = Date.now(),
): { daysLeft: number; remaining: number } | null {
  if (!periodStart || !periodEnd) return null;
  const start = new Date(periodStart).getTime();
  const end = new Date(periodEnd).getTime();
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) {
    return null;
  }
  const left = Math.max(0, end - now);
  return {
    daysLeft: Math.ceil(left / 86_400_000),
    remaining: Math.min(1, Math.max(0, left / (end - start))),
  };
}
