import { useMemo, useState } from "react";
import { Hand, Mic, UserPlus, Users, X } from "lucide-react";
import type { VoiceParticipant, WatchParty, WatchPartyGuestsMode } from "@pqp/shared";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { UserAvatar } from "@/components/user/user-avatar";
import { useTranslation } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import type { CohostCandidate } from "@/components/watch-party/watch-party-cohosts";
import { visibleRaisedHands } from "@/components/watch-party/watch-party-panel";

export interface PeoplePanelPerson {
  userId: string;
  displayName: string;
  avatarUrl: string | null;
}

/** Above this many candidates, a filter box earns its place — same threshold `WatchPartyCohosts` uses. */
const FILTER_FROM = 8;
const MAX_OFFERED = 5;

/**
 * PESSOAS (2026-09-18, `docs/plans/WATCH_PARTY_UI.md` pass 4): the one
 * place that says who is here and lets the people running the show act on
 * them. It replaces two dialogs that showed the same people under two
 * names: the Convidados dialog behind the bar's "No ar" button (the guests
 * system, `party.guests`) and the "Pedindo pra falar" / "No palco" lists at
 * the bottom of the Opções dialog (the legacy stage system, `party.stage`).
 * A host could see two queues for one room and had to learn both.
 *
 * Both systems still exist on the wire and both still work; this panel
 * draws them as one list each. "No ar" is `guests.onAir` plus
 * `stage.invited`; "Pedindo pra falar" is `guests.requests` plus
 * `stage.hands`, each row keeping the action its own system understands
 * (Chamar / Dispensar for a request, Chamar for a hand, Tirar do ar for
 * either). The legacy hands stay capped the way the dialog capped them
 * (`visibleRaisedHands`).
 *
 * `data-watch-party-guest-panel` stays on the root while the host can
 * manage guests, because that is the selector the e2e spec finds the
 * roster by, and a selector should survive a layout.
 */
export function WatchPartyPeoplePanel({
  party,
  runsTheParty,
  roster,
  audienceCount,
  max,
  candidates,
  onAccept,
  onDecline,
  onRemove,
  onInvite,
  onStageAction,
  className,
}: {
  party: WatchParty;
  runsTheParty: boolean;
  /** Everybody seated in the room, presenter included. */
  roster: readonly VoiceParticipant[];
  /** Seatless watchers plus the seated audience, presenter excluded. */
  audienceCount: number;
  max: number;
  /** Server members who are not the host, not a co-host, not already on air. */
  candidates: readonly CohostCandidate[];
  onAccept: (userId: string) => void;
  onDecline: (userId: string) => void;
  onRemove: (userId: string) => void;
  onInvite: (userId: string) => void;
  onStageAction?: (
    action: "invite" | "remove" | "raise" | "lower",
    userId?: string,
  ) => void | Promise<void>;
  className?: string;
}) {
  const { t } = useTranslation();
  const [filter, setFilter] = useState("");
  const [picking, setPicking] = useState(false);

  const guests = party.guests;
  const guestsMode: WatchPartyGuestsMode = party.options.guests;
  const manageGuests = runsTheParty && guestsMode !== "off";
  const onAir: PeoplePanelPerson[] = guests?.onAir ?? [];
  const requests: PeoplePanelPerson[] = guests?.requests ?? [];
  const requestCount = guests?.requestCount ?? requests.length;
  const invited = party.stage.invited.filter(
    (person) => !onAir.some((row) => row.userId === person.userId),
  );
  const hands = visibleRaisedHands(
    party.stage.hands.filter(
      (person) => !requests.some((row) => row.userId === person.userId),
    ),
  );
  const atLimit = onAir.length >= max;
  const showQueue =
    runsTheParty &&
    (guestsMode === "request" ||
      (party.options.voiceEnabled && party.options.raiseHand));

  // Who can be called up: not the host, not a co-host, not already on air
  // or invited (the same rule the overlay applied before pass 4).
  const eligible = useMemo(
    () =>
      candidates.filter(
        (c) =>
          c.userId !== party.hostUserId &&
          !party.cohosts.some((cohost) => cohost.userId === c.userId) &&
          !onAir.some((p) => p.userId === c.userId) &&
          !(guests?.invited ?? []).some((p) => p.userId === c.userId),
      ),
    [candidates, party.hostUserId, party.cohosts, onAir, guests?.invited],
  );
  const filtered = useMemo(() => {
    const query = filter.trim().toLowerCase();
    const pool = query
      ? eligible.filter((c) => c.displayName.toLowerCase().includes(query))
      : eligible;
    return pool.slice(0, MAX_OFFERED);
  }, [eligible, filter]);
  const overflow = Math.max(0, eligible.length - filtered.length);

  const heading =
    "text-[11px] font-semibold uppercase tracking-wider text-text-tertiary";
  const row =
    "flex items-center gap-2 rounded-lg px-2 py-1.5 hover:bg-surface-2";

  return (
    <div
      data-watch-party-people-panel
      data-watch-party-guest-panel={manageGuests ? "" : undefined}
      className={cn(
        "flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto px-3 py-3",
        className,
      )}
    >
      <section className="flex flex-col gap-2">
        <h3 className={heading}>{t("watchParty.panel.inRoom")}</h3>
        <p className="px-2 text-[11px] text-text-tertiary">
          {t("voice.watch.audience", { count: audienceCount })}
        </p>
        {roster.length === 0 ? (
          <p className="px-2 text-sm text-text-tertiary">
            {t("watchParty.panel.nobodyInRoom")}
          </p>
        ) : (
          <ul className="flex flex-col gap-1">
            {roster.map((person) => (
              <li
                key={person.peerId}
                data-watch-party-roster-row={person.userId}
                className={row}
              >
                <UserAvatar
                  name={person.displayName}
                  avatarUrl={person.avatarUrl}
                  className="h-7 w-7"
                />
                <span className="min-w-0 flex-1 truncate text-sm text-text">
                  {person.displayName}
                </span>
                {person.userId === party.hostUserId && (
                  <span className="text-[11px] text-text-tertiary">
                    {t("watchParty.panel.host")}
                  </span>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>

      {runsTheParty && (onAir.length > 0 || invited.length > 0 || manageGuests) && (
        <section className="flex flex-col gap-2">
          <h3 className={heading}>
            {t("watchParty.guests.panelOnAir", { count: onAir.length, max })}
          </h3>
          <ul className="flex flex-col gap-1">
            {onAir.map((person) => (
              <li
                key={person.userId}
                data-watch-party-guest-on-air={person.userId}
                className={row}
              >
                <UserAvatar name={person.displayName} avatarUrl={person.avatarUrl} className="h-7 w-7" />
                <span className="min-w-0 flex-1 truncate text-sm text-text">
                  {person.displayName}
                </span>
                <Mic className="h-3.5 w-3.5 shrink-0 text-success" aria-hidden="true" />
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => onRemove(person.userId)}
                  data-watch-party-guest-remove={person.userId}
                >
                  {t("watchParty.guests.remove")}
                </Button>
              </li>
            ))}
            {invited.map((person) => (
              <li key={person.userId} className={row}>
                <UserAvatar
                  name={person.displayName}
                  avatarUrl={person.avatarUrl}
                  rounded="full"
                  className="h-7 w-7"
                />
                <span className="min-w-0 flex-1 truncate text-sm text-text">
                  {person.displayName}
                </span>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => void onStageAction?.("remove", person.userId)}
                  data-watch-party-stage-remove
                >
                  {t("watchParty.stage.remove")}
                </Button>
              </li>
            ))}
          </ul>
        </section>
      )}

      {showQueue && (
        <section className="flex flex-col gap-2">
          <h3 className={heading}>{t("watchParty.guests.queue")}</h3>
          {requests.length === 0 && hands.visible.length === 0 ? (
            <p className="px-2 text-sm text-text-tertiary">
              {t("watchParty.guests.queueEmpty")}
            </p>
          ) : (
            <ul className="flex flex-col gap-1">
              {requests.map((person) => (
                <li
                  key={person.userId}
                  data-watch-party-guest-request-row={person.userId}
                  className={row}
                >
                  <UserAvatar name={person.displayName} avatarUrl={person.avatarUrl} className="h-7 w-7" />
                  <span className="min-w-0 flex-1 truncate text-sm text-text">
                    {person.displayName}
                  </span>
                  <Button
                    type="button"
                    variant="secondary"
                    size="sm"
                    disabled={atLimit}
                    onClick={() => onAccept(person.userId)}
                    data-watch-party-guest-accept={person.userId}
                  >
                    {t("watchParty.guests.accept")}
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() => onDecline(person.userId)}
                    data-watch-party-guest-decline={person.userId}
                  >
                    {t("watchParty.guests.decline")}
                  </Button>
                </li>
              ))}
              {hands.visible.map((person) => (
                <li key={person.userId} className={row} data-watch-party-hand>
                  <UserAvatar
                    name={person.displayName}
                    avatarUrl={person.avatarUrl}
                    rounded="full"
                    className="h-7 w-7"
                  />
                  <span className="min-w-0 flex-1 truncate text-sm text-text">
                    <Hand className="mr-1 inline h-3 w-3 text-signal" aria-hidden />
                    {person.displayName}
                  </span>
                  <Button
                    type="button"
                    size="sm"
                    onClick={() => void onStageAction?.("invite", person.userId)}
                    data-watch-party-invite
                  >
                    {t("watchParty.stage.invite")}
                  </Button>
                </li>
              ))}
            </ul>
          )}
          {requestCount > requests.length && (
            <p className="px-2 text-[11px] text-text-tertiary">
              {t("watchParty.guests.queueMore", {
                count: requestCount - requests.length,
              })}
            </p>
          )}
          {hands.hiddenCount > 0 && (
            <p
              className="px-2 text-[11px] text-text-tertiary"
              data-watch-party-hands-more
            >
              {t("watchParty.stage.handsMore", { count: hands.hiddenCount })}
            </p>
          )}
        </section>
      )}

      {manageGuests && (
        <section className="flex flex-col gap-2">
          {!picking ? (
            <Button
              type="button"
              variant="secondary"
              disabled={atLimit}
              onClick={() => setPicking(true)}
              data-watch-party-guest-invite-someone
            >
              <UserPlus className="h-3.5 w-3.5" aria-hidden="true" />
              {t("watchParty.guests.inviteSomeone")}
            </Button>
          ) : (
            <div className="flex flex-col gap-2">
              <div className="flex items-center gap-2">
                {eligible.length > FILTER_FROM && (
                  <Input
                    autoFocus
                    value={filter}
                    onChange={(event) => setFilter(event.target.value)}
                    placeholder={t("watchParty.guests.inviteSomeone")}
                    className="h-8 flex-1"
                  />
                )}
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  aria-label={t("watchParty.guests.title")}
                  onClick={() => {
                    setPicking(false);
                    setFilter("");
                  }}
                >
                  <X className="h-4 w-4" aria-hidden="true" />
                </Button>
              </div>
              <ul className="flex flex-col gap-1">
                {filtered.map((candidate) => (
                  <li
                    key={candidate.userId}
                    className={cn(row, candidate.isCharacter && "opacity-50")}
                  >
                    <UserAvatar
                      name={candidate.displayName}
                      avatarUrl={candidate.avatarUrl}
                      className="h-7 w-7"
                    />
                    <span className="min-w-0 flex-1 truncate text-sm text-text">
                      {candidate.displayName}
                    </span>
                    <Button
                      type="button"
                      variant="secondary"
                      size="sm"
                      disabled={candidate.isCharacter || atLimit}
                      onClick={() => onInvite(candidate.userId)}
                      data-watch-party-guest-invite={candidate.userId}
                    >
                      <UserPlus className="h-3 w-3" aria-hidden="true" />
                      {t("watchParty.guests.accept")}
                    </Button>
                  </li>
                ))}
              </ul>
              {overflow > 0 && (
                <p className="px-2 text-[11px] text-text-tertiary">
                  {t("watchParty.guests.queueMore", { count: overflow })}
                </p>
              )}
            </div>
          )}
          {atLimit && (
            <p
              className="px-1 text-[11px] text-text-tertiary"
              data-watch-party-guests-at-limit
            >
              {t("watchParty.guests.atLimit", { max })}
            </p>
          )}
        </section>
      )}

      {!runsTheParty && onAir.length > 0 && (
        <section className="flex flex-col gap-2">
          <h3 className={heading}>
            <Users className="mr-1 inline h-3 w-3" aria-hidden />
            {t("watchParty.panel.onAir")}
          </h3>
          <ul className="flex flex-col gap-1">
            {onAir.map((person) => (
              <li key={person.userId} className={row}>
                <UserAvatar name={person.displayName} avatarUrl={person.avatarUrl} className="h-7 w-7" />
                <span className="min-w-0 flex-1 truncate text-sm text-text">
                  {person.displayName}
                </span>
                <Mic className="h-3.5 w-3.5 shrink-0 text-success" aria-hidden="true" />
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
