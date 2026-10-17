import { SignUpButton, SignedIn, SignedOut } from "@clerk/clerk-react";
import { Link } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { isDevAuthBypassEnabled } from "@/lib/dev-auth";
import { useTranslation } from "@/lib/i18n";
import { noteSignupCta } from "@/lib/signup-assist";
import { cn } from "@/lib/utils";

/**
 * The create-room button of the `/compare` pages: a sign-up modal for a
 * signed-out reader, a plain link to `/app` for a signed-in one and under the
 * dev bypass. Same arrangement as `/vs-discord` and `/tela`, with its own
 * surface name for the sign-up counter.
 */
export function CompareCreateButton({
  surface,
  className,
}: {
  surface: string;
  className?: string;
}) {
  const { t } = useTranslation();
  const classes = cn("cta-lift h-11 px-6 text-base", className);

  if (isDevAuthBypassEnabled()) {
    return (
      <Button asChild className={classes}>
        <Link to="/app">{t("compare.cta.create")}</Link>
      </Button>
    );
  }

  return (
    <>
      <SignedOut>
        <SignUpButton mode="modal" forceRedirectUrl="/app">
          <Button className={classes} onClick={() => noteSignupCta(surface, "")}>
            {t("compare.cta.create")}
          </Button>
        </SignUpButton>
      </SignedOut>
      <SignedIn>
        <Button asChild className={classes}>
          <Link to="/app">{t("compare.cta.create")}</Link>
        </Button>
      </SignedIn>
    </>
  );
}
