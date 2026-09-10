import { useEffect, useState } from "react";
import { Clapperboard, Eye } from "lucide-react";
import type { WatchParty } from "@pqp/shared";
import { UserAvatar } from "@/components/user/user-avatar";
import { LivePill } from "@/components/watch-party/live-pill";
import { useTranslation } from "@/lib/i18n";
import { formatLiveFor } from "@/lib/live-party-card";
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
 * ONE CLICK IS WATCHING, AND THE BLOCK IS THE BUTTON. Clicking anywhere on it
 * selects the channel; the watch stage mounts on its own and the person is
 * watching with no microphone prompt and no second click. Joining the call is
 * a separate, deliberate button on the stage itself. That ordering is the fix
 * for the second browser that could not get in.
 *
 * There is no "Assistir" chip inside the block. It had one, in red, and both
 * halves of that were wrong: a button inside a button is a second target for
 * the same action, and red in this app means destructive (Encerrar, Banir).
 * The bordered card that lights up on hover is the affordance, and the
 * accessible name says what a click does.
 *
 * THE SECOND LINE IS THE NUMBERS. The card used to say only that a show was
 * on and who was hosting; the two things that tell a person whether to bother
 * (Twitch's channel card, YouTube's live tile) are how many are watching and
 * how long it has been going, and the header comment above promised a viewer
 * count from the first day. Both come from state the sidebar already holds:
 * the audience from `channel-live` and the roster, the uptime from the
 * party's own `wentLiveAt`, ticked once a minute here so a card looked at
 * for hours stays true.
 */
export function LivePartyBlock({
  parties,
  selectedChannelId,
  canStart = false,
  audience,
  onWatch,
  onCreate,
}: {
  /** Live parties in this server, newest first. Usually exactly one. */
  parties: readonly WatchParty[];
  selectedChannelId: string | null;
  /** This person holds `START_WATCH_PARTY` somewhere in this server. */
  canStart?: boolean;
  /** People watching, by channel id. Absent means "do not show a number". */
  audience?: Readonly<Record<string, number>>;
  onWatch: (channelId: string) => void;
  onCreate?: () => void;
}) {
  const { t } = useTranslation();
  // The uptime ticks once a minute while a party is on, and not at all
  // otherwise: an interval on an empty sidebar is a battery cost for nothing.
  const [now, setNow] = useState(() => new Date());
  const anyLive = parties.length > 0;
  useEffect(() => {
    if (!anyLive) {
      return;
    }
    setNow(new Date());
    const timer = window.setInterval(() => setNow(new Date()), 60_000);
    return () => window.clearInterval(timer);
  }, [anyLive]);

  if (parties.length === 0) {
    /**
     * NOTHING, OR ONE BUTTON. A member with no permission and no party
     * running sees no heading, no empty section and no placeholder: watch
     * parties simply are not part of their sidebar until one exists. A person
     * who may start one gets a single control, and it reads as an action
     * rather than as a channel type, which is the whole point of the change.
     */
    if (!canStart || !onCreate) {
      return null;
    }
    return (
      <div className="mb-3 px-1" data-testid="live-party-create">
        <button
          type="button"
          data-live-party-create
          className="flex w-full items-center gap-2 rounded-lg border border-dashed border-ink-4/70 px-2.5 py-2 text-left text-paper-muted transition-colors hover:border-danger/40 hover:bg-ink-3 hover:text-paper"
          onClick={onCreate}
        >
          <Clapperboard className="h-4 w-4 shrink-0" aria-hidden />
          <span className="truncate text-sm font-medium">
            {t("watchParty.create.button")}
          </span>
        </button>
      </div>
    );
  }
  return (
    <div className="mb-3 px-1" data-testid="live-party-block">
      <p className="mb-1 px-2 text-[10px] font-semibold uppercase tracking-wider text-paper-muted">
        {t("watchParty.block.label")}
      </p>
      <ul className="flex flex-col gap-1.5">
        {parties.map((party) => {
          const selected = selectedChannelId === party.channelId;
          const watching = audience?.[party.channelId];
          const liveFor = formatLiveFor(party.wentLiveAt, now);
          return (
            <li key={party.id}>
              <button
                type="button"
                data-live-party-row
                data-channel-id={party.channelId}
                aria-current={selected ? "page" : undefined}
                title={t("watchParty.live.watchHint")}
                aria-label={`${party.name}: ${t("watchParty.live.watch")}`}
                onClick={() => onWatch(party.channelId)}
                className={cn(
                  "flex w-full flex-col gap-1 rounded-lg border px-2.5 py-2 text-left transition-colors",
                  selected
                    ? "border-danger/50 bg-danger/10"
                    : "border-ink-4/70 bg-ink-2 hover:border-danger/40 hover:bg-ink-3",
                )}
              >
                {/* THE ANATOMY EVERY LIVE PRODUCT CONVERGES ON (Twitch's
                    sidebar row, YouTube's live tile, Kick's card, Discord's
                    Go Live card): the badge alone in the top-right, the name
                    as the one loud element, and the host and the numbers on
                    one muted line under it. The first cut of this card put
                    the badge, the count and the clock on one row with icons
                    and it read as busy; three lines, each with one job, is
                    what a 230px rail can carry. Red is reserved for the
                    badge: the avatar has no dot, nothing else competes. */}
                <span className="flex items-start justify-between gap-2">
                  <UserAvatar
                    name={party.hostDisplayName}
                    avatarUrl={party.hostAvatarUrl}
                    rounded="full"
                    className="h-8 w-8 shrink-0"
                  />
                  <LivePill className="mt-0.5" />
                </span>
                <span className="line-clamp-2 break-words text-sm font-semibold leading-snug text-paper">
                  {party.name}
                </span>
                <span className="flex min-w-0 items-baseline justify-between gap-2 text-[11px] text-paper-muted">
                  <span className="min-w-0 truncate">
                    {t("watchParty.live.hostedBy", {
                      name: party.hostDisplayName,
                    })}
                  </span>
                  {typeof watching === "number" && (
                    <span
                      className="flex shrink-0 items-center gap-1 tabular-nums"
                      data-live-party-audience={watching}
                      data-live-party-uptime={liveFor ?? undefined}
                    >
                      <Eye className="h-3 w-3 shrink-0" aria-hidden />
                      <span className="sr-only">
                        {t("watchParty.live.viewers", { count: watching })}
                      </span>
                      <span aria-hidden>{watching}</span>
                      {liveFor && (
                        <span className="text-paper-muted/70" aria-hidden>
                          {" · "}
                          {liveFor}
                        </span>
                      )}
                    </span>
                  )}
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
