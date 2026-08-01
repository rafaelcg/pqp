import { isImageContentType, type Attachment } from "@pqp/shared";
import {
  Download,
  File as FileIcon,
  FileAudio,
  FileText,
  FileVideo,
  ImageOff,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Dialog } from "@/components/ui/dialog";
import { fetchAttachmentUrl } from "@/lib/api";
import { formatByteSize } from "@/lib/attachments";
import { cn } from "@/lib/utils";

/** Big enough to read a screenshot, small enough that one image is not the pane. */
const MAX_TILE_WIDTH_PX = 400;
const MAX_TILE_HEIGHT_PX = 320;

interface AttachmentGridProps {
  attachments: Attachment[];
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
export function AttachmentGrid({ attachments }: AttachmentGridProps) {
  const [lightbox, setLightbox] = useState<{
    attachment: Attachment;
    src: string;
  } | null>(null);

  if (attachments.length === 0) {
    return null;
  }

  return (
    <>
      <div className="mt-1.5 flex flex-wrap items-start gap-2">
        {attachments.map((attachment) =>
          isImageContentType(attachment.contentType) ? (
            <ImageTile
              key={attachment.id}
              attachment={attachment}
              onOpen={(src) => setLightbox({ attachment, src })}
            />
          ) : (
            <DownloadChip key={attachment.id} attachment={attachment} />
          ),
        )}
      </div>

      {/* The shared Dialog owns the focus trap, Escape, and putting focus back
          on the thumbnail that opened it. */}
      <Dialog
        open={lightbox !== null}
        title={lightbox?.attachment.filename ?? ""}
        size="lg"
        onClose={() => setLightbox(null)}
      >
        {lightbox && (
          <img
            src={lightbox.src}
            alt={lightbox.attachment.filename}
            className="mx-auto max-h-[72vh] w-auto max-w-full"
          />
        )}
      </Dialog>
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
  onOpen: (src: string) => void;
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
      onClick={() => onOpen(src)}
      aria-label={`Open ${attachment.filename}`}
      style={box ? { width: box.width, height: box.height } : undefined}
      className={cn(
        "block overflow-hidden rounded-md border border-ink-4 bg-ink-3/40 transition-colors hover:border-signal/60 focus-visible:border-signal focus-visible:outline-none",
        !box && "max-w-full",
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

function DownloadChip({
  attachment,
  unavailable = false,
}: {
  attachment: Attachment;
  unavailable?: boolean;
}) {
  const Icon = unavailable ? ImageOff : typeIcon(attachment.contentType);

  return (
    <a
      href={attachment.url}
      // Cross-origin storage ignores this attribute; what actually forces a
      // download is the `response-content-disposition` the server signed into
      // the URL, so that nothing user-uploaded can render as a document in a
      // tab on our own origin. This is here for the filename it suggests.
      download={attachment.filename}
      rel="noopener noreferrer"
      className="flex max-w-[20rem] items-center gap-2.5 rounded-md border border-ink-4 bg-ink-3/60 px-3 py-2 text-sm text-paper transition-colors hover:border-signal/60 hover:bg-ink-3"
    >
      <Icon className="h-5 w-5 shrink-0 text-paper-muted" />
      <span className="min-w-0 flex-1">
        <span className="block truncate">{attachment.filename}</span>
        <span className="block text-[11px] text-paper-muted">
          {unavailable
            ? "Image unavailable"
            : formatByteSize(attachment.byteSize)}
        </span>
      </span>
      <Download className="h-4 w-4 shrink-0 text-paper-muted" />
    </a>
  );
}
