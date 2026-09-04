import { SignIn, SignUp, useAuth, useClerk, useUser } from "@clerk/clerk-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Navigate, useLocation } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Seo } from "@/components/marketing/seo";
import { ApiError, mintDesktopHandoff, setAuthTokenProvider } from "@/lib/api";
import { isDesktopApp } from "@/lib/desktop";
import { getAuthToken, isDevAuthBypassEnabled } from "@/lib/dev-auth";
import {
  desktopLoginHandoffHref,
  loopbackHandoffUrl,
  resolveDesktopLoginParams,
} from "@/lib/desktop-login";
import { useTranslation } from "@/lib/i18n";

/**
 * Opened in the system browser by the Electron shell. Google/Apple run here,
 * where the user is already signed in. After they confirm, we mint a ticket
 * and send it to 127.0.0.1 so the app can adopt the session.
 *
 * If this route is hit inside Electron itself, go to /app. The shell already
 * has a waiting screen; this page is for Chrome/Safari.
 */
export function DesktopLoginPage() {
  if (isDesktopApp() || isDevAuthBypassEnabled()) {
    return <Navigate to="/app" replace />;
  }
  return <DesktopLoginInner />;
}

function DesktopLoginInner() {
  const { t } = useTranslation();
  const location = useLocation();
  const { isLoaded, isSignedIn, getToken } = useAuth();
  const { user } = useUser();
  const { signOut } = useClerk();
  const [handoffError, setHandoffError] = useState<string | null>(null);
  const [handoffBusy, setHandoffBusy] = useState(false);
  const getTokenRef = useRef(getToken);
  getTokenRef.current = getToken;

  useEffect(() => {
    setAuthTokenProvider((options) =>
      getAuthToken(() =>
        getTokenRef.current({ skipCache: options?.forceRefresh }),
      ),
    );
  }, []);

  const params = useMemo(
    () => resolveDesktopLoginParams(location.search),
    [location.search],
  );
  const handoffHref = useMemo(
    () => desktopLoginHandoffHref(window.location.origin, params),
    [params],
  );

  const continueToApp = useCallback(async () => {
    if (!params.returnUrl) {
      window.location.replace(params.next ?? "/app");
      return;
    }
    setHandoffBusy(true);
    setHandoffError(null);
    try {
      const { ticket } = await mintDesktopHandoff();
      window.location.replace(
        loopbackHandoffUrl(params.returnUrl, ticket, params.state),
      );
    } catch (error) {
      setHandoffBusy(false);
      if (error instanceof ApiError && error.status === 404) {
        setHandoffError(t("desktopLogin.apiOld"));
        return;
      }
      setHandoffError(t("desktopLogin.handoffFailed"));
    }
  }, [params.next, params.returnUrl, params.state, t]);

  const clerkAppearance = {
    elements: {
      rootBox: "mx-auto w-full",
      cardBox: "w-full shadow-none",
    },
  };

  return (
    <div className="relative flex min-h-full flex-col items-center justify-center overflow-hidden px-6 py-12">
      <Seo
        title={t("desktopLogin.seo.title")}
        description={t("desktopLogin.seo.description")}
        path="/desktop-login"
        noIndex
      />
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_20%_20%,var(--glow-accent),transparent_40%)]" />
      <div className="animate-rise relative z-10 flex w-full max-w-[400px] flex-col items-center text-center">
        <p className="mb-6 text-xs uppercase tracking-[0.28em] text-signal">
          pqp
        </p>
        {params.done ? (
          <>
            <h1 className="font-display text-3xl font-extrabold leading-tight">
              {t("desktopLogin.done")}
            </h1>
            <p className="mt-3 text-paper-muted">{t("desktopLogin.doneBody")}</p>
          </>
        ) : !isLoaded ? (
          <p className="text-paper-muted">{t("app.loading.signingIn")}</p>
        ) : !isSignedIn ? (
          <div className="w-full text-left">
            {params.mode === "sign-up" ? (
              <SignUp
                routing="hash"
                forceRedirectUrl={handoffHref}
                signInForceRedirectUrl={handoffHref}
                appearance={clerkAppearance}
              />
            ) : (
              <SignIn
                routing="hash"
                forceRedirectUrl={handoffHref}
                signUpForceRedirectUrl={handoffHref}
                appearance={clerkAppearance}
              />
            )}
          </div>
        ) : (
          <>
            <h1 className="font-display text-3xl font-extrabold leading-tight">
              {t("desktopLogin.title")}
            </h1>
            <p className="mt-3 text-paper-muted">
              {params.returnUrl
                ? t("desktopLogin.confirmBody")
                : t("desktopLogin.missingReturn")}
            </p>
            {handoffError ? (
              <p className="mt-4 text-danger">{handoffError}</p>
            ) : null}
            <div className="mt-8 flex w-full flex-col gap-3">
              <Button onClick={() => void continueToApp()} disabled={handoffBusy}>
                {t("desktopLogin.continue", {
                  name:
                    user?.fullName ||
                    user?.primaryEmailAddress?.emailAddress ||
                    t("desktopLogin.continueFallback"),
                })}
              </Button>
              <Button
                variant="secondary"
                onClick={() => {
                  void signOut({ redirectUrl: handoffHref });
                }}
              >
                {t("desktopLogin.switch")}
              </Button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
