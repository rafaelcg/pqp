import { Badge } from "@/components/ui/badge";
import { BetaTag } from "@/components/ui/beta-tag";
import { useTranslation } from "@/lib/i18n";

/** BOT and BETA beside a server bot's name; "removido" once it left the server. */
export function ServerBotTags({ gone = false }: { gone?: boolean }) {
  const { t } = useTranslation();
  return (
    <span className="inline-flex items-center gap-1 self-center">
      <Badge variant="accent" size="tag" className="font-bold">
        {t("chat.botTag")}
      </Badge>
      {gone ? (
        <Badge variant="muted" size="tag">
          {t("chat.botRemoved")}
        </Badge>
      ) : (
        // Under the redesign, the same tag shape as BOT beside it.
        <BetaTag className="redesign:h-[var(--badge-tag-h)] redesign:rounded-[var(--badge-radius)] redesign:px-[var(--badge-tag-px)] redesign:py-0 redesign:text-[length:var(--badge-text)] redesign:normal-case redesign:tracking-normal" />
      )}
    </span>
  );
}
