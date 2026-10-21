import { useAuth, useClerk } from "@clerk/clerk-react";
import { ArrowRight } from "lucide-react";
import { Link, useNavigate } from "react-router-dom";
import { Button } from "@/components/ui/button";
import {
  appsCtaHref,
  rememberAppsRef,
  type AppsLandingPath,
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
  path: AppsLandingPath;
  label: string;
  className?: string;
  /** The button's look; the arrow is drawn only on the default one. */
  variant?: "default" | "secondary" | "ghost";
  /** `h-12` by default; `compact` is the slim bar's size. */
  compact?: boolean;
  /** Called on every press, before anything else (a closed event, never a property). */
  onActivate?: () => void;
}

/**
 * "Abrir o pqp" / "Criar conta grátis". A signed-in visitor goes straight to
 * the app. A signed-out one opens the sign-up modal with the page's tag
 * already in the acquisition stash (before Clerk takes over, because the modal
 * can end in a navigation this page does not survive) and on the redirect URL
 * as the belt, so the account that comes out of it says which page made it.
 * Clerk not ready, or throwing, falls back to `/app?ref=`, which hosts the
 * same forms. The dev bypass has no ClerkProvider and no sign-up: the account
 * exists, go in.
 */
export function AppsCta(props: AppsCtaProps) {
  return isDevAuthBypassEnabled() ? (
    <BypassAppsCta {...props} />
  ) : (
    <ClerkAppsCta {...props} />
  );
}

function classes({ className, compact }: AppsCtaProps): string {
  return cn(compact ? "h-9 px-4 text-sm" : CTA_CLASS, className);
}

function Arrow({ variant, compact }: AppsCtaProps) {
  return variant && variant !== "default" ? null : compact ? null : <ArrowRight className="h-4 w-4" aria-hidden />;
}

function BypassAppsCta(props: AppsCtaProps) {
  const { tag, label, variant, path, onActivate } = props;
  return (
    <Button asChild variant={variant} className={classes(props)}>
      <Link
        to={appsCtaHref(tag)}
        data-apps-cta={tag}
        onClick={() => {
          onActivate?.();
          rememberAppsRef(tag, path);
        }}
      >
        {label}
        <Arrow {...props} />
      </Link>
    </Button>
  );
}

function ClerkAppsCta(props: AppsCtaProps) {
  const { tag, path, label, variant, onActivate } = props;
  const { isLoaded, isSignedIn } = useAuth();
  const clerk = useClerk();
  const navigate = useNavigate();
  const href = appsCtaHref(tag);

  if (isSignedIn) {
    return (
      <Button asChild variant={variant} className={classes(props)}>
        <Link to="/app" data-apps-cta={tag} onClick={() => onActivate?.()}>
          {label}
          <Arrow {...props} />
        </Link>
      </Button>
    );
  }

  return (
    <Button
      type="button"
      variant={variant}
      className={classes(props)}
      data-apps-cta={tag}
      onClick={() => {
        onActivate?.();
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
      <Arrow {...props} />
    </Button>
  );
}
