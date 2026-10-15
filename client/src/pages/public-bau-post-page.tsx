import { SignUpButton, SignedIn, SignedOut, useAuth } from "@clerk/clerk-react";
import { ArrowUpRight, Heart, MessageCircle } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { Link } from "react-router-dom";
import {
  bauPostPath,
  bauPublicPostPath,
  publicCommunityDisplayUrl,
  publicCommunityPath,
  type PublicBauPostResponse,
  type PublicCommunity,
} from "@pqp/shared";
import { GifAttachment } from "@/components/chat/message-list";
import { ChannelText } from "@/components/community-home/community-home-channel-refs";
import { UnlockedMedia } from "@/components/community-home/community-home-media";
import { BauShareButton } from "@/components/community-home/community-home-share-public";
import { HeroMosaic } from "@/components/communities/hero-mosaic";
import { Seo } from "@/components/marketing/seo";
import { Button } from "@/components/ui/button";
import { usePrefersReducedMotion } from "@/hooks/use-reduced-motion";
import {
  fetchPublicBauPost,
  fetchPublicCommunity,
  lookupCommunityMembership,
} from "@/lib/api";
import { resolveUploadedImageUrl } from "@/lib/avatar";
import { getAuthToken, isDevAuthBypassEnabled } from "@/lib/dev-auth";
import { gifMessageMedia } from "@/lib/gif-media";
import { intentStorage, stashJoinIntent } from "@/lib/handle-intent";
import { heroHue, heroTintStyle, initialsFor } from "@/lib/hero-tint";
import { intlLocale } from "@/lib/locale";
import { noteSignupCta } from "@/lib/signup-assist";
import { useTranslation } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import { CommunityShell, ResumeSignUp } from "./public-community-page";

/**
 * `pqp.gg/c/<slug>/p/<postId>`: one Baú post, for somebody with no account.
 *
 * THE LANDING A SHARE LANDS ON. A member pastes a post into X, Reddit, WhatsApp
 * or Telegram; whoever taps it must see the post itself, immediately, with no
 * wall, and then be offered the room it came from. So the page is the post
 * drawn the way the Baú draws it (same media component, same type), and below
 * it a block that is the community's poster in small: its picture, name, member
 * count, and one button that carries the visitor through sign-up INTO the
 * community (the same `?join=<slug>` intent `/c/<slug>` uses, so the age gate
 * and the arrival flow are the ones every other door already has).
 *
 * A POST, NOT A WINDOW. No author, no comments, no likers: the API does not
 * send them (`publicBauPostSchema`), so nothing here could draw them. Counts
 * only. What a stranger gets is what the staff chose to publish for the open
 * internet.
 *
 * SIGNED IN, THE PAGE KNOWS WHAT YOU ARE. A signed-in person is asked once
 * whether they are already in (`lookupCommunityBySlug`, behind auth, which is
 * where the room's id lives): a member gets "Abrir no app" straight onto the
 * post, anybody else the join button. Until that answers the join button is
 * what shows, because that is true for everyone.
 *
 * THE UNFURL CARD IS WRITTEN SOMEWHERE ELSE: `client/functions/_middleware.ts`
 * through `lib/bau-post-meta.ts`. `Seo` below fixes the head for a human who is
 * already here.
 */

const SURFACE = "community";

type LoadState =
  | { status: "loading" }
  | { status: "found"; data: PublicBauPostResponse }
  | { status: "missing"; community: PublicCommunity | null }
  | { status: "error" };

export function PublicBauPostPage({
  slug,
  postId,
}: {
  slug: string;
  postId: string;
}) {
  const { t } = useTranslation();
  const [state, setState] = useState<LoadState>({ status: "loading" });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    setState({ status: "loading" });
    fetchPublicBauPost(slug, postId, { signal: controller.signal })
      .then(async (data) => {
        if (controller.signal.aborted) {
          return;
        }
        if (data) {
          setState({ status: "found", data });
          return;
        }
        // The post is not available, but the community may still be, and a
        // dead link is the best moment there is to offer the room.
        const community = await fetchPublicCommunity(slug, {
          signal: controller.signal,
        }).catch(() => null);
        if (!controller.signal.aborted) {
          setState({ status: "missing", community });
        }
      })
      .catch(() => {
        if (!controller.signal.aborted) {
          // NOT "missing": a dropped connection is not a dead link.
          setState({ status: "error" });
        }
      });
    return () => controller.abort();
  }, [slug, postId, attempt]);

  if (state.status === "loading") {
    return <CommunityShell narrow>{null}</CommunityShell>;
  }

  if (state.status === "error") {
    return (
      <CommunityShell narrow>
        <div className="rounded-3xl border border-ink-4 bg-ink-2/80 px-6 py-10 text-center backdrop-blur-sm">
          <h1 className="font-display text-2xl font-bold">
            {t("bauPublic.unavailable.title")}
          </h1>
          <p className="mt-3 text-paper-muted">{t("bauPublic.unavailable.body")}</p>
          <Button className="cta-lift mt-6" onClick={() => setAttempt((n) => n + 1)}>
            {t("publicCommunity.retry")}
          </Button>
        </div>
      </CommunityShell>
    );
  }

  if (state.status === "missing") {
    return <MissingPost slug={slug} postId={postId} community={state.community} />;
  }

  return <PostPage slug={slug} data={state.data} />;
}

// -------------------------------------------------------------------- post

function PostPage({ slug, data }: { slug: string; data: PublicBauPostResponse }) {
  const { t, locale } = useTranslation();
  const reduced = usePrefersReducedMotion();
  const { post, community } = data;
  const stagger = (index: number): CSSProperties | undefined =>
    reduced ? undefined : ({ "--stagger": Math.min(index, 8) } as CSSProperties);

  const path = bauPublicPostPath(slug, post.id);
  // The page's own address, so a staging or self-hosted origin shares itself.
  const publicUrl = `${typeof window === "undefined" ? "https://pqp.gg" : window.location.origin}${path}`;
  const shareTitle = post.title?.trim() || post.teaser?.trim() || community.name;

  const postedLabel = post.publishedAt
    ? new Date(post.publishedAt).toLocaleDateString(intlLocale(locale), {
        day: "numeric",
        month: "long",
        year: "numeric",
      })
    : null;
  const gif = post.body ? gifMessageMedia(post.body) : null;
  const iconUrl = resolveUploadedImageUrl(community.iconUrl);
  const hue = useMemo(() => heroHue(community.slug), [community.slug]);

  return (
    <CommunityShell>
      <article data-public-bau-post={post.id} data-public-community={community.slug}>
        <Link
          to={publicCommunityPath(community.slug)}
          className={cn(
            "mb-4 inline-flex max-w-full items-center gap-2.5 rounded-full border border-ink-4 bg-ink-2/70 py-1.5 pl-1.5 pr-4 text-sm text-paper-muted transition-colors hover:border-signal/50 hover:text-paper",
            !reduced && "animate-rise",
          )}
          style={stagger(0)}
        >
          <span
            aria-hidden
            className="flex h-7 w-7 shrink-0 items-center justify-center overflow-hidden rounded-full text-[11px] font-bold text-paper"
            style={iconUrl ? undefined : heroTintStyle(hue, 60)}
          >
            {iconUrl ? (
              <img src={iconUrl} alt="" className="h-full w-full object-cover" decoding="async" />
            ) : (
              initialsFor(community.name)
            )}
          </span>
          <span className="min-w-0 truncate">
            {t("bauPublic.fromBau", { name: community.name })}
          </span>
        </Link>

        <div
          className={cn(
            "overflow-hidden rounded-2xl border border-border bg-surface-1",
            !reduced && "animate-rise",
          )}
          style={stagger(1)}
        >
          {post.media && <UnlockedMedia media={post.media} flush />}
          <div className="p-5 sm:p-7">
            {post.title && (
              <h1 className="break-words font-display text-2xl font-bold leading-snug tracking-tight text-text sm:text-3xl">
                {post.title}
              </h1>
            )}
            {postedLabel && (
              <p className="mt-1.5 text-sm text-text-tertiary">
                {t("bauPublic.posted", { date: postedLabel })}
              </p>
            )}
            {post.body &&
              (gif ? (
                <div className="mt-4">
                  <GifAttachment media={gif} />
                </div>
              ) : (
                <p className="mt-4 whitespace-pre-wrap break-words text-base leading-7 text-text">
                  <ChannelText text={post.body} />
                </p>
              ))}

            <footer className="mt-5 flex flex-wrap items-center gap-3 text-xs text-paper-muted">
              {post.likeCount > 0 && (
                <span
                  className="inline-flex items-center gap-1.5 px-1 py-1"
                  aria-label={t("bauPublic.likes", { count: post.likeCount })}
                  data-public-bau-likes
                >
                  <Heart className="h-4 w-4" aria-hidden />
                  <span className="tabular-nums">{post.likeCount}</span>
                </span>
              )}
              {post.commentCount > 0 && (
                <span
                  className="inline-flex items-center gap-1.5 px-1 py-1"
                  aria-label={t("bauPublic.comments", { count: post.commentCount })}
                  data-public-bau-comments
                >
                  <MessageCircle className="h-4 w-4" aria-hidden />
                  <span className="tabular-nums">{post.commentCount}</span>
                </span>
              )}
              <span className="ml-auto">
                <BauShareButton publicUrl={publicUrl} title={shareTitle} surface="page" />
              </span>
            </footer>
          </div>
        </div>

        <div
          className={cn("mt-8", !reduced && "animate-rise")}
          style={stagger(2)}
        >
          <CommunityCta community={community} postId={post.id} />
        </div>

        <Link
          to="/"
          className="flex items-center justify-center gap-1.5 px-6 py-6 text-xs font-medium uppercase tracking-[0.16em] text-paper-muted transition-colors hover:text-signal"
        >
          {t("publicCommunity.footer.cta")}
          <ArrowUpRight aria-hidden className="h-3.5 w-3.5" />
        </Link>
      </article>

      <Seo
        title={
          post.title
            ? t("bauPublic.seo.title", { title: post.title, name: community.name })
            : t("bauPublic.seo.untitled", { name: community.name })
        }
        description={
          post.teaser ?? t("bauPublic.seo.description", { name: community.name })
        }
        path={path}
      />
    </CommunityShell>
  );
}

// --------------------------------------------------------------------- cta

/**
 * The community's poster, small, with the one button. Shared by the post and by
 * the dead-link page, so a link that stopped working still has somewhere to go.
 */
function CommunityCta({
  community,
  postId,
}: {
  community: PublicCommunity;
  /** The post this page is about, when there is one: where "Abrir no app" lands. */
  postId: string | null;
}) {
  const { t, locale } = useTranslation();
  const bypass = isDevAuthBypassEnabled();
  const hue = useMemo(() => heroHue(community.slug), [community.slug]);
  const bannerUrl = resolveUploadedImageUrl(community.bannerUrl);
  const iconUrl = resolveUploadedImageUrl(community.iconUrl);
  const appHref = `/app?join=${encodeURIComponent(community.slug)}`;
  const countLabel = community.memberCount.toLocaleString(
    locale === "en" ? "en-US" : intlLocale(locale),
  );

  /** The same intent `/c/<slug>` carries through sign-up. See `handle-intent.ts`. */
  const rememberIntent = () => {
    stashJoinIntent(intentStorage(), community.slug);
    noteSignupCta(SURFACE, community.slug);
  };

  const buttonClass =
    "cta-lift h-12 w-full rounded-full text-base sm:w-auto sm:min-w-[15rem]";
  const joinLink = (
    <Button asChild className={buttonClass}>
      <Link to={appHref} data-public-bau-join>
        {t("publicCommunity.cta.join")}
      </Link>
    </Button>
  );

  return (
    <section
      className="overflow-hidden rounded-3xl border border-ink-4 bg-ink-2/80 backdrop-blur-sm"
      data-public-bau-cta
    >
      <div className="relative h-24 w-full overflow-hidden sm:h-32">
        {bannerUrl ? (
          <img src={bannerUrl} alt="" className="h-full w-full object-cover" decoding="async" />
        ) : (
          <HeroMosaic hue={hue} />
        )}
        <span aria-hidden className="absolute inset-0 bg-[image:var(--scrim-hero)]" />
      </div>
      <div className="px-5 pb-6 sm:px-8 sm:pb-8">
        <div className="flex items-end gap-4">
          <span
            aria-hidden
            className="relative -mt-9 flex h-[4.5rem] w-[4.5rem] shrink-0 items-center justify-center overflow-hidden rounded-2xl font-display text-xl font-bold text-paper shadow-[var(--shadow-hero-avatar)] ring-4 ring-ink-2 sm:-mt-11 sm:h-20 sm:w-20"
            style={iconUrl ? undefined : heroTintStyle(hue, 60)}
          >
            {iconUrl ? (
              <img src={iconUrl} alt="" className="h-full w-full object-cover" decoding="async" />
            ) : (
              initialsFor(community.name)
            )}
          </span>
          <div className="min-w-0 flex-1 pb-0.5">
            <h2 className="font-display text-xl font-extrabold leading-tight tracking-tight [overflow-wrap:anywhere] sm:text-2xl">
              {community.name}
            </h2>
            <p className="mt-0.5 font-mono text-xs text-signal">
              {publicCommunityDisplayUrl(community.slug)}
            </p>
          </div>
        </div>

        {community.tagline && (
          <p className="mt-4 text-base leading-snug text-paper-muted [overflow-wrap:anywhere]">
            {community.tagline}
          </p>
        )}
        <p className="mt-3 text-sm text-paper-muted">
          {t("publicCommunity.members", {
            count: community.memberCount,
            countLabel,
          })}
        </p>

        <h3 className="mt-6 font-display text-lg font-bold tracking-tight">
          {t("bauPublic.cta.title")}
        </h3>
        <p className="mt-1 text-sm leading-relaxed text-paper-muted">
          {t("bauPublic.cta.body", { name: community.name })}
        </p>

        <div className="mt-5 flex flex-col gap-2 sm:flex-row sm:items-center">
          {bypass ? (
            <ViewerCta
              community={community}
              postId={postId}
              buttonClass={buttonClass}
              joinLink={joinLink}
              getToken={devToken}
            />
          ) : (
            <>
              <SignedOut>
                <ResumeSignUp slug={community.slug} appHref={appHref} />
                <SignUpButton mode="modal" forceRedirectUrl={appHref}>
                  <Button className={buttonClass} onClick={rememberIntent} data-public-bau-join>
                    {t("publicCommunity.cta.join")}
                    <ArrowUpRight aria-hidden className="h-4 w-4" />
                  </Button>
                </SignUpButton>
              </SignedOut>
              <SignedIn>
                <ClerkViewerCta
                  community={community}
                  postId={postId}
                  buttonClass={buttonClass}
                  joinLink={joinLink}
                />
              </SignedIn>
            </>
          )}
          <Button asChild variant="ghost" className="h-12 rounded-full px-5 text-sm">
            <Link to={publicCommunityPath(community.slug)}>
              {t("bauPublic.cta.seeCommunity")}
            </Link>
          </Button>
        </div>
      </div>
    </section>
  );
}

/** The dev bypass's token, through the same helper every other caller uses. */
const devToken = () => getAuthToken(async () => null);

type ViewerCtaProps = {
  community: PublicCommunity;
  postId: string | null;
  buttonClass: string;
  joinLink: React.ReactNode;
};

/** `ViewerCta` with Clerk's token, for a real signed-in session. */
function ClerkViewerCta(props: ViewerCtaProps) {
  const { getToken } = useAuth();
  // Held in a ref: Clerk's `getToken` is a fresh function on some renders, and
  // a dependency that changes every render would re-ask on every render
  // (CLAUDE.md pitfall 2).
  const ref = useRef(getToken);
  ref.current = getToken;
  const stable = useRef(() => ref.current()).current;
  return <ViewerCta {...props} getToken={stable} />;
}

/**
 * What a signed-in person is offered. Asked once, behind auth, because the
 * room's id (what "Abrir no app" needs to land on the post) is not in the
 * public payload and must not be.
 */
function ViewerCta({
  community,
  postId,
  buttonClass,
  joinLink,
  getToken,
}: ViewerCtaProps & { getToken: () => Promise<string | null> }) {
  const { t } = useTranslation();
  // Keyed by the slug it was asked for, so a result can never be read under
  // another community: a stale one is ignored on the very render that changes
  // the slug, not one effect later.
  const [found, setFound] = useState<{ slug: string; serverId: string } | null>(null);
  const member = found && found.slug === community.slug ? found : null;

  useEffect(() => {
    let cancelled = false;
    // Null for every failure (see `lookupCommunityMembership`): not signed in,
    // banned, offline. The join button is still the truth for all of them.
    void lookupCommunityMembership(community.slug, getToken).then((result) => {
      if (!cancelled && result?.joined) {
        setFound({ slug: community.slug, serverId: result.serverId });
      }
    });
    return () => {
      cancelled = true;
    };
    // `getToken` is stable by construction (a ref-backed wrapper or a module
    // constant), so it is not what re-asks.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [community.slug]);

  if (!member) {
    return <>{joinLink}</>;
  }
  return (
    <Button asChild className={buttonClass}>
      <Link
        to={postId ? bauPostPath(member.serverId, postId) : `/app/server/${member.serverId}`}
        data-public-bau-open
      >
        {t("bauPublic.cta.open")}
        <ArrowUpRight aria-hidden className="h-4 w-4" />
      </Link>
    </Button>
  );
}

// ----------------------------------------------------------------- missing

/**
 * The post is not here. ONE PAGE FOR EVERY REASON, which is the client half of
 * the server's refusal to tell them apart: a draft, a members-only post, a
 * deleted one, a community that turned the feature off and a typo all answer
 * the same 404, so the copy has to be true of all of them. When the community
 * itself is still public its poster is offered, because the person holding a
 * dead link is exactly who should be shown the way in.
 */
function MissingPost({
  slug,
  postId,
  community,
}: {
  slug: string;
  postId: string;
  community: PublicCommunity | null;
}) {
  const { t } = useTranslation();
  return (
    <CommunityShell narrow={!community}>
      <div className="animate-rise rounded-3xl border border-ink-4 bg-ink-2/80 px-6 py-10 text-center backdrop-blur-sm sm:px-8">
        <p className="font-mono text-sm text-paper-muted">
          {publicCommunityDisplayUrl(slug)}
        </p>
        <h1 className="mt-4 font-display text-2xl font-bold tracking-tight">
          {t("bauPublic.missing.title")}
        </h1>
        <p className="mt-3 text-paper-muted">{t("bauPublic.missing.body")}</p>
        {community ? (
          <p className="mt-2 text-paper-muted">
            {t("bauPublic.missing.community", { name: community.name })}
          </p>
        ) : (
          <Button asChild className="cta-lift mt-7 h-11 rounded-full px-6 text-base">
            <Link to="/app">{t("publicCommunity.missing.cta")}</Link>
          </Button>
        )}
      </div>
      {community && (
        <div className="mt-6" data-public-bau-missing-community>
          <CommunityCta community={community} postId={null} />
        </div>
      )}
      <Seo
        title={t("bauPublic.missing.title")}
        description={t("bauPublic.missing.body")}
        path={bauPublicPostPath(slug, postId)}
        noIndex
      />
    </CommunityShell>
  );
}
