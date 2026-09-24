/**
 * Watch party scheduling: client-side pieces that do not need the full
 * component tree to be worth shipping and testing on their own: the feature
 * flag gate, and the relative-time label the upcoming-session card and the
 * sidebar hint both need.
 *
 * WHY THIS IS A PURE FUNCTION AND NOT A HOOK. The card, the sidebar hint and
 * (eventually) a countdown all want the same string for the same
 * `startsAt`/`now` pair; a hook would mean three places independently
 * deciding whether to poll and how often. Callers own the ticking (an
 * interval, or `useEffect` + `setInterval`); this only ever answers "what
 * does it say right now".
 */

/** `VITE_WATCH_PARTY_SCHEDULE`, off by default, per CLAUDE.md env var conventions. */
export function isChannelSessionScheduleEnabled(): boolean {
  return import.meta.env.VITE_WATCH_PARTY_SCHEDULE === "true";
}

export type SessionScheduleLocale = "pt-BR" | "en" | "es";

const WEEKDAYS_PT = [
  "domingo",
  "segunda",
  "terça",
  "quarta",
  "quinta",
  "sexta",
  "sábado",
];
const WEEKDAYS_ES = [
  "domingo",
  "lunes",
  "martes",
  "miércoles",
  "jueves",
  "viernes",
  "sábado",
];
const WEEKDAYS_EN = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
];

/** The weekday's name in the locale's own casing ("sábado", "Saturday"). */
export function weekdayName(date: Date, locale: SessionScheduleLocale): string {
  return weekdays(locale)[date.getDay()]!;
}

function weekdays(locale: SessionScheduleLocale): string[] {
  return locale === "pt-BR"
    ? WEEKDAYS_PT
    : locale === "es"
      ? WEEKDAYS_ES
      : WEEKDAYS_EN;
}

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

function sameCalendarDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

/**
 * "em 12 min", "começa em 12 min": swap the label depending on `live`
 * urgency wording is the caller's call (a countdown reads differently 2 days
 * out than 2 minutes out); this only produces the time phrase.
 *
 * `now` is a parameter, not `Date.now()`, so a card re-rendering on its own
 * timer and a unit test asserting a fixed instant call the same function.
 */
export function formatSessionRelativeTime(
  startsAt: string | Date,
  now: Date,
  locale: SessionScheduleLocale = "pt-BR",
): string {
  const target = typeof startsAt === "string" ? new Date(startsAt) : startsAt;
  const diffMs = target.getTime() - now.getTime();
  const words = PHRASES[locale];

  if (diffMs <= 0) {
    return words.live;
  }

  const diffMinutes = Math.round(diffMs / 60_000);
  if (diffMinutes < 1) {
    return words.underAMinute;
  }
  if (diffMinutes < 60) {
    return words.inMinutes(diffMinutes);
  }

  const diffHours = diffMs / 3_600_000;
  const clock = words.clock(pad2(target.getHours()), pad2(target.getMinutes()));
  if (sameCalendarDay(target, now)) {
    return words.today(clock);
  }

  const tomorrow = new Date(now);
  tomorrow.setDate(tomorrow.getDate() + 1);
  if (sameCalendarDay(target, tomorrow)) {
    return words.tomorrow(clock);
  }

  if (diffHours < 24 * 6) {
    return words.weekday(weekdays(locale)[target.getDay()]!, clock);
  }

  return words.inDays(Math.round(diffHours / 24));
}

interface SchedulePhrases {
  live: string;
  underAMinute: string;
  inMinutes: (n: number) => string;
  clock: (hh: string, mm: string) => string;
  today: (clock: string) => string;
  tomorrow: (clock: string) => string;
  weekday: (day: string, clock: string) => string;
  inDays: (n: number) => string;
}

const PHRASES: Record<SessionScheduleLocale, SchedulePhrases> = {
  "pt-BR": {
    live: "ao vivo agora",
    underAMinute: "em menos de 1 min",
    inMinutes: (n) => `em ${n} min`,
    clock: (hh, mm) => `${hh}h${mm}`,
    today: (clock) => `hoje às ${clock}`,
    tomorrow: (clock) => `amanhã às ${clock}`,
    weekday: (day, clock) => `${day} às ${clock}`,
    inDays: (n) => `em ${n} dias`,
  },
  es: {
    live: "en vivo ahora",
    underAMinute: "en menos de 1 min",
    inMinutes: (n) => `en ${n} min`,
    clock: (hh, mm) => `${hh}:${mm}`,
    today: (clock) => `hoy a las ${clock}`,
    tomorrow: (clock) => `mañana a las ${clock}`,
    weekday: (day, clock) => `el ${day} a las ${clock}`,
    inDays: (n) => `en ${n} días`,
  },
  en: {
    live: "live now",
    underAMinute: "in less than 1 min",
    inMinutes: (n) => `in ${n} min`,
    clock: (hh, mm) => `${hh}:${mm}`,
    today: (clock) => `today at ${clock}`,
    tomorrow: (clock) => `tomorrow at ${clock}`,
    weekday: (day, clock) => `${day} at ${clock}`,
    inDays: (n) => `in ${n} days`,
  },
};

// ---------------------------------------------------------- reminder toast bus

/**
 * A `channel-session-reminder` WS frame, as `App.tsx`'s message router
 * received it. Same shape as `onActivityToast` in notifications.ts: the
 * frame is addressed to this user specifically, so there is one listener
 * (the toast stack), not a per-channel subscription.
 */
export interface ChannelSessionReminderToast {
  sessionId: string;
  channelId: string;
  title: string;
  startsAt: string;
  kind: "before" | "live";
}

const reminderToastListeners = new Set<
  (toast: ChannelSessionReminderToast) => void
>();

export function emitChannelSessionReminderToast(
  toast: ChannelSessionReminderToast,
): void {
  for (const listener of reminderToastListeners) {
    listener(toast);
  }
}

export function onChannelSessionReminderToast(
  listener: (toast: ChannelSessionReminderToast) => void,
): () => void {
  reminderToastListeners.add(listener);
  return () => {
    reminderToastListeners.delete(listener);
  };
}

// ------------------------------------------------------------- form helpers

/** `datetime-local` wants `YYYY-MM-DDTHH:mm` in local time. Same shape as
 * the Baú schedule form's own helper (community-home-feed.tsx); duplicated
 * rather than imported because that one is private to its component. */
export function toLocalInputValue(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function browserTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

export function defaultSessionScheduleValue(): string {
  const next = new Date(Date.now() + 60 * 60 * 1000);
  next.setMinutes(0, 0, 0);
  return toLocalInputValue(next);
}
