import { useEffect, useRef, useState } from "react";
import { canRenameHandle, DISPLAY_NAME_MAX_LENGTH, HANDLE_MAX_LENGTH, handleRenameAvailableAt, MAX_USER_BANNER_BYTES, normalizeHandle, publicProfileDisplayUrl, publicProfilePath, USER_BANNER_HEIGHT, USER_BANNER_MIME_ALLOWLIST, USER_BANNER_WIDTH, type User, type UserBannerConfig } from "@pqp/shared";
import { Input } from "@/components/ui/input";
import { AvatarPicker } from "@/components/user/avatar-picker";
import { useTranslation } from "@/lib/i18n";
import { intlLocale } from "@/lib/locale";
import { ApiError, deleteUserBanner, fetchUserBannerConfig } from "@/lib/api";
import { resolveUploadedImageUrl } from "@/lib/avatar";
import { uploadUserBanner } from "@/lib/banner-upload";
import { Field } from "@/components/settings/ui";

/* ----------------------------------------------------------------- profile */

/**
 * Name, handle and avatar — the only part of settings that waits for Save.
 *
 * The avatar control is `AvatarPicker` rather than anything local, because
 * onboarding renders the same one; a second picker is how the two lists of
 * presets start to differ.
 */
export function ProfileSection({
  user,
  displayName,
  onDisplayName,
  username,
  onUsername,
  handle,
  onHandle,
  avatarUrl,
  onAvatarUrl,
  onUserUpdated,
}: {
  user: User | null;
  displayName: string;
  onDisplayName: (next: string) => void;
  username: string;
  onUsername: (next: string) => void;
  handle: string;
  onHandle: (next: string) => void;
  avatarUrl: string;
  onAvatarUrl: (next: string) => void;
  onUserUpdated: (user: User) => void;
}) {
  const { t, locale } = useTranslation();
  const [copied, setCopied] = useState(false);

  // Null while the account has never claimed one, or once the window is over.
  const renameAvailableAt = canRenameHandle(user?.handleChangedAt, user?.handle)
    ? null
    : handleRenameAvailableAt(user?.handleChangedAt, user?.handle);

  const publicUrl = user?.handle ? publicProfileDisplayUrl(user.handle) : null;

  function copyPublicUrl() {
    if (!publicUrl) return;
    void navigator.clipboard
      ?.writeText(`https://${publicUrl}`)
      .then(() => setCopied(true))
      .catch(() => {
        // No clipboard (plain http, an embedded webview). The link is right
        // there in plain text, which is the fallback.
      });
  }

  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), 2000);
    return () => window.clearTimeout(timer);
  }, [copied]);

  return (
    <div className="space-y-5">
      {user?.tag && (
        <Field label={t("settings.profile.handle")}>
          <p className="rounded-md border border-ink-4 bg-ink px-3 py-2 font-mono text-sm text-signal">
            {user.tag}
          </p>
        </Field>
      )}

      {/*
        The public link, immediately under the tag it is constantly confused
        with. Two name fields in one form is a design smell, so the two are put
        side by side and each says what it is for: `name#1234` is how somebody
        adds you inside the app, `pqp.gg/@name` is a page you can hand to
        somebody who has never heard of pqp.

        The claimed link is rendered as TEXT WITH A COPY BUTTON rather than as
        the input's value, because the two are different objects: the input is a
        thing you are editing and can abandon with Cancel, and the link is a
        thing you own and want on your clipboard. Collapsing them would mean the
        copy button copies a draft.
      */}
      <Field
        label={t("settings.profile.publicHandle")}
        hint={t("settings.profile.publicHandle.hint")}
      >
        <div className="flex items-stretch gap-0 rounded-md border border-ink-4 bg-ink focus-within:ring-2 focus-within:ring-signal/50">
          <span className="flex select-none items-center pl-3 font-mono text-sm text-paper-muted">
            pqp.gg/@
          </span>
          <input
            value={handle}
            maxLength={HANDLE_MAX_LENGTH}
            autoComplete="off"
            autoCapitalize="none"
            spellCheck={false}
            disabled={renameAvailableAt !== null}
            placeholder={t("settings.profile.publicHandle.placeholder")}
            onChange={(event) => onHandle(normalizeHandle(event.target.value))}
            className="min-w-0 flex-1 bg-transparent px-1 py-2 font-mono text-sm text-paper outline-none placeholder:text-paper-muted/60 disabled:opacity-60"
          />
        </div>

        {renameAvailableAt && (
          <p className="mt-1.5 text-xs text-warning">
            {t("settings.profile.publicHandle.cooldown", {
              date: renameAvailableAt.toLocaleDateString(
                intlLocale(locale),
                { day: "numeric", month: "long", year: "numeric" },
              ),
            })}
          </p>
        )}

        {publicUrl && (
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <code className="rounded bg-ink-3 px-2 py-1 font-mono text-xs text-signal">
              {publicUrl}
            </code>
            <button
              type="button"
              onClick={copyPublicUrl}
              className="inline-flex items-center gap-1 text-xs text-paper-muted underline underline-offset-2 hover:text-paper"
            >
              {copied
                ? t("settings.profile.publicHandle.copied")
                : t("settings.profile.publicHandle.copy")}
            </button>
            <a
              href={publicProfilePath(user!.handle!)}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1 text-xs text-paper-muted underline underline-offset-2 hover:text-paper"
            >
              {t("settings.profile.publicHandle.view")}
            </a>
          </div>
        )}
      </Field>

      {/* Above the avatar, matching the page it feeds: on `pqp.gg/@you` the
          banner is the first thing anybody sees and the avatar overlaps it.
          A settings form whose order contradicts the thing it edits is a form
          people scroll past looking for the control they can already picture. */}
      <BannerField user={user} onUserUpdated={onUserUpdated} />

      <div>
        <span className="mb-2 block text-xs uppercase tracking-wide text-paper-muted">
          {t("settings.profile.avatar")}
        </span>
        <AvatarPicker
          value={avatarUrl}
          onChange={onAvatarUrl}
          fallbackName={displayName}
          labels={{
            urlPlaceholder: t("settings.profile.avatar.urlPlaceholder"),
            urlLabel: t("settings.profile.avatar.urlLabel"),
            presetLabel: t("settings.profile.avatar.preset"),
            clear: t("settings.profile.avatar.clear"),
            upload: t("settings.profile.avatar.upload"),
            uploading: t("settings.profile.avatar.uploading"),
          }}
          // The claim already wrote it, so the app's copy of the account is
          // updated here rather than waiting for Save — otherwise the sidebar
          // keeps the old picture until the dialog closes, and Cancel would
          // look like it undid an upload it cannot.
          onUploaded={onUserUpdated}
        />
      </div>

      <label className="block">
        <span className="mb-2 block text-xs uppercase tracking-wide text-paper-muted">
          {t("settings.profile.displayName")}
        </span>
        <Input
          value={displayName}
          maxLength={DISPLAY_NAME_MAX_LENGTH}
          onChange={(e) => onDisplayName(e.target.value)}
        />
      </label>

      <label className="block">
        <span className="mb-2 block text-xs uppercase tracking-wide text-paper-muted">
          {t("settings.profile.username")}
        </span>
        <Input
          value={username}
          onChange={(e) =>
            onUsername(e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, ""))
          }
          placeholder={t("settings.profile.usernamePlaceholder")}
        />
        <span className="mt-1 block text-xs text-paper-muted">
          {t("settings.profile.usernameHint")}
        </span>
      </label>

      {/* Said once, here, because this section is the only one where Save means
          anything — everywhere else a control has already taken effect by the
          time the user looks away from it. */}
      <p className="text-xs text-paper-muted">{t("settings.profile.saveNote")}</p>
    </div>
  );
}

/**
 * The profile banner, uploaded and claimed the moment it is picked.
 *
 * NOT A DRAFT, unlike the three fields under it, and the asymmetry is the same
 * one `ServerIdentitySection` lives with: the bytes are already in the bucket
 * and the row already points at them, so there is nothing a later Save could
 * apply and nothing Cancel could take back. The control therefore reports what
 * HAPPENED rather than what is pending, and hands the updated account upward so
 * the preview here changes while the dialog is still open.
 *
 * The config is memoised for the life of the tab, exactly as the avatar picker
 * and the server identity section memoise theirs: storage is either configured
 * on this deployment or it is not, and re-asking every time the dialog opens is
 * a round trip somebody spends looking at a blank slot.
 */
let bannerConfigPromise: Promise<UserBannerConfig> | null = null;

function bannerUploadConfig(): Promise<UserBannerConfig> {
  bannerConfigPromise ??= fetchUserBannerConfig().catch(() => ({
    enabled: false,
    maxBytes: MAX_USER_BANNER_BYTES,
    width: USER_BANNER_WIDTH,
    height: USER_BANNER_HEIGHT,
  }));
  return bannerConfigPromise;
}

function BannerField({
  user,
  onUserUpdated,
}: {
  user: User | null;
  onUserUpdated: (user: User) => void;
}) {
  const { t } = useTranslation();
  const fileRef = useRef<HTMLInputElement>(null);
  const [enabled, setEnabled] = useState(false);
  const [busy, setBusy] = useState<"upload" | "remove" | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void bannerUploadConfig().then((config) => {
      if (!cancelled) {
        setEnabled(config.enabled);
      }
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const bannerUrl = resolveUploadedImageUrl(user?.bannerUrl ?? null);

  async function handleFile(file: File) {
    setBusy("upload");
    setError(null);
    try {
      onUserUpdated(await uploadUserBanner(file));
    } catch (failure) {
      setError(
        failure instanceof ApiError || failure instanceof Error
          ? failure.message
          : t("settings.profile.banner.failed"),
      );
    } finally {
      setBusy(null);
    }
  }

  async function handleRemove() {
    setBusy("remove");
    setError(null);
    try {
      const res = await deleteUserBanner();
      onUserUpdated(res.user);
    } catch (failure) {
      setError(
        failure instanceof ApiError || failure instanceof Error
          ? failure.message
          : t("settings.profile.banner.removeFailed"),
      );
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="space-y-2" data-profile-banner>
      <span className="block text-xs uppercase tracking-wide text-paper-muted">
        {t("settings.profile.banner")}
      </span>

      {/* The preview is a 3:1 strip rather than a thumbnail, because that is
          the crop the upload will apply — a square preview would show a photo
          that is not the photo the page ends up with. */}
      <div className="aspect-[3/1] w-full overflow-hidden rounded-lg border border-ink-4 bg-ink">
        {bannerUrl ? (
          <img
            src={bannerUrl}
            alt=""
            className="h-full w-full object-cover"
            decoding="async"
          />
        ) : (
          <div className="flex h-full w-full items-center justify-center px-3 text-center text-xs text-paper-muted">
            {t("settings.profile.banner.empty")}
          </div>
        )}
      </div>

      {!enabled ? (
        <p className="text-xs text-paper-muted">
          {t("settings.profile.banner.unconfigured")}
        </p>
      ) : (
        <>
          <p className="text-xs text-paper-muted">
            {t("settings.profile.banner.hint", {
              width: USER_BANNER_WIDTH,
              height: USER_BANNER_HEIGHT,
            })}
          </p>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              disabled={busy !== null}
              className="rounded-md border border-ink-4 px-2.5 py-1.5 text-xs text-paper hover:border-signal/50 disabled:opacity-60"
              onClick={() => fileRef.current?.click()}
            >
              {busy === "upload"
                ? t("settings.profile.banner.uploading")
                : bannerUrl
                  ? t("settings.profile.banner.replace")
                  : t("settings.profile.banner.upload")}
            </button>
            {bannerUrl && (
              <button
                type="button"
                disabled={busy !== null}
                className="rounded-md border border-ink-4 px-2.5 py-1.5 text-xs text-paper-muted hover:border-danger/50 hover:text-danger disabled:opacity-60"
                onClick={() => void handleRemove()}
              >
                {busy === "remove"
                  ? t("settings.profile.banner.removing")
                  : t("settings.profile.banner.remove")}
              </button>
            )}
            <input
              ref={fileRef}
              type="file"
              aria-label={t("settings.profile.banner")}
              // A hint to the picker, never a check: the real gate is that
              // `createImageBitmap` refuses to decode anything that is not an
              // image, and what is uploaded is a JPEG this browser produced
              // rather than the bytes that were chosen.
              accept={USER_BANNER_MIME_ALLOWLIST.join(",")}
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
          </div>
        </>
      )}

      {error && (
        <p role="alert" className="text-xs text-danger">
          {error}
        </p>
      )}
    </div>
  );
}
