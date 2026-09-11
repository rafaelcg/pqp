import { useEffect, useRef, useState, type ReactElement } from "react";
import {
  Bell,
  BellOff,
  Check,
  Clapperboard,
  Lock,
  Crown,
  Hand,
  Mic,
  MicOff,
  MonitorPlay,
  Pencil,
  Phone,
  Radio,
  Share2,
  SlidersHorizontal,
  Square,
  Undo2,
} from "lucide-react";
import {
  canPerformWatchPartyAction,
  mayTakeWatchPartySeat,
  watchPartySpeakAffordance,
  watchPartySurface,
  type LiveHlsStream,
  type VoiceRoomTransport,
  type WatchParty,
  type WatchPartyOptions,
} from "@pqp/shared";
import { VideoQualityMenu } from "@/components/voice/video-quality-menu";
import {
  screenCaptureMaxFrameRate,
  type ScreenFrameRate,
} from "@/lib/hls-capture-rate";
import {
  applyScreenCaptureQuality,
  screenCaptureSizeFor,
  WATCH_PARTY_HOST_QUALITIES,
  watchPartyHostFrameRate,
  watchPartyHostQuality,
  type VideoQuality,
} from "@/lib/video-quality";
import {
  OptionGroup,
  WatchPartyOptionsPanel,
  slowModeKey,
} from "@/components/watch-party/watch-party-options";
import {
  canAppointCohosts,
  WatchPartyCohosts,
  type CohostCandidate,
} from "@/components/watch-party/watch-party-cohosts";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Dialog, DialogBody } from "@/components/ui/dialog";
import { UserAvatar } from "@/components/user/user-avatar";
import { FeatureHint } from "@/components/layout/feature-hint";
import { LivePill } from "@/components/watch-party/live-pill";
import { browserShareCapabilities, type ShareOutcome } from "@/lib/share-handle";
import { shareWatchParty, watchPartyShareUrl } from "@/lib/share-watch-party";
import { WatchPartyTransmission } from "@/components/watch-party/watch-party-transmission";
import { formatSessionRelativeTime } from "@/lib/channel-session-schedule";
import { supportsScreenShare } from "@/components/voice/capabilities";
import { getDesktop, isDesktopApp } from "@/lib/desktop";
import { useTranslation } from "@/lib/i18n";
import {
  screenCaptureEnvironment,
  screenCaptureOptions,
} from "@/lib/screen-capture-audio";
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
  /**
   * The host putting a picture up on a party that is already live: join the
   * room if needed and open the picker. Without it the waiting screen told
   * a host who had stopped sharing to share again, with no control that did.
   */
  onShareScreen?: () => Promise<void>;
  onEnd: () => Promise<void>;
  onDiscard: () => Promise<void>;
  onOptionsChange: (options: Partial<WatchPartyOptions>) => Promise<void>;
  onRename: (name: string) => Promise<void>;
  onClaimHost: () => Promise<void>;
  /**
   * "Me avisa quando começar" on the scheduled screen, bound to the party's
   * own reminder (a party IS a channel session, so `party.reminding` is the
   * same row the session card toggles). Absent means the toggle is not drawn.
   */
  onToggleReminder?: (wants: boolean) => Promise<void>;
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
  /**
   * Capture cadence for the share. Device-local with videoQuality; Auto
   * follows this server's HLS ladder. The same value Settings writes.
   */
  screenFrameRate?: ScreenFrameRate;
  /** The call strip used to own this; the live bar is the only bar now. */
  onVideoQualityChange?: (quality: VideoQuality) => void;
  onScreenFrameRateChange?: (rate: ScreenFrameRate) => void;
  roomViewers?: number;
  transport?: VoiceRoomTransport | null;
  /** This seat was taken as audience: no microphone was ever asked for. */
  isAudienceSeat?: boolean;
  /**
   * The host's own microphone, for the pill on the bar: nothing on the live
   * screen said whether it was open. `off` is not in the call at all;
   * `muted` is in the call with the mic closed; `open` means the room can
   * hear it (the audience never can: the stream carries the window's audio).
   */
  micState?: "off" | "muted" | "room" | "everyone";
  /** "Meu mic vai no stream", the standing preference, and the switch for it. */
  micInStream?: boolean;
  onMicInStreamChange?: (on: boolean) => void;
  /** The pill on the bar mutes and unmutes when this is given. */
  onToggleMute?: () => void;
  /** Give the seat back, in the party's words: Sair do palco. */
  onLeaveSeat?: () => void;
  /** Stop this person's share; the party stays live. */
  onStopShare?: () => Promise<void>;
  /** Pick a different window or tab; the old share stops first. */
  onReplaceShare?: () => Promise<void>;
  /** 60 when this server's HLS ladder names a 60 fps rung. */
  hlsMaxFrameRate?: 30 | 60;
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
      // A quiet watch party channel, seen by somebody who may not start one.
      // Say why the button is missing rather than showing an empty pane:
      // the permission has a name in the roles menu, and the person who can
      // grant it is one ask away. Not in a call (the call stage owns that
      // space) and not while a picture is up (`liveUntitled` covers it).
      return slot === "surface" &&
        !props.canStart &&
        !props.inCall &&
        !props.hasStream ? (
        <NoPermissionStage {...props} />
      ) : null;
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

// ------------------------------------------------------------------- share

/**
 * "Copiar link", on the draft and on the live bar. The label says what the
 * device did (a phone opened a sheet, a desktop copied), the way the handle
 * share does. A party in a conversation has no server and no shareable
 * address, so the button is absent there rather than dead.
 */
function WatchPartyShareButton({
  party,
  size = "sm",
}: {
  party: WatchParty;
  size?: "sm" | "default";
}) {
  const { t, locale } = useTranslation();
  const [outcome, setOutcome] = useState<ShareOutcome | null>(null);

  useEffect(() => {
    if (outcome !== "copied" && outcome !== "failed") {
      return;
    }
    const timer = window.setTimeout(() => setOutcome(null), 2000);
    return () => window.clearTimeout(timer);
  }, [outcome]);

  if (!party.serverId) {
    return null;
  }
  const serverId = party.serverId;
  const label =
    outcome === "copied"
      ? t("watchParty.share.copied")
      : outcome === "failed"
        ? t("watchParty.share.failed")
        : t("watchParty.share.cta");

  return (
    <Button
      type="button"
      variant="ghost"
      size={size}
      onClick={() => {
        const url = watchPartyShareUrl(
          window.location.origin,
          serverId,
          party.channelId,
        );
        void shareWatchParty(
          { name: party.name, url, locale },
          browserShareCapabilities(),
        ).then((result) => {
          if (result !== "dismissed") {
            setOutcome(result);
          }
        });
      }}
      data-watch-party-share
    >
      {outcome === "copied" ? (
        <Check className="mr-1.5 h-3.5 w-3.5" aria-hidden />
      ) : (
        <Share2 className="mr-1.5 h-3.5 w-3.5" aria-hidden />
      )}
      {label}
    </Button>
  );
}

// ------------------------------------------------- options: one dialog, one row

/**
 * THE SAME DIALOG BEFORE AND DURING THE SHOW. The setup surface used to carry
 * a 72-unit column of every option plus the co-host list beside the preview,
 * and the live bar opened a dialog with the same controls. Two surfaces for
 * one set of switches, and the bigger one sat on the screen where a host has
 * the least reason to touch any of them: every default is already right for a
 * film night (voice off, reactions on, chat unthrottled). Twitch, YouTube and
 * TikTok all put the options a click away and keep the picture and the one
 * button in front. So the draft gets the live dialog, opened from a summary
 * row, and the column is gone.
 *
 * `stage` is the hands queue, which only exists once there is a room with
 * people in it; a draft has none by construction.
 */
function WatchPartyOptionsDialog({
  props,
  party,
  open,
  onClose,
  stage,
}: {
  props: WatchPartyPanelProps;
  party: WatchParty;
  open: boolean;
  onClose: () => void;
  stage: boolean;
}) {
  const { t } = useTranslation();
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={t("watchParty.options.title")}
      eyebrow={party.name}
      description={
        party.state === "live" ? t("watchParty.options.liveNote") : undefined
      }
      size="md"
    >
      <DialogBody className="flex flex-col gap-4" data-testid="watch-party-options-drawer">
        <WatchPartyOptionsPanel
          options={party.options}
          audienceCount={props.audienceCount}
          onChange={(patch) => void props.onOptionsChange(patch)}
        />
        {/* THIS COMPUTER'S SWITCH, not the party's: whether the share carries
            the host's own voice to the people watching from outside. Off,
            the stream carries the window's audio only and the mic stays with
            the seated room, which is what a host who wants to chat with
            friends in a separate lobby while the film plays wants. */}
        {props.onMicInStreamChange && (
          <OptionGroup title={t("watchParty.options.streamTitle")}>
            <div className="px-1 py-0.5" data-watch-party-mic-in-stream>
              <Switch
                label={t("watchParty.options.micInStream")}
                description={t("watchParty.options.micInStreamBody")}
                checked={props.micInStream !== false}
                onCheckedChange={(on) => props.onMicInStreamChange?.(on)}
              />
            </div>
          </OptionGroup>
        )}
        {/* Mid-show, and it is the same control the setup surface had. A
            co-host promoted here is granted SPEAK on the spot by the server
            when the party's floor is closed, so somebody brought in to help
            can actually talk to the room. */}
        {cohostSection(props, party, "border-t border-border pt-4")}
        {/* The queue is a moderation surface and only the people running the
            party see it: an audience that can watch who asked and was passed
            over is an audience having a worse time. It is also nonsense in a
            party with no voice, where nobody is asking for anything, so it
            follows the Voz control rather than the stored stage mode. */}
        {stage &&
          party.options.voiceEnabled &&
          party.options.stageMode === "invited" && (
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
}

/**
 * One line that says what the switches are set to, with the one control that
 * changes them. Reads as a sentence ("Voz desligada · Reações ligadas · Chat
 * normal · Sem co-host") so a host can confirm the defaults at a glance
 * without opening anything, which is what most of them will do.
 */
function WatchPartyOptionsSummary({
  party,
  micInStream,
  onOpen,
}: {
  party: WatchParty;
  micInStream?: boolean;
  onOpen: () => void;
}) {
  const { t } = useTranslation();
  const { options } = party;
  const parts = [
    options.voiceEnabled
      ? t("watchParty.summary.voiceOn")
      : t("watchParty.summary.voiceOff"),
    options.reactionsEnabled
      ? t("watchParty.summary.reactionsOn")
      : t("watchParty.summary.reactionsOff"),
    options.slowModeSeconds > 0
      ? t("watchParty.summary.slow", {
          value: t(slowModeKey(options.slowModeSeconds)),
        })
      : t("watchParty.summary.chatNormal"),
    party.cohosts.length > 0
      ? t("watchParty.summary.cohosts", { count: party.cohosts.length })
      : t("watchParty.summary.noCohost"),
    ...(micInStream === undefined
      ? []
      : [
          micInStream
            ? t("watchParty.summary.micInStream")
            : t("watchParty.summary.micRoomOnly"),
        ]),
  ];
  return (
    <div
      data-testid="watch-party-options-summary"
      className="flex shrink-0 items-center gap-2 border-t border-ink-4/60 bg-ink px-3 py-1.5"
    >
      <p className="min-w-0 flex-1 truncate text-xs text-paper-muted">
        {parts.join(" · ")}
      </p>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        onClick={onOpen}
        data-watch-party-options-toggle
      >
        <SlidersHorizontal className="mr-1.5 h-3.5 w-3.5" aria-hidden />
        {t("watchParty.summary.adjust")}
      </Button>
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

/**
 * The same pane, for somebody without START_WATCH_PARTY. "Nothing" was the
 * previous answer, and nothing teaches nobody: the permission exists, it has
 * a name in Cargos, and a moderator can tick it in one click if asked.
 */
function NoPermissionStage(props: WatchPartyPanelProps) {
  const { t } = useTranslation();
  return (
    <div
      data-testid="watch-party-no-permission"
      className={cn(
        "flex flex-col items-center justify-center gap-2 overflow-hidden border-b border-ink-4/60 bg-ink px-6 py-8 text-center",
        surfaceHeight(props.fill, "min-h-0"),
      )}
    >
      <span className="flex h-11 w-11 items-center justify-center rounded-full bg-ink-3 text-paper-muted">
        <Lock className="h-5 w-5" aria-hidden />
      </span>
      <p className="text-sm font-semibold text-paper">
        {t("watchParty.empty.title")}
      </p>
      <p className="max-w-sm text-xs text-paper-muted">
        {t("watchParty.empty.noPermission", {
          permission: t("roles.perm.START_WATCH_PARTY"),
        })}
      </p>
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
 *
 * THE OPTIONS ARE THE SAME AS EVERY OTHER SHARE. A bare `{ audio: true }` is
 * the 23 Aug 2026 echo: on Windows Electron it becomes WASAPI loopback of the
 * whole render endpoint (the call included), and in a browser it leaves
 * `systemAudio` / `restrictOwnAudio` to the engine's defaults. Setup must go
 * through `screenCaptureOptions` with `preferBrowserTab` so the picker steers
 * at a tab, system audio stays excluded, and the call's own playback is
 * stripped when the engine knows how. The stream handed to go-live is then
 * already a capture that cannot put every voice back into the room.
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
  const [optionsOpen, setOptionsOpen] = useState(false);
  // A PHONE CANNOT PUT A PICTURE UP. `getDisplayMedia` does not exist on iOS
  // Safari at all and is refused on Android Chrome, so the empty state says
  // where to go instead of offering a button that opens nothing, and the
  // Ir ao vivo it could never enable is not drawn. Everything else on this
  // surface (the name, the options, the link, discarding) still works from
  // the phone, which is where a host is when they set a time on the bus.
  const canPutPictureUp = supportsScreenShare();
  // The most common "it doesn't work" from the QA runbook (step 3): the host
  // picked the tab and left "share tab audio" unticked, and nobody hears the
  // film. Say so under the preview, before anyone is watching.
  const silentPick = stream !== null && stream.getAudioTracks().length === 0;

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
      // Same builder every ordinary share uses. `preferBrowserTab` is the
      // watch-party product: the player tab and its sound, never the machine
      // mixer that contains the call. See `lib/screen-capture-audio.ts`.
      const quality = watchPartyHostQuality(props.videoQuality ?? "auto");
      const fps = watchPartyHostFrameRate(
        quality,
        screenCaptureMaxFrameRate({
          preference: props.screenFrameRate ?? "auto",
          hlsLadderMax: props.hlsMaxFrameRate ?? 30,
        }),
      );
      const size = screenCaptureSizeFor(quality);
      const options = screenCaptureOptions(
        false,
        screenCaptureEnvironment(
          isDesktopApp(),
          getDesktop()?.platform ?? null,
        ),
        {
          preferBrowserTab: true,
          maxFrameRate: fps,
          maxWidth: size.width,
          maxHeight: size.height,
        },
      );
      const picked = await navigator.mediaDevices.getDisplayMedia(options);
      const videoTrack = picked.getVideoTracks()[0];
      if (videoTrack) {
        await applyScreenCaptureQuality(videoTrack, quality, fps);
      }
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
              {canPutPictureUp ? (
                <>
                  <p className="text-sm text-paper-muted">
                    {t("watchParty.setup.noSource")}
                  </p>
                  <Button type="button" variant="secondary" onClick={() => void pick()}>
                    {t("watchParty.setup.pick")}
                  </Button>
                  {pickError && (
                    <p className="text-xs text-danger">{pickError}</p>
                  )}
                </>
              ) : (
                <p
                  className="max-w-xs text-sm text-paper-muted"
                  data-testid="watch-party-phone-host"
                >
                  {t("watchParty.setup.phoneHost")}
                </p>
              )}
            </div>
          )}
          {/* The name sits on the picture, where the live bar will show it,
              rather than at the top of a form. Same input the e2e reads. */}
          <div className="absolute right-2 top-2 flex items-center gap-2">
            <input
              type="text"
              maxLength={120}
              aria-label={t("watchParty.setup.nameLabel")}
              className="w-32 rounded-md border border-ink-4/60 sm:w-44 bg-surface-0/90 px-2 py-1 text-right text-sm font-semibold text-paper focus:border-ink-4"
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
            {stream && (
              <Button
                type="button"
                variant="secondary"
                size="sm"
                onClick={() => void pick()}
              >
                {t("watchParty.setup.repick")}
              </Button>
            )}
          </div>
          {silentPick && (
            <p
              data-testid="watch-party-no-audio"
              className="pointer-events-none absolute bottom-3 left-3 right-3 rounded-md border border-warning/40 bg-surface-0/90 px-2.5 py-1.5 text-xs text-warning"
            >
              {t("watchParty.setup.noAudio")}
            </p>
          )}
        </div>

      </div>

      <WatchPartyOptionsSummary
        party={party}
        micInStream={props.onMicInStreamChange ? props.micInStream !== false : undefined}
        onOpen={() => setOptionsOpen(true)}
      />

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
            {/* ONE WARNING, NOT TWO. The preview used to carry a pill ("Só
                você tá vendo isso") and this row said "Ainda não tá no ar"
                with the next step after it: the same fact in two places, in
                two tones. The row says it once: whose eyes are on this, then
                what to do about it. The bar is why a host on production once
                announced "im live" to a room with nothing going out; it
                stays the sentence, and the pill goes. */}
            <span className="font-semibold text-warning">
              {t("watchParty.setup.heading")}
            </span>{" "}
            <span className="text-text-tertiary">
              {stream
                ? t("watchParty.setup.goLiveHint")
                : canPutPictureUp
                  ? t("watchParty.setup.pickFirst")
                  : t("watchParty.setup.phoneHint")}
            </span>
          </p>
        </div>
        <div className="flex shrink-0 flex-wrap items-center gap-2">
          <WatchPartyShareButton party={party} size="default" />
          <Button
            type="button"
            variant="ghost"
            onClick={() => setConfirmDiscard(true)}
            data-watch-party-discard
          >
            <Undo2 className="mr-1.5 h-3.5 w-3.5" aria-hidden />
            {t("watchParty.setup.discard")}
          </Button>
          {/* NO PICTURE, NO BUTTON. Discord's Go Live and YouTube's "Ready to
              go live?" both refuse to start until there is a source, and the
              one production incident this surface has had was a host going
              live to a black pane. The party and the picture stay separable
              on the server (a share that dies mid-show does not end the
              party); the setup surface just will not START one without a
              picture. The scheduled card keeps its own unconditional button
              for the host who set a time and shares once they are in. */}
          {canPutPictureUp && (
            <Button
              type="button"
              disabled={busy || !stream}
              title={stream ? undefined : t("watchParty.setup.pickFirst")}
              onClick={() => void goLive()}
              data-watch-party-go-live
              className="bg-danger text-paper hover:bg-danger/85"
            >
              <Radio className="mr-1.5 h-3.5 w-3.5" aria-hidden />
              {t("watchParty.setup.goLive")}
            </Button>
          )}
        </div>
      </div>

      <WatchPartyOptionsDialog
        props={props}
        party={party}
        open={optionsOpen}
        onClose={() => setOptionsOpen(false)}
        stage={false}
      />

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

/**
 * THE GATHERING SCREEN. A scheduled party used to be a name, a time and, for
 * the host, a button. YouTube's scheduled watch page is the model instead: a
 * place people arrive at before there is a picture, with a countdown, a
 * reminder bell and the chat already open, so the audience is there when the
 * host presses the button rather than trickling in ten minutes after. The
 * chat is the other pane of the split, so this half only has to give them a
 * reason to stay.
 *
 * The clock ticks every 30 s so "em 3 min" is never stale by more than that,
 * and "ao vivo agora" appears on its own when the time passes even though
 * the state has not moved (the host has not pressed anything yet).
 */
function ScheduledStage(props: WatchPartyPanelProps & { party: WatchParty }) {
  const { t, locale } = useTranslation();
  const { party } = props;
  const canGoLive = canPerformWatchPartyAction({
    action: "goLive",
    role: party.viewerRole,
    state: party.state,
  });
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(new Date()), 30_000);
    return () => window.clearInterval(timer);
  }, []);
  const [reminding, setReminding] = useState(party.reminding);
  const [reminderBusy, setReminderBusy] = useState(false);
  const displayedPartyId = useRef(party.id);
  displayedPartyId.current = party.id;
  useEffect(() => setReminding(party.reminding), [party.id, party.reminding]);
  // Same instance can show party B while A's toggle is still in flight. The
  // finally guard below must not clear B's busy; reset it when the party changes.
  useEffect(() => {
    setReminderBusy(false);
  }, [party.id]);
  const toggleReminder = async () => {
    if (!props.onToggleReminder) {
      return;
    }
    const partyId = party.id;
    const next = !reminding;
    setReminding(next);
    setReminderBusy(true);
    try {
      await props.onToggleReminder(next);
    } catch {
      if (displayedPartyId.current === partyId) {
        setReminding(!next);
      }
    } finally {
      if (displayedPartyId.current === partyId) {
        setReminderBusy(false);
      }
    }
  };
  const when = formatSessionRelativeTime(
    party.startsAt ?? "",
    now,
    locale === "pt-BR" ? "pt-BR" : "en",
  );

  return (
    <div
      data-testid="watch-party-scheduled"
      className={cn(
        "flex flex-col items-center justify-center overflow-hidden border-b border-ink-4/60 bg-ink px-4 py-6",
        surfaceHeight(props.fill, "min-h-0"),
      )}
    >
      {/* A CARD, NOT A VOID. The first cut floated the identity, the time and
          three buttons of three different weights in the middle of a black
          pane. The time is what a person came to read, so it is the
          headline; who and what sit under it; the two quiet actions share
          a row; and the host's one loud action has a row of its own with
          the honest sentence beside it (viewers are looking at this screen,
          so "nobody sees anything" was false). */}
      <div className="flex w-full max-w-md flex-col items-center gap-4 rounded-2xl border border-border bg-surface-0 px-6 py-6 text-center">
        <div>
          <p
            className="text-[11px] font-semibold uppercase tracking-wider text-text-tertiary"
          >
            {t("watchParty.scheduled.eyebrow")}
          </p>
          <p
            className="mt-1 text-xl font-semibold text-paper"
            data-testid="watch-party-scheduled-when"
          >
            {t("watchParty.scheduled.startsAt", { when })}
          </p>
        </div>
        <PartyIdentity
          party={party}
          onRename={props.onRename}
          className="flex-none justify-center"
        />
        <div className="flex flex-wrap items-center justify-center gap-2">
          {props.onToggleReminder && (
            <Button
              type="button"
              variant={reminding ? "default" : "secondary"}
              size="sm"
              disabled={reminderBusy}
              aria-pressed={reminding}
              onClick={() => void toggleReminder()}
              data-watch-party-remind
            >
              {reminding ? (
                <Bell className="mr-1.5 h-3.5 w-3.5" aria-hidden />
              ) : (
                <BellOff className="mr-1.5 h-3.5 w-3.5" aria-hidden />
              )}
              {reminding
                ? t("watchParty.scheduled.reminding")
                : t("watchParty.scheduled.remind")}
            </Button>
          )}
          <WatchPartyShareButton party={party} />
        </div>
        {canGoLive ? (
          <div className="flex w-full flex-col items-center gap-2 border-t border-border pt-4">
            <Button
              type="button"
              className="w-full bg-danger text-paper hover:bg-danger/85 sm:w-auto"
              onClick={() => void props.onGoLive(null)}
              data-watch-party-go-live
            >
              <Radio className="mr-1.5 h-3.5 w-3.5" aria-hidden />
              {t("watchParty.scheduled.goLiveNow")}
            </Button>
            <p className="text-xs text-text-tertiary">
              {t("watchParty.scheduled.hostNote")}
            </p>
          </div>
        ) : (
          <p className="text-xs text-text-tertiary">
            {t("watchParty.scheduled.viewerNote")}
          </p>
        )}
      </div>
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
  const [qualityMenuOpen, setQualityMenuOpen] = useState(false);
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
   * THE SAME FUNCTION THE SERVER REFUSES THE JOIN WITH. This used to be a
   * hand-rolled `runsTheShow || invited` here and a separate rule in
   * `join-voice-room`, which is two answers to one question and exactly how a
   * button that does nothing gets shipped. `mayTakeWatchPartySeat` is now the
   * only place the rule is written, so a control drawn here is one the server
   * will honour and a control withheld is a join it would refuse.
   *
   * `stage.invited` is public on the wire (`presentStage`: who is UP is
   * public, who is ASKING is not), so an invited guest recognises themselves
   * without a second request and without the client guessing.
   */
  const mayTakeASeat = mayTakeWatchPartySeat({
    canStartWatchParty: props.canStart,
    party: {
      voiceEnabled: party.options.voiceEnabled,
      isHost: party.viewerRole === "host",
      isCohost: party.viewerRole === "cohost",
      isInvited:
        props.currentUserId !== undefined &&
        party.stage.invited.some(
          (person) => person.userId === props.currentUserId,
        ),
    },
  });

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
        onRename={props.onRename}
      />
      {/* WHETHER YOUR MICROPHONE IS OPEN, in words, on the bar. A host live
          in front of a room asked exactly that and nothing here answered:
          the only hint was the mute icon at the bottom of the sidebar. And
          the answer has a second half people get wrong, so it is stated:
          the room can hear an open mic, the audience outside never can. */}
      {(runsTheShow || props.inCall) && props.micState && (() => {
        const mic = props.micState;
        const inCall = mic !== "off";
        const label =
          mic === "everyone"
            ? t("watchParty.live.micEveryone")
            : mic === "room"
              ? t("watchParty.live.micRoom")
              : mic === "muted"
                ? t("watchParty.live.micMuted")
                : t("watchParty.live.micOff");
        const hint =
          mic === "everyone"
            ? t("watchParty.live.micEveryoneHint")
            : mic === "room"
              ? t("watchParty.live.micRoomHint")
              : undefined;
        const className = cn(
          "flex shrink-0 items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-semibold transition-colors",
          mic === "everyone"
            ? "border-success/40 bg-success/15 text-success"
            : mic === "room"
              ? "border-warning/40 bg-warning/10 text-warning"
              : "border-border bg-surface-0 font-normal text-text-tertiary",
          inCall && props.onToggleMute && "hover:bg-surface-2",
        );
        const icon =
          mic === "everyone" || mic === "room" ? (
            <Mic className="h-3 w-3" aria-hidden />
          ) : (
            <MicOff className="h-3 w-3" aria-hidden />
          );
        // THE PILL IS THE MUTE BUTTON. It used to be a label beside a mute
        // control three panes away; the thing that says whether you are
        // heard is the thing you press to stop being heard.
        return inCall && props.onToggleMute ? (
          <button
            type="button"
            data-watch-party-mic={mic}
            aria-pressed={mic === "muted"}
            aria-label={
              mic === "muted"
                ? t("voice.control.unmute")
                : t("voice.control.mute")
            }
            title={hint ?? (mic === "muted" ? t("voice.control.unmute") : t("voice.control.mute"))}
            className={className}
            onClick={props.onToggleMute}
          >
            {icon}
            {label}
          </button>
        ) : (
          <span data-watch-party-mic={mic} title={hint} className={className}>
            {icon}
            {label}
          </span>
        );
      })()}
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
            anybody who may start a watch party in this channel at all; and
            anybody the host has invited up to speak, for whom the whole
            point of being invited is that they can now talk. `stage.invited`
            is public on the wire (`presentStage`: who is UP is public, who is
            ASKING is not), so this is the party's own answer rather than a
            guess. A manager is deliberately NOT here: MANAGE_CHANNELS ends
            and edits somebody else's party, it does not perform in it.

            AND EVERYBODY, ONCE A HOST TURNS VOZ ON. That is the film night,
            and it is the case the blanket removal got wrong: a party whose
            host deliberately opened voice and then offered nobody a way in
            would be a setting that does nothing. The rule is
            `mayTakeWatchPartySeat` above, which is the same function
            `join-voice-room` refuses with, so this control is never drawn for
            a join the server would turn away.

            The listen-only label went with the control. Everybody who can
            still see this button can speak once they are in, so a warning
            about a seat that cannot would now be false. */}
        {/* A WATCH PARTY IS NOT A LOBBY. The host is seated by going live
            or sharing, never by this button, and a co-host takes over with
            Assumir and shares. So with voice off, nobody running the show
            is offered a seat here; a host who wants to chat with friends
            while the film plays uses a voice channel. With voice on, the
            floor is a thing and the door stays. */}
        {!props.inCall &&
          mayTakeASeat &&
          (party.options.voiceEnabled || !runsTheShow) && (
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
        {/* THE SHARE, IN ONE PLACE, IN THE PARTY'S WORDS. The call strip's
            share icons are gone for the host (section 10 of the plan);
            this is where a picture goes up, changes, or comes down. */}
        {runsTheShow && props.onShareScreen && !props.isPresenting && (
          <Button
            type="button"
            size="sm"
            onClick={() => void props.onShareScreen?.()}
            data-watch-party-bar-share
          >
            <MonitorPlay className="mr-1.5 h-3 w-3" aria-hidden />
            {t("watchParty.live.shareScreen")}
          </Button>
        )}
        {runsTheShow && props.isPresenting && props.onReplaceShare && (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => void props.onReplaceShare?.()}
            data-watch-party-bar-replace-share
          >
            <MonitorPlay className="mr-1.5 h-3 w-3" aria-hidden />
            {t("watchParty.live.replaceShare")}
          </Button>
        )}
        {runsTheShow && props.isPresenting && props.onStopShare && (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => void props.onStopShare?.()}
            data-watch-party-bar-stop-share
          >
            <Square className="mr-1.5 h-3 w-3" aria-hidden />
            {t("watchParty.live.stopShare")}
          </Button>
        )}
        {/* THE HOST ENCODE PICKER. The call strip used to carry
            `VideoQualityMenu` next to the share button; section 10 of the
            setup plan hid that strip and moved mute / share / Encerrar here,
            but not this. A host presenting with no webcam then had no way to
            pick 720 vs 1080 except Settings → Voice. Same menu, same stored
            value, labelled for this bar so it is not a round leftover icon. */}
        {runsTheShow && props.onVideoQualityChange && (
          <VideoQualityMenu
            layout="bar"
            testId="watch-party-quality"
            value={props.videoQuality ?? "auto"}
            open={qualityMenuOpen}
            onOpenChange={setQualityMenuOpen}
            onChange={props.onVideoQualityChange}
            qualities={WATCH_PARTY_HOST_QUALITIES}
            isSendingVideo
            isSharingScreen
            screenFrameRate={props.screenFrameRate}
            onScreenFrameRateChange={props.onScreenFrameRateChange}
            usingSfu={props.transport === "livekit"}
            watchingHls
            hlsLive={props.liveStream != null}
            hlsDelaySeconds={props.liveStream?.delaySeconds ?? 10}
            participantCount={Math.max(1, (props.roomViewers ?? 0) + 1)}
            buttonLabel={t("watchParty.live.quality")}
          />
        )}
        {/* THE SEAT'S OWN EXIT, in the party's words. The call strip's red
            Sair is gone from watch party channels (section 10): a seated
            guest gives the seat back here, and a host does not leave a seat
            on purpose, they stop sharing or end the party. */}
        {props.inCall && !runsTheShow && props.onLeaveSeat && (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={props.onLeaveSeat}
            data-watch-party-leave-stage
          >
            <Undo2 className="mr-1.5 h-3 w-3" aria-hidden />
            {t("watchParty.live.leaveStage")}
          </Button>
        )}
        <WatchPartyShareButton party={party} />
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
      micInStream={props.micState === "everyone"}
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
    <WatchPartyOptionsDialog
      props={props}
      party={party}
      open={optionsOpen}
      onClose={() => setOptionsOpen(false)}
      stage
    />
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
          {hostSide && !preparing && props.onShareScreen && (
            <Button
              type="button"
              className="mt-2"
              onClick={() => void props.onShareScreen?.()}
              data-watch-party-share-screen
            >
              <MonitorPlay className="mr-1.5 h-3.5 w-3.5" aria-hidden />
              {t("watchParty.live.shareScreen")}
            </Button>
          )}
        </div>
      </div>
    );
  }

  // A live party WITH a picture: `WatchChannelStage` draws it, and the chrome
  // above the split has already drawn the controls. Nothing left for this half.
  return null;
}

// -------------------------------------------------------------- the identity

/**
 * The party's own name, the host's face, and the live pill. Never the channel.
 *
 * WHO MAY RENAME is `edit` on the shared role table: host, co-host, manager,
 * while the party is draft / scheduled / live. A viewer sees the name as a
 * label. The people who can change it tap the name (or the pencil) here, on
 * the row the room is already looking at, rather than hunting a settings
 * page. The write is the existing PATCH; `watch-party-update` is how the
 * rest of the room gets the new title without a refresh.
 */
function PartyIdentity({
  party,
  compact = false,
  meta,
  className,
  onRename,
}: {
  party: WatchParty;
  compact?: boolean;
  /** Appended after the host, for facts that are not actions (the count). */
  meta?: string;
  className?: string;
  onRename?: (name: string) => Promise<void>;
}) {
  const { t } = useTranslation();
  const live = party.state === "live";
  const canRename =
    onRename !== undefined &&
    canPerformWatchPartyAction({
      action: "edit",
      role: party.viewerRole,
      state: party.state,
    });
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(party.name);
  const inputRef = useRef<HTMLInputElement>(null);
  const skipBlur = useRef(false);

  useEffect(() => {
    if (!editing) {
      setDraft(party.name);
    }
  }, [party.id, party.name, editing]);

  useEffect(() => {
    if (editing) {
      inputRef.current?.focus();
      inputRef.current?.select();
    }
  }, [editing]);

  const commit = () => {
    if (skipBlur.current) {
      skipBlur.current = false;
      return;
    }
    const next = draft.trim();
    setEditing(false);
    if (!onRename || next.length === 0) {
      setDraft(party.name);
      return;
    }
    if (next !== party.name) {
      void onRename(next);
    }
  };

  const nameClass = cn(
    "truncate font-semibold text-paper",
    compact ? "text-sm" : "text-base",
  );

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
          {editing ? (
            <input
              ref={inputRef}
              type="text"
              maxLength={120}
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              onBlur={commit}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  commit();
                }
                if (event.key === "Escape") {
                  event.preventDefault();
                  skipBlur.current = true;
                  setDraft(party.name);
                  setEditing(false);
                }
              }}
              aria-label={t("watchParty.live.renameLabel")}
              data-watch-party-rename-input
              className={cn(
                "min-w-0 flex-1 rounded-md border border-ink-4 bg-ink-3 px-1.5 py-0.5 font-semibold text-paper outline-none focus-visible:border-accent",
                compact ? "text-sm" : "text-base",
              )}
            />
          ) : canRename ? (
            <button
              type="button"
              data-watch-party-name-label
              data-watch-party-rename
              title={t("watchParty.live.rename")}
              onClick={() => setEditing(true)}
              className={cn(
                "flex min-w-0 items-center gap-1 rounded-sm text-left hover:text-paper",
                nameClass,
              )}
            >
              <span className="truncate">{party.name}</span>
              <Pencil
                className="h-3 w-3 shrink-0 text-paper-muted"
                aria-hidden
              />
            </button>
          ) : (
            <span data-watch-party-name-label className={nameClass}>
              {party.name}
            </span>
          )}
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
