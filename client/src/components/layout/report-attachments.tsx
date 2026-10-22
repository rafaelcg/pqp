import type {
  ReportAttachment,
  ReportAttachmentBlockReason,
} from "@pqp/shared";
import { EyeOff, ShieldAlert } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { ApiError, revealReportAttachment } from "@/lib/api";
import { useTranslation, type MessageKey } from "@/lib/i18n";
import { cn } from "@/lib/utils";

/**
 * The files on a reported message, on the report card (both lenses).
 *
 * TWO LAYERS, and the card never blurs the line between them:
 *
 * 1. THE LIST is always drawn: what kind of file, its content type, and the
 *    scanner's own verdict in words. It is metadata off the row, so it is
 *    useful with the preview off, and it is what explains a refusal.
 *
 * 2. THE LOOK is a click. A picture the server says is `available` shows a
 *    placeholder with a warning and NO image request at all; "Mostrar" asks
 *    `POST .../reveal` for a 60 second URL and only then mounts an `<img>`. It
 *    goes back to the placeholder (the `src` dropped, so the bytes are no
 *    longer on screen) on "Esconder", when the URL's minute is up, when the tab
 *    is hidden, and when the card unmounts (a tab change, the report leaving the
 *    queue). The card holds no rule of its own about what may be opened: it
 *    draws what `preview` and `blockReason` say, and a refusal on the click
 *    (the verdict landed after the list loaded) is shown as a refusal.
 *
 * A blocked file says why and points at the illegal-content runbook; a video or
 * any other file says there is no preview. `preview: "off"` draws nothing extra
 * at all: with the flag off the card is the list and nothing else.
 */

/** A little under the URL's own 60 seconds, so the picture is gone before it dies. */
const REVEAL_VISIBLE_MS = 55_000;

const STATUS_KEYS = {
  unscanned: "reports.att.status.unscanned",
  skipped: "reports.att.status.skipped",
  pass: "reports.att.status.pass",
  flagged: "reports.att.status.flagged",
  rejected: "reports.att.status.rejected",
  error: "reports.att.status.error",
} as const;

const KIND_KEYS = {
  image: "reports.att.kind.image",
  gif: "reports.att.kind.gif",
  video: "reports.att.kind.video",
  file: "reports.att.kind.file",
} as const;

const BLOCK_KEYS: Record<ReportAttachmentBlockReason, MessageKey> = {
  scan_status: "reports.att.blocked.scan_status",
  illegal_label: "reports.att.blocked.illegal_label",
  quarantined: "reports.att.blocked.quarantined",
  minor_report: "reports.att.blocked.minor_report",
};

type Translate = ReturnType<typeof useTranslation>["t"];

function scanLine(attachment: ReportAttachment, t: Translate): string {
  const { status, provider, score, labels } = attachment.scan;
  const known = status in STATUS_KEYS;
  const parts = [
    known ? t(STATUS_KEYS[status as keyof typeof STATUS_KEYS]) : status,
  ];
  if (provider) {
    parts.push(t("reports.att.byProvider", { provider }));
  }
  if (score !== null) {
    parts.push(t("reports.att.score", { score: score.toFixed(2) }));
  }
  if (labels.length > 0) {
    parts.push(t("reports.att.labels", { labels: labels.join(", ") }));
  }
  return parts.join(" · ");
}

function refusalKey(error: unknown): MessageKey {
  if (error instanceof ApiError) {
    if (error.status === 403) {
      return "reports.att.revealRefused";
    }
    if (error.status === 404) {
      return "reports.att.revealGone";
    }
    if (error.status === 429) {
      return "reports.att.revealSlow";
    }
  }
  return "reports.att.revealFailed";
}

function Preview({
  reportId,
  attachment,
}: {
  reportId: string;
  attachment: ReportAttachment;
}) {
  const { t } = useTranslation();
  const [url, setUrl] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [errorKey, setErrorKey] = useState<MessageKey | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // A click that is still in flight when the moderator hides the card must not
  // bring the picture back when its answer lands.
  const generation = useRef(0);

  const hide = useCallback(() => {
    generation.current += 1;
    if (timer.current) {
      clearTimeout(timer.current);
      timer.current = null;
    }
    setUrl(null);
    setLoaded(false);
    setBusy(false);
  }, []);

  // Unmounting is collapsing: the card left the screen, so does the picture.
  useEffect(() => hide, [hide]);

  // A hidden tab is not a place to leave a reported picture lying around.
  useEffect(() => {
    if (!url) {
      return;
    }
    const onVisibility = () => {
      if (document.visibilityState === "hidden") {
        hide();
      }
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, [url, hide]);

  async function show() {
    const mine = ++generation.current;
    setBusy(true);
    setErrorKey(null);
    try {
      const reveal = await revealReportAttachment(reportId, attachment.id);
      if (generation.current !== mine) {
        return;
      }
      setUrl(reveal.url);
      timer.current = setTimeout(
        hide,
        Math.min(REVEAL_VISIBLE_MS, reveal.expiresInSeconds * 1000),
      );
    } catch (error) {
      if (generation.current === mine) {
        setErrorKey(refusalKey(error));
      }
    } finally {
      if (generation.current === mine) {
        setBusy(false);
      }
    }
  }

  if (url) {
    return (
      <div className="space-y-1.5">
        <div className="overflow-hidden rounded-md border border-ink-4 bg-ink">
          <img
            src={url}
            alt={t("reports.att.imageAlt")}
            referrerPolicy="no-referrer"
            draggable={false}
            onLoad={() => setLoaded(true)}
            onError={() => {
              hide();
              setErrorKey("reports.att.revealFailed");
            }}
            data-testid="report-attachment-image"
            className={cn(
              "mx-auto block max-h-72 w-auto max-w-full motion-safe:transition-[filter] motion-safe:duration-200",
              loaded ? "blur-0" : "blur-xl",
            )}
          />
        </div>
        <Button size="sm" variant="secondary" onClick={hide}>
          {t("reports.att.hide")}
        </Button>
      </div>
    );
  }

  return (
    <div className="space-y-1.5">
      <div
        data-testid="report-attachment-placeholder"
        className="flex items-center gap-2 rounded-md border border-dashed border-ink-4 bg-ink px-3 py-3 text-xs text-paper-muted"
      >
        <EyeOff className="h-4 w-4 shrink-0" aria-hidden="true" />
        <span>{t("reports.att.previewWarning")}</span>
      </div>
      <Button size="sm" variant="secondary" disabled={busy} onClick={() => void show()}>
        {busy ? t("common.loading") : t("reports.att.show")}
      </Button>
      {errorKey && (
        <p role="alert" className="text-xs text-danger">
          {t(errorKey)}
        </p>
      )}
    </div>
  );
}

export function ReportAttachments({
  reportId,
  attachments,
}: {
  reportId: string;
  attachments: ReportAttachment[];
}) {
  const { t } = useTranslation();
  if (attachments.length === 0) {
    return null;
  }
  return (
    <div
      className="space-y-2 rounded-md border border-ink-4 bg-ink px-3 py-2"
      data-testid="report-attachments"
    >
      <p className="text-xs font-medium text-paper-muted">
        {t("reports.att.title")}
      </p>
      <ul className="space-y-3">
        {attachments.map((attachment) => (
          <li key={attachment.id} className="space-y-1.5 text-xs text-paper-muted">
            <p>
              <span className="font-semibold text-paper">
                {t(KIND_KEYS[attachment.kind])}
              </span>
              {" · "}
              <span className="break-all">{attachment.contentType}</span>
            </p>
            <p>
              {t("reports.att.scanner", { verdict: scanLine(attachment, t) })}
            </p>
            {attachment.preview === "available" && (
              <Preview reportId={reportId} attachment={attachment} />
            )}
            {attachment.preview === "blocked" && attachment.blockReason && (
              <p
                role="note"
                className="flex items-start gap-1.5 text-warning"
              >
                <ShieldAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                <span>
                  {t(BLOCK_KEYS[attachment.blockReason])}{" "}
                  {t("reports.att.runbook")}
                </span>
              </p>
            )}
            {attachment.preview === "unsupported" && (
              <p>{t("reports.att.noPreview")}</p>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
