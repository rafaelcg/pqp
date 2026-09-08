import { formatSessionRelativeTime } from "@/lib/channel-session-schedule";
import { useTranslation } from "@/lib/i18n";

/**
 * "próxima: sex 21h" next to a voice channel's name in the sidebar.
 *
 * DESIGNED AS A SLOT. This is deliberately a small, generically-styled
 * inline label rather than a chip with its own icon or color, so the
 * `watch_party` channel-kind work landing separately can restyle it (a
 * badge, an icon, whatever that channel type's row ends up looking like)
 * without touching the data flow. The parent still just passes a session
 * or nothing.
 */
export function ChannelSessionHint({
  startsAt,
  now,
}: {
  startsAt: string;
  now: Date;
}) {
  const { t } = useTranslation();
  return (
    <span
      data-channel-session-hint
      className="ml-1 shrink-0 truncate text-[10px] text-paper-muted/80"
    >
      {t("watchPartySchedule.sidebarHint", {
        when: formatSessionRelativeTime(startsAt, now, "pt-BR"),
      })}
    </span>
  );
}
