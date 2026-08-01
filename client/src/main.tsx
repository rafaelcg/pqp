import { ClerkProvider } from "@clerk/clerk-react";
import { lazy, StrictMode, Suspense, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";
import { AppLoadingShell } from "./components/layout/app-loading-shell";
import { DesktopDeepLinkBridge } from "./components/desktop-bridge";
import { ErrorBoundary } from "./components/error-boundary";
import { DesktopTitleBar } from "./components/layout/desktop-title-bar";
import { isDesktopApp } from "./lib/desktop";
import { isDevAuthBypassEnabled } from "./lib/dev-auth";
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

const publishableKey = import.meta.env.VITE_CLERK_PUBLISHABLE_KEY;

function AppRoutes({ devBypass = false }: { devBypass?: boolean }) {
  return (
    <Suspense fallback={<AppLoadingShell label="Loading…" />}>
      <Routes>
        <Route path="/" element={<LandingPage />} />
        <Route path="/app/*" element={<App devBypass={devBypass} />} />
        <Route path="/privacy" element={<PrivacyPage />} />
        <Route path="/terms" element={<TermsPage />} />
        <Route path="/cookies" element={<CookiesPage />} />
        <Route
          path="*"
          element={<Navigate to={isDesktopApp() ? "/app" : "/"} replace />}
        />
      </Routes>
    </Suspense>
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
            <ClerkProvider
              publishableKey={publishableKey}
              afterSignOutUrl="/"
              signInFallbackRedirectUrl="/app"
              signUpFallbackRedirectUrl="/app"
            >
              <AppRoutes />
            </ClerkProvider>
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
