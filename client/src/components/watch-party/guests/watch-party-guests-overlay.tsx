import { useEffect, useState } from "react";
import { Users } from "lucide-react";
import { WATCH_PARTY_MAX_GUESTS, type WatchParty } from "@pqp/shared";
import { Button } from "@/components/ui/button";
import { useTranslation } from "@/lib/i18n";
import type { CohostCandidate } from "@/components/watch-party/watch-party-cohosts";
import { GuestRequestButton } from "./guest-request-button";
import { GuestInviteDialog } from "./guest-invite-dialog";
import { GuestOnAirStrip } from "./guest-on-air-strip";
import { GuestPanel } from "./guest-panel";
import { GuestHeaderAvatars } from "./guest-header-avatars";

export type GuestAction =
  | { action: "invite" | "accept" | "decline" | "remove"; userId: string }
  | { action: "request" | "withdraw" | "join" | "leave" };

/**
 * CONVIDADOS, THE WHOLE SURFACE, MOUNTED WITH ONE LINE.
 *
 * `watch-party-panel.tsx` and `watch-party-transmission.tsx` are frozen ahead
 * of PR 538's rewrite (`docs/plans/WATCH_PARTY_GUESTS.md`), so every new
 * control here is a sibling this component draws itself, mounted once from
 * `App.tsx` rather than threaded through either frozen file. It floats over
 * the party's own chrome rather than sitting inside it, which is the honest
 * shape of a feature landing ahead of the surface it will eventually live
 * inside.
 *
 * ONE COMPONENT, FOUR AUDIENCES: the request button (viewer, `guests ===
 * "request"`), the invite dialog (whoever `party.guests.invited` contains
 * themselves), the on-air strip (whoever `party.guests.onAir` contains
 * themselves) and the host/co-host dock button plus panel. At most one of
 * the first three is ever true for one person, so this never shows two.
 */
export function WatchPartyGuestsOverlay({
  party,
  currentUserId,
  cohostCandidates,
  inRoom,
  micOn,
  cameraOn,
  onToggleMic,
  onToggleCamera,
  onGuestAction,
  onGoOnAir,
  onGoOffAir,
  className,
}: {
  party: WatchParty | null;
  currentUserId: string | null;
  cohostCandidates: readonly CohostCandidate[];
  /** Whether this browser currently holds a seat in this channel's room. */
  inRoom: boolean;
  micOn: boolean;
  cameraOn: boolean;
  onToggleMic: () => void;
  onToggleCamera: () => void;
  /** Every action but `join`/`leave`, which have their own dedicated flow (§3.4/§3.6). */
  onGuestAction: (action: GuestAction) => void;
  /** `join`: stop the player, ask mic/camera, join the room, THEN confirm. */
  onGoOnAir: () => Promise<void>;
  /** `leave`: confirm, then leave the room and resume the player. */
  onGoOffAir: () => Promise<void>;
  className?: string;
}) {
  const { t } = useTranslation();
  const [panelOpen, setPanelOpen] = useState(false);
  const [accepting, setAccepting] = useState(false);

  const guests = party?.guests ?? null;
  const runsTheParty =
    party?.viewerRole === "host" || party?.viewerRole === "cohost";
  const isInvited =
    !runsTheParty &&
    currentUserId !== undefined &&
    guests?.invited.some((p) => p.userId === currentUserId) === true;
  const isOnAir =
    currentUserId !== undefined &&
    guests?.onAir.some((p) => p.userId === currentUserId) === true;

  // A dialog answered has nothing left to show: leave the invited list
  // silently rather than flashing the sheet again on the next frame.
  const [answered, setAnswered] = useState(false);
  useEffect(() => {
    if (!isInvited) {
      setAnswered(false);
    }
  }, [isInvited]);

  if (!party || party.state !== "live" || guests === null) {
    return null;
  }

  const candidates = cohostCandidates.filter(
    (c) =>
      c.userId !== party.hostUserId &&
      !party.cohosts.some((cohost) => cohost.userId === c.userId) &&
      !guests.onAir.some((p) => p.userId === c.userId) &&
      !guests.invited.some((p) => p.userId === c.userId),
  );

  async function accept() {
    setAccepting(true);
    try {
      await onGoOnAir();
      // Only on success: a permission refusal or a failed room join means
      // the invitation still stands (the row was never touched), and hiding
      // the dialog here would strand the person with no way back to it
      // short of a reload. Farol flagged the `finally` version of this.
      setAnswered(true);
    } finally {
      setAccepting(false);
    }
  }

  function decline() {
    setAnswered(true);
    // `leave`, not `decline`: `decline` is the host's action on a REQUEST
    // (§5.8), gated on `manageGuests`, and takes the OTHER person's id — an
    // invited person calling it on themselves would 403. `leaveWatchPartyGuestSlot`
    // deletes the invite row whether it is pending (this case) or already
    // accepted (on-air leaving), which is exactly "I don't want this any
    // more" for both. Farol suggested `decline` here; that would break.
    onGuestAction({ action: "leave" });
  }

  return (
    <div
      data-watch-party-guests-overlay
      className={className}
    >
      {isInvited && !answered && (
        <GuestInviteDialog
          open
          hostName={party.hostDisplayName}
          busy={accepting}
          onAccept={accept}
          onDecline={decline}
        />
      )}

      {isOnAir && inRoom && (
        <GuestOnAirStrip
          micOn={micOn}
          cameraOn={cameraOn}
          onToggleMic={onToggleMic}
          onToggleCamera={onToggleCamera}
          onLeave={() =>
            onGoOffAir().catch((err) =>
              console.warn("[watch-party] go-off-air failed", err),
            )
          }
        />
      )}

      {!runsTheParty && !isOnAir && !isInvited && guests.onAir.length > 0 && (
        <GuestHeaderAvatars onAir={guests.onAir} className="mb-1" />
      )}

      {!runsTheParty && !isOnAir && party.options.guests === "request" && (
        <GuestRequestButton
          requested={guests.requested}
          position={guests.position}
          cooldownMinutesLeft={null}
          onRequest={() => onGuestAction({ action: "request" })}
          onWithdraw={() => onGuestAction({ action: "withdraw" })}
        />
      )}

      {runsTheParty && party.options.guests !== "off" && (
        <>
          <Button
            type="button"
            variant="secondary"
            size="sm"
            onClick={() => setPanelOpen(true)}
            data-watch-party-guests-dock
          >
            <Users className="h-3.5 w-3.5" aria-hidden="true" />
            {t("watchParty.guests.panelOnAir", {
              count: guests.onAir.length,
              max: WATCH_PARTY_MAX_GUESTS,
            })}
          </Button>
          <GuestPanel
            open={panelOpen}
            onClose={() => setPanelOpen(false)}
            guestsMode={party.options.guests}
            max={WATCH_PARTY_MAX_GUESTS}
            onAir={guests.onAir}
            requests={guests.requests}
            requestCount={guests.requestCount}
            candidates={candidates}
            onAccept={(userId) => onGuestAction({ action: "accept", userId })}
            onDecline={(userId) => onGuestAction({ action: "decline", userId })}
            onRemove={(userId) => onGuestAction({ action: "remove", userId })}
            onInvite={(userId) => onGuestAction({ action: "invite", userId })}
          />
        </>
      )}
    </div>
  );
}
