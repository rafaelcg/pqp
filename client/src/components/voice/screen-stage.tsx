import { useEffect, useRef, useState } from "react";
import type { LiveReactionEmoji } from "@pqp/shared";
import { validPartTargetMs, type HlsMode } from "@/lib/hls-live-edge";
import type { RemotePeer } from "@/lib/peer-connection-manager";
import { ScreenShareView } from "@/components/voice/screen-share-view";
import { useLgUp } from "@/hooks/use-lg-up";
import { useTranslation } from "@/lib/i18n";
import { isLiveReactionsEnabled } from "@/lib/live-reactions";
import { LiveReactionsBar } from "./live-reactions-bar";
import { LiveReactionsOverlay } from "./live-reactions-overlay";
import { bindRemoteVideo } from "@/lib/remote-video-binding";
import { useHideScreenPreview } from "@/lib/screen-preview-pref";
import { cn } from "@/lib/utils";

export interface ScreenShareTile {
  peerId: string;
  stream: MediaStream | null;
  /** LiveKit egress playlist for this presenter; remote tiles prefer it. */
  hlsUrl?: string | null;
  /**
   * The presenter's camera, as a second playlist. Only the cinema stage draws
   * it: a webcam inside a grid tile is a picture in a picture in a picture.
   */
  cameraHlsUrl?: string | null;
  /** Whether `cameraHlsUrl` carries a picture. Defaults true when omitted. */
  cameraHasVideo?: boolean;
  /** Whether `cameraHlsUrl` carries the presenter's mic (`LIVE_HLS_VOICE_TRACK`). */
  cameraHasVoiceAudio?: boolean;
  delaySeconds?: number;
  /** `LiveHlsStream.mode` (`docs/plans/LL_HLS.md`). Absent means conventional. */
  mode?: HlsMode;
  /** `LiveHlsStream.partTargetMs`, read only when `mode === "ll"`. */
  partTargetMs?: number;
  presenterName: string;
  isSelf: boolean;
  /**
   * The presenter's account id, which is what the volume maps are keyed on so
   * a setting survives them reconnecting with a new `peerId`. Null for our own
   * tile and for a peer whose identity has not arrived yet.
   */
  userId: string | null;
  /**
   * Whether this share arrived with sound. Read from the received stream, not
   * from what the presenter ticked: the question a listener has is whether
   * there is anything here to turn down.
   */
  hasAudio: boolean;
}

export function collectScreenTiles(args: {
  peerIds: string[];
  localPeerId: string | null;
  localName: string;
  localStream: MediaStream | null;
  remotePeers: RemotePeer[];
  fallbackName: string;
  liveStream?: {
    hlsUrl: string;
    cameraHlsUrl?: string;
    cameraHasVideo?: boolean;
    cameraHasVoiceAudio?: boolean;
    presenterPeerId: string;
    delaySeconds?: number;
    /** See `ScreenShareTile.mode`'s comment -- absent on `LiveHlsStream` today. */
    mode?: HlsMode;
    partTargetMs?: number;
  } | null;
}): ScreenShareTile[] {
  return args.peerIds.map((peerId) => {
    const hls =
      args.liveStream && args.liveStream.presenterPeerId === peerId
        ? {
            hlsUrl: args.liveStream.hlsUrl,
            cameraHlsUrl: args.liveStream.cameraHlsUrl ?? null,
            cameraHasVideo: args.liveStream.cameraHasVideo,
            cameraHasVoiceAudio: args.liveStream.cameraHasVoiceAudio,
            delaySeconds: args.liveStream.delaySeconds,
            mode: args.liveStream.mode,
            // Validated here, once, so every downstream reader of a tile's
            // `partTargetMs` (the player, the stall config) already holds a
            // sane value (Farol review, this PR) -- never the raw wire
            // number, which nothing between the server and this map
            // otherwise checks.
            partTargetMs: validPartTargetMs(args.liveStream.partTargetMs),
          }
        : {
            hlsUrl: null,
            cameraHlsUrl: null,
            cameraHasVideo: undefined,
            cameraHasVoiceAudio: undefined,
            delaySeconds: undefined,
            mode: undefined,
            partTargetMs: undefined,
          };
    if (peerId === args.localPeerId) {
      return {
        peerId,
        stream: args.localStream,
        // A presenter watching themselves 10 s late is not useful.
        hlsUrl: null,
        cameraHlsUrl: null,
        presenterName: args.localName,
        isSelf: true,
        userId: null,
        // Our own share is played by the machine sharing it, never by us.
        hasAudio: false,
      };
    }
    const remote = args.remotePeers.find((peer) => peer.peerId === peerId);
    return {
      peerId,
      stream: remote?.screenStream ?? null,
      hlsUrl: hls.hlsUrl,
      cameraHlsUrl: hls.cameraHlsUrl,
      cameraHasVideo: hls.cameraHasVideo,
      cameraHasVoiceAudio: hls.cameraHasVoiceAudio,
      delaySeconds: hls.delaySeconds,
      mode: hls.mode,
      partTargetMs: hls.partTargetMs,
      presenterName: remote?.displayName ?? args.fallbackName,
      isSelf: false,
      userId: remote?.userId ?? null,
      hasAudio: remote?.screenAudioStream != null,
    };
  });
}

/**
 * Which tiles are actually allowed to play over HLS instead of WebRTC.
 *
 * Kept pure and exported so the rule pins without mounting `HlsWatchPlayer`
 * or its chrome: `CallStage` (`call-stage.tsx`) filters `hlsUrl` down to
 * `null` for two independent reasons, and every one of the delay badge, the
 * viewer pill, the quality menu and the holding screen lives *inside*
 * `HlsWatchPlayer` — so a tile this returns with `hlsUrl: null` is a tile
 * whose chrome cannot mount at all, because nothing else in the grid ever
 * renders that component.
 *
 * 1. `readyHlsUrls` — the playlist has to be a live window, not a 404 or the
 *    previous share's ENDLIST (a black video is not a watch party).
 * 2. `watchPartyChrome` — once this account holds a seat in the room this
 *    HLS egress belongs to, PR 551's rule applies: the SFU screen share is
 *    the one and only picture, whoever is presenting. Cinema mode already
 *    refuses itself in that case (`shouldShowCinema`'s `isWatchParty` gate);
 *    this is the same rule for the ordinary grid, which carried `hlsUrl` on
 *    a peer's tile regardless of anyone's seat until this function existed.
 */
export function resolveScreenTileSources<T extends { hlsUrl?: string | null }>(
  tiles: T[],
  readyHlsUrls: ReadonlySet<string>,
  watchPartyChrome: boolean,
): T[] {
  return tiles.map((tile) =>
    tile.hlsUrl && !watchPartyChrome && readyHlsUrls.has(tile.hlsUrl)
      ? tile
      : { ...tile, hlsUrl: null },
  );
}

function ThumbVideo({ stream }: { stream: MediaStream | null }) {
  const ref = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    const video = ref.current;
    if (!video) {
      return;
    }
    // Through the binding so an SFU stream's element is measured for
    // adaptive streaming; a thumbnail asking for the 360p layer is the point.
    const unbind = bindRemoteVideo(video, stream);
    if (stream) {
      void video.play().catch(() => {});
    }
    return unbind;
  }, [stream]);
  return (
    <video
      ref={ref}
      autoPlay
      playsInline
      muted
      className="h-16 w-full object-contain"
    />
  );
}

/**
 * Two shares on a wide window sit side by side. Everything else is one large
 * tile (with a strip when there is more than one). Kept as a function so the
 * voice panel and the DM stage cannot drift, and so a test can pin it without
 * mounting `<video>` elements.
 */
export function screenShareStageLayout(
  tileCount: number,
  wide: boolean,
): "split" | "focus" {
  return tileCount === 2 && wide ? "split" : "focus";
}

interface ScreenStageProps {
  tiles: ScreenShareTile[];
  focusedPeerId: string | null;
  onFocus: (peerId: string) => void;
  onStopSharing?: () => void;
  /**
   * The voice channel this stage belongs to, and the one live reactions are
   * addressed to. Optional so a caller that predates the feature, or one that
   * has no channel to name, simply gets no overlay.
   */
  channelId?: string;
  /**
   * Sends one live reaction. Absent means the stage renders no bar, which is
   * also what a build with `VITE_LIVE_REACTIONS` unset gets.
   */
  onLiveReaction?: (emoji: LiveReactionEmoji) => void;
}

/**
 * One share: today's stage. Two on a wide window: split. Three or more, and
 * any count on a narrow window: one large tile plus a strip to switch.
 *
 * Only the visible branch is mounted. A CSS-hidden live `<video>` still
 * decodes, and on a phone that is two extra 1080p30 decodes per share.
 */
export function ScreenStage({
  tiles,
  focusedPeerId,
  onFocus,
  onStopSharing,
  channelId,
  onLiveReaction,
}: ScreenStageProps) {
  const { t } = useTranslation();
  const wide = useLgUp();
  const hidePreview = useHideScreenPreview();
  // Which share is filling the viewport in-page, on the platforms with no
  // element fullscreen (an iPhone). Owned here rather than by each view so two
  // shares cannot both cover the screen, one buried under the other. Real
  // element fullscreen needs no coordination: the browser only ever has one.
  const [expandedPeerId, setExpandedPeerId] = useState<string | null>(null);
  const tileKey = tiles.map((tile) => tile.peerId).join(",");
  useEffect(() => {
    const peerIds = tileKey === "" ? [] : tileKey.split(",");
    setExpandedPeerId((current) =>
      current !== null && !peerIds.includes(current) ? null : current,
    );
  }, [tileKey]);
  if (tiles.length === 0) {
    return null;
  }
  const expansionProps = (peerId: string) => ({
    expanded: expandedPeerId === peerId,
    // Storing one id rather than a flag per tile is what makes "only one" true
    // by construction: expanding the second share replaces the first.
    onExpandedChange: (next: boolean) =>
      setExpandedPeerId(next ? peerId : null),
  });
  const focused =
    tiles.find((tile) => tile.peerId === focusedPeerId) ?? tiles[0]!;
  const splitTwo = screenShareStageLayout(tiles.length, wide) === "split";
  // Reactions belong to the room, not to a tile, so they are drawn over the
  // whole stage rather than per share: with two shares up, the room is still
  // one room and the confetti is still one crowd's. The three conditions are
  // deliberately separate (the build flag, a channel to address, and a way to
  // send) so a caller that supplies only some of them gets nothing rather
  // than half a feature.
  const liveReactions =
    isLiveReactionsEnabled() && channelId !== undefined && onLiveReaction
      ? { channelId, onReact: onLiveReaction }
      : null;

  return (
    <div className="relative flex max-h-[45%] min-h-[160px] shrink-0 flex-col border-b border-panel-hover bg-ink">
      {splitTwo ? (
        <div className="grid min-h-0 flex-1 grid-cols-2">
          {tiles.map((tile) => (
            <ScreenShareView
              key={tile.peerId}
              variant="tile"
              stream={tile.stream}
              presenterName={tile.presenterName}
              isSelf={tile.isSelf}
              onStopSharing={tile.isSelf ? onStopSharing : undefined}
              {...expansionProps(tile.peerId)}
            />
          ))}
        </div>
      ) : (
        <div className="min-h-0 flex-1">
          <ScreenShareView
            variant="tile"
            stream={focused.stream}
            presenterName={focused.presenterName}
            isSelf={focused.isSelf}
            onStopSharing={focused.isSelf ? onStopSharing : undefined}
            {...expansionProps(focused.peerId)}
          />
        </div>
      )}
      {liveReactions ? (
        <>
          <LiveReactionsOverlay channelId={liveReactions.channelId} />
          <LiveReactionsBar
            channelId={liveReactions.channelId}
            onReact={liveReactions.onReact}
          />
        </>
      ) : null}
      {!splitTwo && tiles.length > 1 && (
        <div className="flex shrink-0 gap-1 overflow-x-auto border-t border-panel-hover p-1">
          {tiles.map((tile) => {
            const selected = tile.peerId === focused.peerId;
            return (
              <button
                key={tile.peerId}
                type="button"
                className={cn(
                  "flex min-w-[7.5rem] max-w-[9rem] flex-col overflow-hidden rounded-md bg-black ring-1 ring-panel-hover",
                  selected && "ring-2 ring-signal",
                )}
                aria-pressed={selected}
                aria-label={t("voice.share.focus", { name: tile.presenterName })}
                onClick={() => onFocus(tile.peerId)}
              >
                {tile.isSelf && hidePreview ? (
                  <div className="flex h-16 items-center justify-center bg-ink-2 px-1 text-[10px] text-paper-muted">
                    {t("voice.share.youAreSharing")}
                  </div>
                ) : (
                  <ThumbVideo stream={tile.stream} />
                )}
                <span className="truncate px-1 py-0.5 text-[10px] text-paper-muted">
                  {tile.isSelf
                    ? t("voice.share.youPresenting")
                    : tile.presenterName}
                </span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
