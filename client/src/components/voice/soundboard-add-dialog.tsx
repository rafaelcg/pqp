import { useRef, useState } from "react";
import { Play } from "lucide-react";
import { soundboardEmojiSchema, soundboardNameSchema } from "@pqp/shared";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { ApiError } from "@/lib/api";
import { useTranslation } from "@/lib/i18n";
import { decodeAudioBuffer, playAudioBuffer, unlockSounds } from "@/lib/sounds";
import { soundboardListenerVolume } from "@/lib/soundboard";
import {
  inspectSoundboardFile,
  uploadSoundboardFile,
  type SoundboardFileError,
} from "@/lib/soundboard-upload";

/** Wire still wants one grapheme. The UI draws Lucide, not this. */
const CUSTOM_SOUND_EMOJI = "✨";

export function SoundboardAddDialog({
  open,
  serverId,
  onClose,
  onAdded,
}: {
  open: boolean;
  serverId: string;
  onClose: () => void;
  onAdded: () => void;
}) {
  const { t } = useTranslation();
  const fileRef = useRef<HTMLInputElement>(null);
  const [name, setName] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [contentType, setContentType] = useState<"audio/mpeg" | "audio/ogg" | null>(
    null,
  );
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  function reset(): void {
    setName("");
    setFile(null);
    setContentType(null);
    setError(null);
    setSaving(false);
    if (fileRef.current) {
      fileRef.current.value = "";
    }
  }

  function close(): void {
    reset();
    onClose();
  }

  async function onFile(next: File | null): Promise<void> {
    setFile(null);
    setContentType(null);
    setError(null);
    if (!next) {
      return;
    }
    const inspected = await inspectSoundboardFile(next);
    if (typeof inspected === "string") {
      setError(t(errorKey(inspected)));
      return;
    }
    setFile(next);
    setContentType(inspected.contentType);
  }

  async function save(): Promise<void> {
    if (!file || !contentType) {
      setError(t("soundboard.error.file"));
      return;
    }
    const parsedName = soundboardNameSchema.safeParse(name);
    const parsedEmoji = soundboardEmojiSchema.safeParse(CUSTOM_SOUND_EMOJI);
    if (!parsedName.success) {
      setError(t("soundboard.error.name"));
      return;
    }
    if (!parsedEmoji.success) {
      setError(t("soundboard.error.name"));
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await uploadSoundboardFile({
        serverId,
        file,
        contentType,
        name: parsedName.data,
        emoji: parsedEmoji.data,
      });
      onAdded();
      close();
    } catch (err) {
      const code = err instanceof ApiError ? err.message : "storage";
      setError(t(errorKey(code)));
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
          <Button variant="secondary" onClick={close} disabled={saving}>
            {t("soundboard.add.cancel")}
          </Button>
          <Button onClick={() => void save()} disabled={saving || !file}>
            {saving ? t("soundboard.add.saving") : t("soundboard.add.save")}
          </Button>
        </>
      }
    >
      <div className="space-y-4 px-5 py-4">
        <div className="space-y-1">
          <p className="text-xs text-text-secondary">{t("soundboard.add.file")}</p>
          <div className="flex items-center gap-2">
            <input
              ref={fileRef}
              type="file"
              accept="audio/mpeg,audio/ogg,.mp3,.ogg"
              className="sr-only"
              onChange={(event) => {
                void onFile(event.target.files?.[0] ?? null);
              }}
            />
            <Button
              type="button"
              variant="secondary"
              className="min-w-0 flex-1 justify-start"
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
              onClick={() => void previewFile(file)}
            >
              <Play className="h-4 w-4" />
            </Button>
          </div>
        </div>
        <label className="block space-y-1">
          <span className="text-xs text-text-secondary">{t("soundboard.add.name")}</span>
          <Input
            value={name}
            maxLength={24}
            aria-label={t("soundboard.add.name")}
            onChange={(event) => setName(event.target.value)}
          />
        </label>
        {error && (
          <p role="alert" className="text-sm text-danger">
            {error}
          </p>
        )}
      </div>
    </Dialog>
  );
}

async function previewFile(file: File | null): Promise<void> {
  if (!file) {
    return;
  }
  unlockSounds();
  const buffer = await decodeAudioBuffer(await file.arrayBuffer());
  if (buffer) {
    playAudioBuffer(buffer, soundboardListenerVolume());
  }
}

function errorKey(
  code: string,
):
  | "soundboard.error.type"
  | "soundboard.error.tooBig"
  | "soundboard.error.tooLong"
  | "soundboard.error.unreadable"
  | "soundboard.error.slots"
  | "soundboard.error.storage"
  | "soundboard.error.file"
  | "soundboard.error.name" {
  switch (code as SoundboardFileError | string) {
    case "type":
      return "soundboard.error.type";
    case "too_big":
      return "soundboard.error.tooBig";
    case "too_long":
      return "soundboard.error.tooLong";
    case "unreadable":
      return "soundboard.error.unreadable";
    case "slots":
      return "soundboard.error.slots";
    case "storage":
      return "soundboard.error.storage";
    default:
      return "soundboard.error.storage";
  }
}
