import { ClerkProvider } from "@clerk/clerk-react";
import { StrictMode, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";
import { App } from "./App";
import { DesktopDeepLinkBridge } from "./components/desktop-bridge";
import { DesktopTitleBar } from "./components/layout/desktop-title-bar";
import { isDesktopApp } from "./lib/desktop";
import { isDevAuthBypassEnabled } from "./lib/dev-auth";
import { CookiesPage } from "./pages/cookies-page";
import { LandingPage } from "./pages/landing-page";
import { PrivacyPage } from "./pages/privacy-page";
import { TermsPage } from "./pages/terms-page";
import "./index.css";

const publishableKey = import.meta.env.VITE_CLERK_PUBLISHABLE_KEY;

function AppRoutes({ devBypass = false }: { devBypass?: boolean }) {
  return (
    <Routes>
      <Route path="/" element={<LandingPage />} />
      <Route path="/app/*" element={<App devBypass={devBypass} />} />
      <Route path="/privacy" element={<PrivacyPage />} />
      <Route path="/terms" element={<TermsPage />} />
      <Route path="/cookies" element={<CookiesPage />} />
      <Route
        path="*"
        element={
          <Navigate to={isDesktopApp() ? "/app" : "/"} replace />
        }
      />
    </Routes>
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
    </BrowserRouter>
  </StrictMode>,
);
