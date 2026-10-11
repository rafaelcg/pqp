import { Smartphone } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import {
  COMMUNITY_HOME_MAX_BYTES,
  formatHomeBytes,
  isHomeVideoFile,
  uploadHomeMedia,
  type UploadedHomeMedia,
} from "@/lib/community-home";
import { useTranslation } from "@/lib/i18n";

/**
 * The optional second cut of a post's video: the vertical edit phones play
 * instead of the main one (`bau_mobile_rendition`). Offered only once the
 * main media is an uploaded video; the composer decides that and renders this.
 *
 * Same upload path as the main file (mint, PUT, claim), so the same size cap
 * and the same type allowlist apply; this only adds "it has to be a video".
 */
export function ComposeMobileRendition({
  serverId,
  current,
  onUploaded,
  onRemove,
}: {
  serverId: string;
  /** The cut on the post or picked in this session, or null. */
  current: { name: string; byteSize: number | null } | null;
  onUploaded: (uploaded: UploadedHomeMedia, previewUrl: string) => void;
  onRemove: () => void;
}) {
  const { t } = useTranslation();
  const [uploading, setUploading] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const abort = useRef<AbortController | null>(null);

  useEffect(() => () => abort.current?.abort(), []);

  async function pick(file: File | null) {
    if (!file) {
      return;
    }
    setError(null);
    if (!isHomeVideoFile(file)) {
      setError(t("communityHome.compose.mobileNotVideo"));
      return;
    }
    if (file.size > COMMUNITY_HOME_MAX_BYTES) {
      setError(t("communityHome.compose.videoOverLimit"));
      return;
    }
    abort.current?.abort();
    const controller = new AbortController();
    abort.current = controller;
    setUploading(0);
    try {
      const uploaded = await uploadHomeMedia(serverId, file, {
        signal: controller.signal,
        onProgress: (fraction) => setUploading(fraction),
      });
      if (controller.signal.aborted) {
        return;
      }
      if (uploaded.kind !== "video") {
        setError(t("communityHome.compose.mobileNotVideo"));
        return;
      }
      onUploaded(uploaded, URL.createObjectURL(file));
    } catch (caught) {
      if (!(caught instanceof DOMException && caught.name === "AbortError")) {
        setError(t("communityHome.compose.uploadFailed"));
      }
    } finally {
      if (abort.current === controller) {
        setUploading(null);
        abort.current = null;
      }
    }
  }

  return (
    <div className="mb-2 text-xs text-paper-muted" data-home-compose-mobile>
      {current ? (
        <p className="flex items-center gap-2" data-home-compose-mobile-label>
          <Smartphone className="h-3.5 w-3.5 shrink-0" aria-hidden />
          <span className="shrink-0">{t("communityHome.compose.mobileLabel")}</span>
          <span className="truncate">
            {current.name}
            {current.byteSize != null ? ` · ${formatHomeBytes(current.byteSize)}` : null}
          </span>
          <button
            type="button"
            className="text-signal hover:underline"
            onClick={onRemove}
            data-home-compose-mobile-remove
          >
            {t("communityHome.compose.clearMedia")}
          </button>
        </p>
      ) : (
        <label className="block">
          <span className="flex items-center gap-2">
            <span className="inline-flex cursor-pointer items-center gap-1.5 rounded-md border border-ink-4 bg-ink px-3 py-1.5 text-xs text-paper hover:bg-ink-4">
              <Smartphone className="h-3.5 w-3.5" aria-hidden />
              {t("communityHome.compose.mobileAdd")}
              <input
                type="file"
                accept="video/mp4,video/webm,.mp4,.webm"
                className="sr-only"
                disabled={uploading !== null}
                data-home-compose-mobile-file
                onChange={(event) => {
                  void pick(event.target.files?.[0] ?? null);
                  event.target.value = "";
                }}
              />
            </span>
            {uploading !== null && (
              <span className="tabular-nums" data-home-compose-mobile-uploading>
                {Math.round(uploading * 100)}%
              </span>
            )}
          </span>
          <span className="mt-1 block">{t("communityHome.compose.mobileHint")}</span>
        </label>
      )}
      {error && (
        <p className="mt-1 text-danger" data-home-compose-mobile-error>
          {error}
        </p>
      )}
    </div>
  );
}
