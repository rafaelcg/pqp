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

export type SessionScheduleLocale = "pt-BR" | "en";

const WEEKDAYS_PT = [
  "domingo",
  "segunda",
  "terça",
  "quarta",
  "quinta",
  "sexta",
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
  const pt = locale === "pt-BR";

  if (diffMs <= 0) {
    return pt ? "ao vivo agora" : "live now";
  }

  const diffMinutes = Math.round(diffMs / 60_000);
  if (diffMinutes < 1) {
    return pt ? "em menos de 1 min" : "in less than 1 min";
  }
  if (diffMinutes < 60) {
    return pt ? `em ${diffMinutes} min` : `in ${diffMinutes} min`;
  }

  const diffHours = diffMs / 3_600_000;
  const hh = pad2(target.getHours());
  const mm = pad2(target.getMinutes());
  if (sameCalendarDay(target, now)) {
    return pt ? `hoje às ${hh}h${mm}` : `today at ${hh}:${mm}`;
  }

  const tomorrow = new Date(now);
  tomorrow.setDate(tomorrow.getDate() + 1);
  if (sameCalendarDay(target, tomorrow)) {
    return pt ? `amanhã às ${hh}h${mm}` : `tomorrow at ${hh}:${mm}`;
  }

  if (diffHours < 24 * 6) {
    const weekday = (pt ? WEEKDAYS_PT : WEEKDAYS_EN)[target.getDay()];
    return pt ? `${weekday} às ${hh}h${mm}` : `${weekday} at ${hh}:${mm}`;
  }

  const diffDays = Math.round(diffHours / 24);
  return pt ? `em ${diffDays} dias` : `in ${diffDays} days`;
}

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
