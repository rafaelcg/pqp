import { ClerkProvider } from "@clerk/clerk-react";
import { dark } from "@clerk/themes";
import {
  lazy,
  StrictMode,
  useEffect,
  Suspense,
  useLayoutEffect,
  useMemo,
  useState,
  type ComponentProps,
  type ReactNode,
} from "react";
import { createRoot } from "react-dom/client";
import {
  BrowserRouter,
  Navigate,
  Outlet,
  Route,
  Routes,
} from "react-router-dom";
import { AppLoadingShell } from "./components/layout/app-loading-shell";
import { DesktopDeepLinkBridge } from "./components/desktop-bridge";
import { ErrorBoundary } from "./components/error-boundary";
import { DesktopTitleBar } from "./components/layout/desktop-title-bar";
import { useTheme } from "./hooks/use-theme";
import { isDesktopApp } from "./lib/desktop";
import { isDevAuthBypassEnabled } from "./lib/dev-auth";
import { I18nProvider, useTranslation } from "./lib/i18n";
import type { Locale } from "./lib/locale";
import { forceTheme } from "./lib/theme";
import { LandingPage } from "./pages/landing-page";
import { UpdatePrompt } from "./components/layout/update-prompt";
import "./index.css";

// The chat client, the emoji picker's data, and the legal pages are all dead
// weight for a visitor who only ever sees the landing page. Desktop always lands
// on /app, so eagerly warm the chunk there instead.
const App = lazy(() => import("./App").then((m) => ({ default: m.App })));
const PrivacyPage = lazy(() =>
  import("./pages/privacy-page").then((m) => ({ default: m.PrivacyPage })),
);
const TermsPage = lazy(() =>
  import("./pages/terms-page").then((m) => ({ default: m.TermsPage })),
);
const CookiesPage = lazy(() =>
  import("./pages/cookies-page").then((m) => ({ default: m.CookiesPage })),
);
const StatusPage = lazy(() =>
  import("./pages/status-page").then((m) => ({ default: m.StatusPage })),
);

const publishableKey = import.meta.env.VITE_CLERK_PUBLISHABLE_KEY;

/**
 * The marketing pages are compositions over a hero photograph, so they stay dark
 * whatever the user picked; light-moding a photo composition is a different
 * design, not a theme. A layout route keeps the pin across /privacy → /terms
 * rather than dropping and retaking it on every navigation.
 */
function DarkRoutes() {
  useLayoutEffect(() => forceTheme("dark"), []);
  return <Outlet />;
}

function AppRoutes({ devBypass = false }: { devBypass?: boolean }) {
  const { t } = useTranslation();
  return (
    <Suspense fallback={<AppLoadingShell label={t("app.loading")} />}>
      <UpdatePrompt />
      <Routes>
        <Route element={<DarkRoutes />}>
          <Route path="/" element={<LandingPage />} />
          <Route path="/privacy" element={<PrivacyPage />} />
          <Route path="/terms" element={<TermsPage />} />
          <Route path="/cookies" element={<CookiesPage />} />
          <Route path="/status" element={<StatusPage />} />
        </Route>
        <Route path="/app/*" element={<App devBypass={devBypass} />} />
        <Route
          path="*"
          element={<Navigate to={isDesktopApp() ? "/app" : "/"} replace />}
        />
      </Routes>
    </Suspense>
  );
}

interface ClerkColors {
  colorPrimary: string;
  colorBackground: string;
  colorText: string;
}

/**
 * Clerk renders in its own default light theme otherwise, which reads as a
 * broken modal inside a dark shell.
 */
/**
 * Clerk's own strings in the user's language.
 *
 * Loaded on demand rather than imported: the pt-BR catalogue is ~66KB, and
 * bundling it into the initial download would make every English visitor pay
 * for it. Nothing waits on this — Clerk renders English until it resolves, and
 * the only surfaces it affects are modals that open on a click, long after the
 * fetch has landed. A failed load is left alone for the same reason: English is
 * a working sign-up form, and a blocked CDN should not become a blocked signup.
 *
 * The locale arrives from `I18nProvider` rather than from a second
 * `detectLocale()` call: Clerk's modals and the app's own copy must never end up
 * in different languages, which is exactly what two independent detections
 * eventually produce.
 */
type ClerkLocalization = ComponentProps<typeof ClerkProvider>["localization"];

function useClerkLocalization(locale: Locale): ClerkLocalization {
  const [localization, setLocalization] = useState<ClerkLocalization>();

  useEffect(() => {
    if (locale !== "pt-BR") {
      return;
    }
    let cancelled = false;
    void import("@clerk/localizations/pt-BR").then(
      (module) => {
        if (!cancelled) {
          setLocalization(module.ptBR);
        }
      },
      () => {
        // Keep English.
      },
    );
    return () => {
      cancelled = true;
    };
  }, [locale]);

  return localization;
}

function ThemedClerkProvider({
  publishableKey,
  children,
}: {
  publishableKey: string;
  children: ReactNode;
}) {
  const { locale } = useTranslation();
  const { resolved } = useTheme();
  const [colors, setColors] = useState<ClerkColors | null>(null);

  // Read from the element rather than importing token values: the custom
  // properties only carry the active theme once the stylesheet has applied.
  useLayoutEffect(() => {
    const styles = getComputedStyle(document.documentElement);
    const read = (token: string) => styles.getPropertyValue(token).trim();
    setColors({
      colorPrimary: read("--color-accent"),
      colorBackground: read("--color-surface-1"),
      colorText: read("--color-text"),
    });
  }, [resolved]);

  const appearance = useMemo(
    () => ({
      baseTheme: resolved === "dark" ? dark : undefined,
      variables: colors ?? undefined,
    }),
    [resolved, colors],
  );
  const localization = useClerkLocalization(locale);

  return (
    <ClerkProvider
      publishableKey={publishableKey}
      afterSignOutUrl="/"
      signInFallbackRedirectUrl="/app"
      signUpFallbackRedirectUrl="/app"
      appearance={appearance}
      localization={localization}
    >
      {children}
    </ClerkProvider>
  );
}

function DesktopShell({ children }: { children: ReactNode }) {
  if (!isDesktopApp()) {
    return <>{children}</>;
  }
  return (
    <div className="flex h-full flex-col">
      <DesktopTitleBar />
      <div className="min-h-0 flex-1">{children}</div>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <BrowserRouter>
      <ErrorBoundary>
        {/* Above the auth branches on purpose: the dev-bypass path renders no
            ClerkProvider, and it used to be the one route where nothing ever
            called detectLocale() and `<html lang>` stayed wrong. */}
        <I18nProvider>
          <DesktopShell>
            <DesktopDeepLinkBridge />
            {isDevAuthBypassEnabled() ? (
              <AppRoutes devBypass />
            ) : publishableKey ? (
              <ThemedClerkProvider publishableKey={publishableKey}>
                <AppRoutes />
              </ThemedClerkProvider>
            ) : (
              <div className="flex h-full items-center justify-center p-8 text-center text-muted">
                <div>
                  <h1 className="mb-2 text-xl font-bold text-foreground">
                    pqp
                  </h1>
                  {/* Untranslated on purpose: this only renders on a broken
                      local build, and the reader is whoever is editing .env. */}
                  <p>
                    Set VITE_CLERK_PUBLISHABLE_KEY or VITE_DEV_AUTH_BYPASS=true
                    in client/.env
                  </p>
                </div>
              </div>
            )}
          </DesktopShell>
        </I18nProvider>
      </ErrorBoundary>
    </BrowserRouter>
  </StrictMode>,
);
