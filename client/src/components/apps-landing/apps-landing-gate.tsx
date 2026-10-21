import type { ReactNode } from "react";
import { Navigate } from "react-router-dom";
import { useAppsLanding } from "@/hooks/use-apps-landing";

/**
 * The door of the pqp Apps pages. Off (or unknown, or an API too old to know)
 * is a redirect to `/`, replacing the entry so Back does not bounce, which is
 * what `ApoieRoute` does for the donation page. While the first answer is on
 * its way nothing but an empty, themed surface is drawn: the page is never
 * shown and then taken back.
 */
export function AppsLandingGate({ children }: { children: ReactNode }) {
  const state = useAppsLanding();
  if (state === "off") {
    return <Navigate to="/" replace />;
  }
  if (state === "checking") {
    return <div className="min-h-full bg-surface-0" aria-busy="true" />;
  }
  return <>{children}</>;
}
