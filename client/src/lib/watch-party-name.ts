/**
 * The name a new watch party starts with, so Enter on an empty head works.
 *
 * A weekday, because that is what people call these ("sessão de sábado")
 * and because it is right often enough to keep and cheap enough to replace:
 * the field is selected on open, so typing anything overwrites it. Pure.
 */
import { weekdayName } from "@/lib/channel-session-schedule";

export function suggestedWatchPartyName(date: Date, locale: string): string {
  const day = weekdayName(date, locale === "pt-BR" ? "pt-BR" : "en");
  return locale === "pt-BR"
    ? `Sessão de ${day}`
    : `${day} session`;
}
