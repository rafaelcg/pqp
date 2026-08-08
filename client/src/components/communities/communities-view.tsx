import {
  COMMUNITY_PAGE_SIZE,
  type CommunitySummary,
} from "@pqp/shared";
import { Compass, Plus, Search, Sparkles, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { ApiError, fetchCommunities, joinCommunity } from "@/lib/api";
import { useTranslation } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import { CommunityCard, CommunityCardSkeleton } from "./community-card";
import {
  applyJoin,
  categoryChips,
  defaultLanguageFilter,
  emptyStateKeys,
  languageSegments,
  mergePages,
  type CategoryFilter,
  type LanguageFilter,
} from "./communities-model";

/** Long enough that typing a word does not fire five requests. */
const SEARCH_DEBOUNCE_MS = 250;

/** Enough to fill three columns twice over without pretending to be the page. */
const SKELETON_COUNT = 6;

interface CommunitiesViewProps {
  /** Leaves the directory and puts the app back where it was. */
  onClose: () => void;
  /**
   * Joined (or opened) a community — the app switches to that server and
   * shows the arrival banner if this is the first time on this device.
   */
  onEnterCommunity: (serverId: string, joinedNow: boolean) => void | Promise<void>;
  /** The other way out: make one instead of finding one. */
  onCreateCommunity: () => void;
  /** Opens the shared report dialog with a `server` target. */
  onReport: (community: CommunitySummary) => void;
}

/**
 * The Communities directory — the whole screen, not a pane.
 *
 * WHY IT TOOK THE VIEWPORT. It used to be the second of two home views, reached
 * from a row under Friends in the conversation sidebar: a directory of every
 * public room on the instance, addressed like a folder of DMs, three quarters
 * of the way down the least-looked-at column in the app. Communities are the
 * concept this product is built around, and a concept does not live in a row.
 * It now opens from a compass at the foot of the server rail — the same place
 * Discord puts discovery, and the one piece of chrome that is on screen no
 * matter what you were doing — and it covers everything, because browsing is a
 * different mode from talking and pretending otherwise costs the grid the width
 * it needs to show more than one card at a time.
 *
 * WHAT THIS IS NOT. It is not a feed, it has no ranking model, and it has no
 * engagement machinery — deliberately, and the reasoning is in
 * `docs/research/communities-orkut.html` §02 and §04. Google's own shutdown
 * archive preserved 51 million Orkut communities and 120 million topics: about
 * 2.35 topics per community across the platform's entire ten-year life, which
 * means the median community never hosted a conversation at all. Joining WAS
 * the product. So this surface optimises for the moment of the click — a name,
 * one line, a member count, a button — and spends nothing on making people talk
 * once they are in.
 *
 * NOTHING HERE RENDERS UNLESS THE SERVER SAYS SO. The parent only mounts this
 * when `/api/communities/config` answered `enabled`, so a deployment with the
 * flag off never reaches this file.
 */
export function CommunitiesView({
  onClose,
  onEnterCommunity,
  onCreateCommunity,
  onReport,
}: CommunitiesViewProps) {
  const { t, locale } = useTranslation();
  const [category, setCategory] = useState<CategoryFilter>(null);
  // Initialised from the app's locale ONCE rather than derived per render: this
  // is a starting point the reader is meant to override, and a value recomputed
  // from `locale` would snap their choice back the next time anything above
  // this re-rendered.
  const [language, setLanguage] = useState<LanguageFilter>(() =>
    defaultLanguageFilter(locale),
  );
  const [rawQuery, setRawQuery] = useState("");
  const [query, setQuery] = useState("");
  const [communities, setCommunities] = useState<CommunitySummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [joiningId, setJoiningId] = useState<string | null>(null);
  const [joinError, setJoinError] = useState<string | null>(null);
  /** Bumped by "try again" so the load effect re-runs on an unchanged filter. */
  const [reloadKey, setReloadKey] = useState(0);
  const shell = useRef<HTMLDivElement>(null);

  // Escape closes it, like every other thing in this app that covers the
  // screen. Bound to the document rather than to the container because the
  // container is a scroll region people click into, and a keydown handler that
  // only fires while a particular node holds focus is a shortcut that works
  // until the first click.
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        onClose();
      }
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  // Land at the top of the directory rather than wherever focus happened to be
  // behind it — the container is focusable only for this, and gives up the tab
  // stop the moment focus leaves.
  useEffect(() => {
    shell.current?.focus({ preventScroll: true });
  }, []);

  // Debounce the box rather than the request: firing per keystroke and
  // cancelling is still one round trip per character on the server's side, and
  // the directory is a LIKE scan.
  useEffect(() => {
    const timer = window.setTimeout(
      () => setQuery(rawQuery.trim()),
      SEARCH_DEBOUNCE_MS,
    );
    return () => window.clearTimeout(timer);
  }, [rawQuery]);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    fetchCommunities(
      { category, language, query: query || null, limit: COMMUNITY_PAGE_SIZE },
      controller.signal,
    )
      .then((page) => {
        setCommunities(page.communities);
        setHasMore(page.hasMore);
      })
      .catch((err: unknown) => {
        // An abort is this effect superseding itself, not a failure anybody
        // should be told about.
        if (controller.signal.aborted) {
          return;
        }
        setError(err instanceof ApiError ? err.message : t("communities.failed"));
      })
      .finally(() => {
        if (!controller.signal.aborted) {
          setLoading(false);
        }
      });
    return () => controller.abort();
  }, [category, language, query, reloadKey, t]);

  const loadMore = useCallback(async () => {
    setLoadingMore(true);
    try {
      const page = await fetchCommunities({
        category,
        language,
        query: query || null,
        limit: COMMUNITY_PAGE_SIZE,
        offset: communities.length,
      });
      // Deduped: the order key moves under the reader, so an offset page can
      // legitimately repeat a row the previous one already delivered.
      setCommunities((prev) => mergePages(prev, page.communities));
      setHasMore(page.hasMore);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t("communities.failed"));
    } finally {
      setLoadingMore(false);
    }
  }, [category, language, query, communities.length, t]);

  async function enter(community: CommunitySummary) {
    if (community.joined) {
      await onEnterCommunity(community.id, false);
      return;
    }
    setJoiningId(community.id);
    setJoinError(null);
    try {
      const result = await joinCommunity(community.id);
      setCommunities((prev) => applyJoin(prev, community.id));
      await onEnterCommunity(community.id, result.joinedNow);
    } catch (err) {
      setJoinError(
        err instanceof ApiError
          ? err.message
          : t("communities.joinFailed", { name: community.name }),
      );
    } finally {
      setJoiningId(null);
    }
  }

  const chips = categoryChips(category);
  const languages = languageSegments(language);
  const empty = emptyStateKeys(query);

  return (
    <div
      ref={shell}
      tabIndex={-1}
      role="dialog"
      aria-modal="true"
      aria-label={t("communities.title")}
      className="fixed inset-0 z-40 flex flex-col bg-ink text-paper focus:outline-none"
      data-communities-view
    >
      {/* The one piece of atmosphere in here: a wash of the accent behind the
          headline, so the top of the page is not the same flat surface as the
          rest of the app. Fixed to the shell rather than the scroll region so
          it does not travel with the cards. */}
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-x-0 top-0 h-[26rem] bg-[radial-gradient(120%_100%_at_50%_0%,var(--glow-accent)_0%,transparent_70%)]"
      />

      <header className="relative z-10 flex h-14 shrink-0 items-center justify-between gap-3 border-b border-ink-4/50 px-4 sm:px-6">
        <div className="flex min-w-0 items-center gap-2">
          <Compass aria-hidden="true" className="h-5 w-5 shrink-0 text-signal" />
          <span className="truncate font-display text-sm font-bold tracking-tight">
            {t("communities.title")}
          </span>
        </div>
        <button
          type="button"
          aria-label={t("communities.close")}
          title={t("communities.close")}
          className="-mr-1.5 rounded-lg p-2 text-paper-muted transition hover:bg-ink-3 hover:text-paper focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-signal/60"
          onClick={onClose}
        >
          <X aria-hidden="true" className="h-5 w-5" />
        </button>
      </header>

      <div className="relative z-10 min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-6xl px-4 pb-20 sm:px-6">
          <div className="pt-8 text-center sm:pt-12">
            <h1 className="font-display text-3xl font-bold leading-[1.05] tracking-tight sm:text-4xl lg:text-5xl">
              {t("communities.hero.title")}
            </h1>
            <p className="mx-auto mt-3 max-w-xl text-sm text-paper-muted sm:text-base">
              {t("communities.hero.body")}
            </p>

            <div className="relative mx-auto mt-6 max-w-xl">
              <Search
                aria-hidden="true"
                className="pointer-events-none absolute left-4 top-1/2 h-4 w-4 -translate-y-1/2 text-paper-muted"
              />
              {/* Not the shared `Input`: this one is the page's centrepiece and
                  wants a pill, a taller target and a focus ring that reads as
                  the primary action rather than as a form field. */}
              <input
                type="search"
                value={rawQuery}
                aria-label={t("communities.search")}
                placeholder={t("communities.searchPlaceholder")}
                className="h-12 w-full rounded-full border border-ink-4 bg-ink-2 pl-11 pr-4 text-base text-paper shadow-sm outline-none transition placeholder:text-paper-muted focus:border-signal/60 focus:ring-4 focus:ring-signal/15"
                onChange={(e) => setRawQuery(e.target.value)}
              />
            </div>
          </div>

          {/* A horizontally scrolling row on a phone rather than a wrapping
              one: ten chips wrap to three lines on a 390px screen and push the
              first card below the fold. From `sm` up there is room to wrap and
              centre them, which is where they read as a menu. */}
          <div
            role="group"
            aria-label={t("communities.title")}
            className="-mx-4 mt-6 flex gap-2 overflow-x-auto px-4 pb-1 sm:mx-0 sm:flex-wrap sm:justify-center sm:px-0"
          >
            {chips.map((chip) => (
              <button
                key={chip.id ?? "all"}
                type="button"
                aria-pressed={chip.active}
                data-category={chip.id ?? "all"}
                className={cn(
                  "flex shrink-0 items-center gap-1.5 rounded-full border px-3.5 py-1.5 text-sm transition",
                  chip.active
                    ? "border-signal bg-signal font-semibold text-ink"
                    : "border-ink-4 bg-ink-2 text-paper-muted hover:border-ink-4 hover:bg-ink-3 hover:text-paper",
                )}
                onClick={() => setCategory(chip.id)}
              >
                <span aria-hidden="true">{chip.emoji}</span>
                {t(chip.labelKey)}
              </button>
            ))}
          </div>

          {/* Language, on its own line under the chips rather than in them.
              Eleven chips already scroll sideways on a phone; three more at the
              end of that queue would be off-screen exactly when they are most
              useful. A joined pill of three fixed options also reads as a
              different KIND of control — it narrows what the chips chose,
              rather than being another thing to choose. */}
          <div
            role="group"
            aria-label={t("communities.language.label")}
            data-language-filter
            className="mt-3 flex justify-center sm:justify-end"
          >
            <div className="inline-flex items-center gap-0.5 rounded-full border border-ink-4 bg-ink-2 p-0.5">
              {languages.map((segment) => (
                <button
                  key={segment.id ?? "all"}
                  type="button"
                  aria-pressed={segment.active}
                  data-language={segment.id ?? "all"}
                  className={cn(
                    "rounded-full px-3 py-1 text-xs font-medium transition",
                    segment.active
                      ? "bg-signal text-ink"
                      : "text-paper-muted hover:text-paper",
                  )}
                  onClick={() => setLanguage(segment.id)}
                >
                  {t(segment.labelKey)}
                </button>
              ))}
            </div>
          </div>

          {/* The Create call to action, above the grid and not buried under it.
              A directory whose only answer to "none of these are mine" is a
              scroll to the bottom teaches people that making one is an advanced
              move. It is not: it is the other half of the feature. */}
          <div className="mt-6 flex flex-col gap-3 rounded-2xl border border-signal/25 bg-signal/[0.06] p-4 sm:flex-row sm:items-center sm:justify-between sm:p-5">
            <div className="min-w-0">
              <p className="flex items-center gap-2 font-display text-base font-bold">
                <Sparkles aria-hidden="true" className="h-4 w-4 text-signal" />
                {t("communities.create.title")}
              </p>
              <p className="mt-1 text-sm text-paper-muted">
                {t("communities.create.body")}
              </p>
            </div>
            <Button className="shrink-0 self-start sm:self-auto" onClick={onCreateCommunity}>
              <Plus aria-hidden="true" className="h-4 w-4" />
              {t("communities.create.action")}
            </Button>
          </div>

          {joinError && (
            <p role="alert" className="mt-6 text-sm text-danger">
              {joinError}
            </p>
          )}

          {loading ? (
            <ul
              className="mt-6 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3"
              aria-busy="true"
              aria-label={t("communities.loading")}
            >
              {Array.from({ length: SKELETON_COUNT }).map((_, i) => (
                <CommunityCardSkeleton key={i} />
              ))}
            </ul>
          ) : error ? (
            <div className="mt-14 flex flex-col items-center gap-4 text-center">
              <span aria-hidden="true" className="text-4xl">
                🛰️
              </span>
              <p role="alert" className="text-sm text-danger">
                {error}
              </p>
              <Button
                variant="secondary"
                onClick={() => setReloadKey((n) => n + 1)}
              >
                {t("communities.retry")}
              </Button>
            </div>
          ) : communities.length === 0 ? (
            <div className="mx-auto mt-14 flex max-w-md flex-col items-center gap-3 text-center">
              {/* Personality rather than an empty box: the directory is
                  supposed to be a place with a sense of humour, and the moment
                  it has nothing to show is the moment that matters most. */}
              <span aria-hidden="true" className="text-5xl">
                🦗
              </span>
              <p className="font-display text-xl font-bold">{t(empty.title)}</p>
              <p className="text-sm text-paper-muted">{t(empty.body)}</p>
              {empty.hint && (
                <p className="text-xs text-paper-muted">{t(empty.hint)}</p>
              )}
              <Button className="mt-2" onClick={onCreateCommunity}>
                <Plus aria-hidden="true" className="h-4 w-4" />
                {t("communities.create.action")}
              </Button>
            </div>
          ) : (
            <>
              <ul className="mt-6 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
                {communities.map((community) => (
                  <CommunityCard
                    key={community.id}
                    community={community}
                    joining={joiningId === community.id}
                    bannerUrl={community.bannerUrl}
                    iconUrl={community.iconUrl}
                    onEnter={() => void enter(community)}
                    onReport={() => onReport(community)}
                  />
                ))}
              </ul>
              {hasMore && (
                <div className="mt-8 flex justify-center">
                  <Button
                    variant="secondary"
                    disabled={loadingMore}
                    onClick={() => void loadMore()}
                  >
                    {loadingMore
                      ? t("communities.loading")
                      : t("communities.loadMore")}
                  </Button>
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
