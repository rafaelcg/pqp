import { SignUpButton, SignedIn, SignedOut } from "@clerk/clerk-react";
import { ArrowUpRight, Check, Copy, Users } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import {
  publicProfileDisplayUrl,
  publicProfilePath,
  validateHandle,
  type PublicProfile,
} from "@pqp/shared";
import { MarketingFooter } from "@/components/marketing/marketing-footer";
import { MarketingNav } from "@/components/marketing/marketing-nav";
import { Seo } from "@/components/marketing/seo";
import { Button } from "@/components/ui/button";
import { UserAvatar } from "@/components/user/user-avatar";
import { fetchPublicProfile } from "@/lib/api";
import { isDevAuthBypassEnabled } from "@/lib/dev-auth";
import { intentStorage, stashAddIntent } from "@/lib/handle-intent";
import { useTranslation } from "@/lib/i18n";
import { cn } from "@/lib/utils";

/**
 * `pqp.gg/@rafa` — the page this whole feature exists to produce.
 *
 * DESIGNED TO BE SCREENSHOTTED. That is not a flourish, it is the distribution
 * mechanism: nobody shares a link to a page that looks like a settings form, and
 * the only reason a person claims a handle is to have somewhere worth pointing
 * at. So it is one card, centred, with the picture large and the name larger,
 * and exactly one thing to do.
 *
 * DELIBERATELY THIN, and the thinness is a legal posture as much as a design
 * one. What is on this page is what `publicProfileSchema` carries and nothing
 * else — no tag, no id, no presence, no message content, no private servers. See
 * the schema's comment for the argument; the short version is that this is the
 * only surface in the product served to somebody with no account, and every
 * field on it had to justify being visible to the whole internet.
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
    return <ProfileShell>{null}</ProfileShell>;
  }

  if (state.status === "error") {
    return (
      <ProfileShell>
        <div className="text-center">
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
 * The page frame: dark, centred, with a soft accent glow behind the card.
 *
 * Shared by all four states so the layout does not jump between "loading",
 * "here they are" and "nobody has this" — a page that reflows as it resolves is
 * a page that looks broken in the half second somebody spends deciding whether
 * to stay.
 */
function ProfileShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-full flex-col bg-ink text-paper">
      <MarketingNav />
      <main className="relative flex flex-1 items-center justify-center overflow-hidden px-5 py-16 sm:px-8">
        <div
          className="pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_at_50%_0%,var(--glow-accent),transparent_60%)]"
          aria-hidden
        />
        <div className="relative z-10 w-full max-w-md">{children}</div>
      </main>
      <MarketingFooter />
    </div>
  );
}

function ClaimedProfile({ profile }: { profile: PublicProfile }) {
  const { t } = useTranslation();
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

  return (
    <ProfileShell>
      <article className="animate-rise overflow-hidden rounded-3xl border border-ink-4 bg-ink-2/80 shadow-[0_24px_80px_-24px_rgba(0,0,0,0.8)] backdrop-blur-sm">
        <div className="flex flex-col items-center px-6 pb-7 pt-9 text-center sm:px-8">
          <UserAvatar
            name={profile.displayName}
            avatarUrl={profile.avatarUrl}
            rounded="full"
            className="h-28 w-28 ring-4 ring-ink-4/60"
            fallbackClassName="bg-signal text-4xl text-ink"
          />

          <h1 className="mt-5 font-display text-3xl font-extrabold leading-tight tracking-tight">
            {profile.displayName}
          </h1>
          <p className="mt-1 font-mono text-sm text-signal">
            @{profile.handle}
          </p>

          {profile.depoimentoCount > 0 && (
            <p className="mt-3 text-sm text-paper-muted">
              {profile.depoimentoCount === 1
                ? t("publicProfile.depoimentos.one")
                : t("publicProfile.depoimentos", {
                    count: profile.depoimentoCount,
                  })}
            </p>
          )}

          {profile.badges.length > 0 && (
            <section className="mt-6 w-full">
              <h2 className="flex items-center justify-center gap-1.5 text-[11px] font-medium uppercase tracking-[0.2em] text-paper-muted">
                <Users aria-hidden className="h-3.5 w-3.5" />
                {t("publicProfile.communities")}
              </h2>
              <ul className="mt-3 flex flex-wrap justify-center gap-2">
                {profile.badges.map((badge) => (
                  <li
                    key={badge.id}
                    className="rounded-full border border-ink-4 bg-ink px-3 py-1 text-xs text-paper-muted"
                  >
                    {badge.name}
                  </li>
                ))}
              </ul>
            </section>
          )}

          <div className="mt-8 w-full">
            {bypass ? (
              <Button asChild className="cta-lift h-11 w-full rounded-full text-base">
                <Link to={appHref}>{t("publicProfile.cta.open")}</Link>
              </Button>
            ) : (
              <>
                <SignedOut>
                  <SignUpButton mode="modal" forceRedirectUrl={appHref}>
                    <Button
                      className="cta-lift h-11 w-full rounded-full text-base"
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
                    className="cta-lift h-11 w-full rounded-full text-base"
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
                "mt-3 inline-flex w-full items-center justify-center gap-1.5 rounded-full px-3 py-2 font-mono text-xs transition-colors",
                copied
                  ? "text-success"
                  : "text-paper-muted hover:text-paper",
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
    <ProfileShell>
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
