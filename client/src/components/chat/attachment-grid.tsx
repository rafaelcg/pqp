import {
  isAudioContentType,
  isImageContentType,
  isVideoContentType,
  type Attachment,
} from "@pqp/shared";
import {
  Download,
  File as FileIcon,
  FileAudio,
  FileText,
  FileVideo,
  ImageOff,
} from "lucide-react";
import {
  DownloadSimple,
  File as FileGlyph,
  FileAudio as FileAudioGlyph,
  FileText as FileTextGlyph,
  FileVideo as FileVideoGlyph,
  ImageBroken,
  type Icon as Glyph,
} from "@phosphor-icons/react";
import { useEffect, useMemo, useRef, useState } from "react";
import { ImageLightbox } from "@/components/chat/image-lightbox";
import { VoiceNoteCard, type VoiceNoteMessage } from "@/components/chat/voice-note-card";
import {
  CONTENT_CARD_FOCUS_REDESIGN,
  CONTENT_CARD_HOVER_REDESIGN,
  CONTENT_CARD_REDESIGN,
  CONTENT_GLYPH_TILE_REDESIGN,
  CONTENT_MEDIA_REDESIGN,
} from "@/components/ui/content-card";
import { Icon as PhosphorIcon } from "@/components/ui/icon";
import { fetchAttachmentUrl } from "@/lib/api";
import { formatByteSize } from "@/lib/attachments";
import { translateMessage } from "@/lib/i18n";
import { cn } from "@/lib/utils";

/** Big enough to read a screenshot, small enough that one image is not the pane. */
const MAX_TILE_WIDTH_PX = 400;
const MAX_TILE_HEIGHT_PX = 320;

interface AttachmentGridProps {
  attachments: Attachment[];
  /**
   * The message these belong to. With it, an attachment carrying a `voice`
   * block is drawn as a voice note card; without it (or for a client that
   * has no idea what `voice` is) it stays the plain audio player.
   */
  voiceMessage?: VoiceNoteMessage;
}

/**
 * Everything a message carries below its body: images inline, anything else as
 * a download chip.
 *
 * Rendered from the structured `attachments` array and never from the message
 * body — `img` is deliberately absent from the markdown allowlist in
 * message-list.tsx, so this is the only path by which an image reaches the
 * conversation, and every URL in it was minted by the server for a reader who
 * has already been access-checked.
 */
export function AttachmentGrid({ attachments, voiceMessage }: AttachmentGridProps) {
  const [lightboxIndex, setLightboxIndex] = useState<number | null>(null);

  // The lightbox navigates only the images of this one message — a video or a
  // PDF chip sitting between two photos is not something arrow keys should
  // stop on.
  const images = useMemo(
    () => attachments.filter((a) => isImageContentType(a.contentType)),
    [attachments],
  );

  if (attachments.length === 0) {
    return null;
  }

  return (
    <>
      <div className="mt-1.5 flex flex-wrap items-start gap-2">
        {attachments.map((attachment) =>
          attachment.voice && voiceMessage ? (
            <VoiceNoteCard
              key={attachment.id}
              attachment={{ ...attachment, voice: attachment.voice }}
              message={voiceMessage}
            />
          ) : isImageContentType(attachment.contentType) ? (
            <ImageTile
              key={attachment.id}
              attachment={attachment}
              onOpen={() =>
                setLightboxIndex(images.findIndex((img) => img.id === attachment.id))
              }
            />
          ) : isVideoContentType(attachment.contentType) ? (
            <VideoTile key={attachment.id} attachment={attachment} />
          ) : isAudioContentType(attachment.contentType) ? (
            <AudioTile key={attachment.id} attachment={attachment} />
          ) : (
            <DownloadChip key={attachment.id} attachment={attachment} />
          ),
        )}
      </div>

      {lightboxIndex !== null && (
        <ImageLightbox
          attachments={images}
          index={lightboxIndex}
          onClose={() => setLightboxIndex(null)}
          onIndexChange={setLightboxIndex}
        />
      )}
    </>
  );
}

/**
 * The box an image occupies before a single byte of it has loaded.
 *
 * Null when the upload happened without readable dimensions (an older row, or a
 * file the browser could not decode at pick time); the tile then falls back to
 * a max-height image and accepts one reflow rather than guessing an aspect
 * ratio and being visibly wrong about it.
 */
function tileBox(
  width: number | null,
  height: number | null,
): { width: number; height: number } | null {
  if (!width || !height) {
    return null;
  }
  const scale = Math.min(
    1,
    MAX_TILE_WIDTH_PX / width,
    MAX_TILE_HEIGHT_PX / height,
  );
  return {
    width: Math.round(width * scale),
    height: Math.round(height * scale),
  };
}

function ImageTile({
  attachment,
  onOpen,
}: {
  attachment: Attachment;
  onOpen: () => void;
}) {
  const [src, setSrc] = useState(attachment.url);
  const [isBroken, setIsBroken] = useState(false);
  /**
   * One refetch per URL and no more. A genuinely dead object fails again on the
   * fresh URL, and without this the second failure would ask for a third URL
   * for ever — a retry loop against our own API, one per image on screen.
   */
  const hasRetried = useRef(false);

  // A newer response carries a newer presigned URL, which earns a new attempt.
  useEffect(() => {
    hasRetried.current = false;
    setSrc(attachment.url);
    setIsBroken(false);
  }, [attachment.url]);

  function handleError() {
    if (hasRetried.current) {
      setIsBroken(true);
      return;
    }
    hasRetried.current = true;
    void fetchAttachmentUrl(attachment.id)
      .then((fresh) => setSrc(fresh.url))
      .catch(() => setIsBroken(true));
  }

  // Expired is the common case and heals itself; deleted is the rare one, and
  // the chip at least still names what used to be there.
  if (isBroken) {
    return <DownloadChip attachment={attachment} unavailable />;
  }

  const box = tileBox(attachment.width, attachment.height);

  return (
    <button
      type="button"
      onClick={onOpen}
      aria-label={translateMessage("chat.openAttachment", {
        name: attachment.filename,
      })}
      style={box ? { width: box.width, height: box.height } : undefined}
      className={cn(
        "block overflow-hidden rounded-md border border-ink-4 bg-ink-3/40 transition-colors hover:border-signal/60 focus-visible:border-signal focus-visible:outline-none",
        !box && "max-w-full",
        CONTENT_MEDIA_REDESIGN,
        "redesign:hover:border-[color:var(--color-border-strong)] redesign:focus-visible:border-transparent",
        CONTENT_CARD_FOCUS_REDESIGN,
      )}
    >
      <img
        src={src}
        alt={attachment.filename}
        loading="lazy"
        decoding="async"
        onError={handleError}
        style={box ? undefined : { maxHeight: `${MAX_TILE_HEIGHT_PX}px` }}
        className={cn(
          "block",
          box ? "h-full w-full object-cover" : "w-auto max-w-full",
        )}
      />
    </button>
  );
}

/**
 * A video renders as a player that has fetched NOTHING. `preload="none"` is
 * the whole feature: a channel full of clips costs its readers zero bytes
 * until one of them presses play, which is also the owner's asked-for
 * "download, then play" behaviour — the browser streams on demand rather than
 * pulling every asset on scroll. `playsInline` keeps iOS from hijacking
 * playback into its own fullscreen, and `controls` delegates play/pause/seek
 * to the platform rather than reinventing them.
 *
 * The presigned URL can expire before anyone presses play (default TTL is
 * hours, but a message can sit unread for days), so the first media error
 * refetches a fresh URL once — the same contract as ImageTile, for the same
 * reason, with the same single-retry bound.
 */
function VideoTile({ attachment }: { attachment: Attachment }) {
  const [src, setSrc] = useState(attachment.url);
  const hasRetried = useRef(false);

  useEffect(() => {
    hasRetried.current = false;
    setSrc(attachment.url);
  }, [attachment.url]);

  function handleError() {
    if (hasRetried.current) {
      return;
    }
    hasRetried.current = true;
    void fetchAttachmentUrl(attachment.id)
      .then((fresh) => setSrc(fresh.url))
      .catch(() => {
        // The chip below the player still offers the plain download.
      });
  }

  return (
    <div className={cn("max-w-full overflow-hidden rounded-md border border-ink-4 bg-ink-3/40", CONTENT_MEDIA_REDESIGN)}>
      <video
        src={src}
        controls
        preload="none"
        playsInline
        onError={handleError}
        style={{ maxHeight: `${MAX_TILE_HEIGHT_PX}px` }}
        className="block w-auto max-w-full"
      />
      <div className="truncate px-2 py-1 text-xs text-text-muted redesign:px-3 redesign:py-1.5 redesign:text-text-secondary">
        {attachment.filename}
      </div>
    </div>
  );
}

/**
 * Audio needs no click gate: the native controls are already compact, and
 * `preload="none"` means rendering them fetches nothing.
 */
function AudioTile({ attachment }: { attachment: Attachment }) {
  const [src, setSrc] = useState(attachment.url);
  const hasRetried = useRef(false);

  useEffect(() => {
    hasRetried.current = false;
    setSrc(attachment.url);
  }, [attachment.url]);

  function handleError() {
    if (hasRetried.current) {
      return;
    }
    hasRetried.current = true;
    void fetchAttachmentUrl(attachment.id)
      .then((fresh) => setSrc(fresh.url))
      .catch(() => {});
  }

  return (
    <div className={cn("w-72 max-w-full rounded-md border border-ink-4 bg-ink-3/40 p-2", CONTENT_CARD_REDESIGN, "redesign:p-2.5")}>
      <audio
        src={src}
        controls
        preload="none"
        onError={handleError}
        className="block w-full"
      />
      <div className="truncate pt-1 text-xs text-text-muted redesign:px-1 redesign:pt-1.5 redesign:text-text-secondary">
        {attachment.filename}
      </div>
    </div>
  );
}

function typeIcon(contentType: string) {
  if (contentType.startsWith("video/")) {
    return FileVideo;
  }
  if (contentType.startsWith("audio/")) {
    return FileAudio;
  }
  if (contentType === "application/pdf" || contentType.startsWith("text/")) {
    return FileText;
  }
  return FileIcon;
}

function typeGlyph(contentType: string): Glyph {
  if (contentType.startsWith("video/")) {
    return FileVideoGlyph;
  }
  if (contentType.startsWith("audio/")) {
    return FileAudioGlyph;
  }
  if (contentType === "application/pdf" || contentType.startsWith("text/")) {
    return FileTextGlyph;
  }
  return FileGlyph;
}

function DownloadChip({
  attachment,
  unavailable = false,
}: {
  attachment: Attachment;
  unavailable?: boolean;
}) {
  const Icon = unavailable ? ImageOff : typeIcon(attachment.contentType);
  const glyph = unavailable ? ImageBroken : typeGlyph(attachment.contentType);

  return (
    <a
      href={attachment.url}
      // Cross-origin storage ignores this attribute; what actually forces a
      // download is the `response-content-disposition` the server signed into
      // the URL, so that nothing user-uploaded can render as a document in a
      // tab on our own origin. This is here for the filename it suggests.
      download={attachment.filename}
      rel="noopener noreferrer"
      className={cn(
        "flex max-w-[20rem] items-center gap-2.5 rounded-md border border-ink-4 bg-ink-3/60 px-3 py-2 text-sm text-paper transition-colors hover:border-signal/60 hover:bg-ink-3",
        CONTENT_CARD_REDESIGN,
        CONTENT_CARD_HOVER_REDESIGN,
        CONTENT_CARD_FOCUS_REDESIGN,
        "redesign:gap-3 redesign:py-2 redesign:pl-2 redesign:pr-3 redesign:text-text",
      )}
    >
      <Icon className="h-5 w-5 shrink-0 text-paper-muted redesign:hidden" />
      <span className={cn("hidden", CONTENT_GLYPH_TILE_REDESIGN, unavailable && "redesign:text-text-tertiary")}>
        <PhosphorIcon icon={glyph} size="md" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate redesign:font-medium">{attachment.filename}</span>
        <span className="block text-[11px] text-paper-muted redesign:text-xs redesign:text-text-tertiary">
          {unavailable
            ? "Image unavailable"
            : formatByteSize(attachment.byteSize)}
        </span>
      </span>
      <Download className="h-4 w-4 shrink-0 text-paper-muted redesign:hidden" />
      <PhosphorIcon
        icon={DownloadSimple}
        kind="symbol"
        size="sm"
        className="hidden text-text-secondary redesign:block"
      />
    </a>
  );
}
