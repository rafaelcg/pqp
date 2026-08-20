import { SignUpButton, SignedIn, SignedOut } from "@clerk/clerk-react";
import { ArrowUpRight, Check, Copy, Users } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import {
  monthStampToDate,
  publicCommunityDisplayUrl,
  publicCommunityPath,
  COMMUNITY_SLUG_PATTERN,
  type PublicCommunity,
} from "@pqp/shared";
import { MarketingFooter } from "@/components/marketing/marketing-footer";
import { MarketingNav } from "@/components/marketing/marketing-nav";
import { Seo } from "@/components/marketing/seo";
import { Button } from "@/components/ui/button";
import { fetchPublicCommunity } from "@/lib/api";
import { resolveUploadedImageUrl } from "@/lib/avatar";
import { isDevAuthBypassEnabled } from "@/lib/dev-auth";
import { intentStorage, stashJoinIntent } from "@/lib/handle-intent";
import { heroHue, heroTintStyle, initialsFor } from "@/lib/hero-tint";
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
    <div className="flex min-h-full flex-col bg-ink text-paper">
      <MarketingNav />
      <main
        className={cn(
          "relative flex flex-1 flex-col overflow-hidden px-4 pb-16 sm:px-6",
          narrow ? "items-center justify-center py-16" : "pt-6 sm:pt-8",
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
    ? since.toLocaleDateString(locale === "pt-BR" ? "pt-BR" : "en", {
        month: "long",
        year: "numeric",
        timeZone: "UTC",
      })
    : null;

  const memberLabel = t("publicCommunity.members", {
    count: community.memberCount,
    countLabel: community.memberCount.toLocaleString(
      locale === "pt-BR" ? "pt-BR" : "en-US",
    ),
  });

  return (
    <CommunityShell>
      <article
        className="animate-rise overflow-hidden rounded-3xl border border-ink-4 bg-ink-2/80 shadow-[var(--shadow-profile-card)] backdrop-blur-sm"
        data-public-community={community.slug}
      >
        <div
          className="relative h-36 w-full sm:h-52"
          style={bannerUrl ? undefined : heroTintStyle(hue, 45)}
        >
          {bannerUrl && (
            <img
              src={bannerUrl}
              alt=""
              className="h-full w-full object-cover"
              fetchPriority="high"
              decoding="async"
            />
          )}
          <span
            aria-hidden
            className="absolute inset-0 bg-[image:var(--scrim-hero)]"
          />
        </div>

        <div className="px-5 pb-8 sm:px-8">
          <div className="flex flex-col items-center text-center sm:flex-row sm:items-end sm:gap-5 sm:text-left">
            {/* `relative` is load-bearing, not decoration: the hero above is
                positioned, and a positioned box paints over a static sibling
                whatever the source order says — without this the icon is sliced
                in half by the banner it is supposed to overlap. */}
            <span
              aria-hidden
              className="relative -mt-14 flex h-24 w-24 shrink-0 items-center justify-center overflow-hidden rounded-3xl font-display text-2xl font-bold text-paper shadow-[var(--shadow-hero-avatar)] ring-4 ring-ink-2 sm:-mt-16 sm:h-28 sm:w-28"
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
            <div className="mt-3 min-w-0 flex-1 sm:mt-0 sm:pb-1">
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
            </div>
          </div>

          {community.tagline && (
            // The joke, at reading size and not at caption size. It is the one
            // thing on the page written by a person about this room, and
            // shrinking it to a subtitle is how a directory of communities
            // starts to look like a directory of database rows.
            <p className="mt-5 text-lg leading-snug text-paper-muted">
              {community.tagline}
            </p>
          )}

          {/* THE NUMBER, BIG. A stranger deciding whether to walk into a room
              wants to know whether there is anybody in it, and every other fact
              on this page is subordinate to that one. Tabular figures so it
              does not shimmer if it re-renders. */}
          <div className="mt-6 rounded-2xl bg-[radial-gradient(ellipse_at_0%_50%,var(--glow-accent-soft),transparent_70%)] py-1">
            <p className="flex items-baseline gap-2">
              <span className="font-display text-4xl font-extrabold tabular-nums text-paper sm:text-5xl">
                {community.memberCount.toLocaleString(
                  locale === "pt-BR" ? "pt-BR" : "en-US",
                )}
              </span>
              <span className="flex items-center gap-1.5 text-sm text-paper-muted">
                <Users aria-hidden className="h-4 w-4" />
                {t("publicCommunity.membersLabel")}
              </span>
            </p>
            {/* Its own line rather than a second column. At 390px the two sit
                on one row only by wrapping into a ragged pair, and the tenure
                line is a footnote to the count — putting it beside the count
                makes it read as a second statistic of equal weight. */}
            {sinceLabel && (
              <p className="mt-1 text-xs text-paper-muted">
                {t("publicCommunity.since", { date: sinceLabel })}
              </p>
            )}
          </div>

          <div className="mt-6 flex flex-col gap-2 sm:flex-row sm:items-center">
            {bypass ? (
              <Button
                asChild
                className="cta-lift h-11 flex-1 rounded-full text-base"
              >
                <Link to={appHref}>{t("publicCommunity.cta.join")}</Link>
              </Button>
            ) : (
              <>
                <SignedOut>
                  <SignUpButton mode="modal" forceRedirectUrl={appHref}>
                    <Button
                      className="cta-lift h-11 flex-1 rounded-full text-base"
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
                    className="cta-lift h-11 flex-1 rounded-full text-base"
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
                "inline-flex h-11 items-center justify-center gap-1.5 rounded-full border border-ink-4 px-4 font-mono text-xs transition-colors",
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

          {/* Whoever followed this link may never have heard of the product.
              One paragraph, below the fold of the decision they came to make,
              so it explains without getting in the way. */}
          <section className="mt-8 rounded-2xl border border-ink-4/70 bg-ink/40 p-4">
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
          className="flex items-center justify-center gap-1.5 border-t border-ink-4/70 bg-ink/60 px-6 py-3 text-xs font-medium uppercase tracking-[0.16em] text-paper-muted transition-colors hover:text-signal"
        >
          {t("publicCommunity.footer.cta")}
          <ArrowUpRight aria-hidden className="h-3.5 w-3.5" />
        </Link>
      </article>

      <Seo
        title={t("publicCommunity.seo.title", { name: community.name })}
        description={
          community.tagline ??
          t("publicCommunity.seo.description", { name: community.name })
        }
        path={publicCommunityPath(community.slug)}
      />
      {/* Not rendered as text anywhere; the member count is what the page shows
          and this is only the accessible sentence for it. */}
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
