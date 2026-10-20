import { useAuth, useClerk } from "@clerk/clerk-react";
import { ArrowRight } from "lucide-react";
import { Link, useNavigate } from "react-router-dom";
import { Button } from "@/components/ui/button";
import {
  appsCtaHref,
  rememberAppsRef,
  type AppsLandingRef,
} from "@/lib/apps-landing";
import { isDevAuthBypassEnabled } from "@/lib/dev-auth";
import { noteSignupCta } from "@/lib/signup-assist";
import { cn } from "@/lib/utils";

const CTA_CLASS = "cta-lift h-12 px-7 text-base";

interface AppsCtaProps {
  /** The page's own tag: `users.acquisition_ref` ends up saying which page. */
  tag: AppsLandingRef;
  /** The page the button sits on, for the acquisition's landing. */
  path: "/apps" | "/apps/locadora";
  label: string;
  className?: string;
}

/**
 * "Abrir o pqp". A signed-in visitor goes straight to the app. A signed-out
 * one opens the sign-up modal with the page's tag already in the acquisition
 * stash (before Clerk takes over, because the modal can end in a navigation
 * this page does not survive) and on the redirect URL as the belt, so the
 * account that comes out of it says which page made it. Clerk not ready, or
 * throwing, falls back to `/app?ref=`, which hosts the same forms. The dev
 * bypass has no ClerkProvider and no sign-up: the account exists, go in.
 */
export function AppsCta(props: AppsCtaProps) {
  return isDevAuthBypassEnabled() ? (
    <BypassAppsCta {...props} />
  ) : (
    <ClerkAppsCta {...props} />
  );
}

function BypassAppsCta({ tag, label, className }: AppsCtaProps) {
  return (
    <Button asChild className={cn(CTA_CLASS, className)}>
      <Link to={appsCtaHref(tag)} data-apps-cta={tag}>
        {label}
        <ArrowRight className="h-4 w-4" aria-hidden />
      </Link>
    </Button>
  );
}

function ClerkAppsCta({ tag, path, label, className }: AppsCtaProps) {
  const { isLoaded, isSignedIn } = useAuth();
  const clerk = useClerk();
  const navigate = useNavigate();
  const href = appsCtaHref(tag);

  if (isSignedIn) {
    return (
      <Button asChild className={cn(CTA_CLASS, className)}>
        <Link to="/app" data-apps-cta={tag}>
          {label}
          <ArrowRight className="h-4 w-4" aria-hidden />
        </Link>
      </Button>
    );
  }

  return (
    <Button
      type="button"
      className={cn(CTA_CLASS, className)}
      data-apps-cta={tag}
      onClick={() => {
        rememberAppsRef(tag, path);
        const go = () => void navigate(href);
        if (!isLoaded) {
          go();
          return;
        }
        try {
          noteSignupCta(tag, "");
          void Promise.resolve(clerk.openSignUp({ forceRedirectUrl: href })).catch(go);
        } catch {
          go();
        }
      }}
    >
      {label}
      <ArrowRight className="h-4 w-4" aria-hidden />
    </Button>
  );
}
