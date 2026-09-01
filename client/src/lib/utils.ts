import { type ClassValue, clsx } from "clsx";
import { twMerge } from "tailwind-merge";
import { translateMessage } from "@/lib/i18n/instance";
import { detectLocale } from "@/lib/locale";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export function getApiBaseUrl(): string {
  return import.meta.env.VITE_API_URL ?? "";
}

export function getWsUrl(): string {
  if (import.meta.env.VITE_WS_URL) {
    return import.meta.env.VITE_WS_URL;
  }
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${protocol}//${window.location.host}/ws`;
}

function localeTag(locale?: string): string {
  return locale ?? detectLocale();
}

export function formatTime(iso: string, locale?: string): string {
  return new Date(iso).toLocaleTimeString(localeTag(locale), {
    hour: "2-digit",
    minute: "2-digit",
  });
}

/** "Today" / "Yesterday" / a full date — the separator between message groups. */
export function formatDayLabel(iso: string, locale?: string): string {
  const date = new Date(iso);
  const today = new Date();
  const startOfDay = (d: Date) =>
    new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const dayMs = 24 * 60 * 60 * 1000;
  const diffDays = Math.round((startOfDay(today) - startOfDay(date)) / dayMs);
  const tag = localeTag(locale);

  if (diffDays === 0) {
    return translateMessage("time.today");
  }
  if (diffDays === 1) {
    return translateMessage("time.yesterday");
  }
  return date.toLocaleDateString(tag, {
    weekday: diffDays < 7 ? "long" : undefined,
    month: "short",
    day: "numeric",
    year: date.getFullYear() === today.getFullYear() ? undefined : "numeric",
  });
}

/**
 * The stamp on a conversation row: the time if it was today, "Yesterday",
 * the weekday inside a week, else a short date. A bare time on a row from
 * last Tuesday reads as "today", which is the one thing this must not say.
 */
export function formatRecency(iso: string, locale?: string): string {
  const date = new Date(iso);
  const today = new Date();
  const startOfDay = (d: Date) =>
    new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const diffDays = Math.round(
    (startOfDay(today) - startOfDay(date)) / (24 * 60 * 60 * 1000),
  );
  const tag = localeTag(locale);
  if (diffDays <= 0) {
    return formatTime(iso, locale);
  }
  if (diffDays === 1) {
    return translateMessage("time.yesterday");
  }
  if (diffDays < 7) {
    return date.toLocaleDateString(tag, { weekday: "short" });
  }
  return date.toLocaleDateString(tag, {
    day: "numeric",
    month: "short",
    year: date.getFullYear() === today.getFullYear() ? undefined : "2-digit",
  });
}

export function isSameDay(a: string, b: string): boolean {
  const first = new Date(a);
  const second = new Date(b);
  return (
    first.getFullYear() === second.getFullYear() &&
    first.getMonth() === second.getMonth() &&
    first.getDate() === second.getDate()
  );
}

/** Full timestamp for a title attribute / tooltip. */
export function formatFullTimestamp(iso: string, locale?: string): string {
  return new Date(iso).toLocaleString(localeTag(locale), {
    dateStyle: "medium",
    timeStyle: "short",
  });
}

