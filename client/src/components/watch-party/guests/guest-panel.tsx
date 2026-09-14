import { useMemo, useState } from "react";
import { Mic, UserPlus, X } from "lucide-react";
import type { WatchPartyGuestsMode } from "@pqp/shared";
import { Dialog, DialogBody } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { UserAvatar } from "@/components/user/user-avatar";
import { useTranslation } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import type { CohostCandidate } from "@/components/watch-party/watch-party-cohosts";

export interface GuestPanelPerson {
  userId: string;
  displayName: string;
  avatarUrl: string | null;
}

/** Above this many candidates, a filter box earns its place — same threshold `WatchPartyCohosts` uses. */
const FILTER_FROM = 8;
const MAX_OFFERED = 5;

/**
 * CONVIDADOS §3.5: the host's ONE dialog, three sections top to bottom —
 * `No ar`, `Pedindo pra falar` (only when `guestsMode === "request"`),
 * `Chamar alguém`. This is the dock's target and the whole of what a host or
 * co-host needs to run the roster; the request queue's ordering (oldest
 * first) is the server's own, carried straight through from `party.guests
 * .requests` with no re-sort here.
 */
export function GuestPanel({
  open,
  onClose,
  guestsMode,
  max,
  onAir,
  requests,
  requestCount,
  candidates,
  onAccept,
  onDecline,
  onRemove,
  onInvite,
}: {
  open: boolean;
  onClose: () => void;
  guestsMode: WatchPartyGuestsMode;
  max: number;
  onAir: readonly GuestPanelPerson[];
  requests: readonly GuestPanelPerson[];
  requestCount: number;
  /** Server members who are not the host, not a co-host, not already on air. */
  candidates: readonly CohostCandidate[];
  onAccept: (userId: string) => void;
  onDecline: (userId: string) => void;
  onRemove: (userId: string) => void;
  onInvite: (userId: string) => void;
}) {
  const { t } = useTranslation();
  const [filter, setFilter] = useState("");
  const [picking, setPicking] = useState(false);
  const atLimit = onAir.length >= max;

  const filtered = useMemo(() => {
    const query = filter.trim().toLowerCase();
    const pool = query
      ? candidates.filter((c) => c.displayName.toLowerCase().includes(query))
      : candidates;
    return pool.slice(0, MAX_OFFERED);
  }, [candidates, filter]);
  const overflow = Math.max(0, candidates.length - filtered.length);

  return (
    <Dialog
      open={open}
      title={t("watchParty.guests.title")}
      onClose={onClose}
    >
      <DialogBody className="flex flex-col gap-5" data-watch-party-guest-panel>
        <section className="flex flex-col gap-2">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-text-tertiary">
            {t("watchParty.guests.panelOnAir", { count: onAir.length, max })}
          </h3>
          <ul className="flex flex-col gap-1">
            {onAir.map((person) => (
              <li
                key={person.userId}
                data-watch-party-guest-on-air={person.userId}
                className="flex items-center gap-2 rounded-lg px-2 py-1.5 hover:bg-surface-2"
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
          </ul>
        </section>

        {guestsMode === "request" && (
          <section className="flex flex-col gap-2">
            <h3 className="text-xs font-semibold uppercase tracking-wide text-text-tertiary">
              {t("watchParty.guests.queue")}
            </h3>
            {requests.length === 0 ? (
              <p className="px-2 text-sm text-text-tertiary">
                {t("watchParty.guests.queueEmpty")}
              </p>
            ) : (
              <ul className="flex flex-col gap-1">
                {requests.map((person) => (
                  <li
                    key={person.userId}
                    data-watch-party-guest-request-row={person.userId}
                    className="flex items-center gap-2 rounded-lg px-2 py-1.5 hover:bg-surface-2"
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
              </ul>
            )}
            {requestCount > requests.length && (
              <p className="px-2 text-[11px] text-text-tertiary">
                {t("watchParty.guests.queueMore", {
                  count: requestCount - requests.length,
                })}
              </p>
            )}
          </section>
        )}

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
                {candidates.length > FILTER_FROM && (
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
                    className={cn(
                      "flex items-center gap-2 rounded-lg px-2 py-1.5 hover:bg-surface-2",
                      candidate.isCharacter && "opacity-50",
                    )}
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
      </DialogBody>
    </Dialog>
  );
}

