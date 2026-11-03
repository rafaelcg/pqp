import {
  isAudioContentType,
  isImageContentType,
  isVideoContentType,
  type Attachment,
} from "@pqp/shared";
import {
  Copy,
  Download,
  File as FileIcon,
  FileAudio,
  FileText,
  FileVideo,
  ImageOff,
  Link as LinkIcon,
  Reply,
  SmilePlus,
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
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { flushSync } from "react-dom";
import { ImageLightbox, LIGHTBOX_TRANSITION_NAME } from "@/components/chat/image-lightbox";
import { VoiceNoteCard, type VoiceNoteMessage } from "@/components/chat/voice-note-card";
import {
  CONTENT_CARD_FOCUS_REDESIGN,
  CONTENT_CARD_HOVER_REDESIGN,
  CONTENT_CARD_REDESIGN,
  CONTENT_GLYPH_TILE_REDESIGN,
  CONTENT_MEDIA_REDESIGN,
} from "@/components/ui/content-card";
import { ContextMenu, type ContextMenuItemDef } from "@/components/ui/context-menu";
import { Icon as PhosphorIcon } from "@/components/ui/icon";
import { fetchAttachmentUrl } from "@/lib/api";
import { formatByteSize } from "@/lib/attachments";
import { translateMessage, useTranslation } from "@/lib/i18n";
import { copyImageToClipboard, downloadImage } from "@/lib/image-actions";
import { useRedesign } from "@/lib/redesign";
import { cn } from "@/lib/utils";

/** Big enough to read a screenshot, small enough that one image is not the pane. */
const MAX_TILE_WIDTH_PX = 400;
const MAX_TILE_HEIGHT_PX = 320;
/** Under the redesign, the most images a message shows before "+N". */
const GRID_MAX = 4;
/** How long "Imagem copiada" stays on the image. */
const IMAGE_NOTICE_MS = 1600;

/** What an image's right-click menu can do beyond copy and save. */
interface ImageMenuActions {
  onReply?: () => void;
  onReact?: () => void;
}

interface AttachmentGridProps {
  attachments: Attachment[];
  /**
   * The message these belong to. With it, an attachment carrying a `voice`
   * block is drawn as a voice note card; without it (or for a client that
   * has no idea what `voice` is) it stays the plain audio player.
   */
  voiceMessage?: VoiceNoteMessage;
  /** Under the redesign: Responder in an image's right-click menu. */
  onReply?: () => void;
  /** Under the redesign: Reagir in an image's right-click menu. */
  onReact?: () => void;
  /** Under the redesign: the lightbox's Ver no canal. */
  onViewInChannel?: () => void;
  /** The message is on screen while its files still upload (redesign only). */
  uploading?: boolean;
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
export function AttachmentGrid({
  attachments,
  voiceMessage,
  onReply,
  onReact,
  onViewInChannel,
  uploading = false,
}: AttachmentGridProps) {
  const [lightboxIndex, setLightboxIndex] = useState<number | null>(null);
  const [transitionId, setTransitionId] = useState<string | null>(null);
  const redesign = useRedesign();
  const gridRef = useRef<HTMLDivElement>(null);

  // The lightbox navigates only the images of this one message — a video or a
  // PDF chip sitting between two photos is not something arrow keys should
  // stop on.
  const images = useMemo(
    () => attachments.filter((a) => isImageContentType(a.contentType)),
    [attachments],
  );

  // No menu on a file that is not on the server yet: its link is local.
  const menu: ImageMenuActions | null = useMemo(
    () => (redesign && !uploading ? { onReply, onReact } : null),
    [redesign, uploading, onReply, onReact],
  );

  if (attachments.length === 0) {
    return null;
  }

  /*
   * Under the redesign the thumbnail grows into the open picture and shrinks
   * back on close (the text channels canvas, "Movimento", 8), through a View
   * Transition. Without support, or with reduced motion, it simply opens.
   */
  const thumbOf = (id: string | undefined) =>
    id
      ? gridRef.current?.querySelector<HTMLElement>(
          `[data-attachment-tile="${CSS.escape(id)}"] img`,
        ) ?? null
      : null;
  const viewTransition = () => {
    const start = (
      document as Document & { startViewTransition?: (update: () => void) => { finished: Promise<void> } }
    ).startViewTransition;
    if (!redesign || !start || window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) {
      return null;
    }
    return start.bind(document);
  };
  const openLightbox = (index: number) => {
    const id = images[index]?.id;
    const thumb = thumbOf(id);
    const start = viewTransition();
    if (!start || !thumb || !id) {
      setLightboxIndex(index);
      return;
    }
    thumb.style.viewTransitionName = LIGHTBOX_TRANSITION_NAME;
    start(() => {
      thumb.style.viewTransitionName = "";
      flushSync(() => {
        setTransitionId(id);
        setLightboxIndex(index);
      });
    });
  };
  const closeLightbox = () => {
    const id = lightboxIndex === null ? undefined : images[lightboxIndex]?.id;
    const thumb = id === transitionId ? thumbOf(id) : null;
    const start = viewTransition();
    if (!start || !thumb) {
      setTransitionId(null);
      setLightboxIndex(null);
      return;
    }
    start(() => {
      flushSync(() => {
        setTransitionId(null);
        setLightboxIndex(null);
      });
      thumb.style.viewTransitionName = LIGHTBOX_TRANSITION_NAME;
    }).finished.finally(() => {
      thumb.style.viewTransitionName = "";
    });
  };

  // Under the redesign two or more images share one grid of at most four
  // (the text channels canvas, "Várias de uma vez"); the last cell says how
  // many more the lightbox holds.
  const grid = redesign && images.length >= 2;

  return (
    <>
      <div ref={gridRef} className="mt-1.5 flex flex-wrap items-start gap-2">
        {grid && (
          <ImageGrid images={images} menu={menu} uploading={uploading} onOpen={openLightbox} />
        )}
        {attachments.map((attachment) =>
          attachment.voice && voiceMessage ? (
            <VoiceNoteCard
              key={attachment.id}
              attachment={{ ...attachment, voice: attachment.voice }}
              message={voiceMessage}
            />
          ) : isImageContentType(attachment.contentType) ? (
            grid ? null : (
              <ImageTile
                key={attachment.id}
                attachment={attachment}
                menu={menu}
                uploading={uploading}
                onOpen={() =>
                  openLightbox(images.findIndex((img) => img.id === attachment.id))
                }
              />
            )
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
          onClose={closeLightbox}
          onIndexChange={setLightboxIndex}
          transitionId={transitionId}
          onViewInChannel={redesign && onViewInChannel ? () => onViewInChannel() : undefined}
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

function ImageGrid({
  images,
  menu,
  uploading,
  onOpen,
}: {
  images: Attachment[];
  menu: ImageMenuActions | null;
  uploading: boolean;
  onOpen: (index: number) => void;
}) {
  const shown = images.slice(0, GRID_MAX);
  const hidden = images.length - shown.length;
  return (
    <div data-attachment-grid="" className="grid w-full max-w-[396px] grid-cols-2 gap-1">
      {shown.map((attachment, index) => (
        <ImageTile
          key={attachment.id}
          attachment={attachment}
          menu={menu}
          uploading={uploading}
          cell
          more={index === shown.length - 1 && hidden > 0 ? hidden : 0}
          onOpen={() => onOpen(index)}
        />
      ))}
    </div>
  );
}

function ImageTile({
  attachment,
  onOpen,
  menu = null,
  cell = false,
  more = 0,
  uploading = false,
}: {
  attachment: Attachment;
  onOpen: () => void;
  /** Set under the redesign: the image gets its own right-click menu. */
  menu?: ImageMenuActions | null;
  /** A cell of the redesign's grid: a fixed 148px row, cropped to fill. */
  cell?: boolean;
  /** On the grid's last cell, how many images did not fit. */
  more?: number;
  /** Still going up: a bar along the bottom of the image. */
  uploading?: boolean;
}) {
  const { t } = useTranslation();
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

  const box = cell ? null : tileBox(attachment.width, attachment.height);

  // Expired is the common case and heals itself; deleted is the rare one, and
  // the chip at least still names what used to be there. Under the redesign
  // the image keeps its place instead, so nothing around it moves.
  if (isBroken) {
    if (!menu) {
      return <DownloadChip attachment={attachment} unavailable />;
    }
    return (
      <div
        data-attachment-unavailable=""
        style={box ? { width: box.width, height: box.height } : undefined}
        className={cn(
          "flex flex-col items-center justify-center gap-2 rounded-md bg-surface-1 px-4 text-center text-xs text-text-tertiary ring-1 ring-inset ring-border",
          cell ? "h-[148px] w-full" : !box && "h-40 w-64 max-w-full",
        )}
      >
        <PhosphorIcon icon={ImageBroken} size="md" />
        {t("chat.attachmentGone")}
      </div>
    );
  }

  const tile = (
    <button
      type="button"
      onClick={onOpen}
      data-attachment-tile={attachment.id}
      aria-label={
        more > 0
          ? t("chat.image.moreLabel", { count: more })
          : translateMessage("chat.openAttachment", { name: attachment.filename })
      }
      style={box ? { width: box.width, height: box.height } : undefined}
      className={cn(
        "relative block overflow-hidden rounded-md border border-ink-4 bg-ink-3/40 transition-colors hover:border-signal/60 focus-visible:border-signal focus-visible:outline-none",
        !box && !cell && "max-w-full",
        cell && "h-[148px] w-full",
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
        style={box || cell ? undefined : { maxHeight: `${MAX_TILE_HEIGHT_PX}px` }}
        className={cn(
          "block",
          // Unsized (an upload still measuring): the same 400px cap a sized
          // tile gets, so it does not jump when the real size arrives.
          box || cell ? "h-full w-full object-cover" : "w-auto max-w-full redesign:max-w-[400px]",
        )}
      />
      {uploading && (
        <span
          data-attachment-uploading=""
          className="absolute inset-x-1.5 bottom-1.5 h-1 overflow-hidden rounded-full bg-[color:var(--overlay)]"
        >
          <span className="block h-full w-1/3 animate-pulse rounded-full bg-accent" />
          <span className="sr-only">{t("composer.uploading", { name: attachment.filename })}</span>
        </span>
      )}
      {more > 0 && (
        <span
          aria-hidden="true"
          className="absolute inset-0 grid place-items-center bg-[color:var(--overlay)] text-xl font-bold text-[color:var(--color-on-media)]"
        >
          {t("chat.image.more", { count: more })}
        </span>
      )}
    </button>
  );

  return menu ? (
    <ImageMenu attachment={attachment} src={src} menu={menu}>
      {tile}
    </ImageMenu>
  ) : (
    tile
  );
}

/**
 * Right-click on an image under the redesign (the text channels canvas,
 * "Clique direito numa imagem"): the image's own actions first, then the
 * message's Responder and Reagir. The wrapper keeps the right-click from also
 * opening the row's message menu. What happened shows on the image itself
 * for a moment, since the list has no toast.
 */
function ImageMenu({
  attachment,
  src,
  menu,
  children,
}: {
  attachment: Attachment;
  src: string;
  menu: ImageMenuActions;
  children: ReactNode;
}) {
  const { t } = useTranslation();
  const [notice, setNotice] = useState<string | null>(null);
  const timer = useRef<number | null>(null);
  useEffect(
    () => () => {
      if (timer.current !== null) {
        window.clearTimeout(timer.current);
      }
    },
    [],
  );
  function show(text: string) {
    if (timer.current !== null) {
      window.clearTimeout(timer.current);
    }
    setNotice(text);
    timer.current = window.setTimeout(() => setNotice(null), IMAGE_NOTICE_MS);
  }

  const items: ContextMenuItemDef[] = [
    {
      id: "copy",
      label: t("chat.image.copy"),
      icon: Copy,
      onSelect: () => {
        copyImageToClipboard(src, attachment.contentType)
          .then(() => show(t("chat.image.copied")))
          .catch(() => show(t("lightbox.copyFailedNoFallbackToast")));
      },
    },
    {
      id: "save",
      label: t("chat.image.save"),
      icon: Download,
      onSelect: () => void downloadImage(src, attachment.filename),
    },
    {
      id: "copy-link",
      label: t("chat.image.copyLink"),
      icon: LinkIcon,
      onSelect: () => {
        navigator.clipboard
          .writeText(src)
          .then(() => show(t("lightbox.copyLinkDone")))
          .catch(() => show(t("lightbox.copyLinkFailedToast")));
      },
    },
  ];
  if (menu.onReply || menu.onReact) {
    items.push({ id: "sep", label: "", separator: true });
  }
  if (menu.onReply) {
    items.push({ id: "reply", label: t("chat.reply"), icon: Reply, onSelect: menu.onReply });
  }
  if (menu.onReact) {
    items.push({ id: "react", label: t("chat.image.react"), icon: SmilePlus, onSelect: menu.onReact });
  }

  return (
    <span
      data-image-menu=""
      className="relative block min-w-0"
      onContextMenu={(event) => event.stopPropagation()}
    >
      <ContextMenu items={items}>{children}</ContextMenu>
      {notice && (
        <span
          role="status"
          className="pointer-events-none absolute bottom-2 left-1/2 -translate-x-1/2 whitespace-nowrap rounded-full bg-[color:var(--overlay)] px-3 py-1 text-xs font-semibold text-[color:var(--color-on-media)]"
        >
          {notice}
        </span>
      )}
    </span>
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
            ? translateMessage("chat.attachmentGone")
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
