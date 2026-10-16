import { ZoomIn, ZoomOut } from "lucide-react";
import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent,
} from "react";
import { USER_BANNER_HEIGHT, USER_BANNER_WIDTH } from "@pqp/shared";
import { Button } from "@/components/ui/button";
import { Dialog, DialogBody } from "@/components/ui/dialog";
import { Slider } from "@/components/ui/slider";
import { useTranslation } from "@/lib/i18n";
import {
  MAX_CROP_ZOOM,
  MIN_CROP_ZOOM,
  cropRegion,
  imageLayout,
  initialCropView,
  panView,
  wheelZoomFactor,
  zoomView,
  type CropRegion,
  type CropView,
} from "@/lib/image-crop";
import { cn } from "@/lib/utils";

/**
 * The step between picking a picture in Perfil and uploading it: frame it.
 *
 * Until this existed the avatar and the banner were cut from the middle of
 * whatever was picked, so a photo whose face was not in the centre lost it.
 * Here the frame has the shape the picture will have (a circle over a square
 * for the avatar, the banner's own 3:1), the person drags the picture under it
 * and zooms, and Save hands back the part they framed. The canvas work stays in
 * `lib/avatar.ts` and the upload path is unchanged: what is uploaded is still a
 * JPEG this browser produced, so nothing changes on the server.
 *
 * Mouse, touch and keyboard all move the same view. Pointer events cover the
 * first two in one path (one pointer pans, two pinch), the wheel and a
 * trackpad pinch (a wheel event with `ctrlKey`) zoom under the cursor, and the
 * frame takes arrow keys, + and - and 0 when it has focus. The slider is a
 * plain Radix slider, so it has its own keys too.
 *
 * An animated GIF is decoded to its first frame by `createImageBitmap`, so it
 * is saved as a still. The dialog says so rather than letting the animation in
 * the preview promise otherwise.
 */

export type ImageCropShape = "avatar" | "banner";

const ASPECT: Record<ImageCropShape, number> = {
  avatar: 1,
  banner: USER_BANNER_WIDTH / USER_BANNER_HEIGHT,
};

/** One arrow press, in CSS pixels of the frame; Shift moves four times as far. */
const KEY_PAN_STEP = 10;
/** One + or - press. Ten presses from 1 is about 2.6×. */
const KEY_ZOOM_STEP = 1.1;

interface ImageCropDialogProps {
  /** The picked file. The dialog is open while this is set. */
  file: File | null;
  shape: ImageCropShape;
  onCancel: () => void;
  /** The part of the picture the person framed, as fractions of it. */
  onConfirm: (region: CropRegion) => void;
}

export function ImageCropDialog({
  file,
  shape,
  onCancel,
  onConfirm,
}: ImageCropDialogProps) {
  const { t } = useTranslation();
  const aspect = ASPECT[shape];
  const keysId = useId();
  // State rather than a ref, so measuring and the wheel listener follow the
  // frame element itself: the dialog may mount it a render after it opens.
  const [frame, setFrame] = useState<HTMLDivElement | null>(null);
  const [src, setSrc] = useState<string | null>(null);
  const [view, setView] = useState<CropView | null>(null);
  const [unreadable, setUnreadable] = useState(false);
  const [frameWidth, setFrameWidth] = useState(0);
  /** Read from pointer and wheel handlers without re-binding them. */
  const frameWidthRef = useRef(0);
  /** Every pointer that is down on the frame, where it was last seen. */
  const pointers = useRef(new Map<number, { x: number; y: number }>());

  // A fresh object URL per file, released when the file changes or the dialog
  // closes. The `<img>` honours EXIF orientation, which is the same picture
  // `createImageBitmap(…, { imageOrientation: "from-image" })` decodes later.
  useEffect(() => {
    setView(null);
    setUnreadable(false);
    if (!file) {
      setSrc(null);
      return;
    }
    const url = URL.createObjectURL(file);
    setSrc(url);
    return () => URL.revokeObjectURL(url);
  }, [file]);

  useLayoutEffect(() => {
    if (!frame) {
      return;
    }
    const element = frame;
    function measure() {
      // The layout width, not the painted one: the dialog rises in with a
      // transform, and a width read mid-animation would leave the picture a
      // few pixels short of the frame's edge until something else resized it.
      const width = element.offsetWidth;
      frameWidthRef.current = width;
      setFrameWidth(width);
    }
    measure();
    if (typeof ResizeObserver === "undefined") {
      window.addEventListener("resize", measure);
      return () => window.removeEventListener("resize", measure);
    }
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [frame]);

  const update = useCallback((change: (current: CropView) => CropView) => {
    setView((current) => (current ? change(current) : current));
  }, []);

  // The wheel needs a non-passive listener to stop the page (or the settings
  // pane behind the dialog) scrolling while the picture zooms, and React's
  // `onWheel` is passive.
  useEffect(() => {
    if (!frame) {
      return;
    }
    const element = frame;
    function onWheel(event: WheelEvent) {
      event.preventDefault();
      const box = element.getBoundingClientRect();
      const focusX = box.width > 0 ? (event.clientX - box.left) / box.width : 0.5;
      const focusY = box.height > 0 ? (event.clientY - box.top) / box.height : 0.5;
      // A trackpad pinch arrives as a wheel with `ctrlKey` and small deltas;
      // it is a zoom like any other, so it takes the same path.
      const factor = wheelZoomFactor(event.deltaY);
      update((current) => zoomView(current, current.zoom * factor, focusX, focusY));
    }
    element.addEventListener("wheel", onWheel, { passive: false });
    return () => element.removeEventListener("wheel", onWheel);
  }, [frame, update]);

  function onPointerDown(event: PointerEvent<HTMLDivElement>) {
    if (!view) {
      return;
    }
    try {
      event.currentTarget.setPointerCapture(event.pointerId);
    } catch {
      // A synthetic or already-released pointer; panning still works while it
      // stays over the frame.
    }
    pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
  }

  function onPointerMove(event: PointerEvent<HTMLDivElement>) {
    const map = pointers.current;
    const previous = map.get(event.pointerId);
    if (!previous) {
      return;
    }
    const next = { x: event.clientX, y: event.clientY };
    const dx = next.x - previous.x;
    const dy = next.y - previous.y;
    const width = frameWidthRef.current;

    if (map.size >= 2) {
      // A pinch. Only this finger moved, so the distance to the other one says
      // how much, and the point between them is where the zoom is anchored.
      const other = [...map.entries()].find(([id]) => id !== event.pointerId)?.[1];
      map.set(event.pointerId, next);
      if (!other) {
        return;
      }
      const before = Math.hypot(previous.x - other.x, previous.y - other.y);
      const after = Math.hypot(next.x - other.x, next.y - other.y);
      if (before <= 0) {
        return;
      }
      const box = event.currentTarget.getBoundingClientRect();
      const focusX = box.width > 0 ? ((next.x + other.x) / 2 - box.left) / box.width : 0.5;
      const focusY = box.height > 0 ? ((next.y + other.y) / 2 - box.top) / box.height : 0.5;
      // The midpoint moved by half this finger's travel: follow it too, so two
      // fingers moving together drag the picture as well as zoom it.
      update((current) =>
        panView(
          zoomView(current, current.zoom * (after / before), focusX, focusY),
          dx / 2,
          dy / 2,
          width,
        ),
      );
      return;
    }

    map.set(event.pointerId, next);
    update((current) => panView(current, dx, dy, width));
  }

  function onPointerEnd(event: PointerEvent<HTMLDivElement>) {
    pointers.current.delete(event.pointerId);
  }

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    const step = event.shiftKey ? KEY_PAN_STEP * 4 : KEY_PAN_STEP;
    const width = frameWidthRef.current;
    let change: ((current: CropView) => CropView) | null = null;
    switch (event.key) {
      case "ArrowLeft":
        change = (current) => panView(current, -step, 0, width);
        break;
      case "ArrowRight":
        change = (current) => panView(current, step, 0, width);
        break;
      case "ArrowUp":
        change = (current) => panView(current, 0, -step, width);
        break;
      case "ArrowDown":
        change = (current) => panView(current, 0, step, width);
        break;
      case "+":
      case "=":
        change = (current) => zoomView(current, current.zoom * KEY_ZOOM_STEP);
        break;
      case "-":
      case "_":
        change = (current) => zoomView(current, current.zoom / KEY_ZOOM_STEP);
        break;
      case "0":
        change = (current) =>
          initialCropView(current.imageWidth, current.imageHeight, current.aspect);
        break;
      default:
        return;
    }
    event.preventDefault();
    update(change);
  }

  const layout = view && frameWidth > 0 ? imageLayout(view, frameWidth) : null;
  const isGif = file?.type === "image/gif";

  return (
    <Dialog
      open={file !== null}
      title={t(
        shape === "avatar"
          ? "settings.profile.crop.avatarTitle"
          : "settings.profile.crop.bannerTitle",
      )}
      description={t("settings.profile.crop.hint")}
      size={shape === "banner" ? "lg" : "md"}
      closeOnBackdrop={false}
      onClose={onCancel}
      footer={
        <div className="grid w-full min-w-0 grid-cols-2 gap-2">
          <Button
            type="button"
            variant="ghost"
            className="h-auto min-h-9 w-full min-w-0 whitespace-normal px-2 text-center max-sm:min-h-11"
            onClick={onCancel}
          >
            {t("common.cancel")}
          </Button>
          <Button
            type="button"
            disabled={!view}
            data-crop-save=""
            className="h-auto min-h-9 w-full min-w-0 whitespace-normal px-2 text-center max-sm:min-h-11"
            onClick={() => {
              if (view) {
                onConfirm(cropRegion(view));
              }
            }}
          >
            {t("common.save")}
          </Button>
        </div>
      }
    >
      <DialogBody className="space-y-4">
        <div
          ref={setFrame}
          data-crop-frame={shape}
          tabIndex={0}
          role="group"
          aria-label={t("settings.profile.crop.area")}
          aria-describedby={keysId}
          className={cn(
            "relative mx-auto w-full touch-none select-none overflow-hidden bg-surface-2 outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-ring-offset",
            shape === "avatar"
              ? "max-w-72 rounded-[var(--radius-card)]"
              : "rounded-[var(--radius-card)]",
            view ? "cursor-grab active:cursor-grabbing" : "cursor-default",
          )}
          style={{ aspectRatio: `${aspect}` }}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerEnd}
          onPointerCancel={onPointerEnd}
          onKeyDown={onKeyDown}
        >
          {src && !unreadable ? (
            <img
              src={src}
              alt=""
              draggable={false}
              decoding="async"
              data-crop-image=""
              className="pointer-events-none absolute max-w-none"
              style={
                layout
                  ? {
                      left: layout.left,
                      top: layout.top,
                      width: layout.width,
                      height: layout.height,
                    }
                  : { visibility: "hidden" }
              }
              onLoad={(event) => {
                const image = event.currentTarget;
                if (image.naturalWidth > 0 && image.naturalHeight > 0) {
                  setView(
                    initialCropView(image.naturalWidth, image.naturalHeight, aspect),
                  );
                } else {
                  setUnreadable(true);
                }
              }}
              onError={() => setUnreadable(true)}
            />
          ) : null}
          {shape === "avatar" ? (
            // The avatar is drawn in a circle everywhere, so the corners the
            // square keeps are shaded: what is bright is what people will see.
            <div
              aria-hidden
              className="pointer-events-none absolute inset-0 rounded-full shadow-[0_0_0_9999px_var(--scrim-media)]"
            />
          ) : null}
        </div>

        {unreadable ? (
          <p role="alert" className="text-sm text-danger">
            {t("settings.profile.crop.unreadable")}
          </p>
        ) : null}

        <div className="flex items-center gap-3">
          <ZoomOut aria-hidden className="h-4 w-4 shrink-0 text-text-tertiary" />
          <Slider
            variant="volume"
            className="flex-1"
            min={MIN_CROP_ZOOM}
            max={MAX_CROP_ZOOM}
            step={0.01}
            value={view?.zoom ?? MIN_CROP_ZOOM}
            disabled={!view}
            aria-label={t("settings.profile.crop.zoom")}
            aria-valuetext={`${Math.round((view?.zoom ?? MIN_CROP_ZOOM) * 100)}%`}
            onValueChange={(zoom) => update((current) => zoomView(current, zoom))}
          />
          <ZoomIn aria-hidden className="h-4 w-4 shrink-0 text-text-tertiary" />
        </div>

        <p id={keysId} className="text-xs text-text-tertiary">
          {t("settings.profile.crop.keys")}
        </p>
        {isGif ? (
          <p className="text-xs text-text-secondary" data-crop-gif="">
            {t("settings.profile.crop.gif")}
          </p>
        ) : null}
      </DialogBody>
    </Dialog>
  );
}
