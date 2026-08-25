import {
  SERVER_BANNER_HEIGHT,
  SERVER_BANNER_WIDTH,
  SERVER_ICON_SIZE,
  SERVER_IMAGE_MIME_ALLOWLIST,
  type Server,
  type ServerImageKind,
} from "@pqp/shared";
import { useEffect, useRef, useState } from "react";
import { ServerBanner, ServerIcon } from "@/components/layout/server-identity";
import { ApiError, deleteServerImage, fetchServerImageConfig } from "@/lib/api";
import { uploadServerImage } from "@/lib/server-image-upload";
import { useTranslation } from "@/lib/i18n";

/**
 * Memoised for the life of the tab, like `avatar-picker.tsx` does with its own
 * config: storage is either configured on this deployment or it is not, and
 * re-asking every time the dialog opens is a round trip the owner spends
 * looking at a blank slot.
 */
let configPromise: Promise<{ enabled: boolean }> | null = null;

function serverImageUploadEnabled(): Promise<{ enabled: boolean }> {
  configPromise ??= fetchServerImageConfig().catch(() => ({ enabled: false }));
  return configPromise;
}

/**
 * The owner's icon-and-banner controls, inside the Overview section.
 *
 * NOT A DRAFT, unlike the server name beside it. A picture is uploaded and
 * claimed the moment it is picked — there is nothing a later Save could apply
 * and nothing a Close could take back, because the bytes are already in the
 * bucket and the row already points at them. So the control reports what
 * happened rather than what is pending, and the parent is handed the updated
 * server so the rail and the channel column change under the dialog while it is
 * still open. Seeing the change land is the whole point of a picture.
 *
 * With no `S3_*` on the deployment there is no upload path at all, and this
 * says so in a sentence rather than showing a button that 503s.
 */
export function ServerIdentitySection({
  server,
  onUpdated,
}: {
  server: Server;
  onUpdated: (server: Server) => void;
}) {
  const { t } = useTranslation();
  const [enabled, setEnabled] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void serverImageUploadEnabled().then((config) => {
      if (!cancelled) {
        setEnabled(config.enabled);
      }
    });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <section className="space-y-3 border-t border-ink-4 pt-5" data-server-identity>
      <h4 className="font-display text-sm font-bold uppercase tracking-wider text-paper-muted">
        {t("serverSettings.identity.title")}
      </h4>
      <p className="text-sm text-paper-muted">
        {t("serverSettings.identity.description")}
      </p>

      {!enabled ? (
        <p className="text-sm text-paper-muted">
          {t("serverSettings.identity.unconfigured")}
        </p>
      ) : (
        <div className="space-y-5">
          <ImageField
            kind="icon"
            server={server}
            onUpdated={onUpdated}
            label={t("serverSettings.identity.icon")}
            hint={t("serverSettings.identity.iconHint", {
              size: SERVER_ICON_SIZE,
            })}
            hasImage={!!server.iconUrl}
            preview={
              <span className="flex h-16 w-16 shrink-0 items-center justify-center overflow-hidden rounded-xl bg-ink-3 font-display text-lg font-bold text-paper">
                <ServerIcon name={server.name} iconUrl={server.iconUrl} />
              </span>
            }
          />

          <ImageField
            kind="banner"
            server={server}
            onUpdated={onUpdated}
            label={t("serverSettings.identity.banner")}
            hint={t("serverSettings.identity.bannerHint", {
              width: SERVER_BANNER_WIDTH,
              height: SERVER_BANNER_HEIGHT,
            })}
            hasImage={!!server.bannerUrl}
            preview={
              server.bannerUrl ? (
                // The real component, not a re-drawing of it: the preview and
                // the thing previewed cannot disagree if they are the same
                // code. It renders nothing at all without a banner, which is
                // why the empty state below is a separate box rather than a
                // wrapper that would collapse to a stray border line.
                <div className="w-64 shrink-0 overflow-hidden rounded-lg border border-ink-4">
                  <ServerBanner
                    name={server.name}
                    bannerUrl={server.bannerUrl}
                  />
                </div>
              ) : (
                <div className="flex h-[72px] w-64 shrink-0 items-center justify-center rounded-lg border border-dashed border-ink-4 text-xs text-paper-muted">
                  {t("serverSettings.identity.bannerEmpty")}
                </div>
              )
            }
          />
        </div>
      )}
    </section>
  );
}

function ImageField({
  kind,
  server,
  onUpdated,
  label,
  hint,
  hasImage,
  preview,
}: {
  kind: ServerImageKind;
  server: Server;
  onUpdated: (server: Server) => void;
  label: string;
  hint: string;
  hasImage: boolean;
  preview: React.ReactNode;
}) {
  const { t } = useTranslation();
  const fileRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState<"upload" | "remove" | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function handleFile(file: File) {
    setBusy("upload");
    setError(null);
    try {
      onUpdated(await uploadServerImage(server.id, kind, file));
    } catch (failure) {
      setError(
        failure instanceof ApiError || failure instanceof Error
          ? failure.message
          : t("serverSettings.identity.failed"),
      );
    } finally {
      setBusy(null);
    }
  }

  async function handleRemove() {
    setBusy("remove");
    setError(null);
    try {
      const res = await deleteServerImage(server.id, kind);
      onUpdated(res.server);
    } catch (failure) {
      setError(
        failure instanceof ApiError || failure instanceof Error
          ? failure.message
          : t("serverSettings.identity.removeFailed"),
      );
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="space-y-2" data-server-image={kind}>
      <p className="text-xs font-semibold uppercase tracking-wide text-paper-muted">
        {label}
      </p>
      <div className="flex items-start gap-3">
        {preview}
        <div className="min-w-0 flex-1 space-y-2">
          <p className="text-xs text-paper-muted">{hint}</p>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              disabled={busy !== null}
              className="rounded-md border border-ink-4 px-2.5 py-1.5 text-xs text-paper hover:border-signal/50 disabled:opacity-60"
              onClick={() => fileRef.current?.click()}
            >
              {busy === "upload"
                ? t("serverSettings.identity.uploading")
                : hasImage
                  ? t("serverSettings.identity.replace")
                  : t("serverSettings.identity.upload")}
            </button>
            {hasImage && (
              <button
                type="button"
                disabled={busy !== null}
                className="rounded-md border border-ink-4 px-2.5 py-1.5 text-xs text-paper-muted hover:border-danger/50 hover:text-danger disabled:opacity-60"
                onClick={() => void handleRemove()}
              >
                {busy === "remove"
                  ? t("serverSettings.identity.removing")
                  : t("serverSettings.identity.remove")}
              </button>
            )}
            <input
              ref={fileRef}
              type="file"
              aria-label={label}
              // A hint to the picker, never a check: the real gate is that
              // `createImageBitmap` refuses to decode anything that is not an
              // image, and what is uploaded afterwards is a JPEG this browser
              // produced rather than the bytes that were chosen.
              accept={SERVER_IMAGE_MIME_ALLOWLIST.join(",")}
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
        </div>
      </div>
      {error && (
        <p role="alert" className="text-xs text-danger">
          {error}
        </p>
      )}
    </div>
  );
}
