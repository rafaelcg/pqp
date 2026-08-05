import { ClerkProvider } from "@clerk/clerk-react";
import { dark } from "@clerk/themes";
import {
  lazy,
  StrictMode,
  Suspense,
  useLayoutEffect,
  useMemo,
  useState,
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
import { forceTheme } from "./lib/theme";
import { LandingPage } from "./pages/landing-page";
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
  return (
    <Suspense fallback={<AppLoadingShell label="Loading…" />}>
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
function ThemedClerkProvider({
  publishableKey,
  children,
}: {
  publishableKey: string;
  children: ReactNode;
}) {
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

  return (
    <ClerkProvider
      publishableKey={publishableKey}
      afterSignOutUrl="/"
      signInFallbackRedirectUrl="/app"
      signUpFallbackRedirectUrl="/app"
      appearance={appearance}
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
                <h1 className="mb-2 text-xl font-bold text-foreground">pqp</h1>
                <p>
                  Set VITE_CLERK_PUBLISHABLE_KEY or VITE_DEV_AUTH_BYPASS=true in
                  client/.env
                </p>
              </div>
            </div>
          )}
        </DesktopShell>
      </ErrorBoundary>
    </BrowserRouter>
  </StrictMode>,
);
