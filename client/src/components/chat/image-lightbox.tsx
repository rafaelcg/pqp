import type { Attachment } from "@pqp/shared";
import {
  ChevronLeft,
  ChevronRight,
  Copy,
  Download,
  ExternalLink,
  ImageOff,
  Link as LinkIcon,
  X,
  ZoomIn,
  ZoomOut,
} from "lucide-react";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type TouchEvent as ReactTouchEvent,
} from "react";
import { createPortal } from "react-dom";
import { Button } from "@/components/ui/button";
import { Tooltip } from "@/components/ui/tooltip";
import { formatByteSize } from "@/lib/attachments";
import { fetchAttachmentUrl } from "@/lib/api";
import { useTranslation } from "@/lib/i18n";
import {
  canZoomToActualSize,
  clampPanOffset,
  computeFit,
  formatDimensions,
  nextLightboxIndex,
  planImageCopy,
  type Size,
} from "@/lib/image-lightbox";
import { cn } from "@/lib/utils";

const FOCUSABLE =
  'a[href], button:not([disabled]), [tabindex]:not([tabindex="-1"])';

/** How long the icon swap ("Copied") stays up before reverting. */
const COPY_FLASH_MS = 1500;
/** How long the failure toast stays up. */
const TOAST_MS = 3000;

interface ImageLightboxProps {
  /** Already filtered to images — the navigable strip for this message/post. */
  attachments: Attachment[];
  index: number;
  onClose: () => void;
  onIndexChange: (index: number) => void;
}

/**
 * The full-viewport photo viewer opened from a message's, or a Baú post's,
 * image attachments.
 *
 * Deliberately not built on `Dialog`: that primitive draws a bordered,
 * width-capped panel with a big title bar, which is the exact "too small"
 * complaint this replaces (2026-09-14). It borrows Dialog's contract instead
 * — `role="dialog"`, a focus trap, Escape only when this is the top layer,
 * focus restored to whatever opened it — so `escapeOwnedByOverlay` and any
 * other overlay-aware code still treats it correctly.
 */
export function ImageLightbox({
  attachments,
  index,
  onClose,
  onIndexChange,
}: ImageLightboxProps) {
  const { t } = useTranslation();
  const panelRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const previouslyFocused = useRef<HTMLElement | null>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  // The keydown listener below is wired up once, at mount, so anything it
  // reads has to come through a ref kept fresh every render rather than a
  // value the listener's closure captured back on that first render — the
  // same trap CLAUDE.md's Clerk pitfall describes for a token getter.
  const indexRef = useRef(index);
  indexRef.current = index;
  const attachmentsRef = useRef(attachments);
  attachmentsRef.current = attachments;
  const onIndexChangeRef = useRef(onIndexChange);
  onIndexChangeRef.current = onIndexChange;

  const current = attachments[index];

  const [resolvedUrl, setResolvedUrl] = useState<Record<string, string>>({});
  const retriedRef = useRef(new Set<string>());
  const [broken, setBroken] = useState<Set<string>>(new Set());
  const [loaded, setLoaded] = useState<Set<string>>(new Set());
  const [measured, setMeasured] = useState<Record<string, Size>>({});
  const [zoomed, setZoomed] = useState(false);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [stageSize, setStageSize] = useState<Size>({ width: 0, height: 0 });
  const [justCopied, setJustCopied] = useState<"image" | "link" | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  const copyFlashTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const dragRef = useRef<{
    startX: number;
    startY: number;
    originX: number;
    originY: number;
  } | null>(null);
  const touchStartRef = useRef<{ x: number; y: number } | null>(null);

  // ------------------------------------------------------------- attachment src

  const src = current ? (resolvedUrl[current.id] ?? current.url) : "";
  const isBroken = current ? broken.has(current.id) : false;
  const isLoaded = current ? loaded.has(current.id) : false;

  const natural: Size | null = current
    ? (measured[current.id] ??
      (current.width && current.height
        ? { width: current.width, height: current.height }
        : null))
    : null;

  // `stageSize` is `{0, 0}` for one frame before the ResizeObserver's first
  // callback; `computeFit` treats that the same as "not known yet" and
  // returns the (degenerate) viewport, which correctly reads as no zoom to
  // offer rather than a flash of a zoom button that immediately disappears.
  const canZoom =
    natural !== null && canZoomToActualSize(natural, computeFit(natural, stageSize));

  function handleLoad(attachmentId: string, event: React.SyntheticEvent<HTMLImageElement>) {
    const img = event.currentTarget;
    setLoaded((prev) => new Set(prev).add(attachmentId));
    if (img.naturalWidth > 0 && img.naturalHeight > 0) {
      setMeasured((prev) =>
        prev[attachmentId]
          ? prev
          : {
              ...prev,
              [attachmentId]: {
                width: img.naturalWidth,
                height: img.naturalHeight,
              },
            },
      );
    }
  }

  function handleImgError(attachment: Attachment) {
    if (retriedRef.current.has(attachment.id)) {
      setBroken((prev) => new Set(prev).add(attachment.id));
      return;
    }
    retriedRef.current.add(attachment.id);
    void fetchAttachmentUrl(attachment.id)
      .then((fresh) =>
        setResolvedUrl((prev) => ({ ...prev, [attachment.id]: fresh.url })),
      )
      .catch(() => setBroken((prev) => new Set(prev).add(attachment.id)));
  }

  // Preload the neighbours so an arrow press or a swipe feels instant. Best
  // effort only — a failed preload just means the neighbour loads normally
  // when it becomes current.
  useEffect(() => {
    for (const neighbourIndex of [index - 1, index + 1]) {
      const neighbour = attachments[neighbourIndex];
      if (neighbour) {
        const warm = new Image();
        warm.src = resolvedUrl[neighbour.id] ?? neighbour.url;
      }
    }
  }, [index, attachments, resolvedUrl]);

  // A new image starts at fit, never carrying over the last one's zoom.
  useEffect(() => {
    setZoomed(false);
    setPan({ x: 0, y: 0 });
  }, [index]);

  // -------------------------------------------------------------- navigation

  // Stable across every render on purpose — it reads the refs above rather
  // than closing over `index`/`attachments`/`onIndexChange` directly, so the
  // keydown effect (mounted once) can call it years after mount and still
  // move from wherever the strip actually is, not from the first render.
  const go = useCallback((direction: -1 | 1) => {
    const next = nextLightboxIndex(
      indexRef.current,
      attachmentsRef.current.length,
      direction,
    );
    if (next !== null) {
      onIndexChangeRef.current(next);
    }
  }, []);

  const hasPrev = nextLightboxIndex(index, attachments.length, -1) !== null;
  const hasNext = nextLightboxIndex(index, attachments.length, 1) !== null;

  // ------------------------------------------------------------------ toasts

  function showToast(message: string) {
    if (toastTimer.current) {
      clearTimeout(toastTimer.current);
    }
    setToast(message);
    toastTimer.current = setTimeout(() => setToast(null), TOAST_MS);
  }

  function flashCopied(kind: "image" | "link") {
    if (copyFlashTimer.current) {
      clearTimeout(copyFlashTimer.current);
    }
    setJustCopied(kind);
    copyFlashTimer.current = setTimeout(() => setJustCopied(null), COPY_FLASH_MS);
  }

  useEffect(
    () => () => {
      if (copyFlashTimer.current) clearTimeout(copyFlashTimer.current);
      if (toastTimer.current) clearTimeout(toastTimer.current);
    },
    [],
  );

  // ------------------------------------------------------------------ actions

  async function convertToPng(blob: Blob): Promise<Blob> {
    const bitmap = await createImageBitmap(blob);
    try {
      const canvas = document.createElement("canvas");
      canvas.width = bitmap.width;
      canvas.height = bitmap.height;
      const ctx = canvas.getContext("2d");
      if (!ctx) {
        throw new Error("no 2d context");
      }
      ctx.drawImage(bitmap, 0, 0);
      const pngBlob = await new Promise<Blob>((resolve, reject) => {
        canvas.toBlob(
          (result) => (result ? resolve(result) : reject(new Error("toBlob failed"))),
          "image/png",
        );
      });
      return pngBlob;
    } finally {
      bitmap.close?.();
    }
  }

  async function copyLinkFallback(url: string) {
    try {
      await navigator.clipboard.writeText(url);
    } catch {
      // Best effort — the toast below still names what was attempted, and a
      // clipboard that refuses plain text refuses everything else here too.
    }
    showToast(t("lightbox.copyFailedToast"));
  }

  async function handleCopyImage() {
    if (!current) return;
    const plan = planImageCopy(current.contentType);
    try {
      if (
        typeof navigator.clipboard?.write !== "function" ||
        typeof ClipboardItem === "undefined"
      ) {
        throw new Error("Clipboard image writes unsupported");
      }
      const response = await fetch(src);
      if (!response.ok) {
        throw new Error(`fetch failed: ${response.status}`);
      }
      const sourceBlob = await response.blob();
      const pngBlob = plan.needsConversion
        ? await convertToPng(sourceBlob)
        : sourceBlob;
      const items: Record<string, Blob> = { "image/png": pngBlob };
      if (plan.includeLinkText) {
        items["text/plain"] = new Blob([current.url], { type: "text/plain" });
      }
      await navigator.clipboard.write([new ClipboardItem(items)]);
      flashCopied("image");
    } catch {
      await copyLinkFallback(current.url);
    }
  }

  async function handleCopyLink() {
    if (!current) return;
    try {
      await navigator.clipboard.writeText(current.url);
      flashCopied("link");
    } catch {
      showToast(t("lightbox.copyLinkFailedToast"));
    }
  }

  async function handleDownload() {
    if (!current) return;
    try {
      const response = await fetch(src);
      if (!response.ok) {
        throw new Error(`fetch failed: ${response.status}`);
      }
      const blob = await response.blob();
      const blobUrl = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = blobUrl;
      anchor.download = current.filename;
      anchor.rel = "noopener";
      anchor.click();
      setTimeout(() => URL.revokeObjectURL(blobUrl), 1000);
    } catch {
      // The presigned GET for an image is not signed for a forced download
      // (it has to render inline in the grid), and a cross-origin bucket
      // ignores the `download` attribute anyway — opening it is the honest
      // fallback rather than a download that silently never starts.
      window.open(current.url, "_blank", "noopener,noreferrer");
    }
  }

  function toggleZoom() {
    if (!canZoom) return;
    setZoomed((z) => !z);
    setPan({ x: 0, y: 0 });
  }

  // --------------------------------------------------------------- panning

  function handlePointerDown(event: ReactPointerEvent<HTMLDivElement>) {
    if (!zoomed || (event.pointerType !== "mouse" && event.pointerType !== "pen")) {
      return;
    }
    dragRef.current = {
      startX: event.clientX,
      startY: event.clientY,
      originX: pan.x,
      originY: pan.y,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
  }

  function handlePointerMove(event: ReactPointerEvent<HTMLDivElement>) {
    if (!dragRef.current || !natural) return;
    const dx = event.clientX - dragRef.current.startX;
    const dy = event.clientY - dragRef.current.startY;
    setPan({
      x: clampPanOffset(dragRef.current.originX + dx, natural.width, stageSize.width),
      y: clampPanOffset(dragRef.current.originY + dy, natural.height, stageSize.height),
    });
  }

  function handlePointerUp() {
    dragRef.current = null;
  }

  function handleWheel(event: React.WheelEvent<HTMLDivElement>) {
    if (!zoomed || !natural) return;
    event.preventDefault();
    setPan((prev) => ({
      x: clampPanOffset(prev.x - event.deltaX, natural.width, stageSize.width),
      y: clampPanOffset(prev.y - event.deltaY, natural.height, stageSize.height),
    }));
  }

  function handleDoubleClick() {
    toggleZoom();
  }

  // Single-finger swipe only. Any second touch (a pinch) is left completely
  // alone — no preventDefault, no state — so the browser's native pinch-zoom
  // keeps working over this overlay exactly like it does everywhere else.
  function handleTouchStart(event: ReactTouchEvent<HTMLDivElement>) {
    if (event.touches.length !== 1) {
      touchStartRef.current = null;
      return;
    }
    const touch = event.touches[0]!;
    touchStartRef.current = { x: touch.clientX, y: touch.clientY };
  }

  function handleTouchEnd(event: ReactTouchEvent<HTMLDivElement>) {
    const start = touchStartRef.current;
    touchStartRef.current = null;
    if (!start || zoomed || event.changedTouches.length !== 1) return;
    const touch = event.changedTouches[0]!;
    const dx = touch.clientX - start.x;
    const dy = touch.clientY - start.y;
    if (Math.abs(dx) > 48 && Math.abs(dx) > Math.abs(dy) * 1.5) {
      go(dx < 0 ? 1 : -1);
    }
  }

  // ------------------------------------------------------- focus, esc, resize

  const focusables = useCallback(() => {
    const panel = panelRef.current;
    if (!panel) return [] as HTMLElement[];
    return [...panel.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(
      (node) => node.offsetParent !== null || node === document.activeElement,
    );
  }, []);

  useEffect(() => {
    previouslyFocused.current = document.activeElement as HTMLElement | null;
    const timer = window.setTimeout(() => {
      const panel = panelRef.current;
      if (!panel || panel.contains(document.activeElement)) return;
      (focusables()[0] ?? panel).focus();
    }, 0);

    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    function isTopLayer(): boolean {
      const layer = panelRef.current?.closest("[data-dialog-layer]");
      const layers = document.querySelectorAll("[data-dialog-layer]");
      return !layer || layers[layers.length - 1] === layer;
    }

    function onKeyDown(event: KeyboardEvent) {
      if (!isTopLayer()) return;
      if (event.key === "Escape") {
        event.stopPropagation();
        onCloseRef.current();
        return;
      }
      if (event.key === "ArrowLeft") {
        event.preventDefault();
        go(-1);
        return;
      }
      if (event.key === "ArrowRight") {
        event.preventDefault();
        go(1);
        return;
      }
      if (event.key !== "Tab") return;
      const nodes = focusables();
      if (nodes.length === 0) {
        event.preventDefault();
        return;
      }
      const first = nodes[0]!;
      const last = nodes[nodes.length - 1]!;
      const active = document.activeElement;
      if (event.shiftKey && (active === first || !panelRef.current?.contains(active))) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && active === last) {
        event.preventDefault();
        first.focus();
      }
    }

    document.addEventListener("keydown", onKeyDown, true);
    return () => {
      window.clearTimeout(timer);
      document.removeEventListener("keydown", onKeyDown, true);
      document.body.style.overflow = previousOverflow;
      if (previouslyFocused.current?.isConnected) {
        previouslyFocused.current.focus();
      }
    };
    // Mount/unmount only — `go` and `focusables` close over fresh state via
    // refs where it matters, and re-running this per keystroke would tear the
    // trap down mid-interaction the same way Dialog's own comment explains.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;
    const measure = () =>
      setStageSize({ width: stage.clientWidth, height: stage.clientHeight });
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(stage);
    return () => observer.disconnect();
  }, []);

  const dimensions = natural ? formatDimensions(natural.width, natural.height) : null;
  const sizeLabel = current ? formatByteSize(current.byteSize) : "";
  const metaLabel = [dimensions, sizeLabel].filter(Boolean).join(" · ");

  if (!current) {
    return null;
  }

  return createPortal(
    <div
      data-dialog-layer=""
      role="dialog"
      aria-modal="true"
      aria-label={current.filename}
      ref={panelRef}
      tabIndex={-1}
      className="fixed inset-0 z-[60] flex flex-col outline-none"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) {
          onClose();
        }
      }}
    >
      <div aria-hidden="true" className="absolute inset-0 bg-surface-0/95" />

      {/* Top bar */}
      <div className="relative z-10 flex items-center gap-2 border-b border-border bg-surface-0/90 px-3 py-2 backdrop-blur-sm sm:px-4">
        <div className="hidden min-w-0 flex-1 sm:block">
          <p
            className="truncate text-sm font-medium text-text"
            title={current.filename}
          >
            {current.filename}
          </p>
          {metaLabel && (
            <p className="truncate text-xs text-text-tertiary">{metaLabel}</p>
          )}
        </div>
        <div className="flex-1 sm:hidden" />

        {attachments.length > 1 && (
          <span className="shrink-0 text-xs tabular-nums text-text-tertiary">
            {t("lightbox.counter", { position: index + 1, total: attachments.length })}
          </span>
        )}

        <div className="flex shrink-0 items-center gap-0.5 overflow-x-auto">
          <Tooltip
            label={
              justCopied === "image"
                ? t("lightbox.copyImageDone")
                : t("lightbox.copyImage")
            }
            detail={
              planImageCopy(current.contentType).reason === "gif"
                ? t("lightbox.copyImageGifDetail")
                : undefined
            }
          >
            <Button
              variant="ghost"
              size="icon"
              className="h-11 w-11"
              onClick={() => void handleCopyImage()}
              disabled={isBroken}
            >
              <Copy className="h-4 w-4" />
            </Button>
          </Tooltip>

          <Tooltip
            label={
              justCopied === "link" ? t("lightbox.copyLinkDone") : t("lightbox.copyLink")
            }
          >
            <Button
              variant="ghost"
              size="icon"
              className="h-11 w-11"
              onClick={() => void handleCopyLink()}
            >
              <LinkIcon className="h-4 w-4" />
            </Button>
          </Tooltip>

          {/* A plain `<a>` rather than `<Button asChild>`: Tooltip's trigger
              only needs a single element that forwards a ref to a real DOM
              node, and a native anchor is the simplest thing that qualifies —
              no Slot-through-Slot composition to get right. Classes mirror
              `variant="ghost" size="icon"` by hand. */}
          <Tooltip label={t("lightbox.openOriginal")}>
            <a
              href={current.url}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex h-11 w-11 items-center justify-center gap-2 whitespace-nowrap rounded-[var(--radius-control)] text-text-tertiary transition-[background,color,transform] duration-[var(--duration-fast)] hover:bg-surface-2 hover:text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-offset-ring-offset focus-visible:ring-focus-ring active:scale-[0.98]"
            >
              <ExternalLink className="h-4 w-4" />
            </a>
          </Tooltip>

          <Tooltip label={t("lightbox.download")}>
            <Button
              variant="ghost"
              size="icon"
              className="h-11 w-11"
              onClick={() => void handleDownload()}
              disabled={isBroken}
            >
              <Download className="h-4 w-4" />
            </Button>
          </Tooltip>

          {canZoom && (
            <Tooltip label={zoomed ? t("lightbox.zoomOut") : t("lightbox.zoomIn")}>
              <Button
                variant="ghost"
                size="icon"
                className="h-11 w-11"
                onClick={toggleZoom}
                aria-pressed={zoomed}
              >
                {zoomed ? <ZoomOut className="h-4 w-4" /> : <ZoomIn className="h-4 w-4" />}
              </Button>
            </Tooltip>
          )}

          <Tooltip label={t("lightbox.close")}>
            <Button
              variant="ghost"
              size="icon"
              className="h-11 w-11"
              onClick={onClose}
            >
              <X className="h-4 w-4" />
            </Button>
          </Tooltip>
        </div>
      </div>

      {/* Stage */}
      <div
        ref={stageRef}
        className="group relative flex min-h-0 flex-1 items-center justify-center overflow-hidden p-6"
        onWheel={handleWheel}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerUp}
        onDoubleClick={handleDoubleClick}
        onTouchStart={handleTouchStart}
        onTouchEnd={handleTouchEnd}
      >
        {isBroken ? (
          <div className="flex flex-col items-center gap-2 text-text-tertiary">
            <ImageOff className="h-10 w-10" />
            <p className="text-sm">{t("chat.attachmentUnavailable")}</p>
          </div>
        ) : (
          <>
            {!isLoaded && (
              <img
                src={src}
                alt=""
                aria-hidden="true"
                draggable={false}
                className="pointer-events-none absolute max-h-full max-w-full scale-110 object-contain opacity-40 blur-2xl"
              />
            )}
            <img
              key={current.id}
              src={src}
              alt={current.filename}
              draggable={false}
              onLoad={(event) => handleLoad(current.id, event)}
              onError={() => handleImgError(current)}
              style={
                zoomed && natural
                  ? {
                      width: natural.width,
                      height: natural.height,
                      transform: `translate(${pan.x}px, ${pan.y}px)`,
                    }
                  : undefined
              }
              className={cn(
                "select-none object-contain transition-opacity duration-200",
                isLoaded ? "opacity-100" : "opacity-0",
                // No `touch-action` override here on purpose, in either state:
                // the drag-to-pan gesture below only answers to mouse and pen
                // pointer events, so a touch is never claimed by it, and native
                // pinch-zoom stays exactly as available at 1:1 as it is at fit.
                zoomed
                  ? "max-w-none max-h-none cursor-grab active:cursor-grabbing"
                  : cn("max-h-full max-w-full", canZoom && "cursor-zoom-in"),
              )}
            />
          </>
        )}

        {hasPrev && (
          <button
            type="button"
            aria-label={t("lightbox.previous")}
            onClick={() => go(-1)}
            className="absolute left-2 top-1/2 z-10 flex h-11 w-11 -translate-y-1/2 items-center justify-center rounded-full bg-surface-0/70 text-text opacity-100 transition-opacity hover:bg-surface-1 sm:opacity-0 sm:group-hover:opacity-100 sm:group-focus-within:opacity-100"
          >
            <ChevronLeft className="h-5 w-5" />
          </button>
        )}
        {hasNext && (
          <button
            type="button"
            aria-label={t("lightbox.next")}
            onClick={() => go(1)}
            className="absolute right-2 top-1/2 z-10 flex h-11 w-11 -translate-y-1/2 items-center justify-center rounded-full bg-surface-0/70 text-text opacity-100 transition-opacity hover:bg-surface-1 sm:opacity-0 sm:group-hover:opacity-100 sm:group-focus-within:opacity-100"
          >
            <ChevronRight className="h-5 w-5" />
          </button>
        )}
      </div>

      {/* Bottom hint, desktop only */}
      <div className="relative z-10 hidden items-center justify-center border-t border-border bg-surface-0/70 py-1.5 text-center text-[11px] text-text-tertiary sm:flex">
        {t("lightbox.hint")}
      </div>

      {toast && (
        <div
          role="status"
          className="absolute bottom-14 left-1/2 z-20 -translate-x-1/2 rounded-[var(--radius-control)] bg-surface-2 px-3 py-1.5 text-xs text-text shadow-[var(--shadow-popover)] sm:bottom-10"
        >
          {toast}
        </div>
      )}
    </div>,
    document.body,
  );
}
