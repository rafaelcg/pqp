import { useLocation } from "react-router-dom";
import { UpdateIndicator } from "@/components/layout/update-indicator";
import { TooltipProvider } from "@/components/ui/tooltip";
import { useUpdateOffered } from "@/lib/update-prompt-state";

/**
 * The update indicator for pages that have no rail: the landing page, sign-in,
 * a public profile or community. Inside `/app` the rail (desktop) and the phone
 * screens carry it, and a second one here would be two of the same button.
 *
 * A small round button in the bottom-left corner, the same one, with the same
 * popover opening upward. It is there only while there is a build to take.
 * `TooltipProvider` is its own because the one the app shell mounts does not
 * wrap these routes.
 */
export function StandaloneUpdateIndicator() {
  const { pathname } = useLocation();
  const offered = useUpdateOffered();
  if (!offered || pathname === "/app" || pathname.startsWith("/app/")) {
    return null;
  }
  return (
    <TooltipProvider>
      <div className="fixed bottom-4 left-4 z-[60]">
        <UpdateIndicator variant="corner" />
      </div>
    </TooltipProvider>
  );
}
