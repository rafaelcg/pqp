import { SignInButton, SignUpButton, useAuth } from "@clerk/clerk-react";
import type { ComponentProps, ReactNode } from "react";
import { Link } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { isDevAuthBypassEnabled } from "@/lib/dev-auth";
import { useTranslation, type MessageKey } from "@/lib/i18n";
import { cn } from "@/lib/utils";

export type AuthCtaAppearance = "hero" | "nav-hero" | "nav-solid" | "default";

interface MarketingAuthCtasProps {
  appearance?: AuthCtaAppearance;
  /** Primary label. Defaults to Join. */
  primaryKey?: MessageKey;
  showSignIn?: boolean;
  /** Closing-band arrow. Drawn here so translators never carry it. */
  decoratePrimary?: boolean;
  className?: string;
}

/**
 * Join / Sign in / Open the app, shared by the landing chrome.
 *
 * WHY THE SIGNED-OUT PAIR IS THE DEFAULT. Clerk's `<SignedOut>` / `<SignedIn>`
 * render nothing until the session is known, which left the hero and nav
 * without a button. Most visitors are signed out, so that pair paints first.
 * Open the app replaces it only after `isSignedIn` is true.
 *
 * Dev bypass has no ClerkProvider, so both actions go to `/app`. The signed-out
 * chrome still shows, because that is the page a first-time visitor sees.
 */
export function MarketingAuthCtas(props: MarketingAuthCtasProps) {
  if (isDevAuthBypassEnabled()) {
    return <AuthPair {...props} signedIn={false} bypass />;
  }
  return <ClerkAuthCtas {...props} />;
}

function ClerkAuthCtas(props: MarketingAuthCtasProps) {
  const { isSignedIn } = useAuth();
  return <AuthPair {...props} signedIn={isSignedIn === true} />;
}

function AuthPair({
  appearance = "default",
  primaryKey = "nav.join",
  showSignIn = true,
  decoratePrimary = false,
  className,
  signedIn,
  bypass = false,
}: MarketingAuthCtasProps & { signedIn: boolean; bypass?: boolean }) {
  const { t } = useTranslation();
  const primaryLabel =
    signedIn && primaryKey === "nav.join" ? t("nav.openApp") : t(primaryKey);
  const label = (
    <PrimaryLabel label={primaryLabel} decorate={decoratePrimary} />
  );

  return (
    <div className={cn("flex flex-wrap items-center justify-center gap-2", className)}>
      {signedIn || bypass ? (
        <PrimaryButton appearance={appearance} asChild>
          <Link to="/app">{label}</Link>
        </PrimaryButton>
      ) : (
        <SignUpButton mode="modal" forceRedirectUrl="/app">
          <PrimaryButton appearance={appearance}>{label}</PrimaryButton>
        </SignUpButton>
      )}
      {showSignIn && !signedIn ? (
        bypass ? (
          <SignInLink appearance={appearance} />
        ) : (
          <SignInButton mode="modal" forceRedirectUrl="/app">
            <SignInButtonFace appearance={appearance}>
              {t("nav.signIn")}
            </SignInButtonFace>
          </SignInButton>
        )
      ) : null}
    </div>
  );
}

function PrimaryLabel({
  label,
  decorate,
}: {
  label: string;
  decorate: boolean;
}) {
  if (!decorate) return label;
  return (
    <>
      {label}
      <span aria-hidden className="ml-2">
        →
      </span>
    </>
  );
}

function PrimaryButton({
  appearance,
  className,
  ...props
}: ComponentProps<typeof Button> & { appearance: AuthCtaAppearance }) {
  return (
    <Button
      className={cn(
        "cta-lift",
        appearance === "hero" &&
          "h-11 rounded-full bg-white px-6 text-base font-semibold text-ink shadow-lg shadow-black/25 hover:bg-white/90",
        appearance === "nav-hero" &&
          "bg-white text-ink shadow-lg shadow-black/20 hover:bg-white/90",
        appearance === "default" && "h-11 px-6 text-base",
        className,
      )}
      {...props}
    />
  );
}

function signInClass(appearance: AuthCtaAppearance): string {
  if (appearance === "hero") {
    return "cta-lift inline-flex h-11 items-center rounded-full px-5 text-base font-medium text-white/90 ring-1 ring-white/40 backdrop-blur-sm hover:bg-white/15";
  }
  if (appearance === "default") {
    return "";
  }
  return cn(
    "hidden px-3 py-1.5 text-sm font-medium transition-colors duration-150 sm:inline",
    appearance === "nav-hero"
      ? "text-white/85 hover:text-white"
      : "text-paper-muted hover:text-paper",
  );
}

function SignInLink({ appearance }: { appearance: AuthCtaAppearance }) {
  const { t } = useTranslation();
  if (appearance === "default") {
    return (
      <Button variant="secondary" asChild className="cta-lift h-11 px-6 text-base">
        <Link to="/app">{t("nav.signIn")}</Link>
      </Button>
    );
  }
  return (
    <Link to="/app" className={signInClass(appearance)}>
      {t("nav.signIn")}
    </Link>
  );
}

function SignInButtonFace({
  appearance,
  children,
}: {
  appearance: AuthCtaAppearance;
  children: ReactNode;
}) {
  if (appearance === "default") {
    return (
      <Button variant="secondary" className="cta-lift h-11 px-6 text-base">
        {children}
      </Button>
    );
  }
  return (
    <button type="button" className={signInClass(appearance)}>
      {children}
    </button>
  );
}
