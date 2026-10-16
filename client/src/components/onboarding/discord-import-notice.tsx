import { Import, X } from "lucide-react";
import { useEffect, useId } from "react";
import { Button } from "@/components/ui/button";
import { useTranslation } from "@/lib/i18n";
import { track } from "@/lib/track";
import { cn } from "@/lib/utils";

/** One view event per server per page load: the card can be handed back. */
const viewed = new Set<string>();

/** Test seam. */
export function resetDiscordImportNoticeViewsForTests(): void {
  viewed.clear();
}

/**
 * "Veio do Discord? Traz teu servidor pra cá": one strip under the header of
 * a small, new server's main text channel, for somebody who may manage it.
 * The button opens the Discord import; the X closes it, and
 * `lib/discord-import-notice.ts` decides whether it ever comes back.
 *
 * Same frame as the arrival strip and the newcomer-invite strip, and it takes
 * the arrival strip's slot: one instruction per screen. Who sees it is
 * `discordImportNoticeVisible`; this file only draws it. A labelled region,
 * not a live region: it is a standing offer, and announcing it on every
 * channel switch would be noise for a screen reader.
 */
export function DiscordImportNotice({
  serverId,
  existing,
  onImport,
  onDismiss,
}: {
  serverId: string;
  /** The import will go into THIS server (not make a new one). Analytics only. */
  existing: boolean;
  onImport: () => void;
  onDismiss: () => void;
}) {
  const { t } = useTranslation();
  const titleId = useId();

  useEffect(() => {
    if (viewed.has(serverId)) {
      return;
    }
    viewed.add(serverId);
    track("discord_import_notice_view", { existing });
  }, [serverId, existing]);

  return (
    <section
      data-discord-import-notice=""
      aria-labelledby={titleId}
      className="animate-rise flex shrink-0 flex-wrap items-center gap-x-3 gap-y-2 border-b border-border bg-accent-soft px-4 py-3"
    >
      <span
        aria-hidden="true"
        className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-accent text-on-accent"
      >
        <Import className="h-4 w-4" />
      </span>
      <div className="min-w-0 flex-1">
        <p
          id={titleId}
          className="text-balance text-sm font-semibold text-on-accent-soft"
        >
          {t("discordImportNotice.title")}
        </p>
        <p className="mt-0.5 text-pretty text-sm text-on-accent-soft/80">
          {t("discordImportNotice.body")}
        </p>
      </div>
      {/* On a phone the button takes its own row under the text, lined up
          with it (past the 32px icon and its 12px gap), like the other
          strips; the X stays in the top row at every width. */}
      <div className="order-last flex w-full gap-2 pl-11 sm:order-none sm:w-auto sm:pl-0">
        <Button
          size="sm"
          data-discord-import-notice-action=""
          className="shrink-0"
          onClick={() => {
            track("discord_import_notice_click", { existing });
            onImport();
          }}
        >
          {t("discordImportNotice.action")}
        </Button>
      </div>
      <button
        type="button"
        data-discord-import-notice-close=""
        aria-label={t("discordImportNotice.dismiss")}
        onClick={() => {
          track("discord_import_notice_dismiss", { existing });
          onDismiss();
        }}
        className={cn(
          "relative shrink-0 rounded-[var(--radius-control)] p-1.5 text-on-accent-soft/70 transition-colors hover:bg-surface-2 hover:text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring",
          "after:absolute after:-inset-1.5 after:content-['']",
        )}
      >
        <X aria-hidden="true" className="h-4 w-4" />
      </button>
    </section>
  );
}
