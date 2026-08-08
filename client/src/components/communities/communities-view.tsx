import {
  COMMUNITY_PAGE_SIZE,
  type CommunitySummary,
} from "@pqp/shared";
import { Compass, Flag, Menu, Search } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ChannelListSkeleton } from "@/components/ui/skeleton";
import { ServerIcon } from "@/components/layout/server-identity";
import { resolveUploadedImageUrl } from "@/lib/avatar";
import { ApiError, fetchCommunities, joinCommunity } from "@/lib/api";
import { useTranslation } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import {
  applyJoin,
  cardAction,
  categoryChips,
  emptyStateKeys,
  memberCountKey,
  mergePages,
  monogram,
  type CategoryFilter,
} from "./communities-model";

/** Long enough that typing a word does not fire five requests. */
const SEARCH_DEBOUNCE_MS = 250;

interface CommunitiesViewProps {
  /** Mobile-only hamburger, same affordance the Friends view has. */
  onOpenNav?: () => void;
  /**
   * Joined (or opened) a community — the app switches to that server and
   * shows the arrival banner if this is the first time on this device.
   */
  onEnterCommunity: (serverId: string, joinedNow: boolean) => void | Promise<void>;
  /** Opens the shared report dialog with a `server` target. */
  onReport: (community: CommunitySummary) => void;
}

/**
 * The Communities directory: search, category chips, a grid of cards.
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
  onOpenNav,
  onEnterCommunity,
  onReport,
}: CommunitiesViewProps) {
  const { t } = useTranslation();
  const [category, setCategory] = useState<CategoryFilter>(null);
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
      { category, query: query || null, limit: COMMUNITY_PAGE_SIZE },
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
  }, [category, query, reloadKey, t]);

  const loadMore = useCallback(async () => {
    setLoadingMore(true);
    try {
      const page = await fetchCommunities({
        category,
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
  }, [category, query, communities.length, t]);

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
  const empty = emptyStateKeys(query);

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-communities-view>
      <header className="flex h-14 shrink-0 items-center gap-3 border-b border-ink-4/60 px-4">
        {onOpenNav && (
          <button
            type="button"
            className="rounded-md p-1.5 hover:bg-ink-3 md:hidden"
            aria-label={t("empty.openNav")}
            onClick={onOpenNav}
          >
            <Menu className="h-5 w-5" />
          </button>
        )}
        <Compass
          aria-hidden="true"
          className="h-5 w-5 shrink-0 text-paper-muted"
        />
        <h1 className="truncate font-display text-base font-bold">
          {t("communities.title")}
        </h1>
        <p className="hidden truncate text-sm text-paper-muted sm:block">
          {t("communities.subtitle")}
        </p>
      </header>

      <div className="shrink-0 space-y-3 border-b border-ink-4/60 px-4 py-3">
        <div className="relative max-w-md">
          <Search
            aria-hidden="true"
            className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-paper-muted"
          />
          <Input
            type="search"
            value={rawQuery}
            aria-label={t("communities.search")}
            placeholder={t("communities.searchPlaceholder")}
            className="pl-9"
            onChange={(e) => setRawQuery(e.target.value)}
          />
        </div>

        {/* A horizontally scrolling row rather than a wrapping one: ten chips
            wrap to three lines on a 390px phone and push the first card below
            the fold, which is the whole screen this feature has. */}
        <div
          role="group"
          aria-label={t("communities.title")}
          className="-mx-1 flex gap-1.5 overflow-x-auto px-1 pb-1"
        >
          {chips.map((chip) => (
            <button
              key={chip.id ?? "all"}
              type="button"
              aria-pressed={chip.active}
              data-category={chip.id ?? "all"}
              className={cn(
                "shrink-0 rounded-full px-3 py-1 text-sm transition-colors",
                chip.active
                  ? "bg-signal font-semibold text-ink"
                  : "bg-ink-3 text-paper-muted hover:bg-ink-4 hover:text-paper",
              )}
              onClick={() => setCategory(chip.id)}
            >
              {t(chip.labelKey)}
            </button>
          ))}
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-4">
        {joinError && (
          <p role="alert" className="mb-3 text-sm text-danger">
            {joinError}
          </p>
        )}

        {loading ? (
          <ChannelListSkeleton />
        ) : error ? (
          <div className="space-y-3">
            <p role="alert" className="text-sm text-danger">
              {error}
            </p>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => setReloadKey((n) => n + 1)}
            >
              {t("communities.retry")}
            </Button>
          </div>
        ) : communities.length === 0 ? (
          <div className="max-w-sm space-y-2 py-8">
            <p className="font-display text-xl font-bold">{t(empty.title)}</p>
            <p className="text-sm text-paper-muted">{t(empty.body)}</p>
            {empty.hint && (
              <p className="text-xs text-paper-muted">{t(empty.hint)}</p>
            )}
          </div>
        ) : (
          <>
            <ul className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
              {communities.map((community) => (
                <CommunityCard
                  key={community.id}
                  community={community}
                  joining={joiningId === community.id}
                  onEnter={() => void enter(community)}
                  onReport={() => onReport(community)}
                />
              ))}
            </ul>
            {hasMore && (
              <div className="mt-4 flex justify-center">
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
  );
}

function CommunityCard({
  community,
  joining,
  onEnter,
  onReport,
}: {
  community: CommunitySummary;
  joining: boolean;
  onEnter: () => void;
  onReport: () => void;
}) {
  const { t } = useTranslation();
  const action = cardAction(community);
  // The report control is revealed on hover/focus like every other quiet row
  // action in the app, but it stays reachable by keyboard at all times — a
  // moderation affordance that only exists for people with a pointer is not a
  // moderation affordance.
  const cardRef = useRef<HTMLLIElement>(null);

  return (
    <li
      ref={cardRef}
      className="group relative flex flex-col overflow-hidden rounded-lg border border-ink-4 bg-ink-2/60 transition-colors hover:border-ink-4/80 hover:bg-ink-3/40"
      data-community={community.id}
    >
      {/* The banner, where there is one, above everything and edge to edge.
          A card without one keeps the layout it had — the padding moved off the
          `<li>` and onto the body below precisely so the image can bleed. */}
      <CommunityBanner name={community.name} bannerUrl={community.bannerUrl} />

      <div className="flex flex-1 flex-col gap-3 p-4">
      <div className="flex items-start gap-3">
        <span
          aria-hidden="true"
          className="flex h-11 w-11 shrink-0 items-center justify-center overflow-hidden rounded-xl bg-ink-4 font-display text-sm font-bold text-paper"
        >
          {/* The directory keeps its own monogram — see the `fallback` note on
              `ServerIcon`. Only the image path is shared. */}
          <ServerIcon
            name={community.name}
            iconUrl={community.iconUrl}
            fallback={monogram(community.name)}
          />
        </span>
        <div className="min-w-0 flex-1">
          <p className="truncate font-display text-base font-bold text-paper">
            {community.name}
          </p>
          <p className="mt-0.5 text-xs uppercase tracking-wide text-paper-muted">
            {t(`communities.category.${community.category}` as never)}
            {" · "}
            <span className="tabular-nums">
              {t(memberCountKey(community.memberCount), {
                count: community.memberCount,
              })}
            </span>
          </p>
        </div>
        <button
          type="button"
          title={t("communities.report")}
          aria-label={`${t("communities.report")}: ${community.name}`}
          className="shrink-0 rounded-md p-1.5 text-paper-muted opacity-0 hover:bg-ink-3 hover:text-danger focus-visible:opacity-100 group-hover:opacity-100"
          onClick={onReport}
        >
          <Flag aria-hidden="true" className="h-3.5 w-3.5" />
        </button>
      </div>

      {/* Clamped to two lines rather than truncated to one: a tagline is the
          joke, and half a joke is worse than none. Cards in a row stay the same
          height because the button block below is pushed down by `mt-auto`. */}
      {community.tagline && (
        <p className="line-clamp-2 text-sm text-paper-muted">
          {community.tagline}
        </p>
      )}

      <div className="mt-auto">
        <Button
          size="sm"
          variant={action === "open" ? "secondary" : "default"}
          disabled={joining}
          onClick={onEnter}
        >
          {joining
            ? t("communities.joining")
            : t(action === "open" ? "communities.open" : "communities.join")}
        </Button>
      </div>
      </div>
    </li>
  );
}

/**
 * The card's banner strip, or nothing.
 *
 * Its own small component rather than `ServerBanner` reused: that one overlays
 * the server's name, because the channel column has no other place to put it.
 * Here the name is already the card's first line, and printing it twice — once
 * over the image, once under it — is what makes a directory look generated. So
 * this is the image alone, at the aspect ratio a 1024×360 upload actually has.
 */
function CommunityBanner({
  name,
  bannerUrl,
}: {
  name: string;
  bannerUrl: string | null;
}) {
  const [failed, setFailed] = useState(false);
  const resolved = resolveUploadedImageUrl(bannerUrl);
  if (!resolved || failed) {
    return null;
  }
  return (
    <img
      src={resolved}
      alt=""
      loading="lazy"
      referrerPolicy="no-referrer"
      data-community-banner={name}
      className="h-24 w-full shrink-0 border-b border-ink-4 object-cover"
      onError={() => setFailed(true)}
    />
  );
}
