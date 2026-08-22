import { useClerk } from "@clerk/clerk-react";
import { LogOut } from "lucide-react";
import { Button } from "@/components/ui/button";
import { isDevAuthBypassEnabled } from "@/lib/dev-auth";
import { useTranslation } from "@/lib/i18n";

/**
 * Sign out, from inside the app.
 *
 * WHY THIS EXISTS. Until now the only way out of a session was Clerk's
 * `<UserButton>` in the user panel, and that widget renders on the condition
 * `showUserButton && !avatarUrl` — so it disappeared the moment somebody
 * uploaded an avatar. The people most invested in the app were the ones with no
 * way to leave it, which is the wrong way round. Sign out belongs somewhere that
 * does not depend on what a profile happens to contain.
 *
 * WHY IT IS NOT IN THE SECTION RAIL. That rail is a real `role="tablist"`, and
 * a tablist's children are tabs. Putting a button that is not a tab inside it
 * breaks arrow-key navigation and lies to a screen reader about how many
 * sections there are. The dialog footer is already persistent across every
 * section, so it is the one place that is equally reachable from all of them.
 *
 * THE BYPASS RENDERS NOTHING, deliberately. `ClerkProvider` is not mounted at
 * all under `VITE_DEV_AUTH_BYPASS`, so `useClerk` would throw — that much is
 * forced. What is a choice is rendering nothing rather than a button that
 * reloads the page: under the bypass the identity comes from an env var, so the
 * app boots straight back in. A control that says "sign out" and visibly does
 * not is worse than no control, and this is a local-development mode where the
 * way out is to unset the variable.
 */
export function SignOutButton({ className }: { className?: string }) {
  if (isDevAuthBypassEnabled()) {
    return null;
  }
  return <ClerkSignOut className={className} />;
}

function ClerkSignOut({ className }: { className?: string }) {
  const { signOut } = useClerk();
  const { t } = useTranslation();

  return (
    <Button
      variant="ghost"
      className={className}
      // Redirect to the landing page rather than staying put. `/app` behind a
      // dead session renders the signed-out prompt, which reads as an error
      // right after a deliberate action; the homepage reads as having left.
      onClick={() => void signOut({ redirectUrl: "/" })}
    >
      <LogOut aria-hidden className="h-4 w-4" />
      {t("settings.signOut")}
    </Button>
  );
}
