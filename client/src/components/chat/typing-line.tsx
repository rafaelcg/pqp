import type { TypingUser } from "@/hooks/use-chat";
import type { Translator } from "@/lib/i18n";
import { useTranslation } from "@/lib/i18n";

/** Past this many, a count stops meaning anything: "Muita gente". */
const TYPING_MANY = 20;

/** "Bia está digitando", two names, or a count. People only, never bots. */
export function typingLabel(t: Translator["t"], names: readonly string[]): string {
  return names.length === 0
    ? ""
    : names.length > TYPING_MANY
      ? t("chat.typingMany")
    : names.length === 1
      ? t("chat.typing_one", { name: names[0]! })
      : names.length === 2
        ? t("chat.typing_two", { name: names[0]!, other: names[1]! })
        : t("chat.typing_other", { count: names.length });
}

/**
 * Who is typing, for the composer's status line under the redesign. Bots
 * keep their own rows above the composer (`TypingIndicator` in the list).
 */
export function TypingLine({ users }: { users: readonly TypingUser[] }) {
  const { t } = useTranslation();
  const names = users.filter((user) => !user.activity).map((user) => user.displayName);
  if (names.length === 0) {
    return null;
  }
  return (
    <span data-typing-line="" aria-live="polite" className="inline-flex min-w-0 items-center gap-1.5">
      <span aria-hidden="true" className="flex shrink-0 gap-0.5">
        {[0, 1, 2].map((index) => (
          <span
            key={index}
            className="h-1.5 w-1.5 animate-bounce rounded-full bg-text-tertiary"
            style={{ animationDelay: `${index * 120}ms` }}
          />
        ))}
      </span>
      <span className="truncate">{typingLabel(t, names)}…</span>
    </span>
  );
}
