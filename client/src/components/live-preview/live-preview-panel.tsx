import {
  MINIMUM_AGE_YEARS,
  publicCommunityDisplayUrl,
  type LivePreviewListedChannel,
  type LivePreviewUpcoming,
} from "@pqp/shared";
import { Check, Clock, Lock, Play, RotateCcw, Share2 } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Link } from "react-router-dom";
import { BetaTag } from "@/components/ui/beta-tag";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Skeleton } from "@/components/ui/skeleton";
import { useMediaQuery } from "@/components/ui/use-media-query";
import {
  BirthDateFields,
  EMPTY_DATE_PARTS,
  toIsoDate,
  type DateParts,
} from "@/components/user/birth-date-fields";
import {
  fetchLivePreviewListing,
  startLivePreview,
  type LivePreviewSource,
} from "@/lib/api";
import { intentStorage, stashLiveChannelIntent } from "@/lib/handle-intent";
import { useTranslation } from "@/lib/i18n";
import { intlLocale } from "@/lib/locale";
import {
  formatPreviewCountdown,
  judgePreviewAge,
  phaseAfterStart,
  phaseOnWatch,
  previewIsUrgent,
  previewOffersSignUp,
  previewRemainingFraction,
  previewSecondsLeft,
  previewShowsPage,
  previewViewerCount,
  previewWindowMinutes,
  readPreviewAgeMemory,
  readPreviewTicket,
  rememberPreviewAge,
  safeLocal,
  safeSession,
  shareLink,
  stashLivePreviewAcquisition,
  writePreviewTicket,
  type LivePreviewPhase,
} from "@/lib/live-preview";
import { track } from "@/lib/track";
import { cn } from "@/lib/utils";
import type { LivePreviewAuth } from "./live-preview-auth";
import {
  AboutCard,
  CommunityAvatar,
  CountdownClock,
  DateTile,
  LiveBadge,
  LockedChatCompact,
  LockedChatPanel,
  PreviewArt,
  sessionWhen,
  SignUpBlock,
  UpcomingCard,
  useCommunityMeta,
  ViewerChip,
  type LivePreviewCommunity,
} from "./live-preview-parts";
import { LivePreviewPlayer } from "./live-preview-player";

export type { LivePreviewCommunity } from "./live-preview-parts";

/** Tailwind's `lg`: the chat becomes a column beside the player from here up. */
const LG_UP_QUERY = "(min-width: 1024px)";

/** How often the listing is asked again: what is live, the titles, the count. */
const LISTING_REFRESH_MS = 30_000;

type Tab = "chat" | "about" | "upcoming";

/**
 * THE SIGNED-OUT LIVE PREVIEW, drawn.
 *
 * Shown on a community's public page and on the signed-out invite gate, only
 * when the page's own answer said `livePreview: true` (the server's
 * per-server flag) and only while something is live. Everything it plays is
 * decided by the server (`services/live-preview.ts`): which channel, and
 * until when.
 *
 * Two shapes. While idle, a big live card sits in the page (the entry). From
 * "Assistir agora" on, a full-screen live page covers it: the player, the
 * party's title and community, a locked chat, and on a phone a sticky bar
 * with the countdown and the sign-up. The age question and the end are
 * sheets over that page. Mobile first: the page is one column under `lg`
 * with tabs for Chat, Sobre and Próximas, and two columns (the chat on the
 * right) above it.
 *
 * In order: the entry, the age question (the account gate's fields and
 * threshold, answered on this device and never sent), the film with a
 * countdown, and at the end the sign-up. Under the threshold it shows no
 * media and offers no account anywhere on screen.
 */
export function LivePreviewPanel({
  source,
  landing,
  surface,
  community,
  auth,
  onSignUpIntent,
  onLiveChange,
}: {
  source: LivePreviewSource;
  /** The acquisition landing to record for a sign-up from here. */
  landing: string;
  /** For the funnel events. */
  surface: "community" | "invite";
  community: LivePreviewCommunity;
  /** Sign-up, sign-in and direct OAuth, built by the surface (see `live-preview-auth.tsx`). */
  auth: LivePreviewAuth;
  /** Anything else the surface stashes before sign-up (the join intent). */
  onSignUpIntent?: () => void;
  /** Whether a party is live, so the page around the entry can make room for it. */
  onLiveChange?: (live: boolean) => void;
}) {
  const { t } = useTranslation();
  const [channels, setChannels] = useState<LivePreviewListedChannel[] | null>(null);
  const [upcoming, setUpcoming] = useState<LivePreviewUpcoming[]>([]);
  const [windowSeconds, setWindowSeconds] = useState<number | null>(null);
  const [channelId, setChannelId] = useState<string | null>(null);
  const [phase, setPhase] = useState<LivePreviewPhase>({ kind: "idle" });
  const [parts, setParts] = useState<DateParts>(EMPTY_DATE_PARTS);
  const [ageError, setAgeError] = useState(false);
  const [endedSheet, setEndedSheet] = useState(true);
  const [tab, setTab] = useState<Tab>("chat");
  const [now, setNow] = useState(() => Date.now());
  // The chat column is CSS-hidden under `lg`, but hidden still mounts, and a
  // second Clerk form (its own captcha and hash router) has no business
  // running invisibly on a phone. So its sign-up is built only from `lg` up.
  const wide = useMediaQuery(LG_UP_QUERY);
  const viewTracked = useRef(false);
  const endTracked = useRef(false);
  const restarts = useRef(0);
  const sourceKey = source.kind === "community" ? `c:${source.slug}` : `i:${source.code}`;

  // The listing: on mount and every 30 s, watching or not, so a party that
  // starts while the page is open shows up, one that ends goes away, and the
  // count under the player stays current. Cached 10 s at the edge.
  useEffect(() => {
    const controller = new AbortController();
    const load = () => {
      void fetchLivePreviewListing(source, { signal: controller.signal }).then((answer) => {
        if (controller.signal.aborted) {
          return;
        }
        setChannels(answer?.livePreview.channels ?? []);
        setUpcoming(answer?.livePreview.upcoming ?? []);
        if (answer) {
          setWindowSeconds(answer.livePreview.seconds);
        }
      });
    };
    load();
    const timer = window.setInterval(load, LISTING_REFRESH_MS);
    return () => {
      controller.abort();
      window.clearInterval(timer);
    };
    // `source` is identified by `sourceKey`; a new object with the same
    // target must not refetch.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sourceKey]);

  // The channel being watched keeps its latest listing row (title, count),
  // and stays drawn when it drops out of a later listing mid-window.
  const lastShown = useRef<LivePreviewListedChannel | null>(null);
  const listed =
    (channelId ? channels?.find((row) => row.id === channelId) : channels?.[0]) ?? null;
  if (listed) {
    lastShown.current = listed;
  }
  const shown = listed ?? (channelId ? lastShown.current : null);
  const live = (channels?.length ?? 0) > 0;

  useEffect(() => {
    onLiveChange?.(live);
  }, [live, onLiveChange]);

  useEffect(() => {
    if (shown && !viewTracked.current) {
      viewTracked.current = true;
      track("live_preview_view", { surface });
    }
  }, [shown, surface]);

  const begin = useCallback(
    async (targetId: string) => {
      setPhase({ kind: "starting" });
      const result = await startLivePreview({
        channelId: targetId,
        ticket: readPreviewTicket(safeLocal(), targetId),
      });
      if (result.kind === "ok") {
        writePreviewTicket(safeLocal(), targetId, result.body.ticket);
        if (restarts.current === 0) {
          track("live_preview_play", { surface });
        }
      }
      setNow(Date.now());
      setPhase(phaseAfterStart(result));
    },
    [surface],
  );

  // The countdown, and the end of the window. The server's token dies at the
  // same instant; this is what makes the page say so instead of stalling.
  const expiresAt = phase.kind === "watching" ? phase.expiresAt : null;
  useEffect(() => {
    if (expiresAt === null) {
      return;
    }
    const tick = () => {
      const at = Date.now();
      setNow(at);
      if (at >= expiresAt) {
        setPhase({ kind: "ended" });
      }
    };
    tick();
    const timer = window.setInterval(tick, 1_000);
    return () => window.clearInterval(timer);
  }, [expiresAt]);

  useEffect(() => {
    if (phase.kind === "ended" && !endTracked.current) {
      endTracked.current = true;
      track("live_preview_ended", { surface });
    }
    if (phase.kind === "ended") {
      setEndedSheet(true);
    }
  }, [phase.kind, surface]);

  // While the live page covers the site, the site underneath is inert: no
  // focus, no screen reader and no clicks reach the poster behind it. The page
  // is portalled to <body>, beside #root, so it is not inside what this
  // switches off (and neither are Clerk's modals).
  const pageShown = shown !== null && previewShowsPage(phase);
  useEffect(() => {
    if (!pageShown) {
      return;
    }
    const root = document.getElementById("root");
    if (!root) {
      return;
    }
    root.inert = true;
    return () => {
      root.inert = false;
    };
  }, [pageShown]);

  if (!shown) {
    return null;
  }

  const watch = (target: LivePreviewListedChannel) => {
    setChannelId(target.id);
    const next = phaseOnWatch(readPreviewAgeMemory(safeSession(), safeLocal()));
    setPhase(next);
    if (next.kind === "starting") {
      void begin(target.id);
    }
  };

  const exit = () => {
    setParts(EMPTY_DATE_PARTS);
    setAgeError(false);
    setPhase({ kind: "idle" });
  };

  const submitAge = () => {
    const verdict = judgePreviewAge(toIsoDate(parts));
    if (verdict === "invalid") {
      setAgeError(true);
      return;
    }
    setAgeError(false);
    // The verdict is remembered; the date is dropped right here.
    setParts(EMPTY_DATE_PARTS);
    rememberPreviewAge(verdict, safeSession(), safeLocal());
    if (verdict === "minor") {
      track("live_preview_age_declined", { surface });
      setPhase({ kind: "declined" });
      return;
    }
    void begin(shown.id);
  };

  const onPlayerUnavailable = () => {
    // Ask the server what happened rather than guess: the window ended, the
    // presenter restarted on a new session, or the party is over. Twice in a
    // row without a frame in between is an error, not a loop.
    if (restarts.current >= 2) {
      setPhase({ kind: "error" });
      return;
    }
    restarts.current += 1;
    void begin(shown.id);
  };

  /**
   * Every way to an account from here runs this first: the surface's own
   * intent (the community join, or the invite), the channel to land on, and
   * the attribution. Sign-in too, so an existing account lands on the film.
   */
  const prepare = (at: string) => {
    onSignUpIntent?.();
    const storage = intentStorage();
    stashLiveChannelIntent(storage, shown.id);
    stashLivePreviewAcquisition(storage, landing);
    track("live_preview_signup", { surface, at, phase: phase.kind });
  };
  const signUp = (at: string) => () => {
    prepare(at);
    auth.signUp();
  };
  const signIn = (at: string) => () => {
    prepare(at);
    auth.signIn();
  };
  const signUpBlock = (at: string, large = false) => (
    <SignUpBlock
      auth={auth}
      large={large}
      onFirstTouch={() => prepare(`${at}:inline`)}
      onSignUp={signUp(at)}
      onSignIn={signIn(at)}
    />
  );

  if (!previewShowsPage(phase)) {
    return (
      <LivePreviewEntry
        community={community}
        channels={channels ?? [shown]}
        upcoming={upcoming}
        windowSeconds={windowSeconds}
        onWatch={watch}
      />
    );
  }

  const offers = previewOffersSignUp(phase);
  const title = shown.title?.trim() || `#${shown.name}`;
  const viewers = previewViewerCount(shown);
  const secondsLeft = phase.kind === "watching" ? previewSecondsLeft(phase.expiresAt, now) : 0;
  const countdown = formatPreviewCountdown(secondsLeft);
  const urgent = previewIsUrgent(secondsLeft);
  const remaining =
    phase.kind === "watching"
      ? previewRemainingFraction(phase.expiresAt, windowSeconds ?? secondsLeft, now)
      : 0;
  const showBar = offers && (phase.kind === "watching" || phase.kind === "ended");

  // Portalled to <body>: the page hosting the entry has its own stacking
  // contexts and entrance transforms, and either would trap a fixed layer
  // under the site's nav or inside the poster column.
  return createPortal(
    <div
      data-live-preview={phase.kind}
      role="region"
      aria-label={t("livePreview.region")}
      className="fixed inset-0 z-50 overflow-y-auto overscroll-contain bg-surface-0 text-text"
    >
      <header className="sticky top-0 z-20 flex items-center justify-between gap-3 border-b border-border bg-rail px-4 py-2 lg:px-6 lg:py-3">
        <div className="flex min-w-0 items-center gap-3">
          <Link to="/" className="font-brand text-2xl leading-none tracking-tight text-accent">
            pqp
          </Link>
          <BetaTag />
          {community.slug && (
            <>
              <span aria-hidden className="hidden h-5 w-px bg-border sm:block" />
              <button
                type="button"
                onClick={exit}
                aria-label={t("livePreview.header.back", { name: community.name })}
                className="hidden min-h-11 min-w-0 items-center truncate rounded-[var(--radius-control)] text-sm text-text-secondary hover:text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring sm:inline-flex"
              >
                pqp.gg/c/
                <span className="font-handle font-semibold text-text">{community.slug}</span>
              </button>
            </>
          )}
        </div>
        {offers && (
          <div className="flex shrink-0 items-center gap-2">
            <Button
              type="button"
              variant="ghost"
              className="hidden h-11 px-4 sm:inline-flex"
              onClick={signIn("header")}
            >
              {t("livePreview.header.signIn")}
            </Button>
            <Button type="button" className="h-11 px-4 font-bold" onClick={signUp("header")}>
              {t("livePreview.cta.signUp")}
            </Button>
          </div>
        )}
      </header>

      <main
        className={cn(
          "mx-auto flex w-full max-w-[1440px] flex-col gap-5 lg:flex-row lg:items-start lg:px-6 lg:pb-12 lg:pt-5",
          showBar ? "pb-40" : "pb-10",
        )}
      >
        <section className="flex min-w-0 flex-1 flex-col lg:gap-[18px]">
          <div className="relative aspect-video w-full overflow-hidden bg-surface-0 lg:rounded-[var(--radius-panel)] lg:border lg:border-border">
            {phase.kind === "watching" ? (
              <LivePreviewPlayer
                url={phase.hlsUrl}
                mode={phase.mode}
                onUnavailable={onPlayerUnavailable}
              >
                {/* Floats over the picture so the page never moves under it. */}
                <div aria-hidden className="absolute inset-x-0 top-0 h-[3px] bg-text/15 lg:h-1">
                  <div
                    className={cn(
                      "h-full transition-[width] duration-1000 ease-linear",
                      urgent ? "bg-warning" : "bg-accent",
                    )}
                    style={{ width: `${remaining * 100}%` }}
                  />
                </div>
                <div className="pointer-events-none absolute left-2.5 top-2.5 flex items-center gap-1.5 lg:left-4 lg:top-4 lg:gap-2">
                  <LiveBadge small>{t("livePreview.live")}</LiveBadge>
                  {viewers !== null && <ViewerChip count={viewers} small />}
                </div>
                <span className="pointer-events-none absolute right-4 top-4 hidden items-center gap-2 rounded-full border border-accent/45 bg-surface-0/80 px-3 py-1.5 text-[13px] font-semibold tabular-nums lg:inline-flex">
                  <CountdownClock urgent={urgent} />
                  {t("livePreview.countdown", { time: countdown })}
                </span>
              </LivePreviewPlayer>
            ) : phase.kind === "starting" ? (
              <Skeleton className="h-full w-full rounded-none" />
            ) : (
              <>
                <PreviewArt community={community} />
                {(phase.kind === "age" || phase.kind === "declined") && (
                  <span className="absolute left-2.5 top-2.5 lg:left-4 lg:top-4">
                    <LiveBadge small>{t("livePreview.live")}</LiveBadge>
                  </span>
                )}
                {phase.kind === "ended" && (
                  <div className="absolute inset-0 flex flex-col items-center justify-center gap-1.5 bg-surface-0/70 px-4 text-center">
                    <LiveBadge small>{t("livePreview.stillLive")}</LiveBadge>
                    {viewers !== null && (
                      <span className="text-sm font-semibold">
                        {t("livePreview.stillWatching", { count: viewers, countLabel: viewers.toLocaleString() })}
                      </span>
                    )}
                  </div>
                )}
                {phase.kind === "gone" && (
                  <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-surface-0/80 px-6 text-center">
                    <h2 className="font-display text-lg font-bold">{t("livePreview.gone.title")}</h2>
                    <p className="max-w-sm text-sm text-text-secondary">{t("livePreview.gone.body")}</p>
                  </div>
                )}
                {phase.kind === "error" && (
                  <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-surface-0/80 px-6 text-center">
                    <p className="max-w-sm text-sm text-text-secondary">{t("livePreview.error.body")}</p>
                    <Button
                      type="button"
                      variant="secondary"
                      className="h-11 rounded-full px-5"
                      onClick={() => {
                        restarts.current = 0;
                        void begin(shown.id);
                      }}
                    >
                      <RotateCcw aria-hidden className="h-4 w-4" />
                      {t("livePreview.error.retry")}
                    </Button>
                  </div>
                )}
              </>
            )}
          </div>

          <div className="flex flex-col gap-3.5 px-4 pt-3 lg:px-0 lg:pt-0">
            <h1 className="font-display text-lg font-bold leading-tight [overflow-wrap:anywhere] lg:text-[26px]">
              {title}
            </h1>
            <CommunityRow
              community={community}
              offers={offers}
              onJoin={signUp("join")}
            />
          </div>

          <div className="mt-3 lg:hidden">
            <div
              role="tablist"
              aria-label={t("livePreview.tabs.label")}
              className="flex gap-1 border-b border-border px-4"
            >
              {(["chat", "about", "upcoming"] as const).map((key) => (
                <button
                  key={key}
                  type="button"
                  role="tab"
                  id={`live-preview-tab-${key}`}
                  aria-selected={tab === key}
                  aria-controls={`live-preview-panel-${key}`}
                  onClick={() => setTab(key)}
                  className={cn(
                    "-mb-px min-h-11 border-b-2 px-3.5 text-sm transition-colors duration-[var(--duration-fast)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring",
                    tab === key
                      ? "border-accent font-bold text-text"
                      : "border-transparent font-semibold text-text-tertiary hover:text-text",
                  )}
                >
                  {t(`livePreview.tabs.${key}`)}
                </button>
              ))}
            </div>
            <div
              role="tabpanel"
              id={`live-preview-panel-${tab}`}
              aria-labelledby={`live-preview-tab-${tab}`}
              className={tab === "chat" ? undefined : "px-4 pt-4"}
            >
              {tab === "chat" && <LockedChatCompact />}
              {tab === "about" && <AboutCard community={community} />}
              {tab === "upcoming" && (
                <UpcomingCard upcoming={upcoming} onNotify={offers ? signUp("notify") : undefined} />
              )}
            </div>
          </div>

          <div className="hidden gap-4 lg:grid lg:grid-cols-2">
            <AboutCard community={community} />
            <UpcomingCard upcoming={upcoming} onNotify={offers ? signUp("notify") : undefined} />
          </div>
        </section>

        <aside className="hidden h-[min(760px,calc(100dvh-108px))] w-[min(400px,30vw)] min-w-[320px] shrink-0 flex-col overflow-hidden rounded-[var(--radius-panel)] border border-border bg-surface-1 lg:sticky lg:top-[88px] lg:flex">
          <LockedChatPanel
            channelName={shown.name}
            // One Clerk form on screen at a time: while the end sheet is
            // open it has the form, and the column only says why.
            signUp={
              wide && offers && !(phase.kind === "ended" && endedSheet)
                ? signUpBlock("chat")
                : undefined
            }
          />
        </aside>
      </main>

      {showBar && (
        <div className="safe-pb fixed inset-x-0 bottom-0 z-20 flex flex-col gap-2.5 border-t border-border bg-rail px-4 pt-3 lg:hidden">
          <div className="flex items-center justify-between gap-3 text-[13px]">
            <span
              className={cn(
                "inline-flex items-center gap-1.5 font-bold",
                phase.kind === "watching" && urgent ? "text-warning" : "text-text-secondary",
              )}
            >
              <Clock aria-hidden className="h-4 w-4" />
              {phase.kind === "watching" ? (
                <span className="tabular-nums">{t("livePreview.bar.endsIn", { time: countdown })}</span>
              ) : (
                t("livePreview.ended.title")
              )}
            </span>
            <span className="text-text-tertiary">{t("livePreview.bar.quick")}</span>
          </div>
          <Button
            type="button"
            className="h-[50px] w-full rounded-[var(--radius-card)] text-base font-bold"
            onClick={signUp("bar")}
          >
            {t("livePreview.bar.cta")}
          </Button>
        </div>
      )}

      <Dialog
        open={phase.kind === "age"}
        eyebrow={t("livePreview.age.eyebrow", { name: community.name })}
        title={t("livePreview.age.title")}
        description={t("livePreview.age.body", { age: MINIMUM_AGE_YEARS })}
        onClose={exit}
        size="sm"
      >
        <form
          className="safe-pb flex flex-col gap-4 px-5 pt-4"
          onSubmit={(event) => {
            event.preventDefault();
            submitAge();
          }}
        >
          <BirthDateFields parts={parts} onChange={setParts} autoFocus compact />
          <p className="flex items-start gap-2 text-[13px] text-text-tertiary">
            <Lock aria-hidden className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            {t("livePreview.age.note")}
          </p>
          {ageError && (
            <p role="alert" className="text-sm text-danger">
              {t("ageGate.error.badDate")}
            </p>
          )}
          <div className="flex flex-col gap-2">
            <Button
              type="submit"
              disabled={!toIsoDate(parts)}
              className="h-12 w-full rounded-[var(--radius-card)] text-base font-bold"
            >
              <Play aria-hidden className="h-4 w-4" />
              {t("livePreview.age.submit")}
            </Button>
            <Button type="button" variant="ghost" className="h-11 w-full" onClick={exit}>
              {t("livePreview.age.cancel")}
            </Button>
          </div>
        </form>
      </Dialog>

      <Dialog
        open={phase.kind === "declined"}
        title={t("ageGate.blocked.title", { age: MINIMUM_AGE_YEARS })}
        onClose={exit}
        size="sm"
        footer={
          <Button type="button" variant="secondary" className="h-11 px-5" onClick={exit}>
            {t("livePreview.declined.close")}
          </Button>
        }
      >
        <p className="px-5 py-4 text-sm text-text-secondary">
          {t("livePreview.declined.body", { age: MINIMUM_AGE_YEARS })}
        </p>
      </Dialog>

      <Dialog
        open={phase.kind === "ended" && endedSheet && offers}
        title={t("livePreview.ended.title")}
        description={t("livePreview.ended.body", { name: community.name })}
        onClose={() => setEndedSheet(false)}
        size="sm"
      >
        <div className="safe-pb flex flex-col gap-4 px-5 pt-4">
          <ul className="flex flex-col gap-2.5">
            {(["watch", "chat", "next"] as const).map((key) => (
              <li key={key} className="flex items-center gap-2.5 text-sm">
                <span
                  aria-hidden
                  className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-accent-soft text-on-accent-soft"
                >
                  <Check className="h-3.5 w-3.5" />
                </span>
                {t(`livePreview.ended.benefit.${key}`)}
              </li>
            ))}
          </ul>
          {signUpBlock("ended", true)}
        </div>
      </Dialog>
    </div>,
    document.body,
  );
}

function CommunityRow({
  community,
  offers,
  onJoin,
}: {
  community: LivePreviewCommunity;
  offers: boolean;
  onJoin: () => void;
}) {
  const { t } = useTranslation();
  const meta = useCommunityMeta(community);
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), 2000);
    return () => window.clearTimeout(timer);
  }, [copied]);
  const share = () => {
    const url = community.slug
      ? `https://${publicCommunityDisplayUrl(community.slug)}`
      : window.location.href;
    void shareLink(url, community.name).then((outcome) => {
      if (outcome === "copied") {
        setCopied(true);
      }
    });
  };
  const shareLabel = copied ? t("livePreview.community.copied") : t("livePreview.community.share");
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 lg:gap-4">
      <div className="flex min-w-0 flex-1 items-center gap-2.5 lg:gap-3">
        <span className="lg:hidden">
          <CommunityAvatar community={community} size="sm" />
        </span>
        <span className="hidden lg:block">
          <CommunityAvatar community={community} size="lg" live />
        </span>
        <div className="flex min-w-0 flex-col leading-tight">
          <span className="truncate font-display text-[15px] font-bold lg:text-[17px]">
            {community.name}
          </span>
          {meta && <span className="truncate text-xs text-text-tertiary lg:text-[13px]">{meta}</span>}
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        {offers && (
          <>
            <Button
              type="button"
              variant="secondary"
              className="h-11 rounded-full px-4 lg:hidden"
              onClick={onJoin}
            >
              {t("livePreview.community.joinShort")}
            </Button>
            <Button
              type="button"
              className="hidden h-11 rounded-full px-5 text-[15px] font-bold lg:inline-flex"
              onClick={onJoin}
            >
              {t("livePreview.community.join")}
            </Button>
          </>
        )}
        <Button
          type="button"
          variant="secondary"
          size="icon"
          aria-label={shareLabel}
          className="h-11 w-11 rounded-full lg:hidden"
          onClick={share}
        >
          {copied ? <Check aria-hidden className="h-4 w-4" /> : <Share2 aria-hidden className="h-4 w-4" />}
        </Button>
        <Button
          type="button"
          variant="secondary"
          className="hidden h-11 rounded-full px-4 lg:inline-flex"
          onClick={share}
        >
          {copied ? <Check aria-hidden className="h-4 w-4" /> : <Share2 aria-hidden className="h-4 w-4" />}
          {shareLabel}
        </Button>
      </div>
    </div>
  );
}

/**
 * The entry: a big live card where the poster used to have a thin strip.
 * The picture is the community's banner or generated art, never the stream:
 * nothing of the film loads before the age answer.
 */
function LivePreviewEntry({
  community,
  channels,
  upcoming,
  windowSeconds,
  onWatch,
}: {
  community: LivePreviewCommunity;
  channels: readonly LivePreviewListedChannel[];
  upcoming: readonly LivePreviewUpcoming[];
  windowSeconds: number | null;
  onWatch: (channel: LivePreviewListedChannel) => void;
}) {
  const { t, locale } = useTranslation();
  const [first, ...others] = channels;
  if (!first) {
    return null;
  }
  const title = first.title?.trim() || `#${first.name}`;
  const viewers = previewViewerCount(first);
  const next = upcoming[0] ?? null;
  const minutes = windowSeconds ? previewWindowMinutes(windowSeconds) : null;
  return (
    <section
      data-live-preview="idle"
      aria-label={t("livePreview.region")}
      className="flex flex-col gap-3.5 text-text"
    >
      <button
        type="button"
        onClick={() => onWatch(first)}
        aria-label={t("livePreview.entry.watchLabel", { title })}
        className="group relative block aspect-video w-full overflow-hidden rounded-[var(--radius-panel)] bg-surface-1 ring-2 ring-danger focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-focus-ring"
      >
        <PreviewArt community={community} />
        <span aria-hidden className="absolute inset-0 bg-surface-0/25" />
        <span className="absolute left-2.5 top-2.5 flex items-center gap-1.5">
          <LiveBadge small>{t("livePreview.live")}</LiveBadge>
          {viewers !== null && <ViewerChip count={viewers} small />}
        </span>
        <span
          aria-hidden
          className="absolute left-1/2 top-1/2 flex h-[60px] w-[60px] -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full bg-text text-surface-0 shadow-[var(--shadow-2)] transition-transform duration-[var(--duration-fast)] group-hover:scale-105 motion-reduce:transition-none"
        >
          <Play className="ml-0.5 h-6 w-6 fill-current" />
        </span>
      </button>

      <div className="flex flex-col gap-1">
        <span className="text-xs font-bold uppercase tracking-[0.06em] text-danger">
          {t("livePreview.entry.happening", { channel: first.name })}
        </span>
        <h2 className="font-display text-[22px] font-bold leading-tight [overflow-wrap:anywhere]">
          {title}
        </h2>
      </div>

      <Button
        type="button"
        className="cta-lift h-[52px] w-full rounded-[var(--radius-card)] text-base font-bold"
        onClick={() => onWatch(first)}
      >
        <Play aria-hidden className="h-4 w-4 fill-current" />
        {t("livePreview.entry.watch")}
      </Button>
      {minutes !== null && (
        <p className="-mt-1.5 text-center text-[13px] text-text-tertiary">
          {t("livePreview.entry.note", { count: minutes })}
        </p>
      )}

      {others.length > 0 && (
        <ul className="flex flex-col divide-y divide-border rounded-[var(--radius-panel)] border border-border bg-surface-1">
          {others.map((other) => (
            <li key={other.id} className="flex items-center gap-3 px-4 py-2">
              <span aria-hidden className="h-2 w-2 shrink-0 rounded-full bg-danger" />
              <span className="min-w-0 flex-1 truncate text-sm font-medium">
                {other.title?.trim() || `#${other.name}`}
              </span>
              <Button
                type="button"
                variant="secondary"
                className="h-11 shrink-0 rounded-full px-4"
                onClick={() => onWatch(other)}
              >
                <Play aria-hidden className="h-4 w-4" />
                {t("livePreview.entry.watchShort")}
              </Button>
            </li>
          ))}
        </ul>
      )}

      {next && (
        <div className="flex items-center gap-3 rounded-[var(--radius-panel)] border border-border bg-surface-1 px-3.5 py-3">
          <DateTile startsAt={next.startsAt} small />
          <div className="flex min-w-0 flex-1 flex-col">
            <span className="text-xs text-text-tertiary">{t("livePreview.entry.next")}</span>
            <span className="truncate text-sm font-semibold">
              {next.title} · {sessionWhen(next.startsAt, intlLocale(locale)).time}
            </span>
          </div>
        </div>
      )}
    </section>
  );
}
