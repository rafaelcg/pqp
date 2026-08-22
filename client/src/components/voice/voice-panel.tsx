import { useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  HeadphoneOff,
  Headphones,
  Loader2,
  Mic,
  MicOff,
  PhoneOff,
  ScreenShare,
  ScreenShareOff,
  Volume2,
  VolumeX,
} from "lucide-react";
import { MESH_VOICE_WARNING, type VoiceParticipant } from "@pqp/shared";
import type { VoiceInputMode } from "@/hooks/use-voice";
import type { RemotePeer } from "@/lib/peer-connection-manager";
import { Button } from "@/components/ui/button";
import {
  screenShareUnavailableMessage,
  screenShareUnavailableReason,
} from "@/components/voice/capabilities";
import {
  VoiceAvatar,
  type VoiceAvatarSize,
} from "@/components/voice/voice-avatar";
import { useTranslation } from "@/lib/i18n";
import { cn } from "@/lib/utils";

/**
 * Tiles grow as the call shrinks: one person gets a poster, eight people get a
 * contact sheet. Sizes are picked from the participant count rather than from a
 * media query so the same rule holds in the narrow docked column and in the
 * short mobile pane.
 */
function avatarSizeFor(count: number, compact: boolean): VoiceAvatarSize {
  const size: VoiceAvatarSize = count <= 2 ? "xl" : count <= 4 ? "lg" : "md";
  if (!compact) {
    return size;
  }
  return size === "xl" ? "lg" : size === "lg" ? "md" : "sm";
}

interface ParticipantTileProps {
  name: string;
  avatarUrl?: string | null;
  isSelf?: boolean;
  isSpeaking: boolean;
  isMuted?: boolean;
  isDeafened?: boolean;
  isPresenting: boolean;
  /**
   * Self tile only: the mic is open right now. In voice activity this is the
   * same thing as "not muted" and says nothing new, so it is only rendered as
   * its own badge in push-to-talk, where it is the one thing you need to know.
   */
  isTransmitting?: boolean;
  showTransmitBadge?: boolean;
  avatarSize: VoiceAvatarSize;
  minHeightClass: string;
  connectionState?: RemotePeer["connectionState"];
  /** 0..1 playback multiplier. Only supplied for remote peers. */
  volume?: number;
  onSetVolume?: (volume: number) => void;
  onRetry?: () => void;
}

function ParticipantTile({
  name,
  avatarUrl,
  isSelf = false,
  isSpeaking,
  isMuted = false,
  isDeafened = false,
  isPresenting,
  isTransmitting = false,
  showTransmitBadge = false,
  avatarSize,
  minHeightClass,
  connectionState,
  volume,
  onSetVolume,
  onRetry,
}: ParticipantTileProps) {
  const { t } = useTranslation();
  const silenced = volume === 0;
  // Remembers where the slider was so unmuting restores that level, not 100%.
  const restoreRef = useRef(1);

  useEffect(() => {
    if (volume !== undefined && volume > 0) {
      restoreRef.current = volume;
    }
  }, [volume]);

  const failed = connectionState === "failed";
  const settling =
    connectionState !== undefined && connectionState !== "connected" && !failed;

  return (
    <li
      className={cn(
        "group relative flex flex-col items-center justify-center gap-2 rounded-xl border p-3 text-center transition-colors duration-150",
        minHeightClass,
        failed
          ? "border-danger/50 bg-danger/5"
          : isSpeaking || (showTransmitBadge && isTransmitting)
            ? "border-accent/60 bg-ink-2"
            : "border-ink-4 bg-ink",
      )}
    >
      <VoiceAvatar
        name={name}
        avatarUrl={avatarUrl}
        // The speaking ring doubles as the transmitting indicator rather than
        // a second visual language: in push-to-talk an open mic *is* the state
        // worth showing, whether or not you happen to be making noise this
        // frame. Everywhere else the ring keeps its usual meaning.
        isSpeaking={(isSpeaking || (showTransmitBadge && isTransmitting)) && !silenced}
        muted={isMuted || silenced}
        size={avatarSize}
      />

      <p className="w-full min-w-0 truncate text-sm font-medium">
        {name}
        {isSelf && (
          <span className="ml-1 text-xs text-paper-muted">
            {t("voice.tile.you")}
          </span>
        )}
      </p>

      {(isPresenting ||
        isDeafened ||
        isMuted ||
        silenced ||
        settling ||
        failed ||
        showTransmitBadge) && (
        <div className="flex flex-wrap items-center justify-center gap-1">
          {/* Push-to-talk only. Two states, always one of them on screen, so
              the answer to "am I live right now" is never an absence. */}
          {/* i18n: needs `voice.tile.live` / `voice.tile.holdToTalk`. */}
          {showTransmitBadge && !isMuted && !isDeafened && (
            <span
              className={cn(
                "flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] uppercase tracking-wide",
                isTransmitting
                  ? "bg-accent/20 text-accent"
                  : "bg-ink-3 text-paper-muted",
              )}
            >
              {isTransmitting ? (
                <Mic className="h-3 w-3" aria-hidden="true" />
              ) : (
                <MicOff className="h-3 w-3" aria-hidden="true" />
              )}
              {isTransmitting ? "Live" : "Hold to talk"}
            </span>
          )}
          {isPresenting && (
            <span className="flex items-center gap-1 rounded bg-signal/20 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-signal">
              <ScreenShare className="h-3 w-3" aria-hidden="true" />
              {t("voice.tile.presenting")}
            </span>
          )}
          {isDeafened ? (
            <span
              className="flex items-center gap-1 rounded bg-ink-3 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-danger"
              title={t("voice.tile.deafened")}
            >
              <HeadphoneOff className="h-3 w-3" aria-hidden="true" />
              {t("voice.tile.deafened")}
            </span>
          ) : (
            isMuted && (
              <span
                className="flex items-center gap-1 rounded bg-ink-3 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-danger"
                title={t("voice.tile.mutedTitle")}
              >
                <MicOff className="h-3 w-3" aria-hidden="true" />
                {t("voice.tile.muted")}
              </span>
            )
          )}
          {silenced && (
            <span className="flex items-center gap-1 rounded bg-ink-3 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-paper-muted">
              <VolumeX className="h-3 w-3" aria-hidden="true" />
              {t("voice.tile.silenced")}
            </span>
          )}
          {/* A settled connection is the normal case and says nothing; only the
              in-between and broken states are worth a line of the tile. */}
          {/* `PeerConnectionState` narrows to "connecting" here — "connected"
              and "failed" are handled above — so this is one word, not the raw
              enum it used to print. */}
          {settling && (
            <span className="flex items-center gap-1 text-[10px] uppercase tracking-wide text-paper-muted">
              <Loader2 className="h-3 w-3 animate-spin" aria-hidden="true" />
              {t("voice.tile.connecting")}
            </span>
          )}
          {failed && (
            <span className="text-[10px] uppercase tracking-wide text-danger">
              {t("voice.tile.disconnected")}
            </span>
          )}
        </div>
      )}

      {failed && onRetry && (
        <Button
          variant="secondary"
          size="sm"
          className="h-6 px-2 text-[10px]"
          onClick={onRetry}
        >
          {t("voice.tile.retry")}
        </Button>
      )}

      {onSetVolume && volume !== undefined && !failed && (
        <div
          className={cn(
            "grid w-full transition-[grid-template-rows] duration-150",
            volume === 1
              ? "grid-rows-[0fr] group-hover:grid-rows-[1fr] group-focus-within:grid-rows-[1fr]"
              : "grid-rows-[1fr]",
          )}
        >
          <div className="overflow-hidden">
            <div className="flex items-center gap-1 pt-1">
              <Button
                variant="ghost"
                size="icon"
                className="h-6 w-6 shrink-0"
                aria-label={
                  silenced
                    ? t("voice.tile.unmutePeer", { name })
                    : t("voice.tile.mutePeer", { name })
                }
                aria-pressed={silenced}
                onClick={() => onSetVolume(silenced ? restoreRef.current : 0)}
              >
                {silenced ? (
                  <VolumeX className="h-3.5 w-3.5 text-danger" />
                ) : (
                  <Volume2 className="h-3.5 w-3.5" />
                )}
              </Button>
              <input
                type="range"
                min={0}
                max={1}
                step={0.05}
                value={volume}
                aria-label={t("voice.tile.volumeFor", { name })}
                aria-valuetext={t("voice.tile.volumePercent", {
                  percent: Math.round(volume * 100),
                })}
                onChange={(event) => onSetVolume(Number(event.target.value))}
                className="h-1 min-w-0 flex-1 cursor-pointer accent-signal"
              />
            </div>
          </div>
        </div>
      )}
    </li>
  );
}

interface VoicePanelProps {
  channelName: string;
  status: "idle" | "joining" | "connected";
  remotePeers: RemotePeer[];
  self: VoiceParticipant | null;
  localPeerId: string | null;
  speakingPeerIds: string[];
  isMuted: boolean;
  isDeafened: boolean;
  inputMode?: VoiceInputMode;
  /** Audio is leaving this machine right now. See `VoiceState.isTransmitting`. */
  isTransmitting?: boolean;
  /**
   * The bound key, already formatted, or null on a device where binding a key
   * makes no sense (a phone). Null is what switches the hint from "hold ` " to
   * "hold the button".
   */
  pushToTalkKeyLabel?: string | null;
  /**
   * Whether this window currently has keyboard focus. False means the key
   * binding is genuinely not working, and the panel says so — the web has no
   * global hotkey, and pretending otherwise is how someone ends up pressing a
   * key at a window that is not listening.
   */
  windowFocused?: boolean;
  onPushToTalk?: (held: boolean) => void;
  /** peerId → 0..2 playback multiplier. Missing entries play at 1. */
  peerVolumes: Record<string, number>;
  error: string | null;
  compactPeers?: boolean;
  /** Media is going through an SFU — the mesh peer ceiling does not apply. */
  usingSfu?: boolean;
  isSharingScreen?: boolean;
  /** Whether our own live share is carrying the machine's audio. */
  isSharingScreenAudio?: boolean;
  /** peerId of whoever is presenting (self or remote), or null if nobody is. */
  screenSharePeerId?: string | null;
  /**
   * The room's roster (`voice-roster` participants) for this channel. Carries
   * each peer's self-declared muted/deafened state, which is not part of the
   * media-level `RemotePeer` — so remote tiles can show the same badges the
   * channel list does. Optional: without it the tiles simply carry no state
   * badges, which is what they always did.
   */
  participants?: VoiceParticipant[];
  onJoin: () => void;
  onLeave: () => void;
  onToggleMute: () => void;
  onToggleDeafen: () => void;
  onSetPeerVolume: (peerId: string, volume: number) => void;
  onRetryPeer?: (peerId: string) => void;
  onStartScreenShare?: () => void;
  onStopScreenShare?: () => void;
}

export function VoicePanel({
  channelName,
  status,
  remotePeers,
  self,
  localPeerId,
  speakingPeerIds,
  isMuted,
  isDeafened,
  inputMode = "voice-activity",
  isTransmitting = true,
  pushToTalkKeyLabel = null,
  windowFocused = true,
  onPushToTalk,
  peerVolumes,
  error,
  compactPeers = false,
  usingSfu = false,
  isSharingScreen = false,
  isSharingScreenAudio = false,
  screenSharePeerId = null,
  participants = [],
  onJoin,
  onLeave,
  onToggleMute,
  onToggleDeafen,
  onSetPeerVolume,
  onRetryPeer,
  onStartScreenShare,
  onStopScreenShare,
}: VoicePanelProps) {
  const { t } = useTranslation();
  const showWarning = !usingSfu && remotePeers.length >= MESH_VOICE_WARNING;
  const someoneElseSharing =
    !!screenSharePeerId && screenSharePeerId !== localPeerId;
  const speaking = new Set(speakingPeerIds);
  // Roster state by peer id — mute/deafen badges for the *other* tiles. Self
  // renders from local state instead, which is ahead of the roster echo.
  const rosterByPeerId = new Map(participants.map((p) => [p.peerId, p]));
  const connectedCount =
    (status === "connected" && self ? 1 : 0) + remotePeers.length;

  // Probed once per mount: whether a browser has getDisplayMedia never changes
  // mid-session, and this must not be re-evaluated on every keystroke elsewhere.
  const screenShareBlocked = useMemo(() => screenShareUnavailableReason(), []);
  const [hint, setHint] = useState<string | null>(null);
  const pushToTalk = inputMode === "push-to-talk";
  // Muted or deafened outranks the key, so the button says so rather than
  // inviting a press that would do nothing.
  const pushToTalkBlocked = isMuted || isDeafened;

  // The explanation is an answer to a tap, not a persistent state of the call.
  useEffect(() => {
    if (!hint) {
      return;
    }
    const timer = setTimeout(() => setHint(null), 6000);
    return () => clearTimeout(timer);
  }, [hint]);

  // A share that carries no sound is the common one, and the presenter cannot
  // hear the problem: their own machine is playing whatever they shared. So it
  // is stated once, in the same quiet slot every other explanation uses, and
  // fades on the same timer rather than nagging for the whole presentation.
  useEffect(() => {
    if (isSharingScreen && !isSharingScreenAudio) {
      setHint(t("voice.share.noAudio"));
    }
  }, [isSharingScreen, isSharingScreenAudio, t]);

  const avatarSize = avatarSizeFor(connectedCount, compactPeers);
  // A call of one still deserves a stage rather than a stray card — but only
  // where there is height to spend. Below `lg` this panel is a short band above
  // the chat, and a tall tile there would just push the controls out of reach.
  const minHeightClass =
    connectedCount <= 1
      ? compactPeers
        ? "min-h-[6.5rem] lg:min-h-[11rem]"
        : "min-h-[8rem] lg:min-h-[14rem]"
      : compactPeers
        ? "min-h-[5.5rem]"
        : "min-h-[7.5rem]";
  const gridTemplateColumns =
    connectedCount <= 1
      ? "1fr"
      : `repeat(auto-fit, minmax(${compactPeers ? "6.5rem" : "8rem"}, 1fr))`;

  return (
    <div className="flex h-full min-h-0 flex-col border-b border-panel-hover lg:border-b-0 lg:border-r">
      {/* h-14 matches the chat header beside it, so the two columns share one
          horizontal rule instead of two that nearly line up. */}
      <header className="flex h-14 shrink-0 items-center gap-2 border-b border-panel-hover px-4 shadow-sm">
        <Mic className="h-5 w-5 shrink-0 text-muted" aria-hidden="true" />
        <span className="min-w-0 flex-1 truncate font-semibold">
          {channelName}
        </span>
        {status === "connected" && (
          <span className="flex shrink-0 items-center gap-1 text-xs text-success">
            <span className="h-1.5 w-1.5 rounded-full bg-success" />
            {t("voice.live")}
            <span className="text-paper-muted">· {connectedCount}</span>
          </span>
        )}
      </header>

      {error && (
        <div
          role="alert"
          className="flex shrink-0 items-start gap-2 border-b border-danger/40 bg-danger/10 px-3 py-2 text-sm text-danger"
        >
          <AlertTriangle
            className="mt-0.5 h-4 w-4 shrink-0"
            aria-hidden="true"
          />
          <p className="min-w-0 flex-1 break-words">{error}</p>
        </div>
      )}

      {status === "connected" && showWarning && (
        <p className="shrink-0 border-b border-warning/30 bg-warning/10 px-3 py-1.5 text-center text-xs text-warning">
          {t("voice.meshWarning")}
        </p>
      )}

      {status === "idle" && (
        <div className="flex flex-1 flex-col items-center justify-center gap-3 p-6 text-center">
          <p className="max-w-xs text-sm text-muted">{t("voice.idle.body")}</p>
          <Button onClick={onJoin}>{t("voice.join")}</Button>
        </div>
      )}

      {status === "joining" && (
        <div className="flex flex-1 flex-col items-center justify-center gap-3 p-6 text-center">
          <p
            aria-live="polite"
            className="flex items-center gap-2 text-sm text-muted"
          >
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
            {t("voice.connectingTo", { channel: channelName })}
          </p>
          <Button variant="ghost" size="sm" onClick={onLeave}>
            {t("voice.cancel")}
          </Button>
        </div>
      )}

      {status === "connected" && (
        <>
          {/* The participant grid owns the column: it stretches to whatever is
              left between the header and the control bar, centres itself while
              the call is small, and scrolls once eight tiles no longer fit. */}
          <div className="flex min-h-0 flex-1 flex-col overflow-y-auto p-3">
            {/* `my-auto` rather than `justify-center`: auto margins centre a
                short call without clipping the first row once eight tiles
                overflow the column. */}
            <div className="my-auto flex flex-col gap-3">
              <ul
                className="grid auto-rows-min gap-2"
                style={{ gridTemplateColumns }}
              >
                {self && (
                  <ParticipantTile
                    name={self.displayName}
                    avatarUrl={self.avatarUrl}
                    isSelf
                    isSpeaking={
                      !!localPeerId &&
                      speaking.has(localPeerId) &&
                      !isMuted &&
                      isTransmitting
                    }
                    isMuted={isMuted}
                    isDeafened={isDeafened}
                    isPresenting={isSharingScreen}
                    isTransmitting={isTransmitting}
                    showTransmitBadge={pushToTalk}
                    avatarSize={avatarSize}
                    minHeightClass={minHeightClass}
                  />
                )}
                {remotePeers.map((peer) => {
                  const key = peer.userId ?? peer.peerId;
                  const roster = rosterByPeerId.get(peer.peerId);
                  return (
                    <ParticipantTile
                      key={peer.peerId}
                      name={peer.displayName ?? `${peer.peerId.slice(0, 8)}…`}
                      avatarUrl={peer.avatarUrl}
                      isSpeaking={speaking.has(peer.peerId) && !isDeafened}
                      isMuted={roster?.muted ?? false}
                      isDeafened={roster?.deafened ?? false}
                      isPresenting={peer.peerId === screenSharePeerId}
                      avatarSize={avatarSize}
                      minHeightClass={minHeightClass}
                      connectionState={peer.connectionState}
                      volume={peerVolumes[key] ?? 1}
                      onSetVolume={(volume) => onSetPeerVolume(key, volume)}
                      onRetry={
                        onRetryPeer ? () => onRetryPeer(peer.peerId) : undefined
                      }
                    />
                  );
                })}
              </ul>

              {connectedCount <= 1 && (
                <p className="text-center text-xs text-paper-muted">
                  {t("voice.alone")}
                </p>
              )}
            </div>
          </div>

          <div className="shrink-0 border-t border-panel-hover bg-ink px-3 py-2">
            {/* The hold button is shown on every device, not only touch ones.
                On a phone it is the *only* way to use push-to-talk — there is
                no keyboard to bind — and on a desktop it is the affordance that
                makes the mode discoverable and gives the key a visible twin. */}
            {pushToTalk && (
              <div className="mb-2">
                {/* i18n: needs `voice.ptt.hold`, `voice.ptt.transmitting`,
                    `voice.ptt.blocked`, `voice.ptt.hintKey`,
                    `voice.ptt.hintButton`, `voice.ptt.unfocused`. */}
                <Button
                  variant={isTransmitting ? "default" : "secondary"}
                  className={cn(
                    "w-full select-none",
                    // Without this a long press on a phone starts a text
                    // selection or a scroll and the button never gets its
                    // pointerup — which would be a stuck-open mic.
                    "touch-none",
                    isTransmitting && "ring-2 ring-accent",
                  )}
                  disabled={pushToTalkBlocked}
                  aria-pressed={isTransmitting}
                  onPointerDown={(event) => {
                    // Capturing means the pointerup is delivered here even if
                    // the finger slides off the button before lifting.
                    event.currentTarget.setPointerCapture?.(event.pointerId);
                    onPushToTalk?.(true);
                  }}
                  onPointerUp={() => onPushToTalk?.(false)}
                  onPointerCancel={() => onPushToTalk?.(false)}
                  onLostPointerCapture={() => onPushToTalk?.(false)}
                  // Keyboard users get hold-to-talk on the focused button too;
                  // a plain click (which is press+release in one) would be a
                  // transmission of zero length, so Space is handled by hand.
                  onKeyDown={(event) => {
                    if (event.key === " " && !event.repeat) {
                      event.preventDefault();
                      onPushToTalk?.(true);
                    }
                  }}
                  onKeyUp={(event) => {
                    if (event.key === " ") {
                      event.preventDefault();
                      onPushToTalk?.(false);
                    }
                  }}
                  onBlur={() => onPushToTalk?.(false)}
                >
                  {isTransmitting ? (
                    <Mic className="h-4 w-4" aria-hidden="true" />
                  ) : (
                    <MicOff className="h-4 w-4" aria-hidden="true" />
                  )}
                  {pushToTalkBlocked
                    ? "Muted — push-to-talk is off"
                    : isTransmitting
                      ? "Transmitting"
                      : "Hold to talk"}
                </Button>
                <p className="mt-1 text-center text-[11px] text-paper-muted">
                  {pushToTalkKeyLabel
                    ? `Hold ${pushToTalkKeyLabel} or the button above.`
                    : "Hold the button above to talk."}
                </p>
                {pushToTalkKeyLabel && !windowFocused && (
                  /* Said out loud rather than hidden: a browser cannot see a
                     key pressed while another window has focus, so the binding
                     really is dead right now. Only the desktop shell can
                     register a global hotkey. */
                  <p
                    role="status"
                    className="mt-1 text-center text-[11px] text-warning"
                  >
                    This window isn&apos;t focused — the key won&apos;t reach
                    it. Click here first, or use the button.
                  </p>
                )}
              </div>
            )}
            <div className="flex items-center justify-center gap-2">
              <Button
                variant="secondary"
                size="icon"
                aria-label={
                  isMuted ? t("voice.control.unmute") : t("voice.control.mute")
                }
                aria-pressed={isMuted}
                onClick={onToggleMute}
              >
                {isMuted ? (
                  <MicOff className="h-4 w-4 text-danger" />
                ) : (
                  <Mic className="h-4 w-4" />
                )}
              </Button>
              <Button
                variant="secondary"
                size="icon"
                aria-label={
                  isDeafened
                    ? t("voice.control.undeafen")
                    : t("voice.control.deafen")
                }
                aria-pressed={isDeafened}
                onClick={onToggleDeafen}
              >
                {isDeafened ? (
                  <HeadphoneOff className="h-4 w-4 text-danger" />
                ) : (
                  <Headphones className="h-4 w-4" />
                )}
              </Button>
              {(onStartScreenShare || onStopScreenShare) &&
                (screenShareBlocked ? (
                  /* Not `disabled`: a disabled button cannot be tapped, and on
                     a phone a tap is the only way to ask why. Kept quiet — the
                     explanation is muted helper text, never an alert. */
                  <Button
                    variant="secondary"
                    size="icon"
                    className="opacity-50"
                    aria-disabled
                    aria-label={t("voice.control.shareUnavailable")}
                    title={screenShareUnavailableMessage(screenShareBlocked)}
                    onClick={() =>
                      setHint(screenShareUnavailableMessage(screenShareBlocked))
                    }
                  >
                    <ScreenShare className="h-4 w-4" />
                  </Button>
                ) : (
                  <Button
                    variant="secondary"
                    size="icon"
                    aria-label={
                      isSharingScreen
                        ? t("voice.control.stopShare")
                        : t("voice.control.share")
                    }
                    aria-pressed={isSharingScreen}
                    disabled={someoneElseSharing}
                    title={
                      someoneElseSharing
                        ? t("voice.control.shareTaken")
                        : undefined
                    }
                    onClick={
                      isSharingScreen ? onStopScreenShare : onStartScreenShare
                    }
                  >
                    {isSharingScreen ? (
                      <ScreenShareOff className="h-4 w-4 text-signal" />
                    ) : (
                      <ScreenShare className="h-4 w-4" />
                    )}
                  </Button>
                ))}
              <Button variant="danger" size="sm" onClick={onLeave}>
                <PhoneOff className="h-4 w-4" aria-hidden="true" />
                {t("voice.control.leave")}
              </Button>
            </div>

            {hint && (
              <p
                role="status"
                className="mt-1.5 text-center text-[11px] text-paper-muted"
              >
                {hint}
              </p>
            )}
          </div>
        </>
      )}
    </div>
  );
}
