import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactElement,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import {
  Bell,
  BellOff,
  CalendarClock,
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
  Settings2,
  Share2,
  Square,
  TriangleAlert,
  Undo2,
  Volume2,
} from "lucide-react";
import type { LiveHlsStream, VoiceRoomTransport } from "@pqp/shared";
import type { VideoQuality } from "@/lib/video-quality";
import {
  canPerformWatchPartyAction,
  mayTakeWatchPartySeat,
  watchPartySpeakAffordance,
  watchPartySurface,
  type WatchParty,
  type WatchPartyOptions,
} from "@pqp/shared";
import {
  OptionGroup,
  WatchPartyOptionsPanel,
} from "@/components/watch-party/watch-party-options";
import {
  canAppointCohosts,
  WatchPartyCohosts,
  type CohostCandidate,
} from "@/components/watch-party/watch-party-cohosts";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Input } from "@/components/ui/input";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Dialog, DialogBody } from "@/components/ui/dialog";
import { UserAvatar } from "@/components/user/user-avatar";
import { FeatureHint } from "@/components/layout/feature-hint";
import { LivePill } from "@/components/watch-party/live-pill";
import { browserShareCapabilities, type ShareOutcome } from "@/lib/share-handle";
import { shareWatchParty, watchPartyShareUrl } from "@/lib/share-watch-party";
import {
  MicLevelMeterBar,
  StreamMixControl,
  StreamQualityControl,
  WatchPartyTransmission,
} from "@/components/watch-party/watch-party-transmission";
import { VoiceTrackModeToggle } from "@/components/watch-party/voice-track-mode-toggle";
import type { VoiceTrackMode } from "@/lib/voice-track-mode";
import { WatchPartyStage } from "@/components/watch-party/watch-party-stage";
import {
  browserTimezone,
  formatSessionRelativeTime,
  toLocalInputValue,
} from "@/lib/channel-session-schedule";
import { supportsScreenShare } from "@/components/voice/capabilities";
import { getDesktop, isDesktopApp } from "@/lib/desktop";
import { useTranslation, type MessageKey } from "@/lib/i18n";
import {
  liveScreenCaptureEnvironment,
  offersShellSystemAudio,
  screenCaptureOptions,
} from "@/lib/screen-capture-audio";
import {
  blocksGoLive,
  desktopSharesTabAudio,
  goLiveChecklist,
  isFirefoxUserAgent,
  type ChecklistItem,
  type ChecklistItemId,
  type ChecklistTone,
} from "@/lib/watch-party-go-live-checklist";
import {
  readWatchPartyStreamQuality,
  type WatchPartyStreamQuality,
} from "@/lib/watch-party-stream-quality";
import {
  micIsInaudible,
  presenterMicWarning,
} from "@/lib/watch-party-mic-warning";
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
  /**
   * THE LIVE BAR IS THE CHANNEL HEADER (2026-09-18,
   * `docs/plans/WATCH_PARTY_UI.md` pass 1). While a party is live the app
   * draws no channel header of its own above this panel; the bar takes its
   * row and its height. These two slots carry what the header owned that
   * the party has no words for: the phone's nav button on the left, and a
   * `...` menu (pins, past broadcasts, channel settings, members) on the
   * right. Both optional, both rendered on the presenter and the audience
   * bar alike.
   */
  headerLeading?: ReactNode;
  headerTrailing?: ReactNode;
  /**
   * THE ONE BAR (2026-09-18, pass 2 of `docs/plans/WATCH_PARTY_UI.md`).
   * The element the live surface portals its controls into: the mic pill
   * and meter, the seat controls, share / Trocar / Parar, the mixer, the
   * legacy raise and the seat's exit. `App` hands over either the slot it
   * draws over the bottom of the stage pane or, for a seatless viewer with
   * a picture, the span in the player's own bottom bar. `null` (tests, a
   * party with no stage yet) draws the same row inline above the split, the
   * way the dock used to.
   */
  barSlot?: HTMLElement | null;
  /**
   * Where the host's transmission status goes (pass 3): the slot `App`
   * draws over the top edge of the stage pane. `null` draws it as the row
   * above the split it used to be.
   */
  statusSlot?: HTMLElement | null;
  /** START_WATCH_PARTY on this channel: may create one, may take the stage. */
  canStart: boolean;
  /** True while this person holds a seat in this channel's voice room. */
  inCall: boolean;
  /** True while `WatchChannelStage` has a playable stream for this channel. */
  hasStream: boolean;
  /** True while this person is the one whose screen is on the stage. */
  isPresenting: boolean;
  /**
   * This presenter's OWN screen-share publish to the SFU has dropped (a
   * reconnect) and the client is re-establishing it. Drives the truthful
   * "reconnecting" state in place of a live badge, timer and viewer count on
   * every surface the presenter runs the show from. Only ever true for the
   * presenter (`use-voice`'s `sharePublishRecovering`); false for a viewer, so
   * it never changes what the audience sees.
   */
  sharePublishRecovering?: boolean;
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
  /**
   * `lowLatency` is `party.options.lowLatency` from THIS component's own
   * `party` prop, not read back out of global selection state inside the
   * handler (Farol review, third round): the handler that ends up in
   * `App.tsx` runs after an await, by which point a different channel could
   * be selected, and re-querying "whatever party is current" at that point
   * would answer for the wrong party. Passing it through the call ties the
   * value to the party this specific press was for, not to whatever the
   * sidebar happens to show when the request lands.
   */
  onGoLive: (stream: MediaStream | null, lowLatency: boolean) => Promise<void>;
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
  /**
   * Set or clear the party's time from the setup card. The server moves a
   * draft to `scheduled` when a time arrives and back when it is cleared;
   * this surface then hands over to the scheduled screen. Optional because
   * only the card offers it.
   */
  onSchedule?: (startsAt: string | null) => Promise<void>;
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
  /**
   * "Voz: junto com o filme / separada" (`LIVE_HLS_VOICE_TRACK`). Shown only
   * when both are given: the mode itself and this deployment's own answer on
   * whether the flag is on (`useLiveHlsConfig(serverId)?.voiceTrack`) — see
   * `VoiceTrackModeToggle`.
   */
  voiceTrackMode?: VoiceTrackMode;
  onVoiceTrackModeChange?: (mode: VoiceTrackMode) => void;
  voiceTrackAvailable?: boolean;
  /**
   * `GET /api/live-hls/config`'s `lowLatency.available` for this server
   * (`useLiveHlsConfig(serverId)?.lowLatency?.available`), threaded down to
   * `WatchPartyOptionsPanel` so "Baixa latência (beta)" stays out of the
   * panel entirely on a deployment with `LIVE_HLS_LL` unset or this server
   * off its allowlist.
   */
  lowLatencyAvailable?: boolean;
  /** Apply a mic-gain choice to the running mix at once. See `StreamMixControl`. */
  onMicGainChange?: (value: number) => void;
  /** Same as `onMicGainChange`, for the display (tab-audio) branch. */
  onDisplayGainChange?: (value: number) => void;
  /** The mic's live level in the running mix, for the mixer's meter. */
  micLevelDb?: () => number | null;
  /** The mixed bus's live level, for the "no sound is leaving" warning. */
  outputLevelDb?: () => number | null;
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
  /** This person's camera, for the go-live checklist's "camera off" row. */
  cameraOn?: boolean;
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
  iconOnly = false,
}: {
  party: WatchParty;
  size?: "sm" | "default";
  /** The presenter header's icon: label in the tooltip, feedback in the icon. */
  iconOnly?: boolean;
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
      aria-label={iconOnly ? label : undefined}
      title={iconOnly ? label : undefined}
    >
      {outcome === "copied" ? (
        <Check className={cn("h-3.5 w-3.5", !iconOnly && "mr-1.5")} aria-hidden />
      ) : (
        <Share2 className={cn("h-3.5 w-3.5", !iconOnly && "mr-1.5")} aria-hidden />
      )}
      {!iconOnly && label}
    </Button>
  );
}

// ------------------------------------------------- options: one dialog, one row

/**
 * How many raised hands the options dialog draws before it stops and just
 * counts the rest. Farol flagged the uncapped list (2026-09-13): with voice
 * on and `hosts_only`/`everyone`, every viewer can raise a hand, and a real
 * audience could put hundreds of avatar rows into one dialog on every open.
 */
const MAX_VISIBLE_HANDS = 20;

/**
 * Splits a raised-hand queue at `MAX_VISIBLE_HANDS`: the rows the dialog
 * actually draws, and how many more are waiting than that. The queue already
 * arrives in the server's own raise order (`docs/RAISED_HANDS.md`), so the
 * visible slice is the people waiting longest — exactly who a host should
 * see first — and not an arbitrary cut. Exported (pure, no Dialog/portal
 * involved) so the cap has a test that does not need a DOM.
 */
export function visibleRaisedHands(
  hands: WatchParty["stage"]["hands"],
): { visible: WatchParty["stage"]["hands"]; hiddenCount: number } {
  return {
    visible: hands.slice(0, MAX_VISIBLE_HANDS),
    hiddenCount: Math.max(0, hands.length - MAX_VISIBLE_HANDS),
  };
}

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
}: {
  props: WatchPartyPanelProps;
  party: WatchParty;
  open: boolean;
  onClose: () => void;
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
          isHost={party.viewerRole === "host"}
          lowLatencyAvailable={props.lowLatencyAvailable}
          live={party.state === "live"}
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
        {/* Mount point only — the control itself lives in its own component
            so it survives PR 538's rewrite of this file. */}
        {props.onVoiceTrackModeChange && props.voiceTrackAvailable && (
          <VoiceTrackModeToggle
            mode={props.voiceTrackMode ?? "junto"}
            onChange={props.onVoiceTrackModeChange}
          />
        )}
        {/* Mid-show, and it is the same control the setup surface had. A
            co-host promoted here is granted SPEAK on the spot by the server
            when the party's floor is closed, so somebody brought in to help
            can actually talk to the room. */}
        {cohostSection(props, party, "border-t border-border pt-4")}
        {/* THE QUEUE LEFT THIS DIALOG (pass 4 of `docs/plans/WATCH_PARTY_UI.md`):
            "Pedindo pra falar" and "No palco" are drawn once, in the Pessoas
            tab of the side panel, beside the guests system's own lists. */}
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

// -------------------------------------------------------- the go-live checklist

/**
 * The two live globals `goLiveChecklist` needs, read defensively: a Node
 * test's `navigator` has a UA that names no browser at all and no
 * `window.pqpDesktop`, which reads as an ordinary Chrome tab here — the same
 * "all clear" a real one gets.
 */
function currentUserAgent(): string {
  return typeof navigator === "undefined" ? "" : navigator.userAgent;
}

/** One line of copy per row, chosen by id and tone. */
const CHECKLIST_COPY: Record<ChecklistItem["id"], Partial<Record<ChecklistTone, MessageKey>>> = {
  browser: {
    ok: "watchParty.checklist.browserOk",
    hint: "watchParty.checklist.browserHintDesktop",
    block: "watchParty.checklist.browserBlockFirefox",
  },
  tabAudio: {
    ok: "watchParty.checklist.tabAudioOk",
    hint: "watchParty.checklist.tabAudioHint",
  },
  quality: {
    ok: "watchParty.checklist.qualityOk",
    hint: "watchParty.checklist.qualityHint",
  },
  camera: {
    ok: "watchParty.checklist.cameraOk",
    hint: "watchParty.checklist.cameraHint",
  },
  mic: {
    ok: "watchParty.checklist.micOk",
    hint: "watchParty.checklist.micHint",
  },
};

function checklistCopyKey(item: ChecklistItem): MessageKey {
  return CHECKLIST_COPY[item.id][item.tone] ?? "watchParty.checklist.browserOk";
}

/**
 * The go-live checklist itself: everything from postmortem B3, said before
 * a share goes out rather than diagnosed after the room is confused. Shown
 * in the setup surface and beside "Compartilhar tela" — the two moments a
 * host is about to publish a capture with no way yet to see what went wrong.
 *
 * NON-BLOCKING EXCEPT ONE ROW. Every hint here is exactly that; only Firefox
 * (`blocksGoLive`) gets the harder red line, spelled out again on its own so
 * a host who skimmed the list still sees why the button below it is
 * disabled.
 */
const CHECKLIST_TITLE: Record<ChecklistItemId, MessageKey> = {
  browser: "watchParty.checklist.browserTitle",
  tabAudio: "watchParty.checklist.tabAudioTitle",
  quality: "watchParty.checklist.qualityTitle",
  camera: "watchParty.checklist.cameraTitle",
  mic: "watchParty.checklist.micTitle",
};
const CHECKLIST_BODY: Record<ChecklistItemId, MessageKey> = {
  browser: "watchParty.checklist.browserBody",
  tabAudio: "watchParty.checklist.tabAudioBody",
  quality: "watchParty.checklist.qualityBody",
  camera: "watchParty.checklist.cameraBody",
  mic: "watchParty.checklist.micBody",
};
const CHECKLIST_SHORT: Record<ChecklistItemId, MessageKey> = {
  browser: "watchParty.checklist.short.browser",
  tabAudio: "watchParty.checklist.short.tabAudio",
  quality: "watchParty.checklist.short.quality",
  camera: "watchParty.checklist.short.camera",
  mic: "watchParty.checklist.short.mic",
};

function GoLiveChecklist({
  items,
  className,
  compact = false,
}: {
  items: readonly ChecklistItem[];
  className?: string;
  /**
   * THE STATUS BLOCK (2026-09-13). Inside the setup card the list is not a
   * list: a blocker is one banner with a title and the way out, each hint is
   * a card with a title and its fix, and every check that passed collapses
   * into a single quiet line. The old shape said the Firefox sentence three
   * times (a row, a line under the list, the state bar) and made a passing
   * check look as loud as a failing one. Off, the plain list the live
   * surface's empty stage still draws.
   */
  compact?: boolean;
}) {
  const { t } = useTranslation();
  const allClear = items.every((item) => item.tone === "ok");
  if (compact) {
    const blocks = items.filter((item) => item.tone === "block");
    const hints = items.filter((item) => item.tone === "hint");
    const oks = items.filter((item) => item.tone === "ok");
    return (
      <div
        data-testid="watch-party-go-live-checklist"
        data-watch-party-checklist={allClear ? "clear" : "attention"}
        className={cn("flex flex-col gap-2", className)}
      >
        {blocks.map((item) => (
          <div
            key={item.id}
            className="flex items-start gap-2 rounded-md border border-danger/40 bg-danger/10 px-2.5 py-2 text-xs text-danger"
            data-watch-party-checklist-item={item.id}
            data-testid="watch-party-checklist-blocked"
          >
            <TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
            <span className="min-w-0">
              <span className="block font-semibold">{t(CHECKLIST_TITLE[item.id])}</span>
              <span className="block text-danger/90">{t(CHECKLIST_BODY[item.id])}</span>
            </span>
          </div>
        ))}
        {hints.map((item) => (
          <div
            key={item.id}
            className="flex items-start gap-2 rounded-md border border-warning/30 bg-warning/10 px-2.5 py-2 text-xs text-warning"
            data-watch-party-checklist-item={item.id}
          >
            <TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
            <span className="min-w-0">
              <span className="block font-semibold">{t(CHECKLIST_TITLE[item.id])}</span>
              <span className="block text-paper-muted">{t(CHECKLIST_BODY[item.id])}</span>
            </span>
          </div>
        ))}
        {oks.length > 0 && (
          <p
            className={cn(
              "flex items-start gap-1.5 text-xs",
              allClear ? "text-success" : "text-text-tertiary",
            )}
            data-watch-party-checklist-ok
          >
            <Check className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
            <span>
              {allClear
                ? t("watchParty.checklist.allClear")
                : t("watchParty.checklist.okPrefix")}{" "}
              {oks.map((item, index) => (
                <span key={item.id}>
                  {index > 0 && ", "}
                  <span
                    className="text-text-tertiary"
                    data-watch-party-checklist-item={item.id}
                  >
                    {t(CHECKLIST_SHORT[item.id])}
                  </span>
                </span>
              ))}
              .
            </span>
          </p>
        )}
        <p className="text-[11px] text-text-tertiary">
          {t("watchParty.checklist.filmPlaying")}
        </p>
      </div>
    );
  }
  return (
    <div
      data-testid="watch-party-go-live-checklist"
      data-watch-party-checklist={allClear ? "clear" : "attention"}
      className={cn(
        "flex flex-col gap-1.5 rounded-lg border border-border bg-surface-0 px-2.5 py-2",
        className,
      )}
    >
      <p className="text-[11px] font-semibold uppercase tracking-wider text-text-tertiary">
        {t("watchParty.checklist.title")}
      </p>
      <ul className="flex flex-col gap-1 text-xs">
        {items.map((item) => (
          <ChecklistRow
            key={item.id}
            tone={item.tone}
            data-watch-party-checklist-item={item.id}
          >
            {t(checklistCopyKey(item))}
          </ChecklistRow>
        ))}
        <ChecklistRow tone="ok">
          {t("watchParty.checklist.filmPlaying")}
        </ChecklistRow>
      </ul>
      {blocksGoLive(items) && (
        <p
          data-testid="watch-party-checklist-blocked"
          className="flex items-start gap-1.5 text-xs text-danger"
        >
          <TriangleAlert className="mt-0.5 h-3 w-3 shrink-0" aria-hidden />
          {t("watchParty.checklist.blockedFirefox")}
        </p>
      )}
    </div>
  );
}

function ChecklistRow({
  tone,
  children,
  ...rest
}: {
  tone: ChecklistTone;
  children: ReactNode;
} & Record<`data-${string}`, string>) {
  return (
    <li
      className={cn(
        "flex items-start gap-1.5",
        tone === "block"
          ? "text-danger"
          : tone === "hint"
            ? "text-warning"
            : "text-text-tertiary",
      )}
      {...rest}
    >
      {tone === "ok" ? (
        <Check className="mt-0.5 h-3 w-3 shrink-0" aria-hidden />
      ) : (
        <TriangleAlert className="mt-0.5 h-3 w-3 shrink-0" aria-hidden />
      )}
      <span>{children}</span>
    </li>
  );
}

/** One numbered row of the setup card: a small circled number, a label, the control. */
function SetupStep({
  number,
  label,
  done = false,
  children,
}: {
  number: number;
  label: string;
  done?: boolean;
  children: ReactNode;
}) {
  return (
    <section className="flex flex-col gap-1.5" data-watch-party-step={number}>
      <h3 className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-wider text-text-tertiary">
        <span
          className={cn(
            "flex h-4 w-4 items-center justify-center rounded-full text-[10px]",
            done ? "bg-success text-ink" : "bg-surface-1 text-paper-muted",
          )}
          aria-hidden
        >
          {done ? <Check className="h-2.5 w-2.5" /> : number}
        </span>
        {label}
      </h3>
      {children}
    </section>
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
  const [scheduling, setScheduling] = useState(false);
  // Distinct from `scheduling` above, which is only the toggle: "does this
  // draft have a time at all". This is the in-flight state of one Salvar
  // press (Farol, 2026-09-14): the button used to fire `onSchedule` with
  // `void` and never look at it again, so a rejection was invisible and a
  // second click before the first response landed could race it. Guarded in
  // `saveSchedule` below, which is the only caller.
  const [savingWhen, setSavingWhen] = useState(false);
  const [whenSaveError, setWhenSaveError] = useState<string | null>(null);
  // The quality select sits in the card now, so the checklist's quality row
  // follows it live instead of reading storage once at mount (same fix the
  // live surface needed on 2026-09-13).
  const [quality, setQuality] = useState<WatchPartyStreamQuality>(() =>
    readWatchPartyStreamQuality(props.currentUserId ?? null),
  );
  const [whenValue, setWhenValue] = useState("");
  const thumbRef = useRef<HTMLVideoElement>(null);
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
  // WHAT TO DO ABOUT IT DEPENDS ON WHERE THEY ARE. "Tick share tab audio" is
  // the answer in a browser and nonsense in the desktop app, which has no tabs
  // to tick anything on: there the answer is the picker's own sound box, and on
  // a shell that cannot carry sound at all (macOS: no loopback device in
  // Chromium) the honest answer is to host from Chrome instead.
  //
  // "The picker's own sound box" only exists on a shell new enough to draw it
  // (`sharePickerOffersAudio`) AND able to strip this app's own call out of
  // the tap (`offersShellSystemAudio`). An older Windows build can carry
  // loopback and still have neither: its picker has no checkbox at all, this
  // surface never offers the page-owned `shareSystemAudio` prompt that could
  // stand in for one, so "desktop" would point the presenter at a box that is
  // not there. That build gets the same honest answer as macOS.
  const captureEnv = liveScreenCaptureEnvironment();
  const silentPickHint = !isDesktopApp()
    ? undefined
    : offersShellSystemAudio(captureEnv) && captureEnv.sharePickerOffersAudio
      ? { context: "desktop" }
      : { context: "desktopSilent" };
  const hasAudioTrack =
    stream === null ? null : stream.getAudioTracks().length > 0;
  const checklistItems = useMemo(
    () =>
      goLiveChecklist({
        isFirefox: isFirefoxUserAgent(currentUserAgent()),
        isDesktopShell: isDesktopApp(),
        desktopSharesTabAudio: desktopSharesTabAudio(getDesktop()),
        hasAudioTrack,
        quality,
        cameraOn: props.cameraOn ?? false,
        micMuted: micIsInaudible(props.micState),
      }),
    [hasAudioTrack, quality, props.cameraOn, props.micState],
  );
  // FIREFOX IS THE ONE ROW THAT BLOCKS. Everything else on this list is a
  // hint a host may ignore; there is no signal-safe watch party on Firefox
  // at all (no `restrictOwnAudio`, no `preferCurrentTab`), so `onGoLive` must
  // not run there even with a picture already picked.
  const checklistBlocked = blocksGoLive(checklistItems);

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
    // The Fonte row's thumbnail is the same stream on a second element, so
    // step 2 reads as done without looking left. Two sinks on one track is
    // free; the capture is not duplicated.
    const thumb = thumbRef.current;
    if (thumb && thumb.srcObject !== stream) {
      thumb.srcObject = stream;
    }
  }, [stream]);

  const pick = async () => {
    setPickError(null);
    try {
      // Same builder every ordinary share uses. `preferBrowserTab` is the
      // watch-party product: the player tab and its sound, never the machine
      // mixer that contains the call. See `lib/screen-capture-audio.ts`.
      // `liveScreenCaptureEnvironment`, not a hand-rolled one. This call site
      // used to build its own and leave out the shell's picker flag, so a
      // Windows desktop host was asked for a capture with no audio at all while
      // the shell's own picker stood ready to offer the box. One reader now.
      const options = screenCaptureOptions(
        false,
        liveScreenCaptureEnvironment(),
        { preferBrowserTab: true, maxFrameRate: props.hlsMaxFrameRate },
      );
      const picked = await navigator.mediaDevices.getDisplayMedia(options);
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
      await props.onGoLive(handing, party.options.lowLatency);
    } finally {
      setBusy(false);
    }
  };

  /**
   * Salvar on the Quando row. `savingWhen` guards a double click and a
   * change-then-save-again before the first response lands from sending a
   * second, possibly out-of-order, PATCH; `whenSaveError` is what a rejected
   * one now has to say, instead of the card quietly staying a draft with
   * nothing on screen to explain it.
   */
  const saveSchedule = async () => {
    if (savingWhen) {
      return;
    }
    setSavingWhen(true);
    setWhenSaveError(null);
    try {
      await props.onSchedule?.(new Date(whenValue).toISOString());
    } catch (error) {
      setWhenSaveError(
        error instanceof Error ? error.message : t("watchParty.setup.whenSaveError"),
      );
    } finally {
      setSavingWhen(false);
    }
  };

  /**
   * TWO COLUMNS, ONE STEPPER, ONE BUTTON (2026-09-13). The setup surface
   * used to be a black pane with a grey button in the middle, a name pill
   * floating top-right, a settings string that read like a log line, a
   * checklist card and a state bar: five blocks in five visual languages
   * and no "what do I do first". Meet's green room and Discord's Go Live
   * agree on the shape: the preview on one side reflecting state, a card
   * on the other that reads top to bottom (name, source, settings) and
   * ends in the one button. Everything below reuses what already existed
   * (the picker, the options dialog, the checklist rules, the link
   * button); only the arrangement is new.
   *
   * `watch-party-not-live` is still the LAST thing in the card and never
   * scrolls away (the co-host list and the checklist scroll above it), and
   * it still leads with the state in words: that is the production
   * incident this bar exists for, unchanged.
   */
  const sourceState: "none" | "silent" | "ok" = !stream
    ? "none"
    : silentPick
      ? "silent"
      : "ok";
  const goLiveReason = checklistBlocked
    ? t("watchParty.checklist.blockedShort")
    : stream
      ? null
      : canPutPictureUp
        ? t("watchParty.setup.pickFirst")
        : t("watchParty.setup.phoneHint");

  return (
    <div
      data-testid="watch-party-setup"
      className={cn(
        "relative flex flex-col overflow-hidden border-b border-ink-4/60 bg-ink",
        surfaceHeight(props.fill, "h-[68svh] min-h-[320px]"),
      )}
    >
      <div className="flex min-h-0 flex-1 flex-col md:flex-row">
        {/* THE PREVIEW, OR THE PICKER IN ITS PLACE. Before a pick there is
            nothing to preview, so the pane is not left black with a small
            button in it: the picker itself is the content, with the one
            sentence that prevents the silent-film incident (tab, with tab
            audio ticked). After the pick, the real capture. 160px floor for
            the reason `MIN_STAGE_HEIGHT_PX` gives in `lib/call-split.ts`. */}
        <div className="relative min-h-[160px] min-w-0 flex-1 bg-black">
          {stream ? (
            <>
              <video
                ref={videoRef}
                autoPlay
                muted
                playsInline
                className="h-full w-full object-contain"
                data-testid="watch-party-preview"
              />
              <span className="pointer-events-none absolute left-3 top-3 rounded-full bg-ink/70 px-2 py-0.5 text-[11px] text-paper-muted">
                {t("watchParty.setup.heading")}
              </span>
              {silentPick && (
                <p
                  data-testid="watch-party-no-audio"
                  className="pointer-events-none absolute bottom-3 left-3 right-3 rounded-md border border-warning/40 bg-surface-0/90 px-2.5 py-1.5 text-xs text-warning"
                >
                  {t("watchParty.setup.noAudio", silentPickHint)}
                </p>
              )}
            </>
          ) : (
            <div className="flex h-full w-full flex-col items-center justify-center gap-3 px-6 text-center">
              <span className="flex h-14 w-14 items-center justify-center rounded-2xl bg-surface-1">
                <MonitorPlay className="h-7 w-7 text-paper-muted" aria-hidden />
              </span>
              {canPutPictureUp ? (
                <>
                  <p className="text-base font-semibold text-paper">
                    {t("watchParty.setup.pickTitle")}
                  </p>
                  <p className="max-w-sm text-sm text-paper-muted">
                    {t("watchParty.setup.pickBody")}
                  </p>
                  <Button
                    type="button"
                    size="default"
                    onClick={() => void pick()}
                    data-watch-party-pick
                  >
                    <MonitorPlay className="mr-1.5 h-4 w-4" aria-hidden />
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
        </div>

        {/* THE SETUP CARD. Reads top to bottom: name, source, settings, the
            checklist's hints, then the button. On a narrow stage it stacks
            under the preview. */}
        <aside
          data-testid="watch-party-setup-card"
          // MIN-H-0 + FLEX-1 ON THE STACKED LAYOUT (Farol, 2026-09-14). This
          // was `shrink-0` at every width, which is right for the `md:` row
          // (a fixed 320px column beside the preview) and wrong for the
          // stacked phone column: `shrink-0` there means "take my full
          // content height, whatever that is", so the inner `overflow-y-auto`
          // never became a scroll boundary and the OUTER pane's
          // `overflow-hidden` silently clipped whatever did not fit —
          // including, on a long options list, the Ir ao vivo button itself.
          // `md:flex-none` restores the untouched desktop sizing.
          className="flex w-full min-h-0 flex-1 flex-col border-t border-ink-4/60 bg-ink-2 md:w-80 md:flex-none md:border-l md:border-t-0"
        >
          <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-3">
            <SetupStep number={1} label={t("watchParty.setup.stepNameWhen")}>
              <input
                type="text"
                maxLength={120}
                aria-label={t("watchParty.setup.nameLabel")}
                className="w-full rounded-md border border-ink-4/60 bg-surface-0 px-2.5 py-1.5 text-sm font-semibold text-paper focus:border-ink-4 focus:outline-none"
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
              {/* QUANDO. The create dialog could set a time and nothing after
                  it could; the update API always accepted one. "Agora" is the
                  draft; a time hands this surface over to the scheduled
                  screen (the server does the state move), where the time can
                  be taken back. */}
              {props.onSchedule && (
                <div
                  data-testid="watch-party-when"
                  className="flex flex-col gap-1.5 rounded-md border border-ink-4/60 bg-surface-0 px-2.5 py-1.5"
                >
                  <div className="flex items-center justify-between gap-2 text-xs">
                    <span className="flex min-w-0 items-center gap-1.5 text-paper">
                      <CalendarClock className="h-3.5 w-3.5 shrink-0 text-paper-muted" aria-hidden />
                      <span className="truncate">
                        {scheduling
                          ? t("watchParty.setup.whenSet")
                          : t("watchParty.setup.whenNow")}
                      </span>
                    </span>
                    <span data-watch-party-when-toggle className="shrink-0">
                    <Switch
                      label={t("watchParty.setup.whenSet")}
                      hideLabel
                      checked={scheduling}
                      onCheckedChange={(on) => {
                        setScheduling(on);
                        if (on && whenValue === "") {
                          const soon = new Date(Date.now() + 60 * 60 * 1000);
                          soon.setMinutes(0, 0, 0);
                          setWhenValue(toLocalInputValue(soon));
                        }
                      }}
                      className="w-auto px-0 py-0 hover:bg-transparent"
                    />
                    </span>
                  </div>
                  {scheduling && (
                    <div className="flex flex-wrap items-center gap-2">
                      <Input
                        type="datetime-local"
                        aria-label={t("watchParty.setup.when")}
                        className="h-[var(--control-sm)] w-auto bg-surface-2 text-xs"
                        value={whenValue}
                        min={toLocalInputValue(new Date())}
                        onChange={(event) => {
                          setWhenValue(event.target.value);
                          setWhenSaveError(null);
                        }}
                        data-watch-party-when-input
                      />
                      <Button
                        type="button"
                        size="sm"
                        variant="secondary"
                        disabled={
                          savingWhen ||
                          whenValue === "" ||
                          Number.isNaN(Date.parse(whenValue))
                        }
                        onClick={() => void saveSchedule()}
                        data-watch-party-when-save
                      >
                        {savingWhen
                          ? t("watchParty.setup.whenSaving")
                          : t("watchParty.setup.whenSave")}
                      </Button>
                      <span className="text-[11px] text-text-tertiary">
                        {browserTimezone()}
                      </span>
                    </div>
                  )}
                  {whenSaveError && (
                    <p data-watch-party-when-error className="text-xs text-danger">
                      {whenSaveError}
                    </p>
                  )}
                </div>
              )}
            </SetupStep>

            <SetupStep
              number={2}
              label={t("watchParty.setup.stepSource")}
              done={sourceState === "ok"}
            >
              <div
                data-testid="watch-party-source"
                data-watch-party-source={sourceState}
                className="flex items-center justify-between gap-2 rounded-md border border-ink-4/60 bg-surface-0 px-2.5 py-1.5 text-xs"
              >
                {stream && (
                  <video
                    ref={thumbRef}
                    autoPlay
                    muted
                    playsInline
                    aria-hidden
                    className="h-7 w-12 shrink-0 rounded-sm bg-black object-cover"
                    data-testid="watch-party-source-thumb"
                  />
                )}
                <span
                  className={cn(
                    "min-w-0 flex-1 truncate",
                    sourceState === "ok" && "text-paper",
                    sourceState === "silent" && "text-warning",
                    sourceState === "none" && "text-paper-muted",
                  )}
                >
                  {sourceState === "ok"
                    ? t("watchParty.setup.sourceOk")
                    : sourceState === "silent"
                      ? t("watchParty.setup.sourceSilent")
                      : t("watchParty.setup.noSource")}
                </span>
                {canPutPictureUp && (
                  <Button
                    type="button"
                    variant={stream ? "ghost" : "secondary"}
                    size="sm"
                    onClick={() => void pick()}
                    data-watch-party-repick={stream ? "" : undefined}
                  >
                    {stream
                      ? t("watchParty.setup.repick")
                      : t("watchParty.setup.pickShort")}
                  </Button>
                )}
              </div>
            </SetupStep>

            {/* THE SETTINGS, INLINE (2026-09-13). The rows used to be doors
                to the options dialog, every one of them to the same dialog,
                which made the chevrons a promise nothing kept. The dialog's
                own form (`WatchPartyOptionsPanel`) renders here instead:
                same selects, same switches, same handlers, one place to
                change them. The dialog stays for the live stage, where the
                picture must not move. */}
            <SetupStep number={3} label={t("watchParty.setup.stepSettings")}>
              <div
                data-testid="watch-party-options-summary"
                className="flex flex-col gap-2"
              >
                <WatchPartyOptionsPanel
                  options={party.options}
                  audienceCount={props.audienceCount}
                  onChange={(patch) => void props.onOptionsChange(patch)}
                  stacked
                  isHost={party.viewerRole === "host"}
                  lowLatencyAvailable={props.lowLatencyAvailable}
                  live={party.state === "live"}
                />
                {(props.onMicInStreamChange || canPutPictureUp) && (
                  <OptionGroup title={t("watchParty.options.streamTitle")}>
                    {props.onMicInStreamChange && (
                      <div className="px-1 py-0.5" data-watch-party-mic-in-stream>
                        <Switch
                          label={t("watchParty.options.micInStream")}
                          description={t("watchParty.options.micInStreamBody")}
                          checked={props.micInStream !== false}
                          onCheckedChange={(on) => props.onMicInStreamChange?.(on)}
                        />
                      </div>
                    )}
                    {canPutPictureUp && (
                      <StreamQualityControl
                        userId={props.currentUserId ?? null}
                        onQualityChange={setQuality}
                        stacked
                      />
                    )}
                  </OptionGroup>
                )}
              </div>
              {cohostSection(props, party, "pt-1")}
            </SetupStep>

            {/* THE GO-LIVE CHECKLIST (postmortem B3), now inside the card and
                without its own box: the rows that pass are quiet ticks, the
                rows that do not are the amber lines a host should read. */}
            {canPutPictureUp && <GoLiveChecklist items={checklistItems} compact />}
          </div>

          {/* A STATE BAR, NOT A FOOTER. Leads with whose eyes are on this and
              what to do about it; the button that changes the state is under
              that sentence. Always last, never scrolls. */}
          <div
            data-testid="watch-party-not-live"
            className="flex shrink-0 flex-col gap-2 border-t border-ink-4/60 bg-ink-2 p-3"
          >
            <p className="flex min-w-0 items-start gap-2 text-xs">
              <span className="mt-1 h-2 w-2 shrink-0 rounded-full bg-warning" />
              <span className="min-w-0">
                <span className="font-semibold text-warning">
                  {t("watchParty.setup.heading")}
                </span>{" "}
                <span className="text-text-tertiary">
                  {goLiveReason ?? t("watchParty.setup.goLiveHint")}
                </span>
              </span>
            </p>
            {canPutPictureUp && (
              <Button
                type="button"
                size="default"
                disabled={busy || !stream || checklistBlocked}
                title={
                  checklistBlocked
                    ? t("watchParty.checklist.blockedFirefox")
                    : (goLiveReason ?? undefined)
                }
                onClick={() => void goLive()}
                data-watch-party-go-live
                className="w-full bg-danger text-paper hover:bg-danger/85"
              >
                <Radio className="mr-1.5 h-4 w-4" aria-hidden />
                {t("watchParty.setup.goLive")}
              </Button>
            )}
            <div className="flex items-center justify-between gap-2">
              <WatchPartyShareButton party={party} />
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => setConfirmDiscard(true)}
                data-watch-party-discard
              >
                <Undo2 className="mr-1.5 h-3.5 w-3.5" aria-hidden />
                {t("watchParty.setup.discard")}
              </Button>
            </div>
          </div>
        </aside>
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
              onClick={() => void props.onGoLive(null, party.options.lowLatency)}
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
 * THE DOCK'S MIC LEVEL, ON ITS OWN (Farol, 2026-09-14). This used to be a
 * `useState` inside `LiveSurface` itself, polled at 10 Hz for as long as a
 * host was presenting: every reading re-rendered the whole presenter tree —
 * bar, dock, transmission panel, every open dialog — for one small bar that
 * changes on its own and nothing else on screen needs to know about. Same
 * fix `StreamMixControl`'s meters already use, one level down: the polling
 * interval and the state it drives live in their own leaf, so the 10 Hz
 * timer only ever re-renders this.
 */
function DockMicLevel({ micLevelDb }: { micLevelDb: () => number | null }) {
  const [micLevel, setMicLevel] = useState<number | null>(null);
  useEffect(() => {
    const interval = setInterval(() => setMicLevel(micLevelDb()), 100);
    return () => clearInterval(interval);
  }, [micLevelDb]);
  return micLevel !== null ? (
    <MicLevelMeterBar db={micLevel} testId="watch-party-dock-mic-level" />
  ) : null;
}

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
  const [mixerOpen, setMixerOpen] = useState(false);
  // Host and co-hosts only, client-side, REGARDLESS of what the shared role
  // table still allows a manager to do. An admin/manager watching a live
  // party is not running it and must never be shown a button that ends
  // someone else's show — that is exactly the incident this gate exists for
  // (a server admin clicked Encerrar on a party they were only watching).
  // `canPerformWatchPartyAction` is left untouched here on purpose: this is
  // the client-only half of the fix, so it still returns true for a manager
  // until the shared table itself is changed (a separate, server-restarting
  // PR). The `&&` below is what actually hides the control for a manager
  // today, ahead of that change landing.
  const isHostOrCohost =
    party.viewerRole === "host" || party.viewerRole === "cohost";
  const canEnd =
    canPerformWatchPartyAction({
      action: "end",
      role: party.viewerRole,
      state: party.state,
    }) && isHostOrCohost;
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

  // THE GO-LIVE CHECKLIST, reused from the setup surface for "Compartilhar
  // tela" (postmortem B3): the same four rows, minus tab audio, which this
  // surface has no picked capture to read yet — `onShareScreen` opens its
  // own picker inside `use-voice.ts`, invisible from here.
  //
  // QUALITY IS STATE HERE, NOT A DIRECT READ, because `StreamQualityControl`
  // (`watch-party-transmission.tsx`) keeps its own and is the only thing
  // that ever changes it: reading `localStorage` once at mount, the way the
  // memo below used to, left this row on whatever quality was picked before
  // the panel last mounted, showing "720p, ok" through a live switch to
  // 1080p (Farol, 2026-09-13). `onStreamQualityChange` is how
  // `WatchPartyTransmission` says the choice moved.
  const [liveQuality, setLiveQuality] = useState<WatchPartyStreamQuality>(
    () => readWatchPartyStreamQuality(props.currentUserId ?? null),
  );
  // RE-READ ON A USER CHANGE, not just at mount. The lazy initializer above
  // only ever runs once; on a shared machine where `pqp:dev-user-suffix`
  // (or a real sign-out/sign-in) swaps `currentUserId` while this panel
  // stays mounted, `liveQuality` would otherwise keep showing whichever
  // account's preference happened to be in state when the FIRST account
  // was live, checklist and all (Farol, 2026-09-13). `writeWatchPartyStreamQuality`
  // already scopes the storage key by user, so the fix is reading it again
  // whenever the id this reads for actually changes.
  useEffect(() => {
    setLiveQuality(readWatchPartyStreamQuality(props.currentUserId ?? null));
  }, [props.currentUserId]);
  const liveChecklistItems = useMemo(
    () =>
      goLiveChecklist({
        isFirefox: isFirefoxUserAgent(currentUserAgent()),
        isDesktopShell: isDesktopApp(),
        desktopSharesTabAudio: desktopSharesTabAudio(getDesktop()),
        hasAudioTrack: null,
        quality: liveQuality,
        cameraOn: props.cameraOn ?? false,
        micMuted: micIsInaudible(props.micState),
      }),
    [liveQuality, props.cameraOn, props.micState],
  );

  // "SEU MIC ESTÁ MUDO: NINGUÉM TE OUVE, NEM NA TRANSMISSÃO" (2026-09-13). A
  // recording lost the host's voice for an hour because her mic stayed
  // muted through the whole show and the only hint anywhere was the small
  // pill in the bar. `presenterMicWarning` is the one rule behind this
  // banner, the B2 silence paragraph and the checklist's `mic` row above —
  // fed the same two facts everywhere so they cannot disagree.
  const micMutedWarning =
    presenterMicWarning(props.isPresenting, micIsInaudible(props.micState)) ===
    "warn";

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
   * `stage.invited` is public on the wire (`presentStage`: who is UP is
   * public, who is ASKING is not), so an invited guest recognises themselves
   * without a second request and without the client guessing.
   */
  const isInvited =
    props.currentUserId !== undefined &&
    party.stage.invited.some(
      (person) => person.userId === props.currentUserId,
    );
  /**
   * Whether a seat in this room is this person's to take at all.
   *
   * THE SAME FUNCTION THE SERVER REFUSES THE JOIN WITH. This used to be a
   * hand-rolled `runsTheShow || invited` here and a separate rule in
   * `join-voice-room`, which is two answers to one question and exactly how a
   * button that does nothing gets shipped. `mayTakeWatchPartySeat` is now the
   * only place the rule is written, so a control drawn here is one the server
   * will honour and a control withheld is a join it would refuse.
   */
  const mayTakeASeat = mayTakeWatchPartySeat({
    canStartWatchParty: props.canStart,
    party: {
      voiceEnabled: party.options.voiceEnabled,
      isHost: party.viewerRole === "host",
      isCohost: party.viewerRole === "cohost",
      isInvited,
    },
  });
  /**
   * THE AUDIENCE NEVER JOINS A CALL (2026-09-13). `mayTakeASeat` above is
   * what the SERVER honours, and it is deliberately generous: with voice on
   * it is true for every viewer, because `join-voice-room` must not refuse a
   * seat the host's own Voz switch promised. That is the right rule for the
   * DOOR. It is the wrong rule for this BUTTON: drawing it for every viewer
   * the moment voice is on is exactly the "Entrar na call" Rafael's 2026-09-13
   * decision retires — the audience is the transmission, not a lobby, and
   * nobody watching presses a button labelled like a phone call.
   *
   * So the bar earns its own, narrower question: a seat here is offered only
   * to the people already trusted with the room — the host, a co-host,
   * anyone who may start a party on this channel at all, and anyone the host
   * has already invited up. Everybody else gets `showRequestToSpeak` below
   * instead, and only ever that.
   *
   * THE HOST/CO-HOST HALF STAYS GATED ON VOICE, exactly as it always was: "A
   * WATCH PARTY IS NOT A LOBBY" below is the reason, unchanged by this
   * decision. With voice off the host is seated by going live or sharing,
   * never by this button; a co-host takes over with Assumir the same way.
   * `canStart` and an invited guest are NOT gated on it, also unchanged:
   * they run parties here, or were brought up, whether or not this show has
   * voice.
   *
   * `canStart` IS SCOPED TO EVERYBODY ELSE (2026-09-13 fix). The party's own
   * host and co-hosts almost always also hold START_WATCH_PARTY — they are
   * usually who started it — so an unscoped `|| props.canStart` reopened the
   * exact door the line above just gated: a host with voice off got the
   * button back through the permission check instead of the role check. The
   * `canStart` branch exists for somebody who is trusted with the room but
   * is not currently running this show; the current host/cohost's own path
   * is the branch above, and only that one.
   */
  const mayEnterPalco =
    (runsTheShow && party.options.voiceEnabled) ||
    (!runsTheShow && props.canStart) ||
    isInvited;
  const showEnterPalco =
    !props.inCall && mayEnterPalco && mayTakeASeat;
  /**
   * "Pedir para falar", never "Entrar na call". A plain viewer with voice on
   * has nothing to press until the host brings them up — reusing the same
   * raise/lower hand request `docs/RAISED_HANDS.md` already has, regardless
   * of which stage mode is configured, because the request itself is
   * harmless (it only ever sets `handRaised`) and the alternative is a
   * viewer offered no way to ask at all outside `invited` mode. The host's
   * queue in the options dialog is widened to match, below. Still gated on
   * `raiseHand`: a host who explicitly turned the ask-to-speak queue off
   * gets exactly that, an audience with nothing to press.
   */
  const showRequestToSpeak =
    !props.inCall &&
    !mayEnterPalco &&
    party.options.voiceEnabled &&
    party.options.raiseHand;

  /**
   * TWO BARS, NOT ONE BAR WITH TWELVE CONDITIONS (2026-09-13). Moonkase's
   * party came back with "separate the streamer UI from the spectator UI",
   * and the reason is visible in this file's history: every control here
   * was gated by a different combination of `runsTheShow`, `inCall`,
   * `isPresenting`, `canStart` and `isInvited`, so what a plain viewer saw
   * was whatever fell through. `presenterBar` below is for the host and
   * co-hosts: sharing, the mic pill, the audio mixer, Opções, Encerrar.
   * `audienceBar` is for everybody else and knows only four things: what is
   * live, how many are watching, the link, and, when the host allows it,
   * a way to ask for the microphone. Both share `data-testid="watch-party-bar"`
   * because the split machinery and the tests address "the bar" and do not
   * care which person is behind it.
   */
  const barClassName =
    /* WRAPS, BECAUSE THE COLUMN IS NOT ALWAYS THE WINDOW. Side by side gives
       the stage roughly 62% of the pane, and on a laptop that is narrow
       enough that the identity, the viewer count and three buttons do not
       fit on one line: the first version clipped "Encerrar" against the
       divider, which is the one control a host must always be able to
       reach. The actions drop to a second row instead of overflowing, and
       the identity keeps `min-w-0` so the party's name truncates rather
       than pushing them off. */
    /* AND IT IS THE HEADER NOW (2026-09-18, pass 1 of
       `docs/plans/WATCH_PARTY_UI.md`): same minimum height, same ground
       and same gutters as the channel header it replaces, so the row does
       not read as a second header under an empty one. */
    "flex min-h-14 shrink-0 flex-wrap items-center gap-x-3 gap-y-1.5 border-b border-ink-4/60 bg-ink px-3 py-2 sm:px-4";

  const identity = (
    /* A REAL MINIMUM, so the wrap happens instead of the name vanishing.
       Without it the identity is just `flex-1` and shrinks to nothing in a
       side-by-side column: the party's name truncated away entirely and the
       bar showed a live pill over "com Dev U...", which is the block's one
       job (say WHAT is live) failing in the narrow layout. At this minimum
       the actions wrap to their own row and the name keeps its line. */
    <PartyIdentity
      party={party}
      compact
      className="min-w-[12rem]"
      meta={t("watchParty.live.viewers", { count: props.audienceCount })}
      onRename={props.onRename}
      recovering={props.isPresenting && props.sharePublishRecovering === true}
    />
  );

  /* WHETHER YOUR MICROPHONE IS OPEN, in words, on the bar. A host live
     in front of a room asked exactly that and nothing here answered:
     the only hint was the mute icon at the bottom of the sidebar. And
     the answer has a second half people get wrong, so it is stated:
     the room can hear an open mic, the audience outside never can.
     Drawn for the people running the show and for a seated guest; a
     viewer with no seat has no microphone to describe. */
  const micPill = (runsTheShow || props.inCall) && props.micState && (() => {
        const mic = props.micState;

        const inCall = mic !== "off";
        // THE WARNING IS THE PILL (2026-09-18, pass 1 of
        // `docs/plans/WATCH_PARTY_UI.md`). "Mic mudo: ninguém te ouve" used
        // to be a sentence with an "Ativar mic" link at the end of the
        // status row, one row below the pill that already said "Mic
        // mutado" and already unmuted on press: the same fact and the same
        // action twice, a row apart. Now the pill goes amber, says the
        // sentence, and is the fix. Same rule behind it
        // (`presenterMicWarning`), same test ids, one control.
        const label =
          mic === "everyone"
            ? t("watchParty.live.micEveryone")
            : mic === "room"
              ? t("watchParty.live.micRoom")
              : mic === "muted"
                ? micMutedWarning
                  ? t("watchParty.live.micMutedShort")
                  : t("watchParty.live.micMuted")
                : t("watchParty.live.micOff");
        const hint =
          mic === "everyone"
            ? t("watchParty.live.micEveryoneHint")
            : mic === "room"
              ? t("watchParty.live.micRoomHint")
              : micMutedWarning
                ? t("watchParty.live.activateMic")
                : undefined;
        const className = cn(
          "flex shrink-0 items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-semibold transition-colors",
          mic === "everyone"
            ? "border-success/40 bg-success/15 text-success"
            : mic === "room" || micMutedWarning
              ? "border-warning/40 bg-warning/10 text-warning"
              : "border-border bg-surface-0 font-normal text-text-tertiary",
          inCall && props.onToggleMute && "hover:bg-surface-2",
        );
        const warningAttrs = micMutedWarning
          ? {
              "data-testid": "watch-party-mic-muted-warning",
              "data-watch-party-activate-mic": "",
            }
          : {};
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
            {...warningAttrs}
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
          <span
            data-watch-party-mic={mic}
            {...warningAttrs}
            title={hint}
            className={className}
          >
            {icon}
            {label}
          </span>
        );
      })();

  /* THE SEAT'S OWN CONTROLS, shared by both bars: a seated guest is still
     part of the audience (their bar), and a co-host who took a seat runs
     the show (theirs). Falar asks for the microphone; Sair do palco gives
     the seat back. */
  const seatControls = (
    <>
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
        {/* THE AUDIENCE NEVER JOINS A CALL (2026-09-13, Rafael). The
            transmission is the product: screen, voice and face. A watch
            party has an audience and it has the people running it, and the
            only thing the audience ever presses is "Pedir para falar" — a
            stage request, the same raise/lower hand `docs/RAISED_HANDS.md`
            already has, never "Entrar na call". This is offered regardless
            of `stageMode`: the request is harmless by itself (it only sets
            `handRaised`, which the host's queue below now shows for any
            voice-on party), and the alternative is a viewer with voice on
            and no way at all to ask, outside `invited` mode. */}
    </>
  );

  /* WHAT A PLAIN VIEWER MAY PRESS, and only that. */
  const audienceActions = (
    <>
        {showRequestToSpeak && (
          <Button
            type="button"
            variant={party.stage.handRaised ? "default" : "secondary"}
            size="sm"
            aria-pressed={party.stage.handRaised}
            title={t("watchParty.stage.speakHint")}
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
            guess. A manager is deliberately NOT here: MANAGE_CHANNELS edits
            somebody else's party, it does not perform in it and, since
            2026-09-12, it does not end it either.

            NOT "EVERYBODY ONCE VOICE IS ON" ANY MORE (2026-09-13). That used
            to be the film-night case this rule got right and it is now the
            one Rafael's decision retires on purpose: a plain viewer presses
            "Pedir para falar" above and gets this button, in these same
            words, only once the host has actually brought them up
            (`stage.invited`). `mayTakeWatchPartySeat` — the same function
            `join-voice-room` refuses with — still says yes to every viewer
            while voice is on, because the DOOR must not be narrower than the
            Voz switch promises; this BUTTON is deliberately narrower than
            that function, because a door being open is not a reason to point
            at it.

            The listen-only label went with the control. Everybody who can
            still see this button can speak once they are in, so a warning
            about a seat that cannot would now be false. */}
        {/* A WATCH PARTY IS NOT A LOBBY. The host is seated by going live
            or sharing, never by this button, and a co-host takes over with
            Assumir and shares. So with voice off, nobody running the show
            is offered a seat here; a host who wants to chat with friends
            while the film plays uses a voice channel. With voice on, the
            floor is a thing and the door stays.

            THE COPY IS "ENTRAR NO PALCO", NOT "ENTRAR NA CALL" (2026-09-13).
            The party's own words for its own room, for exactly the people who
            run it or were brought up to: the host and co-hosts (gated on
            voice being on — see above), anyone holding START_WATCH_PARTY on
            this channel (gated on nothing: they run parties here whether or
            not this one has voice), and an invited guest (same). */}
        {showEnterPalco && (
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
    </>
  );

  const presenterActions = (
    <>
        {/* THE SHARE, IN ONE PLACE, IN THE PARTY'S WORDS. The call strip's
            share icons are gone for the host (section 10 of the plan);
            this is where a picture goes up, changes, or comes down. */}
        {runsTheShow && props.onShareScreen && !props.isPresenting && (
          <Button
            type="button"
            size="sm"
            disabled={blocksGoLive(liveChecklistItems)}
            title={
              blocksGoLive(liveChecklistItems)
                ? t("watchParty.checklist.blockedFirefox")
                : undefined
            }
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
        {/* THE STREAM'S AUDIO, ONE PRESS AWAY (2026-09-13). The mixer, the
            two sliders that set how loud the host's voice and the film are
            in the ONE audio track the audience hears, used to live inside
            the transmission disclosure below: closed by default and, open,
            tall enough to push the host's own preview off the screen.
            Moonkase's party asked for exactly this control and did not
            find it. It opens a dialog so the picture never moves. Shown
            whenever somebody is running the show, not only while sharing:
            the sliders persist, so a level set before the film starts is
            the level the film starts with. */}
        {runsTheShow && (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            aria-expanded={mixerOpen}
            title={t("watchParty.live.mixerHint")}
            onClick={() => setMixerOpen(true)}
            data-watch-party-mixer-toggle
          >
            <Volume2 className="mr-1.5 h-3 w-3" aria-hidden />
            {t("watchParty.live.mixer")}
          </Button>
        )}
    </>
  );

  /* THE SEAT'S OWN EXIT, in the party's words. The call strip's red
     Sair is gone from watch party channels (section 10): a seated
     guest gives the seat back here, and a host does not leave a seat
     on purpose, they stop sharing or end the party. */
  const leaveSeat = props.inCall && !runsTheShow && props.onLeaveSeat && (
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
  );

  /* THE METER BESIDE THE MIC, with no click (§6.2, gap 5). `micLevelDb`
     reads the mic branch of the running mix, so it exists only while a
     share is mixing; absent draws nothing. Polling and the 10 Hz state it
     drives live in `DockMicLevel` (Farol, 2026-09-14), never here — see
     that component's own doc. */
  const micLevelDb = runsTheShow ? props.micLevelDb : undefined;

  /**
   * THE HEADER IS FACTS, PLUS ONE RED BUTTON (2026-09-13,
   * `docs/plans/WATCH_PARTY_PRESENTER_UI.md` §6.1). What YouTube's control
   * room and Twitch's stream manager have in common: the top row says what
   * is live and how it is doing, and the only labeled action on it ends the
   * show. The link and the settings are icons. Everything that changes what
   * goes out moved to `presenterDock` below.
   */
  const presenterBar = (
    <div
      data-testid="watch-party-bar"
      data-watch-party-bar="presenter"
      className={barClassName}
    >
      {props.headerLeading}
      {identity}
      <span className="ml-auto flex flex-wrap items-center justify-end gap-1">
        <WatchPartyShareButton party={party} iconOnly />
        <Button
          type="button"
          variant="ghost"
          size="sm"
          aria-expanded={optionsOpen}
          aria-label={t("watchParty.options.title")}
          title={t("watchParty.options.title")}
          onClick={() => setOptionsOpen((open) => !open)}
          data-watch-party-options-toggle
        >
          <Settings2 className="h-3.5 w-3.5" aria-hidden />
        </Button>
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
        {props.headerTrailing}
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
   * THE DOCK (§6.2): one row, always in the same place, for the things that
   * change what the audience gets. Mic with its meter, the screen, the
   * mixer, and the seat controls a co-host may hold. This is the row
   * Twitch Studio draws under its preview and YouTube draws under its
   * webcam, and it is where Moonkase's "volume controls for the streamer
   * and the film" now live one press from the picture. It sits at the
   * bottom of the chrome column, directly above the split, because the
   * picture itself belongs to the call stage and not to this panel.
   */
  /**
   * THE BAR, FOR EVERYBODY WITH SOMETHING TO PRESS (2026-09-18, pass 2 of
   * `docs/plans/WATCH_PARTY_UI.md`). The dock above the split (host only)
   * and the audience bar's own seat controls were two rows saying the same
   * kind of thing to two kinds of person. Now there is one row, at the
   * bottom of the picture, and every role gets its own subset of it: the
   * host and co-hosts their mic, share and mixer; a seated guest their mic,
   * Falar and Sair do palco; a plain viewer the raise and, when invited,
   * Entrar no palco. The guests overlay portals its own group into the same
   * element between these two (`data-watch-party-bar-people`, order-2).
   *
   * Nobody with nothing to press gets a row: a seatless viewer of a party
   * with hands off sees no bar at all, which is the seatless promise.
   */
  const hasBarContent =
    runsTheShow || props.inCall || showRequestToSpeak || showEnterPalco;
  const barControls = hasBarContent && (
    <div
      data-testid="watch-party-bar-controls"
      className={
        props.barSlot
          ? "contents"
          : // Inline fallback: no slot to portal into, so draw the row itself
            // above the split, the way the dock used to.
            "flex shrink-0 flex-wrap items-center gap-1.5 border-b border-ink-4/60 bg-ink px-3 py-1.5"
      }
    >
      <span className="order-1 flex min-w-0 flex-wrap items-center gap-1.5">
        {micPill}
        {micLevelDb && <DockMicLevel micLevelDb={micLevelDb} />}
        {seatControls}
        {audienceActions}
        {leaveSeat}
      </span>
      <span className="order-3 ml-auto flex flex-wrap items-center justify-end gap-1.5">
        {presenterActions}
      </span>
    </div>
  );
  const presenterDock = barControls
    ? props.barSlot
      ? createPortal(barControls, props.barSlot)
      : barControls
    : null;

  /* `canClaim` is the one presenter action an audience member can hold: a
     co-host is `runsTheShow`, but a viewer with the right to take over a
     party whose host vanished is still, until they press it, watching. */
  const audienceBar = (
    <div
      data-testid="watch-party-bar"
      data-watch-party-bar="audience"
      className={barClassName}
    >
      {props.headerLeading}
      {identity}
      <span className="ml-auto flex flex-wrap items-center justify-end gap-1.5">
        <WatchPartyShareButton party={party} />
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
        {props.headerTrailing}
      </span>
    </div>
  );

  const bar = runsTheShow ? presenterBar : audienceBar;

  /**
   * THE MIXER'S DIALOG. Same reasoning as the options dialog below: a
   * `Dialog` because it is the modal this app has, and because the picture
   * behind it must not move. Both sliders are live (`StreamMixControl`),
   * so a host drags "Meu mic" up while watching the output meter and closes.
   */
  const mixerDialog = runsTheShow && (
    <Dialog
      open={mixerOpen}
      size="sm"
      title={t("watchParty.live.mixerTitle")}
      description={t("watchParty.live.mixerBody")}
      onClose={() => setMixerOpen(false)}
    >
      <DialogBody>
        <StreamMixControl
          onMicGainChange={props.onMicGainChange}
          onDisplayGainChange={props.onDisplayGainChange}
          micLevelDb={props.micLevelDb}
          outputLevelDb={props.outputLevelDb}
        />
      </DialogBody>
    </Dialog>
  );

  /**
   * The same panel the setup surface showed, reopened mid-show. A host who
   * learned it before going live does not learn a second one at minute forty,
   * and every change lands immediately for the people already watching (the
   * server re-reconciles the channel on every edit).
   */
  // "SEU MIC ESTÁ MUDO" moved twice: a red strip of its own (2026-09-12),
  // the amber end of the status row (2026-09-13), and now the mic pill
  // itself (2026-09-18, `micPill` above), which was already the fix.

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
      recovering={props.isPresenting && props.sharePublishRecovering === true}
      quality={props.videoQuality ?? "auto"}
      roomViewers={props.roomViewers ?? 0}
      transport={props.transport ?? null}
      now={new Date()}
      onMicGainChange={props.onMicGainChange}
      onDisplayGainChange={props.onDisplayGainChange}
      micLevelDb={props.micLevelDb}
      outputLevelDb={props.outputLevelDb}
      micMuted={micIsInaudible(props.micState)}
      userId={props.currentUserId ?? null}
      onStreamQualityChange={setLiveQuality}
      onOpenMixer={() => setMixerOpen(true)}
      detailsInDialog
      overlay={Boolean(props.statusSlot)}
    />
  );
  const transmissionMounted =
    transmission && props.statusSlot
      ? createPortal(transmission, props.statusSlot)
      : transmission;

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
        {transmissionMounted}
        {presenterDock}
        {/* Portalled by `Dialog`, so it takes no room in this column and the
            split below it never moves. */}
        {optionsDialog}
        {mixerDialog}
        {hostGone}
        {viewerHint}
      </div>
    );
  }

  // Nothing on screen yet, and the person is not in the call: the stage's
  // own holding or preparing state (pass 3 of `docs/plans/WATCH_PARTY_UI.md`)
  // instead of rendering nothing. Which "nothing" it is matters: see
  // `someoneIsSharing` above. The checklist that used to repeat here lives
  // in the green room only; its one blocking rule (Firefox) is the share
  // button's disabled tooltip on the bar.
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
        <WatchPartyStage
          state={preparing ? "preparing" : "holding"}
          hostSide={hostSide}
          hostName={party.hostDisplayName}
        />
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
  recovering = false,
}: {
  party: WatchParty;
  compact?: boolean;
  /** Appended after the host, for facts that are not actions (the count). */
  meta?: string;
  className?: string;
  onRename?: (name: string) => Promise<void>;
  /**
   * The presenter's OWN screen-share publish has dropped and is being
   * re-established. Only ever true on the presenter's own bar. It turns the
   * red "AO VIVO" badge into an amber "Reconectando" one and drops the viewer
   * count: the party is not actually reaching anyone until the picture is back,
   * and a live badge over a dead stream is the exact lie this fixes.
   */
  recovering?: boolean;
}) {
  const { t } = useTranslation();
  const live = party.state === "live" && !recovering;
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
          {recovering && <LivePill variant="recovering" />}
        </span>
        <span
          data-testid={meta ? "watch-party-viewers" : undefined}
          className="truncate text-[11px] text-paper-muted"
        >
          {t("watchParty.live.hostedBy", { name: party.hostDisplayName })}
          {meta && !recovering ? ` · ${meta}` : ""}
        </span>
      </span>
    </span>
  );
}
