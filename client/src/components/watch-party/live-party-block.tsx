import { Clapperboard } from "lucide-react";
import type { WatchParty } from "@pqp/shared";
import { UserAvatar } from "@/components/user/user-avatar";
import { LivePill } from "@/components/watch-party/live-pill";
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
 */
export function LivePartyBlock({
  parties,
  selectedChannelId,
  canStart = false,
  onWatch,
  onCreate,
}: {
  /** Live parties in this server, newest first. Usually exactly one. */
  parties: readonly WatchParty[];
  selectedChannelId: string | null;
  /** This person holds `START_WATCH_PARTY` somewhere in this server. */
  canStart?: boolean;
  onWatch: (channelId: string) => void;
  onCreate?: () => void;
}) {
  const { t } = useTranslation();
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
                {/* TWO ROWS, AND THAT IS WHAT MAKES IT A CARD RATHER THAN A
                    ROW WITH THINGS BOLTED ON.

                    The first attempt put the name, the AO VIVO pill and the
                    Assistir chip on one line beside a 32px avatar. On a real
                    256px rail that left about 60px for the name, so
                    "Cinemoon: sessão coruja" rendered as "Cin…": the block
                    announced that something was live without saying what,
                    which is the one job it has. Splitting it gives the name
                    the whole first line, with only the avatar beside it. AO
                    VIVO and the host drop to the second line, where the thing
                    that truncates is a name people already know rather than
                    the title of the show. Same lesson as the PRIVADO pill on the channel
                    row (PR 368): the pixels belong to the name. */}
                <span className="flex min-w-0 items-center gap-2.5">
                  <span className="relative shrink-0">
                    <UserAvatar
                      name={party.hostDisplayName}
                      avatarUrl={party.hostAvatarUrl}
                      rounded="full"
                      className="h-7 w-7"
                    />
                    {/* Static. `LivePill` below is the one thing that
                        moves; two heartbeats out of step in a card this size
                        is noise, not life. */}
                    <span
                      aria-hidden="true"
                      className="absolute -bottom-0.5 -right-0.5 h-2.5 w-2.5 rounded-full border-2 border-ink-2 bg-danger"
                    />
                  </span>
                  {/* WRAPS TO TWO LINES RATHER THAN TRUNCATING, because the
                      name is the content. "Cinemoon: sessão coruja" rendered
                      as "Cinemoon: sessão cor..." on a real rail, which is
                      most of a name people chose and the one thing this block
                      exists to say. Two lines of 14px in a block that is
                      already two rows costs nothing; a third would, so the
                      clamp is still there behind them. */}
                  <span className="line-clamp-2 break-words text-sm font-semibold leading-snug text-paper">
                    {party.name}
                  </span>
                </span>
                {/* THE LINE IS THE LIVE BADGE AND WHO IS HOSTING. NOTHING ELSE.
                    It used to carry an "Assistir" chip as well, in red, and
                    Rafael's objection was right twice over. The whole block is
                    already the button, so a button inside it is a second
                    target for the same action and it was eating the width the
                    host's name needed. And red in this app means destructive:
                    Encerrar is red, Banir is red. The primary action of a
                    watch party is not in that family, and dressing it that
                    way teaches the wrong thing about the colour.

                    The affordance is the block: a bordered card that lights
                    up on hover, with the live badge and a `title` saying what
                    a click does. No chevron either, which would be one more
                    thing to draw and would say less than the border does. */}
                <span className="flex min-w-0 items-center gap-1.5">
                  <LivePill />
                  <span className="min-w-0 truncate text-[11px] text-paper-muted">
                    {t("watchParty.live.hostedBy", {
                      name: party.hostDisplayName,
                    })}
                  </span>
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
