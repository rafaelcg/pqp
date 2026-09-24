/**
 * The name a new watch party starts with, so Enter on an empty head works.
 *
 * A weekday, because that is what people call these ("sessão de sábado")
 * and because it is right often enough to keep and cheap enough to replace:
 * the field is selected on open, so typing anything overwrites it. Pure.
 */
import { weekdayName } from "@/lib/channel-session-schedule";

export function suggestedWatchPartyName(date: Date, locale: string): string {
  if (locale === "pt-BR") {
    return `Sessão de ${weekdayName(date, "pt-BR")}`;
  }
  if (locale === "es") {
    return `Función del ${weekdayName(date, "es")}`;
  }
  return `${weekdayName(date, "en")} session`;
}
