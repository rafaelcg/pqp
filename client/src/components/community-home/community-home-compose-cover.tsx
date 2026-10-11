import { Film, ImageIcon, Upload } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { RadioGroup } from "@/components/ui/radio-group";
import { Slider } from "@/components/ui/slider";
import {
  formatHomeBytes,
  uploadHomeMedia,
  type UploadedHomeMedia,
} from "@/lib/community-home";
import {
  captureCoverFrame,
  COMMUNITY_HOME_COVER_MAX_BYTES,
  CoverFrameError,
  coverImageProblem,
} from "@/lib/community-home/cover";
import { useTranslation } from "@/lib/i18n";
import { formatVideoDuration } from "./community-home-media";

type CoverMode = "frame" | "image";

/**
 * The cover of a post's uploaded video (`bau_custom_cover`): the picture the
 * player shows before play. Offered only once the main media is an uploaded
 * video; the composer decides that and renders this.
 *
 * Two ways in. "Frame do vídeo" puts the video under a scrubber, starting on
 * the first frame (which is what the cover is when nobody picks one), and
 * "Usar este frame" uploads the frame on screen. "Imagem" takes a JPEG, PNG or
 * WebP. Both end as an ordinary Baú image upload (mint, PUT, claim), and the
 * composer puts its id on the post as `posterUploadId`.
 */
export function ComposeCover({
  serverId,
  videoUrl,
  videoIsLocal,
  current,
  onUploaded,
  onRemove,
}: {
  serverId: string;
  /** The main video to pick a frame from: a `blob:` URL, or the post's signed URL. */
  videoUrl: string | null;
  /** A `blob:` URL from this session, whose pixels are always readable. */
  videoIsLocal: boolean;
  /** The cover picked now or already on the post, or null for the first frame. */
  current: string | null;
  onUploaded: (uploaded: UploadedHomeMedia, previewUrl: string) => void;
  onRemove: () => void;
}) {
  const { t } = useTranslation();
  const [mode, setMode] = useState<CoverMode>("frame");
  const [duration, setDuration] = useState<number | null>(null);
  const [time, setTime] = useState(0);
  const [frameReady, setFrameReady] = useState(false);
  /** A seek is in flight: the frame on screen is not the one the scrubber names yet. */
  const [seeking, setSeeking] = useState(false);
  const [uploading, setUploading] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const abort = useRef<AbortController | null>(null);
  /**
   * False once the picker is gone (a new main video remounts it). Checked
   * after every await that comes before an upload, so a capture or a byte
   * check that finishes late never starts an upload nobody can abort.
   */
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      abort.current?.abort();
    };
  }, []);

  async function upload(file: File) {
    if (!alive.current) {
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
      if (uploaded.kind !== "image") {
        setError(t("communityHome.compose.coverNotImage"));
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

  async function takeFrame() {
    const video = videoRef.current;
    if (!video) {
      return;
    }
    setError(null);
    let file: File;
    try {
      file = await captureCoverFrame(video);
    } catch (caught) {
      if (!alive.current) {
        return;
      }
      setError(
        caught instanceof CoverFrameError && caught.reason === "no-frame"
          ? t("communityHome.compose.uploadFailed")
          : t("communityHome.compose.coverFrameFailed"),
      );
      return;
    }
    await upload(file);
  }

  async function pickImage(file: File | null) {
    if (!file) {
      return;
    }
    setError(null);
    const problem = await coverImageProblem(file);
    if (!alive.current) {
      return;
    }
    if (problem === "size") {
      setError(
        t("communityHome.compose.coverTooBig", {
          limit: formatHomeBytes(COMMUNITY_HOME_COVER_MAX_BYTES),
        }),
      );
      return;
    }
    if (problem === "type") {
      setError(t("communityHome.compose.coverNotImage"));
      return;
    }
    if (problem) {
      setError(t("communityHome.compose.uploadFailed"));
      return;
    }
    await upload(file);
  }

  function scrub(value: number) {
    const video = videoRef.current;
    if (!video || !Number.isFinite(value)) {
      return;
    }
    video.currentTime = value;
    setTime(value);
  }

  const busy = uploading !== null;

  return (
    <div
      className="mb-2 space-y-2 rounded-lg border border-border bg-surface-1 p-3 text-xs text-text-tertiary"
      data-home-compose-cover
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-xs font-semibold uppercase tracking-[0.14em] text-text-secondary">
          {t("communityHome.compose.coverLabel")}
        </span>
        <RadioGroup<CoverMode>
          size="sm"
          label={t("communityHome.compose.coverModeLabel")}
          value={mode}
          onValueChange={(next) => {
            setError(null);
            setMode(next);
          }}
          options={[
            { value: "frame", label: t("communityHome.compose.coverModeFrame") },
            { value: "image", label: t("communityHome.compose.coverModeImage") },
          ]}
          disabled={busy}
          fit="content"
        />
      </div>

      {current ? (
        <div className="flex items-center gap-3" data-home-compose-cover-current>
          <img
            src={current}
            alt={t("communityHome.compose.coverChosen")}
            className="h-12 w-20 shrink-0 rounded-[var(--radius-control)] border border-border bg-surface-0 object-cover"
          />
          <span className="min-w-0 flex-1 text-text-secondary">
            {t("communityHome.compose.coverChosen")}
          </span>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            onClick={() => {
              setError(null);
              onRemove();
            }}
            disabled={busy}
            data-home-compose-cover-reset
          >
            {t("communityHome.compose.coverReset")}
          </Button>
        </div>
      ) : (
        <p data-home-compose-cover-auto>{t("communityHome.compose.coverAuto")}</p>
      )}

      {mode === "frame" ? (
        videoUrl ? (
          <div className="space-y-2" data-home-compose-cover-frame>
            <video
              ref={videoRef}
              key={videoUrl}
              src={videoUrl}
              // A video from the bucket needs CORS for its pixels to be
              // readable; a blob from this session never does.
              crossOrigin={videoIsLocal ? undefined : "anonymous"}
              muted
              playsInline
              preload="metadata"
              aria-hidden
              tabIndex={-1}
              className="aspect-video w-full rounded-[var(--radius-control)] bg-surface-0 object-contain"
              onLoadedMetadata={(event) => {
                const video = event.currentTarget;
                if (Number.isFinite(video.duration) && video.duration > 0) {
                  setDuration(video.duration);
                }
                // Paint the first frame (Safari needs a seek to draw one).
                if (video.currentTime === 0) {
                  video.currentTime = 0.001;
                }
              }}
              onLoadedData={() => setFrameReady(true)}
              onSeeking={() => setSeeking(true)}
              onSeeked={() => setSeeking(false)}
              onError={() => {
                setFrameReady(false);
                setError(t("communityHome.compose.coverVideoFailed"));
              }}
              data-home-compose-cover-video
            />
            <div className="flex items-center gap-3">
              <Slider
                variant="volume"
                value={time}
                min={0}
                max={duration ?? 1}
                step={0.04}
                disabled={!duration || busy}
                onValueChange={scrub}
                aria-label={t("communityHome.compose.coverScrub")}
                aria-valuetext={`${formatVideoDuration(time)} / ${formatVideoDuration(duration ?? 0)}`}
                className="h-8 min-w-0 flex-1"
                data-home-compose-cover-scrub
              />
              <span className="shrink-0 tabular-nums">
                {formatVideoDuration(time)}
                {duration != null ? ` / ${formatVideoDuration(duration)}` : null}
              </span>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Button
                type="button"
                size="sm"
                variant="secondary"
                onClick={() => void takeFrame()}
                disabled={!frameReady || seeking || busy}
                data-home-compose-cover-use-frame
              >
                <Film className="h-3.5 w-3.5" aria-hidden />
                {t("communityHome.compose.coverUseFrame")}
              </Button>
              <span>{t("communityHome.compose.coverFrameHint")}</span>
            </div>
          </div>
        ) : null
      ) : (
        <label className="block" data-home-compose-cover-image>
          <span className="flex items-center gap-2">
            <span className="inline-flex cursor-pointer items-center gap-1.5 rounded-[var(--radius-control)] border border-border bg-surface-2 px-3 py-1.5 text-xs text-text hover:bg-border">
              <Upload className="h-3.5 w-3.5" aria-hidden />
              {t("communityHome.compose.coverPickImage")}
              <input
                type="file"
                accept="image/jpeg,image/png,image/webp,.jpg,.jpeg,.png,.webp"
                className="sr-only"
                disabled={busy}
                data-home-compose-cover-file
                onChange={(event) => {
                  void pickImage(event.target.files?.[0] ?? null);
                  event.target.value = "";
                }}
              />
            </span>
            <ImageIcon className="h-3.5 w-3.5 shrink-0" aria-hidden />
            <span>
              {t("communityHome.compose.coverImageHint", {
                limit: formatHomeBytes(COMMUNITY_HOME_COVER_MAX_BYTES),
              })}
            </span>
          </span>
        </label>
      )}

      {uploading !== null && (
        <p className="tabular-nums" data-home-compose-cover-uploading>
          {Math.round(uploading * 100)}%
        </p>
      )}
      {error && (
        <p className="text-danger" data-home-compose-cover-error>
          {error}
        </p>
      )}
    </div>
  );
}
