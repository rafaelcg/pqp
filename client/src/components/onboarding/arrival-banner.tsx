import { PartyPopper, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useTranslation } from "@/lib/i18n";

/**
 * "You're in {server}" — one strip above the transcript, once per server.
 *
 * WHAT IT REPLACES. An invited stranger's first screen used to be `#general`
 * saying "Start the thread" over two lines of markdown syntax: the identical
 * empty state a server's own owner sees in a channel nobody has used. So the
 * moment somebody accepted an invitation, the product said nothing about where
 * they had arrived, who was there, or what to do — and the one action that turns
 * a stranger into a member is saying something, which nothing asked them to do.
 *
 * WHY A STRIP AND NOT A DIALOG. A dialog over the transcript would have to be
 * dismissed before the channel could be read, which makes the first interaction
 * with a new room "close this". This sits above the messages, pushes nothing
 * around when it goes, and is legible without being answered. It is also the
 * reason the copy names the channel rather than pointing at it: an arrow at a
 * sidebar item is a tooltip, and a tooltip cannot survive a phone.
 *
 * Dismissal is recorded by the caller (`lib/arrival.ts`), which is also what
 * suppresses it on the *second* visit even if this was never clicked — reading
 * the room and moving on is as complete an answer as clicking "Got it".
 */

interface ArrivalBannerProps {
  serverName: string;
  /** The channel it suggests speaking in, without a `#`. Null when none is open. */
  channelName: string | null;
  onDismiss: () => void;
}

export function ArrivalBanner({
  serverName,
  channelName,
  onDismiss,
}: ArrivalBannerProps) {
  const { t } = useTranslation();

  return (
    <div
      data-arrival-banner
      role="status"
      className="animate-rise flex shrink-0 items-start gap-3 border-b border-ink-4/60 bg-signal/[0.07] px-4 py-3"
    >
      <PartyPopper
        aria-hidden="true"
        className="mt-0.5 h-5 w-5 shrink-0 text-signal"
      />
      <div className="min-w-0 flex-1">
        <p className="text-sm font-semibold">
          {t("arrival.title", { server: serverName })}
        </p>
        <p className="mt-0.5 text-sm text-paper-muted">
          {channelName
            ? t("arrival.body", { channel: channelName })
            : t("arrival.bodyNoChannel")}
        </p>
      </div>
      {/* Two ways out, because the strip is wide: a labelled button for the
          reader who wants to answer it, and an X for the reader who has already
          read it and wants the pixels back. */}
      <Button
        size="sm"
        variant="secondary"
        data-arrival-dismiss
        className="hidden shrink-0 sm:inline-flex"
        onClick={onDismiss}
      >
        {t("arrival.dismiss")}
      </Button>
      <button
        type="button"
        data-arrival-close
        aria-label={t("arrival.dismiss")}
        onClick={onDismiss}
        className="shrink-0 rounded-md p-1.5 text-paper-muted transition-colors hover:bg-ink-4 hover:text-paper focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-signal/60 sm:hidden"
      >
        <X aria-hidden="true" className="h-4 w-4" />
      </button>
    </div>
  );
}
