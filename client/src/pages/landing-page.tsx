import {
  SignInButton,
  SignUpButton,
  SignedIn,
  SignedOut,
} from "@clerk/clerk-react";
import { ArrowUpRight } from "lucide-react";
import type { CSSProperties } from "react";
import { Link } from "react-router-dom";
import { MarketingFooter } from "@/components/marketing/marketing-footer";
import { MarketingNav } from "@/components/marketing/marketing-nav";
import { Seo } from "@/components/marketing/seo";
import { Button } from "@/components/ui/button";
import { isDevAuthBypassEnabled } from "@/lib/dev-auth";

function stagger(i: number): CSSProperties {
  return { "--stagger": i } as CSSProperties;
}

const TRUST_ITEMS = [
  "Open source",
  "Self-hostable",
  "Mesh voice",
  "Invite codes",
  "Your keys",
];

export function LandingPage() {
  const bypass = isDevAuthBypassEnabled();

  return (
    <div className="min-h-full bg-ink text-paper">
      <Seo
        title="pqp — group chat you own"
        description="Chaotic group chat with servers, channels, and voice that just works. Open source — self-host or use pqp.gg."
        path="/"
      />

      <section className="relative flex min-h-[100svh] flex-col overflow-hidden">
        <img
          src="/images/hero-background.jpg"
          alt=""
          className="hero-parallax absolute inset-0 h-full w-full object-cover object-center"
          fetchPriority="high"
          decoding="async"
        />
        <div
          className="absolute inset-0 bg-gradient-to-b from-black/50 via-black/28 to-black/75"
          aria-hidden
        />
        <div
          className="pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_at_center,transparent_0%,rgba(0,0,0,0.42)_100%)]"
          aria-hidden
        />
        <div className="hero-grain pointer-events-none absolute inset-0" aria-hidden />

        <MarketingNav variant="hero" />

        <div className="relative z-10 flex flex-1 flex-col items-center justify-center px-5 pb-28 pt-8 text-center sm:px-8">
          <p
            className="animate-rise font-brand text-6xl font-normal tracking-tight text-white drop-shadow-sm sm:text-7xl md:text-8xl"
            style={stagger(0)}
          >
            pqp
          </p>
          <h1
            className="animate-rise mt-6 max-w-2xl font-display text-3xl font-bold leading-[1.05] tracking-tight text-white sm:text-4xl md:text-5xl"
            style={stagger(1)}
          >
            Your friends. Your server. Your mess.
          </h1>
          <p
            className="animate-rise mt-4 max-w-lg text-base text-white/85 sm:text-lg"
            style={stagger(2)}
          >
            Chaotic group chat you actually own — text that flies, voice that
            doesn&apos;t flake. Self-host if you want the keys, or just use
            ours.
          </p>

          <div
            className="animate-rise mt-8 flex items-center gap-3"
            style={stagger(3)}
          >
            {bypass ? (
              <>
                <Button
                  asChild
                  className="cta-lift h-11 rounded-full bg-white px-6 text-base font-semibold text-ink shadow-lg shadow-black/25 hover:bg-white/90"
                >
                  <Link to="/app">Open the app</Link>
                </Button>
                <Link
                  to="/app"
                  className="cta-lift flex h-11 w-11 items-center justify-center rounded-full bg-white/15 text-white ring-1 ring-white/40 backdrop-blur-sm hover:bg-white/25"
                  aria-label="Open the app"
                >
                  <ArrowUpRight className="h-5 w-5" />
                </Link>
              </>
            ) : (
              <>
                <SignedOut>
                  <SignUpButton mode="modal" forceRedirectUrl="/app">
                    <Button className="cta-lift h-11 rounded-full bg-white px-6 text-base font-semibold text-ink shadow-lg shadow-black/25 hover:bg-white/90">
                      Spin up a server
                    </Button>
                  </SignUpButton>
                  <SignInButton mode="modal" forceRedirectUrl="/app">
                    <button
                      type="button"
                      className="cta-lift flex h-11 w-11 items-center justify-center rounded-full bg-white/15 text-white ring-1 ring-white/40 backdrop-blur-sm hover:bg-white/25"
                      aria-label="Sign in"
                    >
                      <ArrowUpRight className="h-5 w-5" />
                    </button>
                  </SignInButton>
                </SignedOut>
                <SignedIn>
                  <Button
                    asChild
                    className="cta-lift h-11 rounded-full bg-white px-6 text-base font-semibold text-ink shadow-lg shadow-black/25 hover:bg-white/90"
                  >
                    <Link to="/app">Open the app</Link>
                  </Button>
                  <Link
                    to="/app"
                    className="cta-lift flex h-11 w-11 items-center justify-center rounded-full bg-white/15 text-white ring-1 ring-white/40 backdrop-blur-sm hover:bg-white/25"
                    aria-label="Open the app"
                  >
                    <ArrowUpRight className="h-5 w-5" />
                  </Link>
                </SignedIn>
              </>
            )}
          </div>
        </div>

        <div className="absolute inset-x-0 bottom-0 z-10 border-t border-white/10 bg-black/25 px-5 py-4 backdrop-blur-sm sm:px-8">
          <ul className="mx-auto flex max-w-4xl flex-wrap items-center justify-center gap-x-8 gap-y-2">
            {TRUST_ITEMS.map((item, i) => (
              <li
                key={item}
                className="animate-rise text-[11px] font-medium uppercase tracking-[0.22em] text-white/70"
                style={stagger(4 + i)}
              >
                {item}
              </li>
            ))}
          </ul>
        </div>
      </section>

      <section className="border-b border-ink-4/40 px-5 py-20 sm:px-8 sm:py-24">
        <div className="mx-auto max-w-2xl text-center">
          <h2 className="font-display text-3xl font-bold tracking-tight sm:text-4xl">
            Tired of renting the room?
          </h2>
          <p className="mt-4 text-lg text-paper-muted">
            Big chat apps rewrite the house rules, bury your servers, and treat
            your crew like inventory. pqp is the opposite: make a server, invite
            people, talk. Keep the keys if you want — or use ours and skip the
            ops.
          </p>
        </div>
      </section>

      <section
        id="how"
        className="scroll-mt-8 border-b border-ink-4/40 px-5 py-20 sm:px-8 sm:py-24"
      >
        <div className="mx-auto max-w-4xl">
          <div className="mx-auto max-w-xl text-center">
            <h2 className="font-display text-3xl font-bold tracking-tight sm:text-4xl">
              Three moves. Then you&apos;re loud.
            </h2>
            <p className="mt-3 text-paper-muted">
              No onboarding maze. Create, invite, cause problems.
            </p>
          </div>
          <ol className="mt-14 grid gap-10 sm:grid-cols-3 sm:gap-8">
            {[
              {
                step: "01",
                title: "Make a server",
                body: "Name it something stupid. Text and voice channels show up ready.",
              },
              {
                step: "02",
                title: "Drop an invite",
                body: "Share a code. Friends pile in — no app-store gatekeeping.",
              },
              {
                step: "03",
                title: "Talk",
                body: "Spam the channels. Jump into mesh voice when the group chat isn't enough.",
              },
            ].map((item) => (
              <li key={item.step} className="text-left sm:text-center">
                <p className="font-display text-sm font-bold text-signal">
                  {item.step}
                </p>
                <h3 className="mt-2 font-display text-xl font-bold">
                  {item.title}
                </h3>
                <p className="mt-2 text-sm text-paper-muted">{item.body}</p>
              </li>
            ))}
          </ol>
        </div>
      </section>

      <section
        id="hosting"
        className="scroll-mt-8 border-b border-ink-4/40 px-5 py-20 sm:px-8 sm:py-24"
      >
        <div className="mx-auto max-w-4xl">
          <div className="mx-auto max-w-xl text-center">
            <h2 className="font-display text-3xl font-bold tracking-tight sm:text-4xl">
              Run it yourself — or don&apos;t
            </h2>
            <p className="mt-3 text-paper-muted">
              Same product. You pick who babysits the metal.
            </p>
          </div>
          <div className="mt-14 grid gap-8 sm:grid-cols-2">
            <div>
              <h3 className="font-display text-xl font-bold">Self-host</h3>
              <p className="mt-3 text-paper-muted">
                Clone the repo, point it at Postgres, plug in your own Clerk
                keys. Your data stays on your box. Unlimited for OSS use — you
                own the stack.
              </p>
            </div>
            <div>
              <h3 className="font-display text-xl font-bold">Hosted at pqp.gg</h3>
              <p className="mt-3 text-paper-muted">
                Sign up and go. We run the servers, auth, and storage. Same
                chaos, zero ops.
              </p>
            </div>
          </div>
        </div>
      </section>

      <section className="px-5 py-20 text-center sm:px-8 sm:py-24">
        <h2 className="font-display text-3xl font-bold tracking-tight sm:text-4xl">
          The room&apos;s empty. Fix that.
        </h2>
        <p className="mx-auto mt-3 max-w-md text-paper-muted">
          Spin up a server in under a minute. Invite the chaos later.
        </p>
        <div className="mt-8 flex flex-wrap items-center justify-center gap-3">
          {bypass ? (
            <Button asChild className="cta-lift h-11 px-6 text-base">
              <Link to="/app">Open the app</Link>
            </Button>
          ) : (
            <>
              <SignedOut>
                <SignUpButton mode="modal" forceRedirectUrl="/app">
                  <Button className="cta-lift h-11 px-6 text-base">
                    Spin up a server
                  </Button>
                </SignUpButton>
                <SignInButton mode="modal" forceRedirectUrl="/app">
                  <Button variant="secondary" className="cta-lift h-11 px-6 text-base">
                    Sign in
                  </Button>
                </SignInButton>
              </SignedOut>
              <SignedIn>
                <Button asChild className="cta-lift h-11 px-6 text-base">
                  <Link to="/app">Open the app</Link>
                </Button>
              </SignedIn>
            </>
          )}
        </div>
      </section>

      <MarketingFooter />
    </div>
  );
}
