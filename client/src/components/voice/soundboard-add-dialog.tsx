import { useEffect, useId, useRef, useState, type RefObject } from "react";
import { Play } from "lucide-react";
import {
  soundboardEmojiSchema,
  SOUNDBOARD_MAX_SOUNDS,
  SOUNDBOARD_NAME_MAX,
} from "@pqp/shared";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { ApiError } from "@/lib/api";
import { useTranslation, type MessageKey } from "@/lib/i18n";
import { decodeAudioBuffer, unlockSounds } from "@/lib/sounds";
import { previewSoundboardBuffer, stopSoundboardPreview } from "@/lib/soundboard";
import {
  inspectSoundboardFile,
  soundboardErrorKey,
  soundboardNameErrorKey,
  uploadSoundboardFile,
  type SoundboardFileError,
} from "@/lib/soundboard-upload";

/** Wire still wants one grapheme. The UI draws Lucide, not this. */
const CUSTOM_SOUND_EMOJI = "✨";

export function SoundboardAddDialog({
  open,
  serverId,
  maxSounds = SOUNDBOARD_MAX_SOUNDS,
  onClose,
  onAdded,
  onAddedAfterClose,
  returnFocusRef,
}: {
  open: boolean;
  serverId: string;
  /** The server's cap, as the API reports it (for the "board is full" error). */
  maxSounds?: number;
  onClose: () => void;
  onAdded: () => void;
  /**
   * The person closed the dialog while a save was in flight and the clip was
   * added anyway. Refresh the list; do not treat it as this dialog's result,
   * which could close a later one.
   */
  onAddedAfterClose?: () => void;
  /**
   * The control that opened the dialog. It gets focus back when the dialog
   * closes, even if the opener re-rendered or moved meanwhile (the dialog's
   * own restore only knows the element focused at open time).
   */
  returnFocusRef?: RefObject<HTMLElement | null>;
}) {
  const { t } = useTranslation();
  const fileRef = useRef<HTMLInputElement>(null);
  const nameRef = useRef<HTMLInputElement>(null);
  const savingRef = useRef(false);
  const previewSeq = useRef(0);
  // One number per opening of the dialog. A save remembers the one it began
  // under and may act only while it is still current: closing moves it on, so
  // a slow upload finishing later cannot close or fill the NEXT dialog.
  const sessionRef = useRef(0);
  // One number per file pick: a slower inspection of an earlier pick is ignored.
  const inspectSeq = useRef(0);
  const abortRef = useRef<AbortController | null>(null);
  // The file a save already stored and the key it was stored under. A claim
  // whose answer was lost may still have added the clip, so Save again claims
  // the same key rather than storing the file a second time.
  const uploadedRef = useRef<{ file: File; key: string } | null>(null);
  const wasOpen = useRef(false);
  const formId = useId();
  const nameErrorId = useId();
  const fileErrorId = useId();
  const [name, setName] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [contentType, setContentType] = useState<"audio/mpeg" | "audio/ogg" | null>(
    null,
  );
  const [fileError, setFileError] = useState<string | null>(null);
  const [nameError, setNameError] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  // The Dialog restores focus to whatever held it at open time. Hand it to the
  // named opener after that has run (a parent's effect runs after the child's
  // cleanup), so Escape never leaves focus on <body>.
  useEffect(() => {
    if (open) {
      wasOpen.current = true;
      return;
    }
    if (wasOpen.current) {
      wasOpen.current = false;
      returnFocusRef?.current?.focus();
    }
  }, [open, returnFocusRef]);

  /** The dialog is going away: drop what is in flight and what is playing. */
  function endSession(): void {
    sessionRef.current += 1;
    inspectSeq.current += 1;
    // A save still in flight answers into a session that is over, so it can
    // no longer tell a refusal from a lost answer here: start the next fresh.
    uploadedRef.current = null;
    previewSeq.current += 1;
    abortRef.current?.abort();
    abortRef.current = null;
    // The save it aborted never reaches its own cleanup, so release the lock
    // here or a reopened dialog would stay disabled.
    savingRef.current = false;
    setSaving(false);
    stopSoundboardPreview();
  }

  // Closed by the parent or unmounted: the same cleanup as the close button.
  useEffect(() => {
    if (!open) {
      return;
    }
    return endSession;
  }, [open]);

  function reset(): void {
    setName("");
    setFile(null);
    setContentType(null);
    setFileError(null);
    setNameError(null);
    setFormError(null);
    setSaving(false);
    savingRef.current = false;
    if (fileRef.current) {
      fileRef.current.value = "";
    }
  }

  function close(): void {
    endSession();
    reset();
    onClose();
  }

  async function onFile(next: File | null): Promise<void> {
    const seq = (inspectSeq.current += 1);
    uploadedRef.current = null;
    setFile(null);
    setContentType(null);
    setFileError(null);
    setFormError(null);
    if (!next) {
      return;
    }
    const inspected = await inspectSoundboardFile(next);
    if (seq !== inspectSeq.current) {
      return;
    }
    if (typeof inspected === "string") {
      setFileError(t(fileErrorKey(inspected)));
      return;
    }
    setFile(next);
    setContentType(inspected.contentType);
  }

  async function save(): Promise<void> {
    if (savingRef.current) {
      return;
    }
    const nameKey = soundboardNameErrorKey(name);
    const emoji = soundboardEmojiSchema.safeParse(CUSTOM_SOUND_EMOJI);
    setNameError(nameKey ? t(nameKey) : null);
    // A chosen file that was refused keeps its own reason.
    setFileError((prev) => (file && contentType ? null : (prev ?? t("soundboard.error.file"))));
    setFormError(null);
    if (nameKey || !file || !contentType || !emoji.success) {
      if (nameKey) {
        nameRef.current?.focus();
      }
      return;
    }
    savingRef.current = true;
    setSaving(true);
    const session = sessionRef.current;
    const controller = new AbortController();
    abortRef.current = controller;
    try {
      await uploadSoundboardFile({
        serverId,
        file,
        contentType,
        name: name.trim(),
        emoji: emoji.data,
        signal: controller.signal,
        uploadedKey:
          uploadedRef.current?.file === file ? uploadedRef.current.key : undefined,
        onUploaded: (key) => {
          if (session === sessionRef.current) {
            uploadedRef.current = key ? { file, key } : null;
          }
        },
      });
      if (session !== sessionRef.current) {
        onAddedAfterClose?.();
        return;
      }
      onAdded();
      close();
    } catch (err) {
      if (session !== sessionRef.current) {
        // An abort or a dropped connection can land after the server
        // committed: refresh the board rather than treat it as proof that
        // nothing was added. A refusal from the server is a plain no.
        if (!(err instanceof ApiError)) {
          onAddedAfterClose?.();
        }
        return;
      }
      const key = soundboardErrorKey(err);
      if (key === "soundboard.error.nameRejected") {
        setNameError(t(key));
      } else {
        setFormError(t(key, { max: maxSounds }));
      }
      savingRef.current = false;
      setSaving(false);
    }
  }

  return (
    <Dialog
      open={open}
      title={t("soundboard.add.title")}
      description={t("soundboard.add.description")}
      onClose={close}
      size="sm"
      footer={
        <>
          <Button type="button" variant="secondary" onClick={close} disabled={saving}>
            {t("soundboard.add.cancel")}
          </Button>
          <Button type="submit" form={formId} disabled={saving}>
            {saving ? t("soundboard.add.saving") : t("soundboard.add.save")}
          </Button>
        </>
      }
    >
      <form
        id={formId}
        noValidate
        className="space-y-4 px-5 py-4"
        onSubmit={(event) => {
          event.preventDefault();
          void save();
        }}
      >
        <div className="space-y-1">
          <p className="text-xs text-text-secondary">{t("soundboard.add.file")}</p>
          <div className="flex items-center gap-2">
            {/* Not a Tab stop: the button beside it is the way in. */}
            <input
              ref={fileRef}
              type="file"
              tabIndex={-1}
              accept="audio/mpeg,audio/ogg,.mp3,.ogg"
              className="sr-only"
              aria-hidden="true"
              onChange={(event) => {
                void onFile(event.target.files?.[0] ?? null);
              }}
            />
            <Button
              type="button"
              variant="secondary"
              className="min-w-0 flex-1 justify-start"
              aria-describedby={fileError ? fileErrorId : undefined}
              onClick={() => fileRef.current?.click()}
            >
              <span className="truncate">
                {file ? file.name : t("soundboard.add.choose")}
              </span>
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              disabled={!file || saving}
              aria-label={t("soundboard.preview")}
              onClick={() => void previewFile(file, previewSeq)}
            >
              <Play className="h-4 w-4" />
            </Button>
          </div>
          {fileError && (
            <p id={fileErrorId} role="alert" className="text-sm text-danger">
              {fileError}
            </p>
          )}
        </div>
        <div className="space-y-1">
          <label htmlFor={`${formId}-name`} className="block text-xs text-text-secondary">
            {t("soundboard.add.name")}
          </label>
          <Input
            id={`${formId}-name`}
            ref={nameRef}
            value={name}
            // Code points, not UTF-16 units: the check below is the real limit.
            maxLength={SOUNDBOARD_NAME_MAX * 2}
            autoComplete="off"
            aria-invalid={nameError ? true : undefined}
            aria-describedby={nameError ? nameErrorId : undefined}
            onChange={(event) => {
              setName(event.target.value);
              setNameError(null);
              setFormError(null);
            }}
          />
          {nameError && (
            <p id={nameErrorId} role="alert" className="text-sm text-danger">
              {nameError}
            </p>
          )}
        </div>
        {formError && (
          <p role="alert" className="text-sm text-danger">
            {formError}
          </p>
        )}
      </form>
    </Dialog>
  );
}

/**
 * Plays through the board's bus, so its mute and volume apply and a new
 * preview stops the last. Only the newest click may start: a decode that
 * finishes after a later click is dropped.
 */
async function previewFile(
  file: File | null,
  seq: { current: number },
): Promise<void> {
  if (!file) {
    return;
  }
  const mine = (seq.current += 1);
  unlockSounds();
  const buffer = await decodeAudioBuffer(await file.arrayBuffer());
  if (buffer && mine === seq.current) {
    previewSoundboardBuffer(buffer);
  }
}

function fileErrorKey(code: SoundboardFileError): MessageKey {
  switch (code) {
    case "too_big":
      return "soundboard.error.tooBig";
    case "too_long":
      return "soundboard.error.tooLong";
    case "unreadable":
      return "soundboard.error.unreadable";
    default:
      return "soundboard.error.type";
  }
}
