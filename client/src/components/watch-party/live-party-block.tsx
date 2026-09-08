import type { WatchParty } from "@pqp/shared";
import { UserAvatar } from "@/components/user/user-avatar";
import { useTranslation } from "@/lib/i18n";
import { cn } from "@/lib/utils";

/**
 * The live watch party, at the very top of the channel list, above the
 * categories, as its own block.
 *
 * WHY IT IS NOT A ROW WITH A BADGE. It was, this morning, and Rafael's answer
 * was that a watch party has to read as an event rather than as a voice
 * channel that happens to be busy. The differences are deliberate and all of
 * them are about identity: the PARTY'S name, not the channel's; the HOST'S
 * face, because an event has somebody running it; a viewer count, because
 * that is what tells you whether to bother; and a live pill. Sitting above
 * the categories is the last part of it, and the part a badge can never do.
 *
 * PREMIUM MEANS CALM. No gradient, no glow, no second colour. The block is
 * the same ink surface as everything else with a border that picks up the
 * live red, one pulsing dot (off under `prefers-reduced-motion`) and slightly
 * more room than a row. Loud would make the sidebar unusable during a show,
 * which is exactly when people need to read the rest of it.
 *
 * ONE CLICK IS WATCHING. The block's action is "Assistir" and it selects the
 * channel; the watch stage mounts on its own and the person is watching with
 * no microphone prompt and no second click. Joining the call is a separate,
 * deliberate button on the stage itself. That ordering is the fix for the
 * second browser that could not get in.
 */
export function LivePartyBlock({
  parties,
  selectedChannelId,
  onWatch,
}: {
  /** Live parties in this server, newest first. Usually exactly one. */
  parties: readonly WatchParty[];
  selectedChannelId: string | null;
  onWatch: (channelId: string) => void;
}) {
  const { t } = useTranslation();
  if (parties.length === 0) {
    return null;
  }
  return (
    <div className="mb-3 px-1" data-testid="live-party-block">
      <p className="mb-1 px-2 text-[10px] font-semibold uppercase tracking-wider text-paper-muted">
        {t("watchParty.block.label")}
      </p>
      <ul className="flex flex-col gap-1.5">
        {parties.map((party) => {
          const selected = selectedChannelId === party.channelId;
          return (
            <li key={party.id}>
              <button
                type="button"
                data-live-party-row
                data-channel-id={party.channelId}
                aria-current={selected ? "page" : undefined}
                title={t("watchParty.live.watchHint")}
                onClick={() => onWatch(party.channelId)}
                className={cn(
                  "flex w-full items-center gap-2.5 rounded-lg border px-2.5 py-2 text-left transition-colors",
                  selected
                    ? "border-danger/50 bg-danger/10"
                    : "border-ink-4/70 bg-ink-2 hover:border-danger/40 hover:bg-ink-3",
                )}
              >
                <span className="relative shrink-0">
                  <UserAvatar
                    name={party.hostDisplayName}
                    avatarUrl={party.hostAvatarUrl}
                    rounded="full"
                    className="h-8 w-8"
                  />
                  <span
                    aria-hidden="true"
                    className="absolute -bottom-0.5 -right-0.5 h-2.5 w-2.5 rounded-full border-2 border-ink-2 bg-danger motion-safe:animate-pulse"
                  />
                </span>
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="flex min-w-0 items-center gap-1.5">
                    <span className="truncate text-sm font-semibold text-paper">
                      {party.name}
                    </span>
                    <span className="shrink-0 rounded-full bg-danger/15 px-1.5 py-px text-[9px] font-bold uppercase tracking-wider text-danger">
                      {t("watchParty.live.badge")}
                    </span>
                  </span>
                  <span className="truncate text-[11px] text-paper-muted">
                    {t("watchParty.live.hostedBy", {
                      name: party.hostDisplayName,
                    })}
                  </span>
                </span>
                <span className="shrink-0 rounded-md bg-danger/15 px-2 py-1 text-[11px] font-semibold text-danger">
                  {t("watchParty.live.watch")}
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
