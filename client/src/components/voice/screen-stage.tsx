import { useEffect, useRef } from "react";
import type { RemotePeer } from "@/lib/peer-connection-manager";
import { ScreenShareView } from "@/components/voice/screen-share-view";
import { useTranslation } from "@/lib/i18n";
import { cn } from "@/lib/utils";

export interface ScreenShareTile {
  peerId: string;
  stream: MediaStream | null;
  presenterName: string;
  isSelf: boolean;
}

export function collectScreenTiles(args: {
  peerIds: string[];
  localPeerId: string | null;
  localName: string;
  localStream: MediaStream | null;
  remotePeers: RemotePeer[];
  fallbackName: string;
}): ScreenShareTile[] {
  return args.peerIds.map((peerId) => {
    if (peerId === args.localPeerId) {
      return {
        peerId,
        stream: args.localStream,
        presenterName: args.localName,
        isSelf: true,
      };
    }
    const remote = args.remotePeers.find((peer) => peer.peerId === peerId);
    return {
      peerId,
      stream: remote?.screenStream ?? null,
      presenterName: remote?.displayName ?? args.fallbackName,
      isSelf: false,
    };
  });
}

function ThumbVideo({ stream }: { stream: MediaStream | null }) {
  const ref = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    const video = ref.current;
    if (!video) {
      return;
    }
    video.srcObject = stream;
    if (stream) {
      void video.play().catch(() => {});
    }
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

interface ScreenStageProps {
  tiles: ScreenShareTile[];
  focusedPeerId: string | null;
  onFocus: (peerId: string) => void;
  onStopSharing?: () => void;
}

/**
 * One share: today's stage. Two on a wide window: split. Three or more, and
 * any count on a narrow window: one large tile plus a strip to switch.
 */
export function ScreenStage({
  tiles,
  focusedPeerId,
  onFocus,
  onStopSharing,
}: ScreenStageProps) {
  const { t } = useTranslation();
  if (tiles.length === 0) {
    return null;
  }
  const focused =
    tiles.find((tile) => tile.peerId === focusedPeerId) ?? tiles[0]!;
  const splitTwo = tiles.length === 2;

  return (
    <div className="flex max-h-[45%] min-h-[160px] shrink-0 flex-col border-b border-panel-hover bg-ink">
      {splitTwo && (
        <div className="hidden min-h-0 flex-1 grid-cols-2 lg:grid">
          {tiles.map((tile) => (
            <ScreenShareView
              key={tile.peerId}
              variant="tile"
              stream={tile.stream}
              presenterName={tile.presenterName}
              isSelf={tile.isSelf}
              onStopSharing={tile.isSelf ? onStopSharing : undefined}
            />
          ))}
        </div>
      )}
      <div className={cn("min-h-0 flex-1", splitTwo && "lg:hidden")}>
        <ScreenShareView
          variant="tile"
          stream={focused.stream}
          presenterName={focused.presenterName}
          isSelf={focused.isSelf}
          onStopSharing={focused.isSelf ? onStopSharing : undefined}
        />
      </div>
      {tiles.length > 1 && (
        <div
          className={cn(
            "flex shrink-0 gap-1 overflow-x-auto border-t border-panel-hover p-1",
            splitTwo && "lg:hidden",
          )}
        >
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
                <ThumbVideo stream={tile.stream} />
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
