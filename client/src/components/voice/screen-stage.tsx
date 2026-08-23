import { useEffect, useRef } from "react";
import type { RemotePeer } from "@/lib/peer-connection-manager";
import { ScreenShareView } from "@/components/voice/screen-share-view";
import { useLgUp } from "@/hooks/use-lg-up";
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
}: ScreenStageProps) {
  const { t } = useTranslation();
  const wide = useLgUp();
  if (tiles.length === 0) {
    return null;
  }
  const focused =
    tiles.find((tile) => tile.peerId === focusedPeerId) ?? tiles[0]!;
  const splitTwo = screenShareStageLayout(tiles.length, wide) === "split";

  return (
    <div className="flex max-h-[45%] min-h-[160px] shrink-0 flex-col border-b border-panel-hover bg-ink">
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
          />
        </div>
      )}
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
