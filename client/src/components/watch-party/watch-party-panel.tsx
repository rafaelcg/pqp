import { useEffect, useRef, useState, type ReactElement } from "react";
import {
  Clapperboard,
  Crown,
  Hand,
  Mic,
  MonitorPlay,
  Phone,
  Radio,
  SlidersHorizontal,
  Square,
  Undo2,
} from "lucide-react";
import type { LiveHlsStream, VoiceRoomTransport } from "@pqp/shared";
import type { VideoQuality } from "@/lib/video-quality";
import {
  canPerformWatchPartyAction,
  watchPartySpeakAffordance,
  watchPartySurface,
  type WatchParty,
  type WatchPartyOptions,
} from "@pqp/shared";
import { WatchPartyOptionsPanel } from "@/components/watch-party/watch-party-options";
import {
  canAppointCohosts,
  WatchPartyCohosts,
  type CohostCandidate,
} from "@/components/watch-party/watch-party-cohosts";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Dialog, DialogBody } from "@/components/ui/dialog";
import { ScrollArea } from "@/components/ui/scroll-area";
import { UserAvatar } from "@/components/user/user-avatar";
import { FeatureHint } from "@/components/layout/feature-hint";
import { LivePill } from "@/components/watch-party/live-pill";
import { WatchPartyTransmission } from "@/components/watch-party/watch-party-transmission";
import { formatSessionRelativeTime } from "@/lib/channel-session-schedule";
import { useTranslation } from "@/lib/i18n";
import { cn } from "@/lib/utils";

/**
 * The watch party surface inside a `watch_party` channel: everything between
 * "there is no party" and "there is one and it is on air".
 *
 * WHY THIS IS ONE COMPONENT AND NOT FOUR. The four things it draws (an empty
 * stage, a host setting one up, a scheduled card, a live bar) are four states
 * of ONE object, and the whole complaint that produced this work was that the
 * feature was a set of unrelated controls rather than a journey. Splitting
 * them by file would have put the transitions between them in `App.tsx`,
 * which is exactly where a journey goes to die.
 *
 * IT DOES NOT DRAW THE PICTURE. `WatchChannelStage` owns the HLS player and
 * has since the morning this shipped. When a party is live and a stream
 * exists, this renders a slim bar above it and nothing else. When a party is
 * live and no stream exists yet, this is the thing that says so, which is the
 * gap that made a second browser look broken: the old code rendered `null`
 * and a viewer got a blank pane with no explanation.
 */

export interface WatchPartyPanelProps {
  party: WatchParty | null;
  channelId: string;
  channelName: string;
  /** START_WATCH_PARTY on this channel: may create one, may take the stage. */
  canStart: boolean;
  /** True while this person holds a seat in this channel's voice room. */
  inCall: boolean;
  /** True while `WatchChannelStage` has a playable stream for this channel. */
  hasStream: boolean;
  /** True while this person is the one whose screen is on the stage. */
  isPresenting: boolean;
  /**
   * Anybody in the room has a screen up, this person or not.
   *
   * Separates the two states that used to share one sentence: a host who has
   * gone live and NOT picked a window yet (nothing is coming until they act),
   * and a host who is sharing while the transcode spins up (the picture is
   * genuinely seconds away). The second is transient and common; the first is
   * the one a host hits in production by cancelling the picker, and telling
   * that room "fica aí que já aparece" is a promise nothing is keeping.
   */
  someoneIsSharing?: boolean;
  /** Everyone watching, seated or not, presenter excluded. */
  audienceCount: number;
  onCreate: () => void;
  onGoLive: (stream: MediaStream | null) => Promise<void>;
  onEnd: () => Promise<void>;
  onDiscard: () => Promise<void>;
  onOptionsChange: (options: Partial<WatchPartyOptions>) => Promise<void>;
  onRename: (name: string) => Promise<void>;
  onClaimHost: () => Promise<void>;
  /**
   * Everybody the host may hand a co-host badge to: this server's members.
   *
   * NOT the room's occupants, and the reason is the surface rather than the
   * role. The moment a host most needs a co-host is before Ir ao vivo, and a
   * draft is invisible, so its room is empty by construction; a list built
   * from the voice roster would be blank on the one screen that matters most.
   * The server re-checks membership and channel access on every promotion, so
   * this is an affordance and never the authority.
   */
  cohostCandidates?: readonly CohostCandidate[];
  /** The host promoting somebody. Host only; the server enforces that too. */
  onPromoteCohost?: (userId: string) => Promise<void>;
  /** The host taking the badge back. */
  onDemoteCohost?: (userId: string) => Promise<void>;
  onJoinCall: () => void;
  /** Watch this party without a seat, or take the audience seat with no mic. */
  onWatchAsAudience?: () => void;
  /** Go from watching to talking. The ONLY place a microphone is requested. */
  onTakeTheMicrophone?: () => void;
  /** The host bringing somebody up, or taking them down. */
  onStageAction?: (
    action: "invite" | "remove" | "raise" | "lower",
    userId?: string,
  ) => Promise<void>;
  /**
   * Who is reading this, so an invited guest can recognise themselves in
   * `stage.invited`. Only the people running the party and the people invited
   * up are offered a seat at all; everybody else watches.
   */
  currentUserId?: string;
  /** `welcome.canSpeak` for this room, as the server resolved it. */
  canSpeak?: boolean;
  /** The channel's live HLS stream, for the host's transmission readout. */
  liveStream?: LiveHlsStream | null;
  /** The host's chosen rung, and the room size, for the outbound readout. */
  videoQuality?: VideoQuality;
  roomViewers?: number;
  transport?: VoiceRoomTransport | null;
  /** This seat was taken as audience: no microphone was ever asked for. */
  isAudienceSeat?: boolean;
  onShapeChange?: (shape: "expanded" | "none") => void;
  /**
   * WHICH HALF OF THE PANEL TO DRAW, and it is rendered twice.
   *
   * `chrome` is the party's own controls: the bar with its name, the options
   * drawer, the transmission readout, the host-gone strip. It is rendered
   * ABOVE the split, outside the collapsible panes, because hiding the video
   * must not take Encerrar with it. A host who collapses the picture to read
   * the chat still has to be able to end their own party, and the first cut
   * put the only control for that inside the pane it hides.
   *
   * `surface` is everything that fills the pane: the empty stage, the setup
   * preview, the scheduled card, the waiting placeholder. That belongs in the
   * split, and it is the only half that reports a shape.
   */
  slot?: "chrome" | "surface";
  /**
   * The split pane owns this surface's height, so stop sizing to the window.
   *
   * THE SAME PROP `WatchChannelStage` AND `CallStage` ALREADY TAKE, and the
   * bug it fixes is that this component was the only stage in the slot that
   * never got it. Every pane-filling surface here was `h-[68svh] shrink-0`: a
   * fraction of the WINDOW, fixed, inside a pane whose height is the window
   * minus the chrome above it. With both panes drawn that is close enough to
   * look deliberate. Collapse the chat and the pane hands the stage slot the
   * whole 803px of an 819px pane while this surface keeps insisting it is 612,
   * so a host who hid the chat got their preview, the go-live bar stranded in
   * the middle of the screen, and a 191px band of empty pane below it with the
   * restore strip at the bottom of it. Reported from production on 12 Sep
   * 2026: "hid the chat and got this bugged UI".
   *
   * Two sources of truth for one height, and the pane's is the correct one:
   * only the pane has measured itself. So this follows it, exactly the way the
   * other two stages in the same slot always have.
   */
  fill?: boolean;
  /** First time this host has reached a setup surface. */
  showHostHint?: boolean;
  /** First time this person has watched a live party. */
  showViewerHint?: boolean;
}

/**
 * How a pane-filling surface sizes itself: the pane's number when the pane has
 * one, its own old window fraction when it does not.
 *
 * Written once because there are four of these (empty, setup, scheduled, the
 * live waiting placeholder) and the whole defect was one of them disagreeing
 * with the pane. `h-full min-h-0` is character for character what
 * `call-stage.tsx` and `watch-stage.tsx` use, so all three stages in the slot
 * answer the pane the same way.
 */
function surfaceHeight(fill: boolean | undefined, floor: string): string {
  return fill ? "h-full min-h-0 flex-1" : `${floor} shrink-0`;
}

export function WatchPartyPanel(props: WatchPartyPanelProps) {
  const { party } = props;
  // ONE DECISION, MADE IN ONE PLACE, and it is not made here. `watchPartySurface`
  // is pure, shared and exhaustively tested, and it exists because the empty
  // state and the live stage used to answer to different masters: the empty
  // state asked "is there a party row" and the stage asked "is there a
  // stream", so a bare screen share rendered BOTH, the create button sitting
  // on top of a live picture. Nothing in this component may consult those two
  // facts separately again.
  const surface = watchPartySurface({
    state: party?.state ?? null,
    hasStream: props.hasStream,
    inCall: props.inCall,
    canStart: props.canStart,
  });

  // Only the surfaces that fill the pane declare a shape. The live bar is
  // furniture above whatever `WatchChannelStage` is doing and must not fight
  // it for the split, the same rule `WatchChannelStage` follows about
  // `CallStage`.
  const slot = props.slot ?? "surface";
  const fills =
    slot === "surface" &&
    (surface === "setup" ||
      surface === "scheduled" ||
      surface === "empty" ||
      ((surface === "live" || surface === "liveUntitled") &&
        !props.hasStream &&
        !props.inCall));
  const wasFilling = useRef(false);
  const { onShapeChange } = props;
  useEffect(() => {
    if (fills) {
      wasFilling.current = true;
      onShapeChange?.("expanded");
      return;
    }
    if (wasFilling.current) {
      wasFilling.current = false;
      onShapeChange?.("none");
    }
  }, [fills, onShapeChange]);
  useEffect(
    () => () => {
      if (wasFilling.current) {
        wasFilling.current = false;
        onShapeChange?.("none");
      }
    },
    [onShapeChange],
  );

  switch (surface) {
    case "empty":
      return slot === "surface" ? <EmptyStage {...props} /> : null;
    case "setup":
      return slot === "surface" && party ? (
        <SetupStage {...props} party={party} />
      ) : null;
    case "scheduled":
      return slot === "surface" && party ? (
        <ScheduledStage {...props} party={party} />
      ) : null;
    case "live":
      return party ? <LiveSurface {...props} party={party} slot={slot} /> : null;
    case "liveUntitled":
      // The channel is live with no party this person can see: a bare screen
      // share, or somebody else's draft. They get the picture (drawn by
      // `WatchChannelStage`) and never the create button.
      return null;
    case "none":
      return null;
  }
}

/**
 * The co-host list, drawn identically on the setup surface and in the live
 * Opções drawer.
 *
 * ONE HELPER RATHER THAN TWO CALL SITES because `promoteCohost` is legal in
 * `draft`, `scheduled` AND `live`, so a host can appoint a backup before the
 * show and again in the middle of it, and the two must be the same control.
 * Nothing renders at all without the callbacks: a section whose buttons did
 * nothing would read as a broken feature rather than an absent one.
 */
function cohostSection(
  props: WatchPartyPanelProps,
  party: WatchParty,
  className: string,
): ReactElement | null {
  // THE DIVIDER IS INSIDE THE GATE, not around the call. The component itself
  // draws nothing for anybody but the host, so a wrapper outside this check
  // left a co-host looking at an empty bordered box under the options: a
  // separator with nothing to separate, which reads as a control that failed
  // to load rather than one they do not have.
  if (
    !props.onPromoteCohost ||
    !props.onDemoteCohost ||
    !canAppointCohosts(party)
  ) {
    return null;
  }
  return (
    <div className={className}>
      <WatchPartyCohosts
        party={party}
        candidates={props.cohostCandidates ?? []}
        onPromote={props.onPromoteCohost}
        onDemote={props.onDemoteCohost}
      />
    </div>
  );
}

// ------------------------------------------------------------- no party yet

function EmptyStage(props: WatchPartyPanelProps) {
  const { t } = useTranslation();
  return (
    <div
      data-testid="watch-party-empty"
      className={cn(
        "flex flex-col items-center justify-center gap-2 overflow-hidden border-b border-ink-4/60 bg-ink px-6 py-8 text-center",
        surfaceHeight(props.fill, "min-h-0"),
      )}
    >
      <span className="flex h-11 w-11 items-center justify-center rounded-full bg-ink-3 text-paper-muted">
        <Clapperboard className="h-5 w-5" aria-hidden />
      </span>
      <p className="text-sm font-semibold text-paper">
        {t("watchParty.empty.title")}
      </p>
      <p className="max-w-sm text-xs text-paper-muted">
        {t("watchParty.empty.body")}
      </p>
      <Button
        type="button"
        className="mt-1"
        onClick={props.onCreate}
        data-watch-party-create
      >
        <Clapperboard className="mr-1.5 h-3.5 w-3.5" aria-hidden />
        {t("watchParty.create.button")}
      </Button>
    </div>
  );
}

// -------------------------------------------------------- the draft, setting up

/**
 * The step Rafael asked for and the one nothing in the app had: the host sees
 * exactly what the room will see, with the settings that matter beside it, and
 * NOTHING IS BROADCAST until they press the one button.
 *
 * THE PREVIEW IS THE REAL CAPTURE. `getDisplayMedia` runs here, during setup,
 * and the same `MediaStream` is handed to the call on go-live (see
 * `ScreenCaptureIntent.stream`). A preview that opened its own capture and then
 * made the host pick again at go-live would be a rehearsal, not a preview: the
 * thing they approved and the thing that went out would be two different
 * captures.
 */
function SetupStage(props: WatchPartyPanelProps & { party: WatchParty }) {
  const { t } = useTranslation();
  const { party } = props;
  const videoRef = useRef<HTMLVideoElement>(null);
  const [stream, setStream] = useState<MediaStream | null>(null);
  const [name, setName] = useState(party.name);
  const [busy, setBusy] = useState(false);
  const [pickError, setPickError] = useState<string | null>(null);
  const [confirmDiscard, setConfirmDiscard] = useState(false);

  useEffect(() => setName(party.name), [party.id, party.name]);

  // The preview stream belongs to this surface. Leaving the draft without
  // going live has to stop the capture, or the browser keeps showing "pqp is
  // sharing your screen" for a share that never happened.
  useEffect(
    () => () => {
      setStream((held) => {
        held?.getTracks().forEach((track) => track.stop());
        return null;
      });
    },
    [],
  );

  useEffect(() => {
    const video = videoRef.current;
    if (video && video.srcObject !== stream) {
      video.srcObject = stream;
    }
  }, [stream]);

  const pick = async () => {
    setPickError(null);
    try {
      const picked = await navigator.mediaDevices.getDisplayMedia({
        video: true,
        audio: true,
      });
      stream?.getTracks().forEach((track) => track.stop());
      // The host stopping the share from the browser's own bar during setup
      // must clear the preview, not leave a frozen last frame that they then
      // go live with.
      picked.getVideoTracks()[0]?.addEventListener("ended", () => {
        setStream((held) => (held === picked ? null : held));
      });
      setStream(picked);
    } catch (error) {
      // Cancelling the picker is the common case and is not an error worth a
      // red line; only a genuine failure is.
      if (error instanceof Error && error.name === "NotAllowedError") {
        return;
      }
      setPickError(t("watchParty.setup.pickError"));
    }
  };

  const goLive = async () => {
    setBusy(true);
    try {
      const handing = stream;
      // Handed off, not stopped: the call now owns these tracks.
      setStream(null);
      await props.onGoLive(handing);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      data-testid="watch-party-setup"
      className={cn(
        "relative flex flex-col overflow-hidden border-b border-ink-4/60 bg-ink",
        surfaceHeight(props.fill, "h-[68svh] min-h-[320px]"),
      )}
    >
      <div className="flex min-h-0 flex-1">
        <div className="relative min-w-0 flex-1 bg-black">
          {stream ? (
            <video
              ref={videoRef}
              autoPlay
              muted
              playsInline
              className="h-full w-full object-contain"
              data-testid="watch-party-preview"
            />
          ) : (
            <div className="flex h-full w-full flex-col items-center justify-center gap-2 px-6 text-center">
              <MonitorPlay
                className="h-7 w-7 text-paper-muted"
                aria-hidden
              />
              <p className="text-sm text-paper-muted">
                {t("watchParty.setup.noSource")}
              </p>
              <Button type="button" variant="secondary" onClick={() => void pick()}>
                {t("watchParty.setup.pick")}
              </Button>
              {pickError && (
                <p className="text-xs text-danger">{pickError}</p>
              )}
            </div>
          )}
          {/* NOT A CAPTION. A HOST READ THE OLD ONE AND SAID "im live".
              This used to be 10px uppercase grey in the corner of the
              preview, which is the visual language of a watermark, and on
              12 Sep 2026 a host on production announced he was live to a
              room while the server reported `sharingScreen: 0` and no
              transcode running. He had picked a window, he could see his own
              picture, and the only thing telling him it was going nowhere
              was that badge.
              So it says what state this is, in a sentence, in the warning
              tone this app uses for "careful", with a dot that reads as a
              status light and never as decoration. It is deliberately the
              same shape as the LIVE pill it is the opposite of. */}
          <span
            data-testid="watch-party-preview-state"
            className="pointer-events-none absolute left-3 top-3 flex items-center gap-1.5 rounded-full border border-warning/40 bg-surface-0/90 px-2.5 py-1 text-xs font-semibold text-warning"
          >
            <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-warning" />
            {t("watchParty.setup.heading")}
          </span>
          {stream && (
            <Button
              type="button"
              variant="secondary"
              size="sm"
              className="absolute right-2 top-2"
              onClick={() => void pick()}
            >
              {t("watchParty.setup.repick")}
            </Button>
          )}
        </div>

        {/* THE INTRO PARAGRAPH IS GONE. It said "pick what you are going to
            share, check it here and go live when it looks right", which is
            what the not-live bar below now says with the button that does it
            attached. Two instructional paragraphs on one screen is one too
            many, and the one that cost the column 44px was the one nobody
            was reading: it pushed the co-host list past the bottom of the
            aside, which is where the host's screenshot showed it cut off
            mid-row. */}
        <aside className="hidden w-72 shrink-0 border-l border-ink-4/60 sm:block">
          {/* A REAL SCROLLBAR, because this column scrolls and macOS draws
              overlay scrollbars, so it showed a row cut in half and nothing
              at all to say why. `ScrollArea` with `type="always"` is the
              primitive `docs/DESIGN.md` names for exactly this: a native
              scrollbar here draws OS chrome over the design, and no
              scrollbar reads as a broken list. */}
          <ScrollArea
            type="always"
            // The thumb's default `surface-2` is nearly invisible against
            // this surface's `surface-0`, and an invisible scrollbar is the
            // thing being fixed. Local, so no other scroller moves.
            className="h-full [&_[data-radix-scroll-area-thumb]]:bg-surface-3"
          >
            <div className="flex flex-col gap-3 p-3">
              <label className="block text-xs text-paper-muted">
                <span className="mb-1 block">{t("watchParty.setup.nameLabel")}</span>
                <input
                  type="text"
                  maxLength={120}
                  className="w-full rounded-md border border-ink-4 bg-ink-3 px-2 py-1.5 text-sm text-paper"
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                  onBlur={() => {
                    const next = name.trim();
                    if (next.length > 0 && next !== party.name) {
                      void props.onRename(next);
                    }
                  }}
                  data-watch-party-name
                />
              </label>

              <p className="mt-1 text-[11px] font-semibold uppercase tracking-wider text-paper-muted">
                {t("watchParty.options.title")}
              </p>
              <WatchPartyOptionsPanel
                options={party.options}
                audienceCount={props.audienceCount}
                onChange={(patch) => void props.onOptionsChange(patch)}
              />

              {/* BEFORE Ir ao vivo is where this belongs. A host who names a
                  backup here has one for the whole show; a host who only finds
                  this control after their own connection has already died has
                  nothing. */}
              {cohostSection(props, party, "mt-1 border-t border-ink-4/60 pt-3")}
            </div>
          </ScrollArea>
        </aside>
      </div>

      {/* A STATE BAR, NOT A FOOTER, and that is the whole of the third fix.
          A host on production picked a window, watched his own preview and
          told a room he was live while nothing at all was being sent. The
          controls were here already; what was missing was anything that said
          what state he was in. So the bar leads with the state in words, in
          the warning tone, and the button that changes it sits at the end of
          that sentence rather than at the bottom of a form.

          IT IS ALWAYS THE LAST THING IN THE PANE. `shrink-0` under a row that
          is `min-h-0 flex-1`, inside a surface that now takes its height from
          the pane (`fill`). However long the options column and the co-host
          list get, they scroll inside the row above; this never moves and
          never needs scrolling to. That is the other half of the same
          report: the host's screenshot only showed Ir ao vivo after
          scrolling, under a co-host list long enough to push it away. */}
      <div
        data-testid="watch-party-not-live"
        className="flex shrink-0 flex-col gap-2 border-t border-warning/30 bg-warning/10 px-3 py-2.5 sm:flex-row sm:items-center"
      >
        <div className="flex min-w-0 flex-1 items-center gap-2">
          <span className="h-2 w-2 shrink-0 rounded-full bg-warning" />
          <p className="min-w-0 text-xs">
            <span className="font-semibold text-warning">
              {t("watchParty.setup.notLive")}
            </span>{" "}
            <span className="text-text-tertiary">
              {t("watchParty.setup.goLiveHint")}
            </span>
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <Button
            type="button"
            variant="ghost"
            onClick={() => setConfirmDiscard(true)}
            data-watch-party-discard
          >
            <Undo2 className="mr-1.5 h-3.5 w-3.5" aria-hidden />
            {t("watchParty.setup.discard")}
          </Button>
          <Button
            type="button"
            disabled={busy}
            onClick={() => void goLive()}
            data-watch-party-go-live
            className="bg-danger text-paper hover:bg-danger/85"
          >
            <Radio className="mr-1.5 h-3.5 w-3.5" aria-hidden />
            {t("watchParty.setup.goLive")}
          </Button>
        </div>
      </div>

      {/* The one sentence a first-time host needs, on the surface where it
          is true. `lib/hints.ts` remembers it; `docs/ONBOARDING.md` has the
          row. */}
      <div className="pointer-events-none absolute bottom-16 right-3 z-10 [&>*]:pointer-events-auto">
        <FeatureHint
          id="watchPartyHost"
          enabled={props.showHostHint === true}
          title={t("watchParty.create.title")}
          body={t("featureHint.watchPartyHost.body")}
        />
      </div>

      <ConfirmDialog
        open={confirmDiscard}
        title={t("watchParty.setup.discardConfirmTitle")}
        description={t("watchParty.setup.discardConfirmBody", {
          name: party.name,
        })}
        confirmLabel={t("watchParty.setup.discard")}
        onClose={() => setConfirmDiscard(false)}
        onConfirm={() => void props.onDiscard()}
      />
    </div>
  );
}

// --------------------------------------------------------------- scheduled

function ScheduledStage(props: WatchPartyPanelProps & { party: WatchParty }) {
  const { t } = useTranslation();
  const { party } = props;
  const canGoLive = canPerformWatchPartyAction({
    action: "goLive",
    role: party.viewerRole,
    state: party.state,
  });
  return (
    <div
      data-testid="watch-party-scheduled"
      className={cn(
        "flex flex-col items-center justify-center gap-2 overflow-hidden border-b border-ink-4/60 bg-ink px-6 py-8 text-center",
        surfaceHeight(props.fill, "min-h-0"),
      )}
    >
      <PartyIdentity party={party} />
      <p className="text-xs text-paper-muted">
        {formatSessionRelativeTime(party.startsAt ?? "", new Date(), "pt-BR")}
      </p>
      {canGoLive && (
        <>
          <Button
            type="button"
            className="mt-1 bg-danger text-paper hover:bg-danger/85"
            onClick={() => void props.onGoLive(null)}
            data-watch-party-go-live
          >
            <Radio className="mr-1.5 h-3.5 w-3.5" aria-hidden />
            {t("watchParty.scheduled.goLiveNow")}
          </Button>
          <p className="text-[11px] text-paper-muted">
            {t("watchParty.scheduled.hostNote")}
          </p>
        </>
      )}
    </div>
  );
}

// --------------------------------------------------------------------- live

/**
 * A live party is two facts that are NOT the same fact: the show is on, and
 * there is a picture. The old code only had the second, so a viewer who
 * arrived before the host started sharing saw an empty pane with no words on
 * it and concluded the feature was broken. That was Rafael's second browser.
 */
function LiveSurface(
  props: WatchPartyPanelProps & { party: WatchParty; slot: "chrome" | "surface" },
) {
  const { t } = useTranslation();
  const { party } = props;
  const [confirmEnd, setConfirmEnd] = useState(false);
  const [optionsOpen, setOptionsOpen] = useState(false);
  const canEnd = canPerformWatchPartyAction({
    action: "end",
    role: party.viewerRole,
    state: party.state,
  });
  const canClaim =
    party.hostDisconnectedAt !== null &&
    canPerformWatchPartyAction({
      action: "claimHost",
      role: party.viewerRole,
      state: party.state,
      hostDisconnectedAt: Date.parse(party.hostDisconnectedAt),
      now: Date.now(),
    });
  const runningTheShow =
    party.viewerRole === "host" || party.viewerRole === "cohost";

  const viewerHint = (
    <div className="pointer-events-none absolute right-3 top-14 z-10 [&>*]:pointer-events-auto">
      <FeatureHint
        id="watchPartyViewer"
        enabled={props.showViewerHint === true}
        title={t("watchParty.live.watch")}
        body={t("featureHint.watchPartyViewer.body")}
      />
    </div>
  );

  const runsTheShow =
    party.viewerRole === "host" || party.viewerRole === "cohost";
  const affordance = watchPartySpeakAffordance({
    options: party.options,
    role: party.viewerRole,
    canSpeak: props.canSpeak ?? false,
  });
  /**
   * Whether a seat in this room is this person's to take at all.
   *
   * NOT "may they" in a permission sense, which the server settles: this is
   * whether the app offers it, and for an audience the answer is no. See the
   * comment on the button. `stage.invited` is sent to everybody by
   * `presentStage`, so an invited guest recognises themselves here without a
   * second request and without the client guessing.
   */
  const mayTakeASeat =
    runsTheShow ||
    (props.currentUserId !== undefined &&
      party.stage.invited.some(
        (person) => person.userId === props.currentUserId,
      ));

  const bar = (
    <div
      data-testid="watch-party-bar"
      /* WRAPS, BECAUSE THE COLUMN IS NOT ALWAYS THE WINDOW. Side by side gives
         the stage roughly 62% of the pane, and on a laptop that is narrow
         enough that the identity, the viewer count and three buttons do not
         fit on one line: the first version clipped "Encerrar" against the
         divider, which is the one control a host must always be able to
         reach. The actions drop to a second row instead of overflowing, and
         the identity keeps `min-w-0` so the party's name truncates rather
         than pushing them off. */
      className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1.5 border-b border-ink-4/60 bg-ink-2 px-3 py-2"
    >
      {/* A REAL MINIMUM, so the wrap happens instead of the name vanishing.
          Without it the identity is just `flex-1` and shrinks to nothing in a
          side-by-side column: the party's name truncated away entirely and the
          bar showed a live pill over "com Dev U...", which is the block's one
          job (say WHAT is live) failing in the narrow layout. At this minimum
          the actions wrap to their own row and the name keeps its line. */}
      <PartyIdentity
        party={party}
        compact
        className="min-w-[12rem]"
        meta={t("watchParty.live.viewers", { count: props.audienceCount })}
      />
      {/* No `shrink-0`: in a narrow column the buttons wrap onto their own
          line rather than running past the divider, which is how "Encerrar"
          ended up half off the screen the first time. */}
      <span className="ml-auto flex flex-wrap items-center justify-end gap-1.5">
        {/* THE MICROPHONE IS ASKED FOR HERE AND NOWHERE ELSE.
            An audience seat opens no `getUserMedia` at all (see
            `VoiceAudioOptions.audienceOnly`), so nobody watching is ever
            prompted, and the "entrou sem microfone" banner that Rafael was
            shown cannot happen: no permission was requested, so none was
            refused. Falar is the deliberate second act, and it is offered
            only when the host's stage rules allow it. */}
        {affordance === "speak" && props.isAudienceSeat && (
          <Button
            type="button"
            size="sm"
            title={t("watchParty.stage.speakHint")}
            onClick={() => props.onTakeTheMicrophone?.()}
            data-watch-party-speak
          >
            <Mic className="mr-1.5 h-3 w-3" aria-hidden />
            {t("watchParty.stage.speak")}
          </Button>
        )}
        {affordance === "raiseHand" && (
          <Button
            type="button"
            variant={party.stage.handRaised ? "default" : "secondary"}
            size="sm"
            aria-pressed={party.stage.handRaised}
            onClick={() =>
              void props.onStageAction?.(
                party.stage.handRaised ? "lower" : "raise",
              )
            }
            data-watch-party-raise
          >
            <Hand className="mr-1.5 h-3 w-3" aria-hidden />
            {party.stage.handRaised
              ? t("watchParty.stage.lower")
              : t("watchParty.stage.raise")}
          </Button>
        )}
        {/* A VIEWER CANNOT JOIN A WATCH PARTY. NOT DISABLED: ABSENT.
            Rafael, on being shown one quiet join control where there used to
            be three: "NO. A VIEWER CANT JOIN A WATCH PARTY BRO". He is right,
            and the earlier fix was still the wrong shape. Demoting a control
            and labelling its consequence ("Entrar so ouvindo") is a way of
            keeping something that should not be on the screen: it still says
            joining is a thing an audience does, and it still costs a reader
            the moment it takes to decide against it.

            A watch party has an audience and it has the people running it.
            The audience watches. That is the whole interaction, it needs no
            control, and the seatless path exists precisely so it needs none:
            watching is a socket, a seat is a LiveKit participant and
            forwarded streams against an envelope of about 600 of them.

            WHO STILL GETS IT, and why each: the host and the co-hosts, who
            run the show and have to be able to get back into their own room;
            and anybody the host has invited up to speak, for whom the whole
            point of being invited is that they can now talk. `stage.invited`
            is public on the wire (`presentStage`: who is UP is public, who is
            ASKING is not), so this is the party's own answer rather than a
            guess. A manager is deliberately NOT here: MANAGE_CHANNELS ends
            and edits somebody else's party, it does not perform in it.

            The listen-only label went with the control. Everybody who can
            still see this button can speak once they are in, so a warning
            about a seat that cannot would now be false. */}
        {!props.inCall && mayTakeASeat && (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            title={t("watchParty.live.joinCallHint")}
            onClick={props.onJoinCall}
            data-watch-party-join-call
          >
            <Phone className="mr-1.5 h-3 w-3" aria-hidden />
            {t("watchParty.live.joinCall")}
          </Button>
        )}
        {runsTheShow && (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            aria-expanded={optionsOpen}
            onClick={() => setOptionsOpen((open) => !open)}
            data-watch-party-options-toggle
          >
            <SlidersHorizontal className="mr-1.5 h-3 w-3" aria-hidden />
            {t("watchParty.options.title")}
          </Button>
        )}
        {canClaim && (
          <Button
            type="button"
            size="sm"
            onClick={() => void props.onClaimHost()}
            data-watch-party-claim
          >
            <Crown className="mr-1.5 h-3 w-3" aria-hidden />
            {t("watchParty.live.claim")}
          </Button>
        )}
        {canEnd && (
          <Button
            type="button"
            variant="danger"
            size="sm"
            onClick={() => setConfirmEnd(true)}
            data-watch-party-end
          >
            <Square className="mr-1.5 h-3 w-3" aria-hidden />
            {t("watchParty.live.end")}
          </Button>
        )}
      </span>
      <ConfirmDialog
        open={confirmEnd}
        title={t("watchParty.live.endConfirmTitle")}
        description={t("watchParty.live.endConfirmBody", { name: party.name })}
        confirmLabel={t("watchParty.live.end")}
        onClose={() => setConfirmEnd(false)}
        onConfirm={() => void props.onEnd()}
      />
    </div>
  );

  /**
   * The same panel the setup surface showed, reopened mid-show. A host who
   * learned it before going live does not learn a second one at minute forty,
   * and every change lands immediately for the people already watching (the
   * server re-reconciles the channel on every edit).
   */
  /* HOST SIDE ONLY, and `runsTheShow` is the gate rather than `canStart`: a
     co-host running the show wants this too, and a moderator who merely holds
     MANAGE_CHANNELS is not transmitting anything. A viewer has no use for the
     presenter's encoder. */
  const transmission = runsTheShow && (
    <WatchPartyTransmission
      stream={props.liveStream ?? null}
      wentLiveAt={party.wentLiveAt}
      audienceCount={props.audienceCount}
      isPresenting={props.isPresenting}
      quality={props.videoQuality ?? "auto"}
      roomViewers={props.roomViewers ?? 0}
      transport={props.transport ?? null}
      now={new Date()}
    />
  );

  /**
   * THE OPTIONS ARE A DIALOG NOW, NOT A DRAWER IN THE COLUMN.
   *
   * It used to be a `shrink-0` block above the split, so opening it PUSHED
   * the split down by its own height. Measured on 12 Sep 2026 at 1440x900
   * with a live party: the drawer was 586px and the pane holding the picture
   * went from 735px to 149px. Rafael's words, with a party running: "need to
   * improve this ui. settings is messy. maybe a popup or pulldown menu?" The
   * picture is the entire point of the screen and a host changing slow mode
   * lost it.
   *
   * `Dialog` rather than a popover or a dropdown because `docs/DESIGN.md`
   * says both of those are PLANNED primitives and that a screen must not
   * hand-roll a local one. Dialog is the modal this app has: focus trap,
   * Escape, focus restoration, a body that scrolls on its own. The stage
   * behind it does not move a pixel, so closing it puts the host back exactly
   * where they were.
   */
  const optionsDialog = runsTheShow && (
    <Dialog
      open={optionsOpen}
      onClose={() => setOptionsOpen(false)}
      title={t("watchParty.options.title")}
      eyebrow={party.name}
      description={t("watchParty.options.liveNote")}
      size="md"
    >
      <DialogBody className="flex flex-col gap-4" data-testid="watch-party-options-drawer">
        <WatchPartyOptionsPanel
          options={party.options}
          audienceCount={props.audienceCount}
          onChange={(patch) => void props.onOptionsChange(patch)}
        />
        {/* Mid-show, and it is the same control the setup surface had. A
            co-host promoted here is granted SPEAK on the spot by the server,
            so somebody brought in to help can actually talk to the room. */}
        {cohostSection(props, party, "border-t border-border pt-4")}
        {/* The queue is a moderation surface and only the people running the
            party see it: an audience that can watch who asked and was passed
            over is an audience having a worse time. */}
        {party.options.stageMode === "invited" && (
          <div className="border-t border-border pt-4">
          <p className="mb-1.5 text-[11px] font-semibold uppercase tracking-wider text-paper-muted">
            {t("watchParty.stage.hands")}
          </p>
          {party.stage.hands.length === 0 ? (
            <p className="text-[11px] text-paper-muted">
              {t("watchParty.stage.noHands")}
            </p>
          ) : (
            <ul className="flex flex-col gap-1">
              {party.stage.hands.map((person) => (
                <li
                  key={person.userId}
                  className="flex items-center gap-2"
                  data-watch-party-hand
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
                    onClick={() =>
                      void props.onStageAction?.("invite", person.userId)
                    }
                    data-watch-party-invite
                  >
                    {t("watchParty.stage.invite")}
                  </Button>
                </li>
              ))}
            </ul>
          )}
          {party.stage.invited.length > 0 && (
            <>
              <p className="mb-1.5 mt-3 text-[11px] font-semibold uppercase tracking-wider text-paper-muted">
                {t("watchParty.stage.title")}
              </p>
              <ul className="flex flex-col gap-1">
                {party.stage.invited.map((person) => (
                  <li key={person.userId} className="flex items-center gap-2">
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
                      variant="ghost"
                      size="sm"
                      onClick={() =>
                        void props.onStageAction?.("remove", person.userId)
                      }
                      data-watch-party-stage-remove
                    >
                      {t("watchParty.stage.remove")}
                    </Button>
                  </li>
                ))}
              </ul>
            </>
            )}
          </div>
        )}
      </DialogBody>
    </Dialog>
  );

  const hostGone = party.hostDisconnectedAt !== null && (
    <div
      data-testid="watch-party-host-gone"
      className="flex shrink-0 items-center gap-2 border-b border-ink-4/60 bg-warning/10 px-3 py-1.5 text-xs text-warning"
    >
      <span className="font-semibold">{t("watchParty.live.hostGone")}</span>
      <span className="text-paper-muted">
        {t("watchParty.live.hostGoneBody", { name: party.hostDisplayName })}
      </span>
    </div>
  );

  // THE CHROME HALF: the party's controls, drawn above the split so that
  // collapsing the video cannot take Encerrar with it.
  if (props.slot === "chrome") {
    return (
      <div className="relative shrink-0">
        {bar}
        {transmission}
        {/* Portalled by `Dialog`, so it takes no room in this column and the
            split below it never moves. */}
        {optionsDialog}
        {hostGone}
        {viewerHint}
      </div>
    );
  }

  // Nothing on screen yet, and the person is not in the call: say so instead
  // of rendering nothing. Which "nothing" it is matters: see
  // `someoneIsSharing` above.
  if (!props.hasStream && !props.inCall) {
    const preparing = props.someoneIsSharing === true;
    const hostSide = runningTheShow && props.canStart;
    return (
      <div
        className={cn(
          "relative flex flex-col overflow-hidden border-b border-ink-4/60 bg-ink",
          surfaceHeight(props.fill, "h-[68svh] min-h-[280px]"),
        )}
      >
        <div
          data-testid="watch-party-waiting"
          data-watch-party-waiting={preparing ? "preparing" : "idle"}
          className="flex min-h-0 flex-1 flex-col items-center justify-center gap-2 bg-black px-6 text-center"
        >
          <Radio
            className={cn(
              "h-7 w-7 text-danger",
              preparing && "motion-safe:animate-pulse",
            )}
            aria-hidden
          />
          <p className="text-sm font-semibold text-paper">
            {preparing
              ? t("watchParty.live.preparing")
              : t("watchParty.live.waiting")}
          </p>
          <p className="max-w-sm text-xs text-paper-muted">
            {preparing
              ? hostSide
                ? t("watchParty.live.preparingHost")
                : t("watchParty.live.preparingBody", {
                    name: party.hostDisplayName,
                  })
              : hostSide
                ? t("watchParty.live.waitingHost")
                : t("watchParty.live.waitingBody", {
                    name: party.hostDisplayName,
                  })}
          </p>
        </div>
      </div>
    );
  }

  // A live party WITH a picture: `WatchChannelStage` draws it, and the chrome
  // above the split has already drawn the controls. Nothing left for this half.
  return null;
}

// -------------------------------------------------------------- the identity

/** The party's own name, the host's face, and the live pill. Never the channel. */
function PartyIdentity({
  party,
  compact = false,
  meta,
  className,
}: {
  party: WatchParty;
  compact?: boolean;
  /** Appended after the host, for facts that are not actions (the count). */
  meta?: string;
  className?: string;
}) {
  const { t } = useTranslation();
  const live = party.state === "live";
  return (
    <span className={cn("flex min-w-0 flex-1 items-center gap-2.5", className)}>
      <UserAvatar
        name={party.hostDisplayName}
        avatarUrl={party.hostAvatarUrl}
        rounded="full"
        className={cn("shrink-0", compact ? "h-7 w-7" : "h-10 w-10")}
      />
      <span className="flex min-w-0 flex-col">
        <span className="flex min-w-0 items-center gap-1.5">
          <span
            data-watch-party-name-label
            className={cn(
              "truncate font-semibold text-paper",
              compact ? "text-sm" : "text-base",
            )}
          >
            {party.name}
          </span>
          {live && <LivePill />}
        </span>
        <span
          data-testid={meta ? "watch-party-viewers" : undefined}
          className="truncate text-[11px] text-paper-muted"
        >
          {t("watchParty.live.hostedBy", { name: party.hostDisplayName })}
          {meta ? ` · ${meta}` : ""}
        </span>
      </span>
    </span>
  );
}
