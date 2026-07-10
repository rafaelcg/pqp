import {
  SignInButton,
  SignUpButton,
  SignedIn,
  SignedOut,
} from "@clerk/clerk-react";
import { Link } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { isDevAuthBypassEnabled } from "@/lib/dev-auth";
import { cn } from "@/lib/utils";

interface MarketingNavProps {
  variant?: "hero" | "solid";
}

export function MarketingNav({ variant = "solid" }: MarketingNavProps) {
  const isHero = variant === "hero";
  const bypass = isDevAuthBypassEnabled();

  return (
    <header
      className={cn(
        "relative z-20 flex items-center justify-between px-5 py-4 sm:px-8",
        !isHero && "border-b border-ink-4/50 bg-ink/80 backdrop-blur-md",
      )}
    >
      <Link
        to="/"
        className={cn(
          "font-brand text-xl tracking-tight",
          isHero ? "text-white" : "text-paper",
        )}
      >
        pqp
      </Link>

      <nav className="hidden items-center gap-8 md:flex">
        <a
          href="/#how"
          className={cn(
            "text-xs font-medium uppercase tracking-[0.18em] transition-opacity hover:opacity-100",
            isHero ? "text-white/70 opacity-90" : "text-paper-muted hover:text-paper",
          )}
        >
          How it works
        </a>
        <a
          href="/#hosting"
          className={cn(
            "text-xs font-medium uppercase tracking-[0.18em] transition-opacity hover:opacity-100",
            isHero ? "text-white/70 opacity-90" : "text-paper-muted hover:text-paper",
          )}
        >
          Self-host
        </a>
      </nav>

      <div className="flex items-center gap-2">
        {bypass ? (
          <Button
            asChild
            className={cn(
              "cta-lift",
              isHero && "bg-white text-ink hover:bg-white/90 shadow-lg shadow-black/20",
            )}
          >
            <Link to="/app">Open the app</Link>
          </Button>
        ) : (
          <>
            <SignedOut>
              <SignInButton mode="modal" forceRedirectUrl="/app">
                <button
                  type="button"
                  className={cn(
                    "hidden px-3 py-1.5 text-sm font-medium sm:inline",
                    isHero
                      ? "text-white/85 hover:text-white"
                      : "text-paper-muted hover:text-paper",
                  )}
                >
                  Sign in
                </button>
              </SignInButton>
              <SignUpButton mode="modal" forceRedirectUrl="/app">
                <Button
                  className={cn(
                    "cta-lift",
                    isHero &&
                      "bg-white text-ink hover:bg-white/90 shadow-lg shadow-black/20",
                  )}
                >
                  Spin up a server
                </Button>
              </SignUpButton>
            </SignedOut>
            <SignedIn>
              <Button
                asChild
                className={cn(
                  "cta-lift",
                  isHero && "bg-white text-ink hover:bg-white/90",
                )}
              >
                <Link to="/app">Open the app</Link>
              </Button>
            </SignedIn>
          </>
        )}
      </div>
    </header>
  );
}
