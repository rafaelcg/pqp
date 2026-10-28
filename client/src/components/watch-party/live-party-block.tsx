import { useEffect, useState } from "react";
import {
  Check as CheckBold,
  ClockCounterClockwise,
  Eye as EyeFill,
  FilmSlate,
} from "@phosphor-icons/react";
import { Check, Clapperboard, Copy, Eraser, Eye, History } from "lucide-react";
import type { WatchParty } from "@pqp/shared";
import { UserAvatar } from "@/components/user/user-avatar";
import { LivePill } from "@/components/watch-party/live-pill";
import { ContextMenu, type ContextMenuItemDef } from "@/components/ui/context-menu";
import { useTranslation } from "@/lib/i18n";
import { formatLiveFor } from "@/lib/live-party-card";
import { Icon } from "@/components/ui/icon";
import { SectionLabel } from "@/components/ui/section-header";
import {
  SIDEBAR_CARD_REDESIGN,
  SIDEBAR_INVITE_REDESIGN,
} from "@/components/ui/sidebar-block";
import { cn } from "@/lib/utils";

/** Keyboard focus on a sidebar party row: the redesign's ring, cut from the side pane. */
const PARTY_FOCUS_REDESIGN =
  "redesign:focus-visible:outline-none redesign:focus-visible:ring-2 redesign:focus-visible:ring-offset-2 redesign:focus-visible:ring-offset-[color:var(--color-pane-side)] redesign:focus-visible:ring-[color:var(--color-focus-ring)]";

/** The clapperboard: Lucide with the toggle off, filled under the redesign. */
function PartyGlyph({ className }: { className?: string }) {
  return (
    <>
      <Clapperboard className={cn("h-4 w-4 shrink-0 redesign:hidden", className)} aria-hidden />
      <Icon icon={FilmSlate} size="sm" className={cn("hidden redesign:block", className)} />
    </>
  );
}

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
/**
 * The one-or-many "Transmissões anteriores" link(s) rendered beside the
 * create/pending card, and the whole reason `historyChannels` exists on
 * `LivePartyBlock`: this is a person's only way back into a `watch_party`
 * channel's own history once its show has ended and the channel has gone
 * back to being unreachable. Split out mainly so the three branches of
 * `parties.length === 0` below can share it without repeating the map.
 */
function HistoryLinks({
  channels,
  onOpen,
}: {
  channels: readonly { id: string; name: string }[];
  onOpen: (channelId: string) => void;
}) {
  const { t } = useTranslation();
  if (channels.length === 0) {
    return null;
  }
  return (
    <ul
      className="mt-1.5 flex flex-col gap-0.5"
      data-testid="live-party-history-links"
    >
      {channels.map((channel) => (
        <li key={channel.id}>
          <button
            type="button"
            data-live-party-history={channel.id}
            className="flex w-full items-center gap-1.5 rounded-md px-1.5 py-1 text-left text-xs text-paper-muted transition-colors hover:text-paper redesign:rounded-full redesign:px-2.5 redesign:py-1.5 redesign:text-text-secondary redesign:hover:bg-row-hover redesign:hover:text-text"
            onClick={() => onOpen(channel.id)}
          >
            <History className="h-3.5 w-3.5 shrink-0 redesign:hidden" aria-hidden />
            <Icon icon={ClockCounterClockwise} size="sm" kind="symbol" className="hidden h-3.5 w-3.5 redesign:block" />
            <span className="truncate">
              {channels.length > 1
                ? t("chrome.watchPartyHistoryNamed", { name: channel.name })
                : t("chrome.watchPartyHistory")}
            </span>
          </button>
        </li>
      ))}
    </ul>
  );
}

export function LivePartyBlock({
  parties,
  selectedChannelId,
  canStart = false,
  pending = null,
  audience,
  onWatch,
  onCreate,
  canPurge,
  onPurge,
  historyChannels = [],
  onOpenHistory,
  recoveringChannelId = null,
  teaser = null,
}: {
  /** Live parties in this server, newest first. Usually exactly one. */
  parties: readonly WatchParty[];
  selectedChannelId: string | null;
  /**
   * The party whose card should say "reconnecting" instead of "AO VIVO": the
   * one this viewer is presenting whose screen publish has dropped. Only ever
   * this viewer's own channel (`use-voice`'s `sharePublishRecovering`), so a
   * genuine audience card is never touched. Null when nothing is recovering.
   */
  recoveringChannelId?: string | null;
  /** This person holds `START_WATCH_PARTY` somewhere in this server. */
  canStart?: boolean;
  /**
   * A draft or scheduled party in this server that this person runs. A
   * draft is private and lives only on its channel, so the sidebar used to
   * keep offering "Criar" over one that already existed, and the API then
   * refused. The control becomes the way back to it instead.
   */
  pending?: WatchParty | null;
  /** People watching, by channel id. Absent means "do not show a number". */
  audience?: Readonly<Record<string, number>>;
  onWatch: (channelId: string) => void;
  onCreate?: () => void;
  /** MANAGE_MESSAGES, server-wide. Gates the "clear recent messages" entry, same as a text channel's row. */
  canPurge?: boolean;
  /** Opens the same purge confirm dialog a text channel's context menu opens, on this party's channel. */
  onPurge?: (channelId: string, name: string) => void;
  /**
   * `watch_party` channels this viewer may see the history of AND that have
   * a broadcast to show (`watchPartyHistoryCandidates` +
   * `useWatchPartyHistoryAvailability`). This is THE reachability fix: with
   * no party running, the channel these came from has no row anywhere else
   * in the app. Empty draws nothing extra.
   */
  historyChannels?: readonly { id: string; name: string }[];
  /** Opens `WatchPartyHistoryDialog` on the given channel. Required to use `historyChannels`. */
  onOpenHistory?: (channelId: string) => void;
  /**
   * The waitlist teaser, for a server where watch parties are NOT on
   * (`shouldOfferWatchPartyTeaser`). Only ever drawn in the branch where there
   * is no party and no create control, so a server that can run a party never
   * sees it: that server has `canStart` and takes the branch above.
   */
  teaser?: { onList: boolean; onOpen: () => void } | null;
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
     * NOTHING, OR ONE BUTTON -- PLUS, MAYBE, THE WAY BACK TO YESTERDAY'S SHOW.
     * A member with no permission, no party running and no history to see
     * gets no heading, no empty section and no placeholder: watch parties
     * simply are not part of their sidebar until one exists. A person who
     * may start one gets a single control, and it reads as an action rather
     * than as a channel type, which is the whole point of the change.
     *
     * `historyChannels` is the exception, and a deliberately narrow one: a
     * moderator who may see a channel's past broadcasts (START_WATCH_PARTY
     * or MANAGE_CHANNELS) gets a small secondary link even here, because an
     * idle `watch_party` channel has no row anywhere else in the app for
     * them to reach it from. It is not gated on `canStart` -- a
     * MANAGE_CHANNELS moderator without START_WATCH_PARTY cannot start a
     * party but can still administer the channel's history.
     */
    const historyLinks =
      onOpenHistory && historyChannels.length > 0 ? (
        <HistoryLinks channels={historyChannels} onOpen={onOpenHistory} />
      ) : null;
    if (pending) {
      const scheduled = pending.state === "scheduled";
      return (
        <div className="mb-3 px-1" data-testid="live-party-pending">
          <button
            type="button"
            data-live-party-pending={pending.state}
            className={`${PARTY_FOCUS_REDESIGN} flex w-full items-center gap-2 rounded-lg border border-warning/40 bg-warning/10 px-2.5 py-2 text-left transition-colors hover:bg-warning/15 redesign:gap-2.5 redesign:rounded-[var(--sidebar-card-radius)] redesign:border-transparent redesign:bg-warning-soft redesign:px-3 redesign:hover:bg-[color:color-mix(in_oklab,var(--color-warning-soft)_85%,var(--color-text))]`}
            onClick={() => onWatch(pending.channelId)}
          >
            <PartyGlyph className="text-warning redesign:text-on-warning-soft" />
            <span className="flex min-w-0 flex-col">
              <span className="truncate text-sm font-medium text-paper redesign:font-semibold redesign:text-text">
                {pending.name}
              </span>
              <span className="text-[11px] text-warning redesign:text-xs redesign:text-on-warning-soft">
                {scheduled
                  ? t("watchParty.block.pendingScheduled")
                  : t("watchParty.block.pendingDraft")}
              </span>
            </span>
          </button>
          {historyLinks}
        </div>
      );
    }
    if (!canStart || !onCreate) {
      if (teaser) {
        return (
          <div className="mb-3 px-1" data-testid="live-party-teaser">
            <button
              type="button"
              data-live-party-teaser={teaser.onList ? "on-list" : "open"}
              aria-label={t("watchParty.waitlist.teaser.aria")}
              className={cn(
                PARTY_FOCUS_REDESIGN,
                "flex w-full items-center gap-2 rounded-lg border border-dashed border-ink-4/70 px-2.5 py-2 text-left text-paper-muted transition-colors hover:border-accent/50 hover:bg-ink-3 hover:text-paper",
                // On the list it is settled, and settled is a card; until then
                // it is a dashed invitation.
                teaser.onList ? SIDEBAR_CARD_REDESIGN : SIDEBAR_INVITE_REDESIGN,
                "redesign:gap-2.5 redesign:px-3",
              )}
              onClick={teaser.onOpen}
            >
              {/* Two lines, the same anatomy as the pending card above: the
                  name, and under it the one word that says what state this
                  is. A pill beside the name cut "Watch party" to "Watc..."
                  in a 230px rail. */}
              <PartyGlyph />
              <span className="flex min-w-0 flex-col">
                <span className={cn("truncate text-sm font-medium redesign:font-semibold", teaser.onList && "redesign:text-text")}>
                  {t("watchParty.waitlist.teaser.label")}
                </span>
                <span
                  className={cn(
                    "flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wider",
                    teaser.onList ? "text-success" : "text-accent",
                    // Sentence case at the second line's size, in the text
                    // forms of the tones.
                    "redesign:text-xs redesign:normal-case redesign:tracking-normal",
                    teaser.onList ? "redesign:text-success-text" : "redesign:text-accent-text",
                  )}
                >
                  {teaser.onList && (
                    <>
                      <Check className="h-3 w-3 redesign:hidden" aria-hidden />
                      <Icon icon={CheckBold} kind="symbol" size="sm" className="hidden h-3 w-3 redesign:block" />
                    </>
                  )}
                  {teaser.onList
                    ? t("watchParty.waitlist.teaser.onList")
                    : t("watchParty.waitlist.teaser.badge")}
                </span>
              </span>
            </button>
            {historyLinks}
          </div>
        );
      }
      if (!historyLinks) {
        return null;
      }
      return (
        <div className="mb-3 px-1" data-testid="live-party-history-only">
          {historyLinks}
        </div>
      );
    }
    return (
      <div className="mb-3 px-1" data-testid="live-party-create">
        <button
          type="button"
          data-live-party-create
          className={cn(
            PARTY_FOCUS_REDESIGN,
            "flex w-full items-center gap-2 rounded-lg border border-dashed border-ink-4/70 px-2.5 py-2 text-left text-paper-muted transition-colors hover:border-danger/40 hover:bg-ink-3 hover:text-paper",
            SIDEBAR_INVITE_REDESIGN,
            "redesign:gap-2.5 redesign:px-3",
          )}
          onClick={onCreate}
        >
          {/* "Make something" at the empty Baú's volume: the glyph in the accent. */}
          <PartyGlyph className="redesign:text-accent-text" />
          <span className="truncate text-sm font-medium">
            {t("watchParty.create.button")}
          </span>
        </button>
        {historyLinks}
      </div>
    );
  }
  return (
    <div className="mb-3 px-1" data-testid="live-party-block">
      <SectionLabel as="p" className="mb-1 px-2 text-[10px] font-semibold uppercase tracking-wider text-paper-muted redesign:px-3">
        {t("watchParty.block.label")}
      </SectionLabel>
      <ul className="flex flex-col gap-1.5">
        {parties.map((party) => {
          const selected = selectedChannelId === party.channelId;
          const recovering = recoveringChannelId === party.channelId;
          const watching = audience?.[party.channelId];
          const liveFor = formatLiveFor(party.wentLiveAt, now);
          // Same two items a text channel's row offers a moderator: this
          // card had no context menu at all before, which meant right-click
          // fell through to the browser's own — the fix is to give it the
          // real one rather than reinvent it, mirroring `ChannelRow`.
          const menuItems: ContextMenuItemDef[] = [];
          if (canPurge && onPurge) {
            menuItems.push({
              id: "purge",
              label: t("chrome.purgeChannel"),
              icon: Eraser,
              danger: true,
              onSelect: () => onPurge(party.channelId, party.name),
            });
          }
          menuItems.push({
            id: "copy-id",
            label: t("chrome.copyChannelId"),
            icon: Copy,
            onSelect: () => void navigator.clipboard.writeText(party.channelId),
          });
          // Reachable a second way while this party is live: the chat pane's
          // own header icon (`canViewWatchPartyHistory` in `App.tsx`) once
          // the channel is selected, which watching it already does. This
          // entry is for right-clicking the card without switching to it.
          if (
            onOpenHistory &&
            historyChannels.some((channel) => channel.id === party.channelId)
          ) {
            menuItems.push({
              id: "history",
              label: t("chrome.watchPartyHistory"),
              icon: History,
              onSelect: () => onOpenHistory(party.channelId),
            });
          }
          return (
            <li key={party.id}>
              <ContextMenu items={menuItems}>
              <button
                type="button"
                data-live-party-row
                data-channel-id={party.channelId}
                aria-current={selected ? "page" : undefined}
                title={t("watchParty.live.watchHint")}
                aria-label={`${party.name}: ${t("watchParty.live.watch")}`}
                onClick={() => onWatch(party.channelId)}
                className={cn(
                  PARTY_FOCUS_REDESIGN,
                  "flex w-full flex-col gap-1 rounded-lg border px-2.5 py-2 text-left transition-colors",
                  selected
                    ? "border-danger/50 bg-danger/10"
                    : "border-ink-4/70 bg-ink-2 hover:border-danger/40 hover:bg-ink-3",
                  SIDEBAR_CARD_REDESIGN,
                  "redesign:gap-1.5 redesign:p-3",
                  // The party you are watching: the selection fill every
                  // sidebar row uses; red stays on the badge alone.
                  selected &&
                    "redesign:border-transparent redesign:bg-row-selected redesign:hover:border-transparent redesign:hover:bg-row-selected",
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
                  <LivePill
                    className={cn(
                      "mt-0.5",
                      // Solid under the redesign, so it reads the same on the
                      // card tint and on the open party's selection fill.
                      !recovering &&
                        "redesign:bg-[color:var(--live-badge-bg)] redesign:text-[10px] redesign:text-on-danger redesign:[&>span]:bg-on-danger",
                    )}
                    variant={recovering ? "recovering" : "live"}
                  />
                </span>
                <span
                  className={cn(
                    "line-clamp-2 break-words text-sm font-semibold leading-snug text-paper redesign:text-text",
                    // The open party's lines follow the open row's: the first
                    // in the selected text, the meta at 72% of it.
                    selected && "redesign:text-on-row-selected",
                  )}
                >
                  {party.name}
                </span>
                <span
                  className={cn(
                    "flex min-w-0 items-baseline justify-between gap-2 text-[11px] text-paper-muted redesign:text-xs redesign:text-text-secondary",
                    selected &&
                      "redesign:text-[color:color-mix(in_oklab,var(--color-on-row-selected)_72%,transparent)]",
                  )}
                >
                  <span className="min-w-0 truncate">
                    {t("watchParty.live.hostedBy", {
                      name: party.hostDisplayName,
                    })}
                  </span>
                  {!recovering && typeof watching === "number" && (
                    <span
                      className="flex shrink-0 items-center gap-1 tabular-nums"
                      data-live-party-audience={watching}
                      data-live-party-uptime={liveFor ?? undefined}
                    >
                      <Eye className="h-3 w-3 shrink-0 redesign:hidden" aria-hidden />
                      <Icon icon={EyeFill} size="sm" className="hidden h-3 w-3 self-center redesign:block" />
                      <span className="sr-only">
                        {t("watchParty.live.viewers", { count: watching })}
                      </span>
                      <span aria-hidden>{watching}</span>
                      {liveFor && (
                        <span className="text-paper-muted/70 redesign:text-text-tertiary" aria-hidden>
                          {" · "}
                          {liveFor}
                        </span>
                      )}
                    </span>
                  )}
                </span>
              </button>
              </ContextMenu>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
