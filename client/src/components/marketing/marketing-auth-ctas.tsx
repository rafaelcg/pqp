import { useAuth, useClerk } from "@clerk/clerk-react";
import type { ComponentProps, ReactNode } from "react";
import { Link, useNavigate } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { isDevAuthBypassEnabled } from "@/lib/dev-auth";
import { useTranslation, type MessageKey } from "@/lib/i18n";
import { cn } from "@/lib/utils";

export type AuthCtaAppearance = "hero" | "nav-hero" | "nav-solid" | "default";

const AFTER_AUTH = "/app";

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
 * WHY `useClerk()` AND NOT `<SignUpButton>`. Clerk's wrappers clone `onClick`
 * onto a single child. A custom face that does not forward that prop (the old
 * Sign in control) is a dead click. Calling `openSignUp` / `openSignIn` on our
 * own buttons keeps the modal and always fires. If Clerk is not ready, we go
 * to `/app`, which already hosts the same forms.
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
  const { isSignedIn, isLoaded } = useAuth();
  const clerk = useClerk();
  const navigate = useNavigate();

  const goApp = () => {
    void navigate(AFTER_AUTH);
  };

  const openOrGo = (open: () => unknown) => {
    if (!isLoaded) {
      goApp();
      return;
    }
    try {
      void Promise.resolve(open()).catch(goApp);
    } catch {
      goApp();
    }
  };

  return (
    <AuthPair
      {...props}
      signedIn={isSignedIn === true}
      onJoin={() =>
        openOrGo(() => clerk.openSignUp({ forceRedirectUrl: AFTER_AUTH }))
      }
      onSignIn={() =>
        openOrGo(() => clerk.openSignIn({ forceRedirectUrl: AFTER_AUTH }))
      }
    />
  );
}

function AuthPair({
  appearance = "default",
  primaryKey = "nav.join",
  showSignIn = true,
  decoratePrimary = false,
  className,
  signedIn,
  bypass = false,
  onJoin,
  onSignIn,
}: MarketingAuthCtasProps & {
  signedIn: boolean;
  bypass?: boolean;
  onJoin?: () => void;
  onSignIn?: () => void;
}) {
  const { t } = useTranslation();
  const primaryLabel =
    signedIn && primaryKey === "nav.join" ? t("nav.openApp") : t(primaryKey);
  const label = (
    <PrimaryLabel label={primaryLabel} decorate={decoratePrimary} />
  );
  const useLink = signedIn || bypass;

  return (
    <div className={cn("flex flex-wrap items-center justify-center gap-2", className)}>
      {useLink ? (
        <PrimaryButton appearance={appearance} asChild>
          <Link to={AFTER_AUTH}>{label}</Link>
        </PrimaryButton>
      ) : (
        <PrimaryButton appearance={appearance} type="button" onClick={onJoin}>
          {label}
        </PrimaryButton>
      )}
      {showSignIn && !signedIn ? (
        bypass ? (
          <SignInLink appearance={appearance} />
        ) : (
          <SignInButtonFace appearance={appearance} onClick={onSignIn}>
            {t("nav.signIn")}
          </SignInButtonFace>
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
        <Link to={AFTER_AUTH}>{t("nav.signIn")}</Link>
      </Button>
    );
  }
  return (
    <Link to={AFTER_AUTH} className={signInClass(appearance)}>
      {t("nav.signIn")}
    </Link>
  );
}

function SignInButtonFace({
  appearance,
  children,
  onClick,
}: {
  appearance: AuthCtaAppearance;
  children: ReactNode;
  onClick?: () => void;
}) {
  if (appearance === "default") {
    return (
      <Button
        type="button"
        variant="secondary"
        className="cta-lift h-11 px-6 text-base"
        onClick={onClick}
      >
        {children}
      </Button>
    );
  }
  return (
    <button type="button" className={signInClass(appearance)} onClick={onClick}>
      {children}
    </button>
  );
}
