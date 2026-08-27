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
  useParams,
} from "react-router-dom";
import { AppLoadingShell } from "./components/layout/app-loading-shell";
import { DesktopDeepLinkBridge } from "./components/desktop-bridge";
import { ErrorBoundary } from "./components/error-boundary";
import { DesktopTitleBar } from "./components/layout/desktop-title-bar";
import { useTheme } from "./hooks/use-theme";
import { rememberAcquisitionFromLocation } from "./lib/acquisition";
import { browserStorage } from "./lib/arrival";
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
const VsDiscordPage = lazy(() =>
  import("./pages/vs-discord-page").then((m) => ({ default: m.VsDiscordPage })),
);
const BetaPage = lazy(() =>
  import("./pages/beta-page").then((m) => ({ default: m.BetaPage })),
);
const AndroidPage = lazy(() =>
  import("./pages/android-page").then((m) => ({ default: m.AndroidPage })),
);
const DownloadPage = lazy(() =>
  import("./pages/download-page").then((m) => ({ default: m.DownloadPage })),
);
const TelaPage = lazy(() =>
  import("./pages/tela-page").then((m) => ({ default: m.TelaPage })),
);
const BlogPage = lazy(() =>
  import("./pages/blog-page").then((m) => ({ default: m.BlogPage })),
);
const BlogPostPage = lazy(() =>
  import("./pages/blog-post-page").then((m) => ({ default: m.BlogPostPage })),
);
const ClaimPage = lazy(() =>
  import("./pages/claim-page").then((m) => ({ default: m.ClaimPage })),
);
const PublicProfilePage = lazy(() =>
  import("./pages/public-profile-page").then((m) => ({
    default: m.PublicProfilePage,
  })),
);
const PublicCommunityPage = lazy(() =>
  import("./pages/public-community-page").then((m) => ({
    default: m.PublicCommunityPage,
  })),
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

/**
 * `pqp.gg/@rafa`.
 *
 * WHY `/:handleSegment` AND NOT `/@:handle`. React Router's path compiler only
 * accepts a parameter that occupies a WHOLE segment — its pattern is
 * `/\/:([\w-]+)/`, anchored on the slash — so `/@:handle` is read as the literal
 * string `/@:handle` and matches nothing. The `@` therefore has to live inside
 * the parameter's value and be stripped here.
 *
 * WHY THE `@` PREFIX AT ALL, given that. Because the alternative is `/rafa`, and
 * that puts every handle in the same namespace as every route this product will
 * ever add: `/privacy` and `/status` are already taken, `/pricing` and `/blog`
 * are one product decision away, and the day one of them collides with a claimed
 * handle somebody's page disappears with no migration available. The `@` makes
 * the two namespaces disjoint forever, at the cost of one character.
 *
 * A segment that is not a handle keeps the behaviour the catch-all had before
 * this route existed — `/` on the web, `/app` in the desktop shell — so no URL
 * that used to redirect now renders a profile page instead.
 */
function PublicProfileRoute() {
  const { handleSegment = "" } = useParams();
  if (!handleSegment.startsWith("@")) {
    return <Navigate to={isDesktopApp() ? "/app" : "/"} replace />;
  }
  return <PublicProfilePage handle={handleSegment.slice(1).toLowerCase()} />;
}

/**
 * `pqp.gg/c/valorant-brasil`.
 *
 * A `/c/` PREFIX RATHER THAN A BARE SLUG, and rather than sharing the `@`
 * namespace with handles. Two reasons, and the second is the one that decided
 * it. First, the same argument the `@` makes for profiles: a bare `/valorant`
 * competes with every route this product will ever add. Second — and this is
 * why communities did not simply get `@` too — a person and a community must be
 * able to hold the same word. `pqp.gg/@rafa` and `pqp.gg/c/rafa` are two pages
 * that never fight, and folding them into one namespace would mean the day
 * somebody's community shares a name with somebody's handle, one of the two
 * loses a URL that is already in screenshots.
 *
 * Unlike the profile route this is a real nested path, so React Router's
 * whole-segment parameter rule is satisfied and the slug needs no unwrapping.
 * Lowercased here so `/c/Valorant` and `/c/valorant` are one page rather than
 * two, one of which 404s.
 */
function PublicCommunityRoute() {
  const { slug = "" } = useParams();
  return <PublicCommunityPage slug={slug.toLowerCase()} />;
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
          <Route path="/vs-discord" element={<VsDiscordPage />} />
          {/* `/tela`: the pt-BR landing for "Discord sem tela no Brasil, o
              que usar". A static single segment, so, as the note on
              `PublicProfileRoute` below explains, the word joins
              RESERVED_HANDLES and nobody can hold `@tela` from now on. A
              search landing has to be a short memorable path and `/tela` is
              the query itself, so the trade is accepted knowingly; do not add
              a second one without the same thought. */}
          <Route path="/tela" element={<TelaPage />} />
          <Route path="/beta" element={<BetaPage />} />
          {/* `/beta` is iOS, `/android` is Android, and they are two pages
              rather than one because the two betas are not the same offer:
              TestFlight is a self-serve link, a Play closed track is a tester
              list somebody has to be put on. Same single-segment cost as
              `/tela` above, so `android` joins RESERVED_HANDLES too. */}
          <Route path="/android" element={<AndroidPage />} />
          <Route path="/download" element={<DownloadPage />} />
          {/* Static before dynamic, and both before `/:handleSegment`. React
              Router ranks a static segment above a parameter, so `/blog/x`
              cannot be read as a handle, but keeping them adjacent here is how
              the next person sees that the ordering was considered. */}
          <Route path="/blog" element={<BlogPage />} />
          <Route path="/blog/:slug" element={<BlogPostPage />} />
          {/* Two paths, one page. `/garanta` is the one that gets shared in
              Brazil and the one every CTA points at; `/claim` exists so an
              English-speaking visitor guessing at a URL is not wrong. Neither
              redirects to the other — a redirect on a landing page is a lost
              click, and both are canonicalised to `/garanta` by `Seo`. */}
          <Route path="/garanta" element={<ClaimPage />} />
          <Route path="/claim" element={<ClaimPage />} />
          {/* Above the single-segment handle route below, though again the
              order does not decide it — `/c/:slug` is two segments and cannot
              collide with a one-segment pattern. Written here because a reader
              looking for "where do the public pages live" should find both in
              the same place. */}
          <Route path="/c/:slug" element={<PublicCommunityRoute />} />
          {/* LAST among the single-segment routes, though the order does not
              actually decide it: React Router ranks a static segment above a
              dynamic one, so `/privacy` still wins even from here. Written last
              anyway, because a reader should not have to know that rule to
              believe the file. */}
          <Route path="/:handleSegment" element={<PublicProfileRoute />} />
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

// Before routing, so every door works the same: the campaign parameters on
// the URL this page loaded with are remembered now, and sent once after the
// account exists (see `lib/acquisition.ts` and the arrival effect in App.tsx).
// Nothing is stripped from the address bar here; the URL is the page's to own.
rememberAcquisitionFromLocation(browserStorage(), window.location);

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
