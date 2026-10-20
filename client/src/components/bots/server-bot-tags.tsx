import { BetaTag } from "@/components/ui/beta-tag";
import { useTranslation } from "@/lib/i18n";

/** BOT and BETA beside a server bot's name; "removido" once it left the server. */
export function ServerBotTags({ gone = false }: { gone?: boolean }) {
  const { t } = useTranslation();
  return (
    <span className="inline-flex items-center gap-1 self-center">
      <span className="rounded-[var(--radius-tick)] bg-accent-soft px-1 py-px text-[10px] font-bold uppercase tracking-wide text-on-accent-soft">
        {t("chat.botTag")}
      </span>
      {gone ? (
        <span className="rounded-[var(--radius-tick)] bg-surface-3 px-1 py-px text-[10px] font-semibold uppercase tracking-wide text-text-tertiary">
          {t("chat.botRemoved")}
        </span>
      ) : (
        <BetaTag />
      )}
    </span>
  );
}
