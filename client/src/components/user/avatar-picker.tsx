import { useEffect, useRef, useState } from "react";
import { AVATAR_MIME_ALLOWLIST, type User } from "@pqp/shared";
import { Input } from "@/components/ui/input";
import { UserAvatar } from "@/components/user/user-avatar";
import { fetchAvatarConfig } from "@/lib/api";
import { uploadAvatar } from "@/lib/avatar-upload";

/**
 * The one avatar picker in the app.
 *
 * Lifted out of `settings-modal.tsx` when onboarding needed the same control:
 * two pickers would mean two preset lists, and the day one of them gained a
 * ninth shape the other would quietly be missing it. The presets are remote
 * SVGs rather than bundled assets, which is also why there is exactly one place
 * that names them.
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

function avatarUploadEnabled(): Promise<{ enabled: boolean }> {
  configPromise ??= fetchAvatarConfig().catch(() => ({ enabled: false }));
  return configPromise;
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
   * a subsequent Save to apply and nothing a Cancel could take back. Omitting
   * this prop hides the upload button entirely — a surface with no way to
   * absorb the new user object has no business starting one.
   */
  onUploaded?: (user: User) => void;
  /** Labels, so the caller's language owns the copy rather than this file. */
  labels: {
    urlPlaceholder: string;
    urlLabel: string;
    presetLabel: string;
    clear: string;
    upload: string;
    uploading: string;
  };
}

export function AvatarPicker({
  value,
  onChange,
  fallbackName,
  onUploaded,
  labels,
}: AvatarPickerProps) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [canUpload, setCanUpload] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);

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

  async function handleFile(file: File) {
    setUploading(true);
    setError(null);
    try {
      const user = await uploadAvatar(file);
      onChange(user.avatarUrl ?? "");
      onUploaded?.(user);
    } catch (failure) {
      setError(
        failure instanceof Error ? failure.message : "That upload failed.",
      );
    } finally {
      setUploading(false);
    }
  }

  return (
    <>
      <div className="mb-2 flex items-center gap-3">
        <UserAvatar
          name={fallbackName}
          avatarUrl={value || null}
          className="h-12 w-12 ring-1 ring-ink-4"
          fallbackClassName="bg-signal text-lg text-ink"
        />
        <Input
          value={value}
          onChange={(event) => onChange(event.target.value)}
          placeholder={labels.urlPlaceholder}
          aria-label={labels.urlLabel}
        />
      </div>
      <div className="flex flex-wrap items-center gap-1.5">
        {AVATAR_PRESETS.map((url) => (
          <button
            key={url}
            type="button"
            aria-label={labels.presetLabel}
            aria-pressed={value === url}
            className={`h-9 w-9 overflow-hidden rounded-md border ${
              value === url
                ? "border-signal ring-1 ring-signal"
                : "border-ink-4 hover:border-signal/50"
            }`}
            onClick={() => onChange(url)}
          >
            <img src={url} alt="" className="h-full w-full object-cover" />
          </button>
        ))}
        <button
          type="button"
          className="rounded-md border border-ink-4 px-2 text-xs text-paper-muted hover:border-signal/50"
          onClick={() => onChange("")}
        >
          {labels.clear}
        </button>
        {canUpload && (
          <>
            <button
              type="button"
              disabled={uploading}
              className="rounded-md border border-ink-4 px-2 py-1 text-xs text-paper hover:border-signal/50 disabled:opacity-60"
              onClick={() => fileRef.current?.click()}
            >
              {uploading ? labels.uploading : labels.upload}
            </button>
            <input
              ref={fileRef}
              type="file"
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
                  void handleFile(file);
                }
              }}
            />
          </>
        )}
      </div>
      {error && (
        <p role="alert" className="mt-2 text-xs text-danger">
          {error}
        </p>
      )}
    </>
  );
}
