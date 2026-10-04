import { useEffect, useId, useRef, useState } from "react";
import { Link2, Upload } from "lucide-react";
import { AVATAR_MIME_ALLOWLIST, type User } from "@pqp/shared";
import {
  SETTINGS_FOCUS,
  SETTINGS_TRANSITION,
  SettingsInlineStatus,
  useInlineSave,
} from "@/components/settings/kit";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { UserAvatar } from "@/components/user/user-avatar";
import { ApiError, fetchAvatarConfig } from "@/lib/api";
import { uploadAvatar } from "@/lib/avatar-upload";
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
 * kit's `inlineErrorMessage` decides: a 4xx sentence as is, anything else the
 * fallback.
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
  /** Labels, so the caller's language owns the copy rather than this file. */
  labels: {
    urlPlaceholder: string;
    urlLabel: string;
    /** Accessible name of the preset set. */
    presets: string;
    /** Accessible name of one preset, 1-based. */
    preset: (number: number) => string;
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
  labels,
}: AvatarPickerProps) {
  const fileRef = useRef<HTMLInputElement>(null);
  const linkId = useId();
  const [canUpload, setCanUpload] = useState(false);
  // The pasted link is the rare path, so it starts folded away.
  const [linkOpen, setLinkOpen] = useState(false);
  const upload = useInlineSave({ savingLabel: labels.uploading });
  const uploading = upload.state.kind === "saving";

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

  return (
    <div className="space-y-3">
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
            onClick={() => onChange("")}
          >
            {labels.remove}
          </Button>
        ) : null}
        <Button
          type="button"
          variant="ghost"
          size="sm"
          aria-expanded={linkOpen}
          aria-controls={linkOpen ? linkId : undefined}
          onClick={() => setLinkOpen((open) => !open)}
        >
          <Link2 aria-hidden className="h-3.5 w-3.5" />
          {labels.useLink}
        </Button>
      </div>

      {linkOpen ? (
        <Input
          id={linkId}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          placeholder={labels.urlPlaceholder}
          aria-label={labels.urlLabel}
          autoComplete="off"
          spellCheck={false}
        />
      ) : null}

      <div role="group" aria-label={labels.presets} className="flex flex-wrap gap-2">
        {AVATAR_PRESETS.map((url, index) => {
          const selected = value === url;
          return (
            <button
              key={url}
              type="button"
              aria-label={labels.preset(index + 1)}
              aria-pressed={selected}
              className={cn(
                "h-9 w-9 overflow-hidden rounded-[var(--radius-card)] border",
                SETTINGS_TRANSITION,
                SETTINGS_FOCUS,
                selected
                  ? "border-accent ring-2 ring-accent"
                  : "border-border hover:border-border-strong",
              )}
              onClick={() => onChange(url)}
            >
              <img src={url} alt="" className="h-full w-full object-cover" />
            </button>
          );
        })}
      </div>

      <SettingsInlineStatus state={upload.state} />
    </div>
  );
}
