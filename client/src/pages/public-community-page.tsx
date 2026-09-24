import { SignUpButton, SignedIn, SignedOut } from "@clerk/clerk-react";
import { intlLocale } from "@/lib/locale";
import { ArrowUpRight, Check, Copy } from "lucide-react";
import { useCallback, useEffect, useMemo, useState, type CSSProperties } from "react";
import { Link } from "react-router-dom";
import {
  monthStampToDate,
  publicCommunityDisplayUrl,
  publicCommunityPath,
  COMMUNITY_SLUG_PATTERN,
  type PublicCommunity,
} from "@pqp/shared";
import { CommunityAboutText } from "@/components/communities/community-about-text";
import { CommunityFeaturedMedia } from "@/components/communities/community-featured-media";
import { HeroMosaic } from "@/components/communities/hero-mosaic";
import { CommunityOfficialLinks } from "@/components/communities/community-official-links";
import { MarketingFooter } from "@/components/marketing/marketing-footer";
import { MarketingNav } from "@/components/marketing/marketing-nav";
import { Seo } from "@/components/marketing/seo";
import { Button } from "@/components/ui/button";
import { fetchPublicCommunity } from "@/lib/api";
import { resolveUploadedImageUrl } from "@/lib/avatar";
import { isDevAuthBypassEnabled } from "@/lib/dev-auth";
import { intentStorage, stashJoinIntent } from "@/lib/handle-intent";
import { heroHue, heroTintStyle, initialsFor } from "@/lib/hero-tint";
import { usePrefersReducedMotion } from "@/hooks/use-reduced-motion";
import { useTranslation } from "@/lib/i18n";
import { cn } from "@/lib/utils";

/**
 * `pqp.gg/c/valorant-brasil` — the front door of a community, for people who do
 * not have an account yet.
 *
 * WHY THIS PAGE EXISTS. The directory inside the app is excellent at answering
 * "what is there?" for somebody who has already signed up, and completely
 * useless for the way communities actually spread, which is one person pasting
 * a link into another group chat. Before this, the only shareable address a
 * community had was an invite code — a string that says nothing about where it
 * leads, cannot be read aloud, and expires. This is the poster: a name, a
 * picture, a pitch, how many people are in there, and one button.
 *
 * IT IS A POSTER AND NOT A WINDOW, and the whole design follows from that. No
 * member list — who is in a room is a fact about those people, not about the
 * room, and publishing it would be the single worst thing this page could do.
 * No messages, no channels, no owner. What a stranger gets is exactly what they
 * need to decide whether to knock, and `publicCommunitySchema` is where that
 * line is drawn and defended.
 *
 * THE CTA CARRIES AN INTENT THROUGH SIGN-UP. Somebody who taps "Entrar na
 * comunidade" with no account has to end up INSIDE this community after the
 * age gate, not in an empty hub — the same failure `signedOutRedirectPath` was
 * written to fix for invites, and the same machinery `?add=<handle>` uses for
 * profiles. The value that travels is the SLUG, never an id: this page was
 * never given one.
 *
 * THE META TAGS COME FROM SOMEWHERE ELSE. `Seo` writes the head for a human who
 * is already here; the card WhatsApp draws is written at the edge by
 * `client/functions/_middleware.ts` through `lib/community-meta.ts`, because no
 * unfurler runs this script.
 */

type LoadState =
  | { status: "loading" }
  | { status: "found"; community: PublicCommunity }
  | { status: "missing" }
  | { status: "error" };

export function PublicCommunityPage({ slug }: { slug: string }) {
  const { t } = useTranslation();
  const [state, setState] = useState<LoadState>({ status: "loading" });
  const [attempt, setAttempt] = useState(0);

  // A slug that could never name a community is answered without a round trip.
  // The API would 404 it anyway; skipping the call means a scanner walking
  // `/c/a`, `/c/--`, `/c/<400 chars>` costs us nothing.
  const wellFormed = COMMUNITY_SLUG_PATTERN.test(slug);

  useEffect(() => {
    if (!wellFormed) {
      setState({ status: "missing" });
      return;
    }
    const controller = new AbortController();
    setState({ status: "loading" });
    fetchPublicCommunity(slug, { signal: controller.signal })
      .then((community) => {
        setState(
          community ? { status: "found", community } : { status: "missing" },
        );
      })
      .catch(() => {
        if (!controller.signal.aborted) {
          // NOT "missing". A network drop rendered as "this community does not
          // exist" tells somebody their friend's link is dead when it is not,
          // and there is no way back from that sentence.
          setState({ status: "error" });
        }
      });
    return () => controller.abort();
  }, [slug, wellFormed, attempt]);

  if (state.status === "loading") {
    return <CommunityShell narrow>{null}</CommunityShell>;
  }

  if (state.status === "error") {
    return (
      <CommunityShell narrow>
        <div className="rounded-3xl border border-ink-4 bg-ink-2/80 px-6 py-10 text-center backdrop-blur-sm">
          <h1 className="font-display text-2xl font-bold">
            {t("publicCommunity.unavailable.title")}
          </h1>
          <p className="mt-3 text-paper-muted">
            {t("publicCommunity.unavailable.body")}
          </p>
          <Button
            className="cta-lift mt-6"
            onClick={() => setAttempt((n) => n + 1)}
          >
            {t("publicCommunity.retry")}
          </Button>
        </div>
      </CommunityShell>
    );
  }

  if (state.status === "missing") {
    return <MissingCommunity slug={slug} />;
  }

  return <CommunityPoster community={state.community} />;
}

function CommunityShell({
  children,
  narrow = false,
}: {
  children: React.ReactNode;
  narrow?: boolean;
}) {
  return (
    <div className="min-h-full bg-ink text-paper">
      <MarketingNav />
      <main
        className={cn(
          "relative px-4 pb-16 sm:px-6",
          narrow
            ? "flex min-h-[70vh] flex-col items-center justify-center overflow-hidden py-16"
            : "pt-6 sm:pt-8",
        )}
      >
        <div
          className="pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_at_50%_0%,var(--glow-accent),transparent_60%)]"
          aria-hidden
        />
        <div
          className={cn(
            "relative z-10 w-full",
            narrow ? "max-w-md" : "mx-auto max-w-3xl",
          )}
        >
          {children}
        </div>
      </main>
      <MarketingFooter />
    </div>
  );
}

/**
 * One glyph per category. The third copy of this map — see the note on
 * `BADGE_GLYPHS` in the profile page for why these public pages carry their own
 * rather than importing the app's Communities model, which lives behind a
 * feature flag this page must render without.
 */
const CATEGORY_GLYPHS: Record<string, string> = {
  games: "🎮",
  musica: "🎧",
  futebol: "⚽",
  estudos: "📚",
  anime: "🌸",
  tech: "💻",
  humor: "😂",
  "series-filmes": "🍿",
  corre: "💸",
  geral: "🌎",
};

function CommunityPoster({ community }: { community: PublicCommunity }) {
  const { t, locale } = useTranslation();
  const bypass = isDevAuthBypassEnabled();
  const reduced = usePrefersReducedMotion();
  const url = publicCommunityDisplayUrl(community.slug);
  const [copied, setCopied] = useState(false);

  const copy = useCallback(() => {
    void navigator.clipboard
      ?.writeText(`https://${url}`)
      .then(() => setCopied(true))
      .catch(() => {
        // No clipboard (plain http, an embedded webview). The URL is in the
        // address bar, which is where somebody who cannot copy will go next.
      });
  }, [url]);

  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), 2000);
    return () => window.clearTimeout(timer);
  }, [copied]);

  /**
   * The join intent, in one click.
   *
   * Signed in: `/app?join=<slug>`, where the app resolves the slug and posts
   * the ordinary join. Signed out: the slug is stashed BEFORE Clerk takes over,
   * because the modal is a navigation this component does not survive, and then
   * `forceRedirectUrl` carries the same value in the URL as the belt to that
   * brace. See `lib/handle-intent.ts` for why both.
   */
  const rememberIntent = () => stashJoinIntent(intentStorage(), community.slug);
  const appHref = `/app?join=${encodeURIComponent(community.slug)}`;

  // Seeded from the slug rather than the name, for the reason the profile's is
  // seeded from the handle: a name can be edited at any moment, and the
  // generated hero must not change colour under a link somebody already shared.
  const hue = useMemo(() => heroHue(community.slug), [community.slug]);
  const bannerUrl = resolveUploadedImageUrl(community.bannerUrl);
  const iconUrl = resolveUploadedImageUrl(community.iconUrl);

  const since = monthStampToDate(community.createdMonth);
  const sinceLabel = since
    ? since.toLocaleDateString(intlLocale(locale), {
        month: "long",
        year: "numeric",
        timeZone: "UTC",
      })
    : null;

  const memberLabel = t("publicCommunity.members", {
    count: community.memberCount,
    countLabel: community.memberCount.toLocaleString(
      locale === "en" ? "en-US" : intlLocale(locale),
    ),
  });
  const countLabel = community.memberCount.toLocaleString(
    locale === "en" ? "en-US" : intlLocale(locale),
  );
  const stagger = (index: number): CSSProperties | undefined =>
    reduced ? undefined : ({ "--stagger": Math.min(index, 8) } as CSSProperties);

  return (
    <CommunityShell>
      <article data-public-community={community.slug}>
        <div
          className={cn("relative h-44 w-full overflow-hidden rounded-3xl sm:h-64", !reduced && "animate-rise")}
          style={stagger(0)}
        >
          {bannerUrl ? (
            <img
              src={bannerUrl}
              alt=""
              className="h-full w-full object-cover"
              fetchPriority="high"
              decoding="async"
            />
          ) : (
            <HeroMosaic hue={hue} />
          )}
          <span
            aria-hidden
            className="absolute inset-0 bg-[image:var(--scrim-hero)]"
          />
        </div>

        <div className="px-6 pb-12 sm:px-10">
          <div
            className={cn("flex flex-col sm:flex-row sm:items-end sm:gap-5", !reduced && "animate-rise")}
            style={stagger(1)}
          >
            <span
              aria-hidden
              className="relative -mt-14 flex h-24 w-24 shrink-0 items-center justify-center overflow-hidden rounded-3xl font-display text-2xl font-bold text-paper shadow-[var(--shadow-hero-avatar)] ring-4 ring-ink sm:-mt-16 sm:h-28 sm:w-28"
              style={iconUrl ? undefined : heroTintStyle(hue, 60)}
            >
              {iconUrl ? (
                <img
                  src={iconUrl}
                  alt=""
                  className="h-full w-full object-cover"
                  decoding="async"
                />
              ) : (
                initialsFor(community.name)
              )}
            </span>
            <div className="mt-4 min-w-0 flex-1 sm:mt-0 sm:pb-1">
              <span className="inline-flex items-center gap-1.5 rounded-full border border-ink-4 bg-ink/60 px-2.5 py-1 text-[11px] font-semibold uppercase tracking-wider text-paper-muted">
                <span aria-hidden>
                  {CATEGORY_GLYPHS[community.category] ?? "🌎"}
                </span>
                {t(`communities.category.${community.category}` as never)}
              </span>
              <h1 className="mt-2 font-display text-3xl font-extrabold leading-tight tracking-tight sm:text-4xl">
                {community.name}
              </h1>
              <p className="mt-1 font-mono text-sm text-signal">{url}</p>
              {community.tagline && (
                <p className="mt-3 text-lg leading-snug text-paper-muted">
                  {community.tagline}
                </p>
              )}
            </div>
          </div>

          {/* About and links fill the poster column, the same width the
              featured 16:9 below them takes, and sit closer to each other
              than to the identity above and the media below: they are the
              pitch, read as one block. */}
          {community.about && (
            <div
              className={cn("mt-8", !reduced && "animate-rise")}
              style={stagger(2)}
            >
              <CommunityAboutText about={community.about} lines={8} />
            </div>
          )}

          {community.links.length > 0 && (
            <div
              className={cn("mt-6", !reduced && "animate-rise")}
              style={stagger(3)}
            >
              <CommunityOfficialLinks links={community.links} />
            </div>
          )}

          {community.featured && (
            <div
              className={cn("mt-10", !reduced && "animate-rise")}
              style={stagger(4)}
            >
              <CommunityFeaturedMedia
                featured={community.featured}
                clickToPlay
              />
            </div>
          )}

          <p
            className={cn(
              "mt-10 text-sm text-paper-muted",
              !reduced && "animate-rise",
            )}
            style={stagger(5)}
          >
            {sinceLabel
              ? t("publicCommunity.membersFootnote", {
                  count: community.memberCount,
                  countLabel,
                  date: sinceLabel,
                })
              : memberLabel}
          </p>

          <div
            className={cn(
              "mt-8 flex flex-col gap-2 sm:flex-row sm:items-center",
              !reduced && "animate-rise",
            )}
            style={stagger(6)}
          >
            {bypass ? (
              <Button
                asChild
                className="cta-lift h-12 w-full flex-1 rounded-full text-base sm:w-auto"
              >
                <Link to={appHref}>{t("publicCommunity.cta.join")}</Link>
              </Button>
            ) : (
              <>
                <SignedOut>
                  <SignUpButton mode="modal" forceRedirectUrl={appHref}>
                    <Button
                      className="cta-lift h-12 w-full flex-1 rounded-full text-base sm:w-auto"
                      onClick={rememberIntent}
                    >
                      {t("publicCommunity.cta.join")}
                      <ArrowUpRight aria-hidden className="h-4 w-4" />
                    </Button>
                  </SignUpButton>
                </SignedOut>
                <SignedIn>
                  <Button
                    asChild
                    className="cta-lift h-12 w-full flex-1 rounded-full text-base sm:w-auto"
                  >
                    <Link to={appHref}>{t("publicCommunity.cta.join")}</Link>
                  </Button>
                </SignedIn>
              </>
            )}

            <button
              type="button"
              onClick={copy}
              className={cn(
                "inline-flex h-12 items-center justify-center gap-1.5 rounded-full border border-ink-4 px-4 font-mono text-xs transition-colors duration-[var(--duration-fast)]",
                copied
                  ? "border-success/50 text-success"
                  : "text-paper-muted hover:border-signal/50 hover:text-paper",
              )}
            >
              {copied ? (
                <Check aria-hidden className="h-3.5 w-3.5" />
              ) : (
                <Copy aria-hidden className="h-3.5 w-3.5" />
              )}
              {copied ? t("publicCommunity.copied") : t("publicCommunity.copy")}
            </button>
          </div>

          <section
            className={cn("mt-10", !reduced && "animate-rise")}
            style={stagger(7)}
          >
            <h2 className="text-[11px] font-semibold uppercase tracking-[0.2em] text-paper-muted">
              {t("publicCommunity.whatIsPqp.title")}
            </h2>
            <p className="mt-2 text-sm leading-relaxed text-paper-muted">
              {t("publicCommunity.whatIsPqp.body")}
            </p>
          </section>
        </div>

        <Link
          to="/"
          className="flex items-center justify-center gap-1.5 px-6 py-3 text-xs font-medium uppercase tracking-[0.16em] text-paper-muted transition-colors hover:text-signal"
        >
          {t("publicCommunity.footer.cta")}
          <ArrowUpRight aria-hidden className="h-3.5 w-3.5" />
        </Link>
      </article>

      <Seo
        title={t("publicCommunity.seo.title", { name: community.name })}
        description={
          community.about ??
          community.tagline ??
          t("publicCommunity.seo.description", { name: community.name })
        }
        path={publicCommunityPath(community.slug)}
      />
      <span className="sr-only">{memberLabel}</span>
    </CommunityShell>
  );
}

/**
 * No such community.
 *
 * ONE PAGE FOR FOUR OUTCOMES, which is not laziness — it is the client half of
 * the server's refusal to tell them apart. Unknown slug, private server,
 * suspended listing and "this deployment has communities off" all answer 404,
 * because any difference between them would publish the operator's moderation
 * decisions to anybody holding a URL. So the copy has to be true of all four,
 * which is why it says "the link may be wrong, or it may have been taken down"
 * rather than guessing.
 *
 * `noIndex`, because a page about a community that is not there is not a page
 * worth having in an index.
 */
function MissingCommunity({ slug }: { slug: string }) {
  const { t } = useTranslation();
  return (
    <CommunityShell narrow>
      <div className="animate-rise rounded-3xl border border-ink-4 bg-ink-2/80 px-6 py-10 text-center backdrop-blur-sm sm:px-8">
        <p className="font-mono text-sm text-paper-muted">
          {publicCommunityDisplayUrl(slug)}
        </p>
        <h1 className="mt-4 font-display text-2xl font-bold tracking-tight">
          {t("publicCommunity.missing.title")}
        </h1>
        <p className="mt-3 text-paper-muted">
          {t("publicCommunity.missing.body")}
        </p>
        <Button asChild className="cta-lift mt-7 h-11 rounded-full px-6 text-base">
          <Link to="/app">{t("publicCommunity.missing.cta")}</Link>
        </Button>
      </div>
      <Seo
        title={t("publicCommunity.missing.title")}
        description={t("publicCommunity.missing.body")}
        path={publicCommunityPath(slug)}
        noIndex
      />
    </CommunityShell>
  );
}
