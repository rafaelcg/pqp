import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import { Link2, Upload } from "lucide-react";
import { AVATAR_MIME_ALLOWLIST, type User } from "@pqp/shared";
import {
  SETTINGS_FOCUS,
  SETTINGS_TRANSITION,
  SettingsInlineStatus,
  useInlineSave,
} from "@/components/settings/kit";
import { Button } from "@/components/ui/button";
import { FileDropZone } from "@/components/ui/file-drop-zone";
import { Input } from "@/components/ui/input";
import { UserAvatar } from "@/components/user/user-avatar";
import { ApiError, fetchAvatarConfig } from "@/lib/api";
import { uploadAvatar } from "@/lib/avatar-upload";
import { firstDroppedFile, type DroppedItems } from "@/lib/file-drop";
import { useTranslation } from "@/lib/i18n";
import { cn } from "@/lib/utils";

/**
 * The one list of preset avatars in the app.
 *
 * Settings draws them through `AvatarPicker` and onboarding imports this list
 * for its own step: two lists would drift, and the day one of them gained a
 * ninth shape the other would quietly be missing it. The presets are remote
 * images rather than bundled assets, which is also why exactly one place names
 * them.
 */
export const AVATAR_PRESETS = [
  "https://api.dicebear.com/9.x/shapes/png?seed=signal",
  "https://api.dicebear.com/9.x/shapes/png?seed=phosphor",
  "https://api.dicebear.com/9.x/shapes/png?seed=desk",
  "https://api.dicebear.com/9.x/shapes/png?seed=mesh",
  "https://api.dicebear.com/9.x/shapes/png?seed=lobby",
  "https://api.dicebear.com/9.x/shapes/png?seed=relay",
  "https://api.dicebear.com/9.x/bottts-neutral/svg?seed=pqp1",
  "https://api.dicebear.com/9.x/bottts-neutral/svg?seed=pqp2",
];

/**
 * Memoised for the life of the tab, the same way the iOS client memoises the
 * attachment config: storage is either configured on this deployment or it is
 * not, and re-asking every time a dialog opens is a round trip the person is
 * looking at a blank slot during.
 */
let configPromise: Promise<{ enabled: boolean }> | null = null;

export function avatarUploadEnabled(): Promise<{ enabled: boolean }> {
  configPromise ??= fetchAvatarConfig().catch(() => ({ enabled: false }));
  return configPromise;
}

/**
 * What an upload failure says, in the reader's language.
 *
 * The upload helpers (`lib/avatar-upload.ts`, `lib/banner-upload.ts`) throw
 * English sentences of their own for the crop and the storage PUT. Those are
 * replaced by the caller's localized `fallback`. An `ApiError` is kept, so the
 * kit's `inlineErrorMessage` can tell a rate limit from any other failure.
 */
export function localizedUploadFailure(error: unknown, fallback: string): Error {
  return error instanceof ApiError ? error : new Error(fallback);
}

interface AvatarPickerProps {
  value: string;
  onChange: (next: string) => void;
  /** Drawn as an initial when nothing is chosen. */
  fallbackName: string;
  /**
   * An upload finished and the server already holds the new avatar.
   *
   * Unlike everything else in this control, an upload is **not** a draft: the
   * claim writes `users.avatar_url` before this fires, so there is nothing for
   * a later Save to apply and nothing Descartar could take back. Omitting this
   * prop hides the upload button entirely: a surface with no way to absorb the
   * new user object has no business starting one.
   */
  onUploaded?: (user: User) => void;
  /**
   * Enter in the link field. The caller decides what that means (Perfil saves).
   */
  onSubmit?: () => void;
  /** Labels, so the caller's language owns the copy rather than this file. */
  labels: {
    urlPlaceholder: string;
    urlLabel: string;
    /** Accessible name of the preset set. */
    presets: string;
    /** Accessible name of one preset, from its short name ("quadrado azul"). */
    preset: (name: string) => string;
    /** Short name of one preset, 1-based, as the drawing looks. */
    presetName: (number: number) => string;
    /** The line under the set once one is chosen, from that short name. */
    presetSelected: (name: string) => string;
    remove: string;
    useLink: string;
    upload: string;
    /** Under the row while an upload runs, in place of "Salvando…". */
    uploading: string;
    uploadFailed: string;
  };
}

/**
 * The avatar row of Perfil: the picture, then upload, remove and a pasted
 * link, then the presets. Choosing a preset, removing or pasting a link stages
 * a draft the unsaved bar saves; an upload applies at once and says so under
 * the row.
 */
export function AvatarPicker({
  value,
  onChange,
  fallbackName,
  onUploaded,
  onSubmit,
  labels,
}: AvatarPickerProps) {
  const { t } = useTranslation();
  const fileRef = useRef<HTMLInputElement>(null);
  const linkId = useId();
  const [canUpload, setCanUpload] = useState(false);
  // The pasted link is the rare path, so it starts folded away.
  const [linkOpen, setLinkOpen] = useState(false);
  const presetRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const upload = useInlineSave({ savingLabel: labels.uploading });
  const uploading = upload.state.kind === "saving";
  // A dropped folder is refused on the spot, before any upload starts.
  const [dropError, setDropError] = useState<string | null>(null);

  useEffect(() => {
    if (!onUploaded) {
      return;
    }
    let cancelled = false;
    void avatarUploadEnabled().then((config) => {
      if (!cancelled) {
        setCanUpload(config.enabled);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [onUploaded]);

  function handleFile(file: File) {
    setDropError(null);
    void upload.run(async () => {
      let user: User;
      try {
        user = await uploadAvatar(file);
      } catch (error) {
        throw localizedUploadFailure(error, labels.uploadFailed);
      }
      onChange(user.avatarUrl ?? "");
      onUploaded?.(user);
    }, labels.uploadFailed);
  }

  /** A drop goes through the same `handleFile` as the picker: same crop, same checks. */
  function handleDrop(items: DroppedItems) {
    const { file, folder } = firstDroppedFile(items);
    if (file) {
      handleFile(file);
    } else if (folder) {
      setDropError(t("composer.dropFolder_one", { name: folder }));
    }
  }

  // The field shows a link somebody typed, never one they did not: a preset
  // is a link too, and so is an uploaded picture, but neither was typed here.
  const customLink =
    value && !AVATAR_PRESETS.includes(value) && !value.startsWith("/") ? value : "";
  const presetIndex = AVATAR_PRESETS.indexOf(value);

  /**
   * Radio group keys: the arrows (and Home and End) move to the next preset
   * and choose it, the way a native radio group does. One Tab stop for the set.
   */
  function handlePresetKey(event: KeyboardEvent<HTMLDivElement>) {
    const last = AVATAR_PRESETS.length - 1;
    const from = presetRefs.current.findIndex((el) => el === document.activeElement);
    if (from < 0) {
      return;
    }
    let next: number;
    switch (event.key) {
      case "ArrowRight":
      case "ArrowDown":
        next = from === last ? 0 : from + 1;
        break;
      case "ArrowLeft":
      case "ArrowUp":
        next = from === 0 ? last : from - 1;
        break;
      case "Home":
        next = 0;
        break;
      case "End":
        next = last;
        break;
      default:
        return;
    }
    event.preventDefault();
    presetRefs.current[next]?.focus();
    onChange(AVATAR_PRESETS[next]);
  }

  return (
    <FileDropZone
      className="space-y-3"
      mode={canUpload && !uploading ? "accept" : "off"}
      onDrop={handleDrop}
      acceptLabel={t("chrome.dropImage")}
      size="field"
    >
      <div className="flex flex-wrap items-center gap-2">
        <UserAvatar
          name={fallbackName}
          avatarUrl={value || null}
          rounded="full"
          className="mr-1 h-12 w-12"
          fallbackClassName="bg-accent text-lg text-on-accent"
        />
        {canUpload ? (
          <>
            <Button
              type="button"
              variant="secondary"
              size="sm"
              className="max-sm:h-11"
              disabled={uploading}
              onClick={() => fileRef.current?.click()}
            >
              <Upload aria-hidden className="h-3.5 w-3.5" />
              {labels.upload}
            </Button>
            <input
              ref={fileRef}
              type="file"
              tabIndex={-1}
              aria-hidden
              // A hint to the picker, never a check: the real gate is that
              // `createImageBitmap` refuses to decode anything that is not an
              // image, and after the crop what is uploaded is a JPEG this
              // browser produced rather than the bytes that were chosen.
              accept={AVATAR_MIME_ALLOWLIST.join(",")}
              className="hidden"
              onChange={(event) => {
                const file = event.target.files?.[0];
                // Cleared before the upload, so picking the same file twice
                // after a failure still fires a change event.
                event.target.value = "";
                if (file) {
                  handleFile(file);
                }
              }}
            />
          </>
        ) : null}
        {value ? (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="max-sm:h-11"
            onClick={() => onChange("")}
          >
            {labels.remove}
          </Button>
        ) : null}
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="max-sm:h-11"
          aria-expanded={linkOpen}
          aria-controls={linkOpen ? linkId : undefined}
          onClick={() => setLinkOpen((open) => !open)}
        >
          <Link2 aria-hidden className="h-3.5 w-3.5" />
          {labels.useLink}
        </Button>
      </div>

      {linkOpen ? (
        <div>
          <label
            htmlFor={linkId}
            className="mb-1.5 block text-xs font-medium text-text-secondary"
          >
            {labels.urlLabel}
          </label>
          <Input
            id={linkId}
            value={customLink}
            onChange={(event) => onChange(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.nativeEvent.isComposing) {
                onSubmit?.();
              }
            }}
            placeholder={labels.urlPlaceholder}
            className="max-sm:h-11"
            autoComplete="off"
            autoCapitalize="none"
            spellCheck={false}
          />
        </div>
      ) : null}

      <div
        role="radiogroup"
        aria-label={labels.presets}
        onKeyDown={handlePresetKey}
        className="flex flex-wrap gap-2 p-1 max-sm:grid max-sm:w-fit max-sm:grid-cols-4 max-sm:gap-3"
      >
        {AVATAR_PRESETS.map((url, index) => {
          const selected = value === url;
          return (
            <button
              key={url}
              ref={(el) => {
                presetRefs.current[index] = el;
              }}
              type="button"
              role="radio"
              aria-label={labels.preset(labels.presetName(index + 1))}
              aria-checked={selected}
              // One Tab stop for the set: the chosen one, or the first.
              tabIndex={index === (presetIndex >= 0 ? presetIndex : 0) ? 0 : -1}
              className={cn(
                "h-9 w-9 overflow-hidden rounded-[var(--radius-card)] border max-sm:h-11 max-sm:w-11",
                SETTINGS_TRANSITION,
                SETTINGS_FOCUS,
                selected
                  ? "border-accent ring-2 ring-accent ring-offset-2 ring-offset-ring-offset"
                  : "border-border hover:border-border-strong",
              )}
              onClick={() => onChange(url)}
            >
              <img src={url} alt="" className="h-full w-full object-cover" />
            </button>
          );
        })}
      </div>

      {presetIndex >= 0 ? (
        <p className="text-xs text-text-tertiary">
          {labels.presetSelected(labels.presetName(presetIndex + 1))}
        </p>
      ) : null}

      <SettingsInlineStatus
        state={dropError ? { kind: "error", message: dropError } : upload.state}
      />
    </FileDropZone>
  );
}
