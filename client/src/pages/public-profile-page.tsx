import { SignUpButton, SignedIn, SignedOut } from "@clerk/clerk-react";
import { ArrowUpRight, Check, Copy, Quote } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import {
  monthStampToDate,
  publicProfileDisplayUrl,
  publicProfilePath,
  validateHandle,
  type ProfileBadge,
  type PublicDepoimento,
  type PublicProfile,
} from "@pqp/shared";
import { MarketingFooter } from "@/components/marketing/marketing-footer";
import { MarketingNav } from "@/components/marketing/marketing-nav";
import { Seo } from "@/components/marketing/seo";
import { Button } from "@/components/ui/button";
import { UserAvatar } from "@/components/user/user-avatar";
import { fetchPublicProfile } from "@/lib/api";
import { resolveUploadedImageUrl } from "@/lib/avatar";
import { isDevAuthBypassEnabled } from "@/lib/dev-auth";
import { intentStorage, stashAddIntent } from "@/lib/handle-intent";
import { heroHue, heroTintStyle } from "@/lib/hero-tint";
import { useTranslation } from "@/lib/i18n";
import { cn } from "@/lib/utils";

/**
 * `pqp.gg/@rafa` — the page this whole feature exists to produce.
 *
 * DESIGNED TO BE SCREENSHOTTED. That is not a flourish, it is the distribution
 * mechanism: nobody shares a link to a page that looks like a settings form,
 * and the only reason a person claims a handle is to have somewhere worth
 * pointing at.
 *
 * IT USED TO BE ONE CENTRED CARD, and the card was the wrong instinct. A card
 * says "here is a record about a user"; the reference points for this page are
 * a MySpace profile, an Orkut profile and a Twitter profile, and all three are
 * a PAGE about a person — full-bleed image at the top, a face overlapping it,
 * the name at a size that is clearly the headline, and then the things that
 * make that person that person. So the shape is now:
 *
 *  1. A HERO. The banner if they uploaded one, otherwise a gradient generated
 *     from their own name's hue (`hero-tint.ts`) — never a grey band, because
 *     the overwhelming majority will never upload anything and "no image" must
 *     still be a composition.
 *  2. THE IDENTITY BLOCK. Avatar overlapping the hero, display name big, handle
 *     in mono under it, "no pqp desde julho de 2026" as a quiet third line, and
 *     the one thing to do.
 *  3. THE ORKUT SOUL. Community badges as a real grid with glyphs and names,
 *     under the sentence "membro de 5 comunidades" — belonging as a fact, not
 *     an inventory of chips.
 *  4. THE DEPOIMENTOS, RENDERED. Every one of them was written by a friend and
 *     published by this person from a preview that said it would be public;
 *     showing a count instead of the words was withholding the feature from the
 *     one page it was built for.
 *
 * STILL DELIBERATELY NARROW, and the narrowness is a legal posture as much as a
 * design one. What is on this page is what `publicProfileSchema` carries and
 * nothing else — no tag, no id, no presence, no email, no private servers, and
 * a join date truncated to its month before it left the server. See the
 * schema's comment; the short version is that this is the only surface in the
 * product served to somebody with no account, and every field on it had to
 * justify being visible to the whole internet.
 *
 * THE META TAGS ON THIS PAGE COME FROM SOMEWHERE ELSE. `Seo` below writes the
 * head for a human who is already here; the card that WhatsApp and Twitter draw
 * is written at the edge by `client/functions/_middleware.ts`, because those
 * crawlers never run this script. If you change the copy here, change it there —
 * `profileCardText` is the other half of the same sentence.
 */

type LoadState =
  | { status: "loading" }
  | { status: "found"; profile: PublicProfile }
  | { status: "free" }
  | { status: "error" };

export function PublicProfilePage({ handle }: { handle: string }) {
  const { t } = useTranslation();
  const [state, setState] = useState<LoadState>({ status: "loading" });
  const [attempt, setAttempt] = useState(0);

  // A handle that could never have been claimed (too short, reserved, a slur)
  // is answered without a round trip. The API would 404 it anyway; skipping the
  // call means a crawler walking `/@a`, `/@b`, `/@c` costs us nothing.
  const claimable = validateHandle(handle) === null;

  useEffect(() => {
    if (!claimable) {
      setState({ status: "free" });
      return;
    }
    const controller = new AbortController();
    setState({ status: "loading" });
    fetchPublicProfile(handle, { signal: controller.signal })
      .then((profile) => {
        setState(profile ? { status: "found", profile } : { status: "free" });
      })
      .catch(() => {
        if (!controller.signal.aborted) {
          // NOT "free". An unreachable API must never be rendered as "this
          // handle is available" — somebody would try to claim a name that is
          // already somebody else's page.
          setState({ status: "error" });
        }
      });
    return () => controller.abort();
  }, [handle, claimable, attempt]);

  if (state.status === "loading") {
    return <ProfileShell narrow>{null}</ProfileShell>;
  }

  if (state.status === "error") {
    return (
      <ProfileShell narrow>
        <div className="rounded-3xl border border-ink-4 bg-ink-2/80 px-6 py-10 text-center backdrop-blur-sm">
          <h1 className="font-display text-2xl font-bold">
            {t("publicProfile.unavailable.title")}
          </h1>
          <p className="mt-3 text-paper-muted">
            {t("publicProfile.unavailable.body")}
          </p>
          <Button
            className="cta-lift mt-6"
            onClick={() => setAttempt((n) => n + 1)}
          >
            {t("publicProfile.retry")}
          </Button>
        </div>
      </ProfileShell>
    );
  }

  if (state.status === "free") {
    return <FreeHandle handle={handle} claimable={claimable} />;
  }

  return <ClaimedProfile profile={state.profile} />;
}

/**
 * The page frame: dark, with a soft accent glow behind the content.
 *
 * `narrow` is the old card width and is kept for the three states that really
 * are one card — loading, error, and an unclaimed handle. A claimed profile is
 * a page, not a card, so it opts out and lays itself out against the shell's
 * full width. The shared frame is what stops the layout jumping between states
 * that resolve in sequence.
 */
function ProfileShell({
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

function ClaimedProfile({ profile }: { profile: PublicProfile }) {
  const { t, locale } = useTranslation();
  const bypass = isDevAuthBypassEnabled();
  const url = publicProfileDisplayUrl(profile.handle);
  const [copied, setCopied] = useState(false);

  const copy = useCallback(() => {
    // `navigator.clipboard` is absent over plain http and refused in some
    // embedded webviews. A silent failure is fine — the URL is in the address
    // bar, which is where somebody who cannot copy will go next.
    void navigator.clipboard
      ?.writeText(`https://${url}`)
      .then(() => setCopied(true))
      .catch(() => {});
  }, [url]);

  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), 2000);
    return () => window.clearTimeout(timer);
  }, [copied]);

  /**
   * The whole growth loop, in one click.
   *
   * Signed in: straight to `/app?add=<handle>`, where the app resolves the
   * handle and sends the request. Signed out: the handle is stashed BEFORE Clerk
   * takes over, because the modal is a navigation this component does not
   * survive — the same lesson `signedOutRedirectPath` learned about invites, in
   * the one shape a path cannot carry. See `lib/handle-intent.ts`.
   */
  const rememberIntent = () => stashAddIntent(intentStorage(), profile.handle);
  const appHref = `/app?add=${encodeURIComponent(profile.handle)}`;

  /**
   * The hue is seeded from the HANDLE, not the display name.
   *
   * A display name changes; a handle costs a thirty-day cooldown to move. The
   * generated banner is the closest thing this person has to a brand colour, so
   * it has to survive them renaming themselves — otherwise the page somebody
   * screenshotted last month is a different colour today.
   */
  const hue = useMemo(() => heroHue(profile.handle), [profile.handle]);
  const bannerUrl = resolveUploadedImageUrl(profile.bannerUrl);

  const since = monthStampToDate(profile.memberSince);
  const sinceLabel = since
    ? since.toLocaleDateString(locale === "pt-BR" ? "pt-BR" : "en", {
        month: "long",
        year: "numeric",
        timeZone: "UTC",
      })
    : null;

  return (
    <ProfileShell>
      <article className="animate-rise overflow-hidden rounded-3xl border border-ink-4 bg-ink-2/80 shadow-[var(--shadow-profile-card)] backdrop-blur-sm">
        {/* ------------------------------------------------------ the hero */}
        <div
          className="relative h-36 w-full sm:h-52"
          style={bannerUrl ? undefined : heroTintStyle(hue, 45)}
        >
          {bannerUrl && (
            <img
              src={bannerUrl}
              alt=""
              className="h-full w-full object-cover"
              // Eager and high priority: this is the largest element above the
              // fold and the one thing a screenshot is of. Lazy-loading the
              // hero is how a shared link renders as a grey box for a beat.
              fetchPriority="high"
              decoding="async"
            />
          )}
          {/* Bottom-anchored scrim in the surface colour, so an uploaded
              photograph dissolves into the page rather than ending in a bar.
              Drawn over the generated gradient too — the name below sits
              partly on it, and one treatment for both is one thing to get
              right. */}
          <span
            aria-hidden
            className="absolute inset-0 bg-[image:var(--scrim-hero)]"
          />
        </div>

        {/* ------------------------------------------------ identity block */}
        <div className="px-5 pb-8 sm:px-8">
          <div className="flex flex-col items-center text-center sm:flex-row sm:items-end sm:gap-5 sm:text-left">
            {/* `relative` is load-bearing, not decoration: the hero above is
                positioned, and a positioned box paints over a static sibling
                whatever the source order says — without this the avatar is
                sliced in half by the banner it is supposed to overlap. The
                directory card learned the same lesson; see the note there. */}
            <UserAvatar
              name={profile.displayName}
              avatarUrl={profile.avatarUrl}
              rounded="full"
              className="relative -mt-14 h-28 w-28 shrink-0 shadow-[var(--shadow-hero-avatar)] ring-4 ring-ink-2 sm:-mt-16 sm:h-32 sm:w-32"
              fallbackClassName="bg-signal text-4xl text-ink"
            />
            <div className="mt-3 min-w-0 flex-1 sm:mt-0 sm:pb-1">
              <h1 className="font-display text-3xl font-extrabold leading-tight tracking-tight sm:text-4xl">
                {profile.displayName}
              </h1>
              <p className="mt-1 font-mono text-sm text-signal">
                @{profile.handle}
              </p>
              {sinceLabel && (
                // Quiet on purpose. It is a badge of tenure, not a field —
                // small, muted, and never the third thing you read.
                <p className="mt-1.5 text-xs text-paper-muted">
                  {t("publicProfile.memberSince", { date: sinceLabel })}
                </p>
              )}
            </div>
          </div>

          <div className="mt-6 flex flex-col gap-2 sm:flex-row sm:items-center">
            {bypass ? (
              <Button
                asChild
                className="cta-lift h-11 flex-1 rounded-full text-base"
              >
                <Link to={appHref}>{t("publicProfile.cta.open")}</Link>
              </Button>
            ) : (
              <>
                <SignedOut>
                  <SignUpButton mode="modal" forceRedirectUrl={appHref}>
                    <Button
                      className="cta-lift h-11 flex-1 rounded-full text-base"
                      onClick={rememberIntent}
                    >
                      {t("publicProfile.cta.add")}
                      <ArrowUpRight aria-hidden className="h-4 w-4" />
                    </Button>
                  </SignUpButton>
                </SignedOut>
                <SignedIn>
                  <Button
                    asChild
                    className="cta-lift h-11 flex-1 rounded-full text-base"
                  >
                    <Link to={appHref}>{t("publicProfile.cta.add")}</Link>
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
              {copied ? t("publicProfile.copied") : url}
            </button>
          </div>

          <CommunityBadges badges={profile.badges} />

          <Depoimentos
            depoimentos={profile.depoimentos}
            total={profile.depoimentoCount}
          />
        </div>

        {/* The loop's second half: every visitor is somebody who could have one
            of these. It is a footer strip rather than a second button so it
            never competes with "me adiciona". */}
        <Link
          to="/garanta"
          className="flex items-center justify-center gap-1.5 border-t border-ink-4/70 bg-ink/60 px-6 py-3 text-xs font-medium uppercase tracking-[0.16em] text-paper-muted transition-colors hover:text-signal"
        >
          {t("publicProfile.footer.cta")}
          <ArrowUpRight aria-hidden className="h-3.5 w-3.5" />
        </Link>
      </article>

      <Seo
        title={t("publicProfile.seo.title", {
          name: profile.displayName,
          handle: profile.handle,
        })}
        description={t("publicProfile.seo.description", {
          name: profile.displayName,
        })}
        path={publicProfilePath(profile.handle)}
      />
    </ProfileShell>
  );
}

/**
 * One glyph per category, so a grid of badges is a grid of different things.
 *
 * A SECOND COPY of `CATEGORY_EMOJI` in `communities-model.ts`, and the copy is
 * deliberate: that module is part of the app's Communities surface, which is
 * behind a feature flag and pulls in the directory's model, and this page must
 * render for somebody with no account on a deployment where that flag is off.
 * Ten emoji is a cheap duplication; the failure mode of it drifting is one
 * badge showing the fallback globe.
 *
 * `badge.category` is typed as a bare string on the public schema rather than
 * as the category enum, so the lookup is total by construction and falls
 * through to the globe for anything unknown.
 */
const BADGE_GLYPHS: Record<string, string> = {
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

/**
 * The Orkut soul: the rooms this person is in, as a proud grid.
 *
 * A GRID AND NOT A CHIP ROW, which is the change that matters. Chips read as
 * metadata — tags on a record — and Orkut's communities were the opposite of
 * metadata: they were the thing people put on their profile INSTEAD of a bio.
 * A two-column grid of tiles, each with a glyph and a full name, gives each one
 * enough room to be read as a room somebody chose rather than as a label
 * somebody was assigned.
 *
 * The heading is a sentence — "membro de 5 comunidades" — and not the word
 * "Comunidades", for the same reason. Every one of these is already public: a
 * listed community appears in a directory that counts this person, and the
 * member's own per-membership opt-out (`show_on_profile`) has already been
 * applied server-side.
 */
function CommunityBadges({ badges }: { badges: ProfileBadge[] }) {
  const { t } = useTranslation();
  if (badges.length === 0) {
    return null;
  }
  return (
    <section className="mt-8" data-profile-communities>
      <h2 className="text-[11px] font-semibold uppercase tracking-[0.2em] text-paper-muted">
        {t("publicProfile.communities.count", { count: badges.length })}
      </h2>
      <ul className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-2">
        {badges.map((badge, index) => (
          <li
            key={badge.id}
            className="animate-rise flex items-center gap-3 rounded-xl border border-ink-4/80 bg-ink/50 px-3 py-2.5 transition-colors hover:border-signal/40"
            style={{ "--stagger": index + 1 } as React.CSSProperties}
          >
            <span
              aria-hidden
              className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-lg"
              style={heroTintStyle(heroHue(badge.id), 40)}
            >
              {BADGE_GLYPHS[badge.category] ?? "🌎"}
            </span>
            <span className="min-w-0 truncate text-sm font-medium text-paper">
              {badge.name}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}

/**
 * The depoimento wall.
 *
 * WHAT MAKES IT SAFE TO RENDER THESE TO STRANGERS is the approval, and the
 * argument is in `publicDepoimentoSchema` in full. Briefly: a friend wrote it
 * for a profile, and the subject published it from a preview that said exactly
 * where it would go. Two people consented to this page.
 *
 * PLAIN TEXT, NO MARKDOWN, NO LINKS. `depoimentoBodySchema` refuses control
 * characters and nothing here upgrades a string into anything richer — a
 * rendered link on an unauthenticated page carrying somebody else's words is
 * the shape §07's three Orkut worms had.
 *
 * `whitespace-pre-line` rather than a markdown renderer: people write these
 * with line breaks and losing them turns a two-line joke into a run-on
 * sentence, which is the entire typographic ambition this needs.
 *
 * The masonry-ish two-column layout is `columns` and not a grid on purpose —
 * these are wildly uneven lengths, and a grid would give a seven-word
 * depoimento the same box as a five-line one.
 */
function Depoimentos({
  depoimentos,
  total,
}: {
  depoimentos: PublicDepoimento[];
  total: number;
}) {
  const { t } = useTranslation();
  if (depoimentos.length === 0) {
    return null;
  }
  // Never a zero and never a bare count — see the note on `depoimentoListSchema`
  // about popularity-counting. This only ever renders when there is a remainder
  // the page is not showing, which is a fact about the page and not a score.
  const remainder = Math.max(0, total - depoimentos.length);

  return (
    <section
      className="relative mt-8 rounded-2xl bg-[radial-gradient(ellipse_at_50%_0%,var(--glow-accent-soft),transparent_70%)] p-0.5"
      data-profile-depoimentos
    >
      <h2 className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-[0.2em] text-paper-muted">
        <Quote aria-hidden className="h-3.5 w-3.5" />
        {t("publicProfile.depoimentos.title")}
      </h2>

      <div className="mt-3 gap-3 sm:columns-2">
        {depoimentos.map((depoimento, index) => (
          <figure
            key={depoimento.id}
            className="animate-rise mb-3 break-inside-avoid rounded-2xl border border-ink-4/80 bg-ink/60 p-4 shadow-[var(--shadow-testimonial)]"
            style={{ "--stagger": index + 1 } as React.CSSProperties}
          >
            <blockquote className="whitespace-pre-line text-sm leading-relaxed text-paper">
              {depoimento.body}
            </blockquote>
            <figcaption className="mt-3 flex items-center gap-2 border-t border-ink-4/60 pt-3">
              <UserAvatar
                name={depoimento.author.displayName}
                avatarUrl={depoimento.author.avatarUrl}
                rounded="full"
                className="h-7 w-7 shrink-0"
                fallbackClassName="bg-ink-3 text-[11px] text-paper"
              />
              <span className="min-w-0">
                <span className="block truncate text-xs font-semibold text-paper">
                  {depoimento.author.displayName}
                </span>
                {/* Only when they claimed one. An author without a handle has
                    no public page, and inventing a link to one — or falling
                    back to their `name#1234` tag — would publish contact
                    details a third party never opted into. */}
                {depoimento.author.handle && (
                  <Link
                    to={publicProfilePath(depoimento.author.handle)}
                    className="block truncate font-mono text-[11px] text-paper-muted transition-colors hover:text-signal"
                  >
                    @{depoimento.author.handle}
                  </Link>
                )}
              </span>
            </figcaption>
          </figure>
        ))}
      </div>

      {remainder > 0 && (
        <p className="mt-1 text-xs text-paper-muted">
          {t("publicProfile.depoimentos.more", { count: remainder })}
        </p>
      )}
    </section>
  );
}

/**
 * Nobody holds this handle.
 *
 * A 404 in HTTP terms and an opportunity in product terms — which is why it is
 * not a dead end. Somebody arriving here has already typed or clicked a name
 * they were interested in, and the only useful thing to say is "it is available,
 * do you want it". `noIndex` because an unclaimed handle is not a page worth
 * having in an index; it is a page worth having when somebody asks for it.
 *
 * `claimable` false means the handle could never be claimed (reserved, a slur,
 * too short). The page still says "there is nobody here" — but it does not offer
 * it, because offering a name we would then refuse is a worse experience than
 * the 404 it replaced.
 */
function FreeHandle({
  handle,
  claimable,
}: {
  handle: string;
  claimable: boolean;
}) {
  const { t } = useTranslation();
  return (
    <ProfileShell narrow>
      <div className="animate-rise rounded-3xl border border-ink-4 bg-ink-2/80 px-6 py-10 text-center backdrop-blur-sm sm:px-8">
        <p className="font-mono text-4xl font-bold text-signal">@{handle}</p>
        <h1 className="mt-5 font-display text-2xl font-bold tracking-tight">
          {t("publicProfile.free.title", { handle })}
        </h1>
        {claimable && (
          <>
            <p className="mt-3 text-paper-muted">
              {t("publicProfile.free.body")}
            </p>
            <Button
              asChild
              className="cta-lift mt-7 h-11 rounded-full px-6 text-base"
            >
              <Link to={`/garanta?handle=${encodeURIComponent(handle)}`}>
                {t("publicProfile.free.cta", { handle })}
              </Link>
            </Button>
          </>
        )}
      </div>
      <Seo
        title={t("claim.seo.title")}
        description={t("claim.seo.description")}
        path={publicProfilePath(handle)}
        noIndex
      />
    </ProfileShell>
  );
}
