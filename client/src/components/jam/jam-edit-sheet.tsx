import { JAM_ARTIST_MAX, JAM_TITLE_MAX, type JamSongSummary } from "@pqp/shared";
import { Camera, Check, ImagePlus, Trash2 } from "lucide-react";
import { useEffect, useId, useRef, useState, type CSSProperties } from "react";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Dialog, DialogBody } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { ImageCropDialog } from "@/components/user/image-crop-dialog";
import { useFileDropZone } from "@/hooks/use-file-drop-zone";
import { ApiError } from "@/lib/api";
import { firstDroppedFile } from "@/lib/file-drop";
import { useTranslation, type MessageKey } from "@/lib/i18n";
import type { CropRegion } from "@/lib/image-crop";
import { jamErrorKind, removeJamCover, setJamCover, updateJamSong } from "@/lib/jam-api";
import {
  checkCoverPicture,
  cleanSongTitle,
  isCoverPicture,
  JAM_COVER_MIN_SIDE,
  JAM_COVER_ACCEPT,
  JamCoverError,
  planJamEdit,
  uploadJamCover,
  type JamCoverChoice,
} from "@/lib/jam-cover";
import { cn } from "@/lib/utils";
import { BandArt } from "./jam-artwork";
import { JamCoverPhoto, useJamCover } from "./jam-cover";

/**
 * Editing a song: its name, its artist and its cover photo, in one small sheet.
 * Opened from the song panel for the people the server lets edit it (the song's
 * author or a moderator, `viewer.isAuthor || viewer.canModerate`); the server
 * decides again on every write, and a 403 here is said in words and the panel is
 * asked to read what this person may do again.
 *
 * THE PICTURE ON THE LEFT IS THE TILE, LIVE. What is edited is shown the way the
 * song will look in the list: the photo (cropped to the tile's shape, so the
 * person sees what the square frame leaves out), the scrim, the waveform, and the
 * name and artist as they are typed. Nothing is a mock-up of a form field.
 *
 * THE COVER IS SENT WHEN IT IS PICKED, CLAIMED WHEN THEY SAVE. Picking a photo
 * frames it (the same crop step the avatar has), crops it to a square JPEG in
 * the browser and uploads it straight to storage while the person goes on typing;
 * the tile shows the picked photo at once, dimmed under a progress ring, and then
 * as it will be. Nothing about the song changes until Save, which claims the
 * upload, so closing the sheet leaves the old cover exactly as it was. Save sends
 * only what changed, in the order name, then picture, and each answer is written
 * to the wall as the song's own update frame (`onSong`), so every other viewer
 * sees the change the way they see any edit.
 */

export interface JamEditSheetProps {
  open: boolean;
  song: JamSongSummary;
  onClose: () => void;
  /** The song as the server answered a write: the panel applies it to the store. */
  onSong: (song: JamSongSummary) => void;
  /** The server said this person may not edit: the panel reads their permissions again. */
  onDenied?: () => void;
}

type Upload =
  | { status: "idle" }
  | { status: "uploading"; fraction: number }
  | { status: "failed"; message: string };

export function JamEditSheet({ open, song, onClose, onSong, onDenied }: JamEditSheetProps) {
  const { t } = useTranslation();
  const formId = useId();
  const fileInput = useRef<HTMLInputElement | null>(null);
  const abort = useRef<AbortController | null>(null);
  // What the person typed, or null while a field is untouched: an untouched field
  // shows (and sends) nothing of its own, so it follows the song as it is now, and a
  // name changed in another window is never written back over.
  const [titleEdit, setTitleEdit] = useState<string | null>(null);
  const [artistEdit, setArtistEdit] = useState<string | null>(null);
  const title = titleEdit ?? song.title;
  const artist = artistEdit ?? song.artist ?? "";
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const [cover, setCover] = useState<JamCoverChoice>({ kind: "keep" });
  const [preview, setPreview] = useState<string | null>(null);
  /** The framed picture while it goes up: it becomes the preview only if the upload lands. */
  const [pending, setPending] = useState<string | null>(null);
  const [upload, setUpload] = useState<Upload>({ status: "idle" });
  const [cropping, setCropping] = useState<File | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [touched, setTouched] = useState(false);

  const replacePreview = (next: string | null) =>
    setPreview((before) => {
      if (before && before !== next) URL.revokeObjectURL(before);
      return next;
    });
  const replacePending = (next: string | null) =>
    setPending((before) => {
      if (before && before !== next) URL.revokeObjectURL(before);
      return next;
    });

  // Every time the sheet opens it starts from the song as it is now.
  useEffect(() => {
    if (open) {
      setTitleEdit(null);
      setArtistEdit(null);
      setConfirmDiscard(false);
      setCover({ kind: "keep" });
      replacePreview(null);
      replacePending(null);
      setUpload({ status: "idle" });
      setCropping(null);
      setNote(null);
      setSaving(false);
      setError(null);
      setTouched(false);
    } else {
      abort.current?.abort();
      // Closed: nothing keeps the picked picture's local address alive.
      replacePreview(null);
      replacePending(null);
    }
  }, [open]);
  useEffect(
    () => () => {
      abort.current?.abort();
      setPreview((before) => {
        if (before) URL.revokeObjectURL(before);
        return null;
      });
      setPending((before) => {
        if (before) URL.revokeObjectURL(before);
        return null;
      });
    },
    [],
  );

  const plan = planJamEdit(song, { title, artist, cover });
  const titleMissing = cleanSongTitle(title) === null;
  // Empty is said as soon as it is empty (an empty title also disables Save, and a
  // disabled button cannot be pressed to find out why).
  const showTitleError = titleMissing && (touched || title !== song.title);
  const uploading = upload.status === "uploading";
  // Something would be lost by closing: a change that Save would send, or a photo going up.
  const dirty = !plan.empty || uploading;
  /** Close the sheet; with something typed or picked it asks first, so Escape and a stray click do not throw it away. */
  function requestClose() {
    if (saving) return;
    if (dirty) {
      setConfirmDiscard(true);
      return;
    }
    onClose();
  }
  const hasPhoto = cover.kind === "new" || uploading || (cover.kind === "keep" && song.coverUrl !== null);

  async function pick(file: File | null) {
    if (!file) return;
    if (!isCoverPicture(file)) {
      setUpload({ status: "failed", message: t("jam.edit.photoType") });
      return;
    }
    setUpload({ status: "idle" });
    // Looked at BEFORE the crop step: a text file renamed .jpg, or a picture too small
    // to be a cover, is refused here in words, not after the person has framed it.
    const check = await checkCoverPicture(file);
    if (!check.ok) {
      setUpload({
        status: "failed",
        message:
          check.reason === "small"
            ? t("jam.edit.photoSmall", { min: JAM_COVER_MIN_SIDE, width: check.width, height: check.height })
            : t("jam.edit.photoUnreadable"),
      });
      return;
    }
    setCropping(file);
  }

  async function send(file: File, region: CropRegion, picture: ImageBitmap) {
    abort.current?.abort();
    const controller = new AbortController();
    abort.current = controller;
    setNote(null);
    setUpload({ status: "uploading", fraction: 0 });
    try {
      const done = await uploadJamCover({
        songId: song.id,
        file,
        region,
        picture,
        signal: controller.signal,
        // The framed picture is on the tile before its first byte is sent.
        onPreview: (url) => {
          if (controller.signal.aborted) URL.revokeObjectURL(url);
          else replacePending(url);
        },
        onProgress: (fraction) => setUpload({ status: "uploading", fraction }),
      });
      if (controller.signal.aborted) return;
      // The picture that went up is the preview now; the one it replaces is let go.
      replacePreview(done.previewUrl);
      setPending(null);
      setCover({ kind: "new", uploadId: done.uploadId });
      setUpload({ status: "idle" });
      setNote(t("jam.edit.readyHint"));
    } catch (failure) {
      if (controller.signal.aborted) return;
      // A failed replacement leaves the photo that was already chosen where it was.
      replacePending(null);
      const message =
        failure instanceof JamCoverError
          ? t(failure.kind === "tooLarge" ? "jam.error.tooLarge" : "jam.edit.photoUnreadable")
          : failure instanceof ApiError
            ? t(`jam.error.${jamErrorKind(failure)}` as MessageKey)
            : t("jam.edit.photoFailed");
      setUpload({ status: "failed", message });
    }
  }

  function removePhoto() {
    abort.current?.abort();
    replacePreview(null);
    replacePending(null);
    setUpload({ status: "idle" });
    setCover({ kind: "remove" });
    setNote(song.coverUrl !== null ? t("jam.edit.removedHint") : null);
  }

  async function save() {
    setTouched(true);
    if (titleMissing || uploading || plan.empty || saving) return;
    setSaving(true);
    setError(null);
    try {
      // The text first, then the picture; each answer is the song as it now is.
      if (plan.patch) {
        onSong((await updateJamSong(song.id, plan.patch)).song);
      }
      if (plan.cover?.op === "set") {
        onSong((await setJamCover(song.id, plan.cover.uploadId)).song);
      } else if (plan.cover?.op === "remove") {
        onSong((await removeJamCover(song.id)).song);
      }
      onClose();
    } catch (failure) {
      setSaving(false);
      if (failure instanceof ApiError && failure.status === 403 && jamErrorKind(failure) === "other") {
        setError(t("jam.edit.denied"));
        onDenied?.();
        return;
      }
      setError(t(`jam.error.${jamErrorKind(failure)}` as MessageKey));
    }
  }

  const { zoneProps, active: dragging } = useFileDropZone({
    mode: open && !saving && !cropping ? "accept" : "off",
    onDrop: (items) => void pick(firstDroppedFile(items).file),
  });

  return (
    <>
      <Dialog
        open={open}
        title={t("jam.edit.title")}
        size="md"
        onClose={requestClose}
        footer={
          <div className="flex w-full justify-end gap-2">
            <Button variant="ghost" onClick={requestClose} disabled={saving}>
              {t("jam.start.cancel")}
            </Button>
            <Button
              type="submit"
              form={formId}
              data-jam-edit-save=""
              disabled={plan.empty || uploading || saving}
              // Nothing to save reads as nothing to press: a flat surface, not a dimmed brand colour.
              className="min-w-24 gap-2 disabled:bg-surface-2 disabled:text-text-tertiary disabled:opacity-60"
            >
              {saving ? t("jam.edit.saving") : t("jam.edit.save")}
            </Button>
          </div>
        }
      >
        <DialogBody>
          <form
            id={formId}
            data-jam-edit=""
            className="grid gap-5 sm:grid-cols-[15rem_minmax(0,1fr)] sm:gap-7"
            onSubmit={(event) => {
              event.preventDefault();
              void save();
            }}
          >
            <div className="flex flex-col items-center gap-2.5 sm:items-stretch" {...zoneProps}>
              <p className="hidden self-start text-xs font-semibold text-text-secondary sm:block">{t("jam.edit.previewLabel")}</p>
              <PreviewTile
                song={song}
                title={cleanSongTitle(title) ?? song.title}
                artist={artist.replace(/\s+/g, " ").trim() || null}
                cover={cover}
                preview={pending ?? preview}
                upload={upload}
                dragging={dragging}
                onPick={() => fileInput.current?.click()}
              />
              <div className="flex w-full max-w-[15rem] gap-1.5 sm:max-w-none">
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  data-jam-edit-photo=""
                  disabled={saving || uploading}
                  onClick={() => fileInput.current?.click()}
                  className="min-w-0 flex-1 gap-2"
                >
                  <ImagePlus className="h-4 w-4 shrink-0" aria-hidden />
                  <span className="truncate">{hasPhoto ? t("jam.edit.changePhoto") : t("jam.edit.addPhoto")}</span>
                </Button>
                {hasPhoto && (
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    data-jam-edit-remove=""
                    disabled={saving}
                    onClick={removePhoto}
                    aria-label={t("jam.edit.removePhoto")}
                    title={t("jam.edit.removePhoto")}
                    className="w-[var(--control-sm)] shrink-0 px-0"
                  >
                    <Trash2 className="h-4 w-4" aria-hidden />
                  </Button>
                )}
              </div>
              <input
                ref={fileInput}
                type="file"
                accept={JAM_COVER_ACCEPT}
                data-jam-edit-file=""
                className="sr-only"
                tabIndex={-1}
                aria-label={t("jam.edit.cover")}
                onChange={(event) => {
                  void pick(event.target.files?.[0] ?? null);
                  event.target.value = "";
                }}
              />
              <p
                role={upload.status === "failed" ? "alert" : "status"}
                aria-live="polite"
                data-jam-edit-note=""
                className={cn(
                  "text-center text-xs leading-snug [text-wrap:pretty] empty:hidden sm:text-left",
                  upload.status === "failed" ? "text-danger" : "text-text-secondary",
                )}
              >
                {upload.status === "failed" ? upload.message : note}
              </p>
            </div>

            <div className="flex min-w-0 flex-col gap-4 sm:pt-[1.625rem]">
              <label className="flex flex-col gap-1.5 text-xs font-semibold text-text-secondary">
                {t("jam.start.songTitle")}
                <Input
                  autoFocus={typeof window !== "undefined" && window.matchMedia?.("(pointer: fine)").matches}
                  value={title}
                  maxLength={JAM_TITLE_MAX}
                  onChange={(event) => setTitleEdit(event.target.value)}
                  placeholder={t("jam.start.songTitlePlaceholder")}
                  aria-invalid={showTitleError ? true : undefined}
                  aria-describedby={showTitleError ? `${formId}-title-error` : undefined}
                  className={cn("bg-surface-2 text-base font-semibold", showTitleError && "border-danger")}
                  data-jam-edit-title=""
                />
                {showTitleError && (
                  <span id={`${formId}-title-error`} role="alert" className="text-xs font-normal text-danger">
                    {t("jam.start.needTitle")}
                  </span>
                )}
                {title.length >= JAM_TITLE_MAX - 20 && (
                  <span
                    data-jam-title-count=""
                    aria-live="polite"
                    className={cn("self-end text-xs font-medium tabular-nums", title.length >= JAM_TITLE_MAX ? "text-danger" : "text-text-secondary")}
                  >
                    {title.length >= JAM_TITLE_MAX
                      ? t("jam.start.titleMax", { max: JAM_TITLE_MAX })
                      : t("jam.start.titleCount", { count: title.length, max: JAM_TITLE_MAX })}
                  </span>
                )}
              </label>
              <label className="flex flex-col gap-1.5 text-xs font-semibold text-text-secondary">
                {t("jam.edit.artist")}
                <Input
                  value={artist}
                  maxLength={JAM_ARTIST_MAX}
                  onChange={(event) => setArtistEdit(event.target.value)}
                  placeholder={t("jam.edit.artistPlaceholder")}
                  className="bg-surface-2"
                  data-jam-edit-artist=""
                />
              </label>
              {error && (
                <p role="alert" data-jam-edit-error="" className="rounded-[var(--radius-control)] bg-danger-soft px-3 py-2 text-sm text-on-danger-soft">
                  {error}
                </p>
              )}
            </div>
          </form>
        </DialogBody>
      </Dialog>

      <ConfirmDialog
        open={confirmDiscard}
        title={t("jam.edit.discardTitle")}
        description={t("jam.edit.discardBody")}
        confirmLabel={t("jam.studio.leave")}
        cancelLabel={t("jam.edit.keepEditing")}
        onClose={() => setConfirmDiscard(false)}
        onConfirm={() => {
          setConfirmDiscard(false);
          onClose();
        }}
      />
      <ImageCropDialog
        file={cropping}
        shape="cover"
        onCancel={() => setCropping(null)}
        onConfirm={(region, picture) => {
          const file = cropping;
          setCropping(null);
          if (file) void send(file, region, picture);
          else picture.close();
        }}
      />
    </>
  );
}

/**
 * The song's card as the wall will draw it, live: the picture (clean, square,
 * exactly the frame the crop step showed), and under it the footer with the name
 * and artist as they are typed. The picture is the button that picks a photo and
 * a drop target, with a solid pill that rises on hover and focus; while a photo
 * goes up the framed picture stays under a ring, and a fresh one lands with a
 * small pop.
 */
function PreviewTile({
  song,
  title,
  artist,
  cover,
  preview,
  upload,
  dragging,
  onPick,
}: {
  song: JamSongSummary;
  title: string;
  artist: string | null;
  cover: JamCoverChoice;
  preview: string | null;
  upload: Upload;
  dragging: boolean;
  onPick: () => void;
}) {
  const { t } = useTranslation();
  const current = useJamCover(song.coverUrl);
  const uploading = upload.status === "uploading";
  const showNew = preview !== null && (cover.kind === "new" || uploading);
  const showCurrent = cover.kind === "keep" && current.src !== null && current.status !== "failed";
  const photo = showNew || showCurrent;
  const percent = uploading ? Math.round(upload.fraction * 100) : 0;
  const R = 22;
  const C = 2 * Math.PI * R;
  return (
    <div
      data-jam-edit-stage=""
      data-state={uploading ? "uploading" : showNew ? "new" : showCurrent ? "current" : "empty"}
      className={cn(
        "group relative isolate flex w-48 shrink-0 flex-col overflow-hidden rounded-[var(--radius-panel)] border border-border bg-surface-1 shadow-[var(--shadow-2)] transition-[transform,box-shadow] duration-[var(--duration-base)] ease-[var(--ease-standard)] has-[button:focus-visible]:ring-2 has-[button:focus-visible]:ring-focus-ring sm:w-full motion-safe:has-[button:active]:scale-[0.98]",
        dragging && "ring-2 ring-accent",
      )}
    >
      <div className="relative aspect-square w-full overflow-hidden text-on-media">
        {showNew ? (
          <img
            key={preview}
            src={preview!}
            alt=""
            draggable={false}
            data-jam-edit-preview=""
            className={cn("jam-cover-pop absolute inset-0 h-full w-full object-cover transition-[filter] duration-[var(--duration-slow)]", uploading && "brightness-[0.55]")}
          />
        ) : showCurrent ? (
          <JamCoverPhoto cover={current} eager />
        ) : (
          <BandArt song={song} />
        )}
        {/* no photo yet: an invitation, not a label over the art */}
        {!photo && (
          <span
            aria-hidden="true"
            className="pointer-events-none absolute inset-2 grid place-items-start justify-items-end rounded-[calc(var(--radius-panel)-0.5rem)] border-2 border-dashed border-on-media/45"
          >
            <span className="m-1.5 grid h-9 w-9 place-items-center rounded-full bg-media-scrim/80 text-on-media transition-transform duration-[var(--duration-base)] ease-[var(--ease-emphasized)] group-hover:scale-110">
              <Camera className="h-[18px] w-[18px]" strokeWidth={2.25} />
            </span>
          </span>
        )}
        {/* a photo is there: the pill that says what the picture does */}
        {photo && !uploading && (
          <span
            aria-hidden="true"
            className={cn(
              "pointer-events-none absolute inset-x-0 top-3 flex justify-center opacity-0 transition-opacity duration-[var(--duration-base)] group-hover:opacity-100 group-has-[button:focus-visible]:opacity-100",
              dragging && "opacity-100",
            )}
          >
            <span className="flex h-8 items-center gap-1.5 rounded-full bg-media-scrim/85 px-3 text-xs font-bold backdrop-blur-sm">
              <Camera className="h-4 w-4" strokeWidth={2.25} />
              {dragging ? t("jam.edit.dropHere") : t("jam.edit.changePhoto")}
            </span>
          </span>
        )}
        {dragging && !photo && (
          <span aria-hidden="true" className="pointer-events-none absolute inset-0 grid place-items-center bg-media-scrim/60 text-[13px] font-bold">
            {t("jam.edit.dropHere")}
          </span>
        )}
        {showNew && !uploading && (
          <span
            aria-hidden="true"
            className="jam-cover-pop pointer-events-none absolute left-2 top-2 flex h-6 items-center gap-1 rounded-full bg-media-scrim/85 pl-1.5 pr-2 text-[11px] font-bold text-on-media"
          >
            <Check className="h-3.5 w-3.5 text-success" strokeWidth={3} />
            {t("jam.edit.ready")}
          </span>
        )}
        {/* the whole picture is the button; while a photo goes up it waits */}
        <button
          type="button"
          onClick={onPick}
          disabled={uploading}
          aria-label={t(photo ? "jam.edit.changePhoto" : "jam.edit.addPhoto")}
          className="absolute inset-0 z-10 cursor-pointer rounded-[inherit] outline-none disabled:cursor-progress"
        />
        {uploading && (
          <span
            role="progressbar"
            aria-label={t("jam.edit.sending")}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={percent}
            data-jam-edit-progress=""
            className="pointer-events-none absolute inset-0 z-20 grid place-items-center"
          >
            <span className="relative grid h-16 w-16 place-items-center rounded-full bg-media-scrim/60 backdrop-blur-[2px]">
              <svg viewBox="0 0 56 56" className="absolute inset-0 -rotate-90" aria-hidden="true">
                <circle cx="28" cy="28" r={R} fill="none" strokeWidth="4" className="stroke-on-media/25" />
                <circle
                  cx="28"
                  cy="28"
                  r={R}
                  fill="none"
                  strokeWidth="4"
                  strokeLinecap="round"
                  className="jam-cover-ring stroke-accent"
                  style={{ strokeDasharray: C, strokeDashoffset: C * (1 - Math.max(0.04, upload.fraction)) } as CSSProperties}
                />
              </svg>
              <span className="text-sm font-extrabold tabular-nums">{percent}%</span>
            </span>
          </span>
        )}
      </div>
      {/* the footer, as the wall draws it */}
      <div aria-hidden="true" className="flex min-w-0 flex-col gap-1 bg-surface-1 p-3">
        <span className="line-clamp-2 font-display text-[15px] font-extrabold leading-[1.12] tracking-[-0.01em] text-text [overflow-wrap:anywhere] [text-wrap:balance]">
          {title}
        </span>
        <span className="min-h-[1.25rem] truncate text-[13px] font-medium text-text-secondary">{artist ?? ""}</span>
      </div>
    </div>
  );
}
