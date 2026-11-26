import type { JamPublicNotice } from "@pqp/shared";
import { X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { useTranslation, type MessageKey } from "@/lib/i18n";
import { setJamHintContext, useJamHintContext } from "@/lib/jam-hint-context";
import { jamNoticePlacement, jamNoticeQueue } from "@/lib/jam-notice-placement";
import { leavesToJamSite, peekJamHandover, rebindJamHandover } from "@/lib/jam-handover";
import { jamSiteHomeUrl, parsePublicJamPath, publicJamAppPath } from "@/lib/jam-public-links";
import {
  openPublicJamById,
  publicJamRequestPath,
  usePublicJamRequest,
} from "@/lib/jam-public-nav";
import { ackTakeNotice, getJamPublicWaiting, loadJamPublicWaiting, subscribeJamPublicNotices, useJamPublicMe, useJamPublicWaiting } from "@/lib/jam-public-store";
import { cn } from "@/lib/utils";
import { isolate } from "@/lib/bidi";
import { JamPublicView } from "./jam-public-view";
import { JamTakeNoticeCards } from "./jam-take-notice-cards";
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
  const { t, locale } = useTranslation();
  const location = useLocation();
  const navigate = useNavigate();
  const me = useJamPublicMe(ready);
  const { notices } = useJamPublicWaiting();
  const route = ready ? parsePublicJamPath(location.pathname) : null;
  const request = usePublicJamRequest();
  const handled = useRef(0);
  const [toast, setToast] = useState<Toast | null>(null);
  const [leaving, setLeaving] = useState(false);
  const [consentOpen, setConsentOpen] = useState(false);
  // A tap on a take notice for the song already open: the view has no live frames, so it is opened again (see `onOpen` below).
  const [viewEpoch, setViewEpoch] = useState(0);

  // Somebody asked for a public jam (an arrival from jam.pqp.gg, a card, a toast).
  useEffect(() => {
    if (!ready || !request || request.nonce === handled.current) {
      return;
    }
    handled.current = request.nonce;
    navigate(publicJamRequestPath(request));
  }, [ready, request, navigate]);

  const routeTarget = route ? (route.kind === "new" ? "new" : route.songId) : null;
  const close = useCallback(() => {
    // Somebody who came from the Jam site for this song is not a member who
    // wandered into a jam: the chat home behind it is empty and has no way back
    // (finding M1 of the launch user test). Closing goes to the site's list of
    // songs, which is what "Voltar pras músicas" says, and is where they came
    // from. The browser's Back still returns to the app, and the app keeps its
    // "Voltar pra jam" strip for that. A different jam opened from the wall of a
    // member's own server closes the way it always did.
    if (routeTarget && leavesToJamSite(peekJamHandover(), routeTarget)) {
      window.location.assign(jamSiteHomeUrl(window.location, locale));
      return;
    }
    // Opened by a click inside the app there is an entry to go back to; opened
    // by a link there is not, and the app's own address goes back instead.
    if (location.key !== "default") {
      navigate(-1);
    } else {
      onClosed();
    }
  }, [location.key, locale, navigate, onClosed, routeTarget]);

  // The account's own notices, as one toast.
  useEffect(() => {
    if (!ready) {
      return;
    }
    const show = (notice: JamPublicNotice) => {
      const next = toastFor(notice, t, () => setConsentOpen(true));
      if (next) {
        setLeaving(false);
        setToast(next);
      }
    };
    return subscribeJamPublicNotices((notice) => {
      if (notice.kind === "take" && !notice.admitted) {
        // With `jam_take_notices` on, the server wrote an item for this take and
        // the card it draws IS the notice; the toast is only for a server that
        // has no such item (the switch is off), so a person is not told twice.
        void loadJamPublicWaiting().then(() => {
          const carded = getJamPublicWaiting().notices.some((one) => one.kind === "take" && one.songId === notice.songId);
          if (!carded) {
            show(notice);
          }
        });
        return;
      }
      show(notice);
    });
  }, [ready, t]);
  // What is drawn, and where (`lib/jam-notice-placement.ts`): one thing at a time, never over a
  // transport. A toast that is held back (a recording is on, a song is open) keeps its place and its
  // nine seconds start when it is finally drawn.
  const hint = useJamHintContext();
  const placement = jamNoticePlacement({ studio: hint.studio, song: hint.song, view: route !== null });
  const queue = jamNoticeQueue(notices, toast !== null, placement);
  const toastKey = toast !== null && queue.toast ? toast.key : null;
  useEffect(() => {
    if (toastKey === null) {
      return;
    }
    const timer = window.setTimeout(() => setLeaving(true), SHOW_MS);
    return () => window.clearTimeout(timer);
  }, [toastKey]);
  // The corner's cards yield while a notice is up (`JamHintContext.notice`).
  const overlayUp = me.enabled && (queue.toast || (queue.card !== null && placement === "overlay"));
  useEffect(() => {
    setJamHintContext({ notice: overlayUp });
    return () => setJamHintContext({ notice: false });
  }, [overlayUp]);
  useEffect(() => {
    if (!leaving) {
      return;
    }
    const timer = window.setTimeout(() => setToast(null), LEAVE_MS);
    return () => window.clearTimeout(timer);
  }, [leaving]);

  if (!ready || (!route && !toast && !consentOpen && notices.length === 0)) {
    return null;
  }
  const cards = (where: "overlay" | "inline") => (
    <JamTakeNoticeCards
      notice={queue.card}
      more={queue.more}
      placement={where}
      onOpen={(notice) => {
        ackTakeNotice(notice.id);
        if (route?.kind === "song" && route.songId === notice.songId) {
          // The song is on screen already, from before the part arrived, and the view
          // reads its song once (no frame reaches it): opening it again is what puts
          // the waiting part, and Aceitar and Recusar, in front of the person.
          setViewEpoch((before) => before + 1);
          return;
        }
        openPublicJamById(notice.songId);
      }}
      onDismiss={(notice) => ackTakeNotice(notice.id)}
    />
  );
  return (
    <>
      {route && (
        <JamPublicView
          key={`${route.kind === "new" ? "new" : route.songId}:${viewEpoch}`}
          target={route.kind === "new" ? "new" : route.songId}
          viewerId={viewerId}
          onClose={close}
          noticeSlot={me.enabled && placement === "inline" ? cards("inline") : null}
          onSongStarted={(songId) => {
            // A jam started by a visitor is now the jam they came from.
            rebindJamHandover(songId);
            navigate(publicJamAppPath(songId), { replace: true });
          }}
        />
      )}
      {toast && me.enabled && queue.toast && (
        <div
          role="status"
          aria-live="polite"
          data-jam-public-toast=""
          className={cn(
            "elevation-3 pointer-events-auto fixed inset-x-3 bottom-[calc(env(safe-area-inset-bottom)+72px)] z-50 flex items-center gap-3 rounded-[var(--radius-card)] bg-surface-2 p-3 sm:inset-x-auto sm:bottom-4 sm:right-4 sm:w-96",
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
      {me.enabled && placement === "overlay" && cards("overlay")}
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
  const title = isolate(notice.title);
  const reason = notice.reason ? ` ${notice.reason}` : "";
  switch (notice.kind) {
    case "consent":
      return { key, text: t("jam.public.notice.consent", { title }), action: { label: t("jam.public.waiting.answer"), run: openConsent } };
    case "take":
      return {
        key,
        text: t(notice.admitted ? "jam.public.notice.takeAdmitted" : "jam.public.notice.take", { title }),
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
