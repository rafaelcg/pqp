import type { JamPublicNotice } from "@pqp/shared";
import { X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { useTranslation, type MessageKey } from "@/lib/i18n";
import { parsePublicJamPath, publicJamAppPath } from "@/lib/jam-public-links";
import {
  openPublicJamById,
  publicJamRequestPath,
  usePublicJamRequest,
} from "@/lib/jam-public-nav";
import { subscribeJamPublicNotices, useJamPublicMe } from "@/lib/jam-public-store";
import { cn } from "@/lib/utils";
import { JamPublicView } from "./jam-public-view";
import { JamConsentDialog } from "./jam-public-waiting";

/**
 * The one place the app listens for public jams: it opens the public view when
 * the address or a request says so, and turns the account's own notices
 * ("somebody is waiting for your answer", "an outside take arrived") into one
 * small toast.
 *
 * Mounted once, by `App`, once the account is ready. While the runtime flag is
 * off it asks for nothing but the flag and draws nothing.
 */

const SHOW_MS = 9000;
const LEAVE_MS = 200;

interface Toast {
  key: number;
  text: string;
  action: { label: string; run: () => void } | null;
}

export interface JamPublicHostProps {
  viewerId: string | null;
  /** The account exists and has a token. */
  ready: boolean;
  /** The view was left with no history to go back to: put the app's own address back. */
  onClosed: () => void;
}

export function JamPublicHost({ viewerId, ready, onClosed }: JamPublicHostProps) {
  const { t } = useTranslation();
  const location = useLocation();
  const navigate = useNavigate();
  const me = useJamPublicMe(ready);
  const route = ready ? parsePublicJamPath(location.pathname) : null;
  const request = usePublicJamRequest();
  const handled = useRef(0);
  const [toast, setToast] = useState<Toast | null>(null);
  const [leaving, setLeaving] = useState(false);
  const [consentOpen, setConsentOpen] = useState(false);

  // Somebody asked for a public jam (an arrival from jam.pqp.gg, a card, a toast).
  useEffect(() => {
    if (!ready || !request || request.nonce === handled.current) {
      return;
    }
    handled.current = request.nonce;
    navigate(publicJamRequestPath(request));
  }, [ready, request, navigate]);

  const close = useCallback(() => {
    // Opened by a click inside the app there is an entry to go back to; opened
    // by a link there is not, and the app's own address goes back instead.
    if (location.key !== "default") {
      navigate(-1);
    } else {
      onClosed();
    }
  }, [location.key, navigate, onClosed]);

  // The account's own notices, as one toast.
  useEffect(() => {
    if (!ready) {
      return;
    }
    return subscribeJamPublicNotices((notice) => {
      const next = toastFor(notice, t, () => setConsentOpen(true));
      if (next) {
        setLeaving(false);
        setToast(next);
      }
    });
  }, [ready, t]);
  const toastKey = toast?.key ?? null;
  useEffect(() => {
    if (toastKey === null) {
      return;
    }
    const timer = window.setTimeout(() => setLeaving(true), SHOW_MS);
    return () => window.clearTimeout(timer);
  }, [toastKey]);
  useEffect(() => {
    if (!leaving) {
      return;
    }
    const timer = window.setTimeout(() => setToast(null), LEAVE_MS);
    return () => window.clearTimeout(timer);
  }, [leaving]);

  if (!ready || (!route && !toast && !consentOpen)) {
    return null;
  }
  return (
    <>
      {route && (
        <JamPublicView
          key={route.kind === "new" ? "new" : route.songId}
          target={route.kind === "new" ? "new" : route.songId}
          viewerId={viewerId}
          onClose={close}
          onSongStarted={(songId) => navigate(publicJamAppPath(songId), { replace: true })}
        />
      )}
      {toast && me.enabled && (
        <div
          role="status"
          aria-live="polite"
          data-jam-public-toast=""
          className={cn(
            "elevation-3 pointer-events-auto fixed inset-x-3 bottom-[calc(env(safe-area-inset-bottom)+72px)] z-50 flex items-center gap-3 rounded-[var(--radius-card)] p-3 sm:inset-x-auto sm:bottom-auto sm:right-4 sm:top-[max(1rem,env(safe-area-inset-top))] sm:w-96",
            leaving ? "animate-toast-out" : "animate-toast-in",
          )}
        >
          <p className="min-w-0 flex-1 text-sm font-semibold leading-snug text-text [text-wrap:pretty]">{toast.text}</p>
          {toast.action && (
            <Button
              size="sm"
              variant="secondary"
              onClick={() => {
                toast.action?.run();
                setLeaving(true);
              }}
            >
              {toast.action.label}
            </Button>
          )}
          <button
            type="button"
            onClick={() => setLeaving(true)}
            aria-label={t("common.close")}
            className="grid h-8 w-8 shrink-0 place-items-center rounded-full text-text-secondary outline-none hover:bg-surface-2 hover:text-text focus-visible:ring-2 focus-visible:ring-focus-ring pointer-coarse:h-11 pointer-coarse:w-11"
          >
            <X className="h-4 w-4" aria-hidden />
          </button>
        </div>
      )}
      <JamConsentDialog open={consentOpen} onClose={() => setConsentOpen(false)} />
    </>
  );
}

let nextToastKey = 0;

function toastFor(
  notice: JamPublicNotice,
  t: (key: MessageKey, values?: Record<string, string | number>) => string,
  openConsent: () => void,
): Toast | null {
  nextToastKey += 1;
  const key = nextToastKey;
  const title = notice.title;
  const reason = notice.reason ? ` ${notice.reason}` : "";
  switch (notice.kind) {
    case "consent":
      return { key, text: t("jam.public.notice.consent", { title }), action: { label: t("jam.public.waiting.answer"), run: openConsent } };
    case "take":
      return {
        key,
        text: t("jam.public.notice.take", { title }),
        action: { label: t("jam.public.waiting.see"), run: () => openPublicJamById(notice.songId) },
      };
    case "removed":
      return { key, text: `${t("jam.public.notice.removed", { title })}${reason}`, action: null };
    case "unpublished":
      return { key, text: `${t("jam.public.notice.unpublished", { title })}${reason}`, action: null };
    case "part-removed":
      return { key, text: `${t("jam.public.notice.partRemoved", { title })}${reason}`, action: null };
    case "approved":
      return { key, text: t("jam.public.notice.approved", { title }), action: null };
    case "rejected":
      return { key, text: `${t("jam.public.notice.rejected", { title })}${reason}`, action: null };
    default:
      return null;
  }
}
