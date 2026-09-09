import { useMemo, useState } from "react";
import { Crown, UserMinus, UserPlus } from "lucide-react";
import type { WatchParty } from "@pqp/shared";
import { canPerformWatchPartyAction } from "@pqp/shared";
import { Button } from "@/components/ui/button";
import { UserAvatar } from "@/components/user/user-avatar";
import { useTranslation } from "@/lib/i18n";

/**
 * The host's co-host list, and the only way to get one.
 *
 * WHY THIS EXISTS AT ALL. `POST /api/watch-parties/:id/cohosts` shipped, the
 * `channel_session_cohosts` table shipped, `setWatchPartyCohost` shipped in
 * `lib/watch-parties-api.ts`, and NOTHING in the client ever called it. So the
 * co-host role was unreachable, and with it the whole takeover path: Assumir
 * is rendered for `role === "cohost"` and there was no way to become one
 * short of a curl. `docs/WATCH_PARTY_QA.md` step 9 says so in as many words
 * ("hoje nao existe tela pra promover co-host"). This is that screen.
 *
 * IT IS NOT A NEW PICKER. The two lists below are the same avatar / name /
 * one-button row the stage queue in `watch-party-panel.tsx` already draws for
 * raised hands and people brought up, because a host who has learned one of
 * these has learned the other. The only thing added is a filter box, and only
 * once the list is long enough that scanning it beats reading it.
 *
 * THE CANDIDATES ARE THE SERVER'S MEMBERS, NOT THE ROOM'S OCCUPANTS. That
 * looks like the wrong choice for a control that lives inside a live party,
 * and it is the deliberate one: the moment a host most wants a co-host is
 * BEFORE going live, when the room is empty by construction (a draft is
 * invisible, so nobody can be sitting in it). A picker sourced from the voice
 * roster would be blank on exactly the surface that matters most, which is
 * the setup surface. The server re-checks membership and channel access on
 * every promotion anyway (`requireServerMember` plus `canAccessChannel`), so
 * this list is an affordance and never the authority.
 *
 * HOST ONLY, and that is `canPerformWatchPartyAction` speaking rather than a
 * local rule. A co-host may run the show and may not touch the roster: the
 * moment they can, a co-host can demote the host and there is no chain of
 * authority left. Succession is `claimHost`, gated on the host being gone.
 */

/** Anybody who could be promoted. The shape both `ServerMember` and a co-host fit. */
export interface CohostCandidate {
  userId: string;
  displayName: string;
  avatarUrl: string | null;
  /** Character accounts cannot run a party, so they are never offered. */
  isCharacter?: boolean;
}

/** Above this many candidates, reading the list stops being realistic. */
const FILTER_FROM = 8;

/**
 * How many candidates are ever drawn at once.
 *
 * THE LIST WAS THE WHOLE MEMBERSHIP. `candidates` is the server's member list
 * (see the header), which on the QG is 2078 people and on the local sandbox
 * measured 104 rows in the DOM on 12 Sep 2026. Every one of them was rendered
 * with an avatar, a name and a Promote button, so the section grew without
 * limit and pushed everything under it, including the go-live control on the
 * setup surface, off the bottom of the pane. `max-h-48` bounded what was
 * VISIBLE and not what was BUILT, which is the wrong half: the layout still
 * had a 3000px child in it and the host still had 2078 rows of React.
 *
 * Five, because this is not a directory. A host appointing a backup either
 * knows who they want, in which case the filter above finds them in two
 * keystrokes, or they want the first few names to remind them. A count says
 * how many more the filter would reach, so nothing is silently hidden.
 */
const MAX_OFFERED = 5;

/**
 * Whether this person may staff this party right now.
 *
 * Exported so the surface that FRAMES this section (a divider, a heading gap)
 * asks the same question the section itself answers. Two copies of that rule
 * is how a co-host ends up looking at an empty bordered box where the host has
 * a control.
 */
export function canAppointCohosts(party: WatchParty): boolean {
  return canPerformWatchPartyAction({
    action: "promoteCohost",
    role: party.viewerRole,
    state: party.state,
  });
}

export function WatchPartyCohosts({
  party,
  candidates,
  onPromote,
  onDemote,
}: {
  party: WatchParty;
  candidates: readonly CohostCandidate[];
  onPromote: (userId: string) => Promise<void>;
  onDemote: (userId: string) => Promise<void>;
}) {
  const { t } = useTranslation();
  const [query, setQuery] = useState("");
  // One id at a time: the row that was clicked is the row that goes busy, so
  // a slow promotion in a big server does not grey out every other button.
  const [busyId, setBusyId] = useState<string | null>(null);

  const mayPromote = canAppointCohosts(party);

  const cohostIds = useMemo(
    () => new Set(party.cohosts.map((one) => one.userId)),
    [party.cohosts],
  );

  const offered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return candidates.filter(
      (one) =>
        one.userId !== party.hostUserId &&
        !cohostIds.has(one.userId) &&
        one.isCharacter !== true &&
        (needle.length === 0 ||
          one.displayName.toLowerCase().includes(needle)),
    );
  }, [candidates, cohostIds, party.hostUserId, query]);

  if (!mayPromote) {
    return null;
  }

  const act = async (userId: string, promote: boolean) => {
    setBusyId(userId);
    try {
      await (promote ? onPromote(userId) : onDemote(userId));
    } finally {
      setBusyId(null);
    }
  };

  const showFilter = candidates.length > FILTER_FROM;
  const shown = offered.slice(0, MAX_OFFERED);
  const hidden = offered.length - shown.length;

  return (
    <div data-watch-party-cohosts className="flex flex-col gap-2">
      <p className="text-[11px] font-semibold uppercase tracking-wider text-paper-muted">
        {t("watchParty.cohosts.title")}
      </p>
      {/* THE PARAGRAPH IS READ ONCE AND THE CONTROLS ARE USED EVERY SHOW, so
          it is a detail the host opens rather than four lines of prose above
          the thing they came for. `<details>` and not a state hook: it is one
          disclosure with no behaviour, the browser already has the semantics
          and the keyboard handling, and a `useState` here would be a second
          way to do what the platform does. */}
      <details className="text-[11px] text-paper-muted">
        <summary className="cursor-pointer select-none text-text-tertiary hover:text-text">
          {t("watchParty.cohosts.summary")}
        </summary>
        <p className="mt-1.5">{t("watchParty.cohosts.body")}</p>
      </details>

      {party.cohosts.length > 0 && (
        <ul className="flex flex-col gap-1">
          {party.cohosts.map((person) => (
            <li
              key={person.userId}
              className="flex items-center gap-2"
              data-watch-party-cohost
            >
              <UserAvatar
                name={person.displayName}
                avatarUrl={person.avatarUrl}
                rounded="full"
                className="h-6 w-6 shrink-0"
              />
              <span className="min-w-0 flex-1 truncate text-xs text-paper">
                {person.displayName}
              </span>
              <Crown
                className="h-3 w-3 shrink-0 text-paper-muted"
                aria-hidden
              />
              <Button
                type="button"
                variant="ghost"
                size="sm"
                disabled={busyId === person.userId}
                onClick={() => void act(person.userId, false)}
                data-watch-party-cohost-demote={person.userId}
              >
                <UserMinus className="mr-1.5 h-3 w-3" aria-hidden />
                {t("watchParty.cohosts.demote")}
              </Button>
            </li>
          ))}
        </ul>
      )}

      {showFilter && (
        <input
          type="search"
          className="w-full rounded-md border border-ink-4 bg-ink-3 px-2 py-1.5 text-sm text-paper"
          placeholder={t("watchParty.cohosts.filterPlaceholder")}
          aria-label={t("watchParty.cohosts.filterPlaceholder")}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          data-watch-party-cohost-filter
        />
      )}

      {offered.length === 0 ? (
        <p className="text-[11px] text-paper-muted">
          {query.trim().length > 0
            ? t("watchParty.cohosts.noMatch")
            : t("watchParty.cohosts.nobody")}
        </p>
      ) : (
        <ul className="flex flex-col gap-1">
          {shown.map((person) => (
            <li
              key={person.userId}
              className="flex items-center gap-2"
              data-watch-party-cohost-candidate
            >
              <UserAvatar
                name={person.displayName}
                avatarUrl={person.avatarUrl}
                rounded="full"
                className="h-6 w-6 shrink-0"
              />
              <span className="min-w-0 flex-1 truncate text-xs text-paper">
                {person.displayName}
              </span>
              <Button
                type="button"
                size="sm"
                disabled={busyId === person.userId}
                onClick={() => void act(person.userId, true)}
                data-watch-party-cohost-promote={person.userId}
              >
                <UserPlus className="mr-1.5 h-3 w-3" aria-hidden />
                {t("watchParty.cohosts.promote")}
              </Button>
            </li>
          ))}
        </ul>
      )}

      {/* NOTHING IS SILENTLY HIDDEN. A cut list with no count reads as a list
          that ended, and a host looking for somebody who is not in the first
          five would conclude they are not in the server. This says how many
          the filter above would reach. */}
      {hidden > 0 && (
        <p
          className="text-[11px] text-paper-muted"
          data-watch-party-cohost-more={hidden}
        >
          {t("watchParty.cohosts.more", { count: hidden })}
        </p>
      )}
    </div>
  );
}
