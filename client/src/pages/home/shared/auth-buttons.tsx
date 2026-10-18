import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import { MarketingAuthGate } from "@/components/marketing/marketing-auth-ctas";
import { browserStorage } from "@/lib/arrival";
import {
  createIntentHref,
  stashCreateIntent,
  type CreateIntent,
} from "@/lib/handle-intent";
import { useTranslation } from "@/lib/i18n";

const AFTER_AUTH = "/app";

/** Opens "Create community" on the name field after sign-up. */
export const CREATE_INTENT: CreateIntent = { mode: "name", source: null };
/** Opens "Create community" on the Discord template paste after sign-up. */
export const IMPORT_INTENT: CreateIntent = { mode: "import", source: null };

/**
 * The homepage and its previews draw their own buttons, so they take the
 * landing's Join and Sign in actions (Clerk modal, or a link to /app under the
 * dev bypass) and supply only the face.
 *
 * `intent` carries what the visitor came to do through the sign-up, the same
 * stash `/vem` uses (`lib/handle-intent.ts`): create a community, or import
 * one from a Discord template. A signed-in visitor follows the intent's link
 * with the same face.
 *
 * A signed-in visitor sees `signedInLabel` ("Open the app", `nav.openApp`,
 * by default) and goes to /app when the button has no intent, or when
 * `openAppWhenSignedIn` is set. That prop is for the header: there, a
 * returning visitor wants the app, not a new community. The dev bypass is
 * never signed in, so it keeps the intent link.
 */
export function JoinButton({
  children,
  className,
  signedInLabel,
  signedInClassName,
  intent,
  openAppWhenSignedIn = false,
}: {
  children: ReactNode;
  className?: string;
  signedInLabel?: ReactNode;
  /**
   * The class of the "Open the app" face, when it differs from `className`
   * (the header hides its create face on phones while the sticky bar is up,
   * but keeps the way back into the app).
   */
  signedInClassName?: string;
  intent?: CreateIntent;
  /** Signed in: show `signedInLabel` and link /app, even with an intent. */
  openAppWhenSignedIn?: boolean;
}) {
  const { t } = useTranslation();
  const href = intent ? createIntentHref(intent) : AFTER_AUTH;
  return (
    <MarketingAuthGate>
      {(auth) =>
        auth.signedIn && (!intent || openAppWhenSignedIn) ? (
          <Link to={AFTER_AUTH} className={signedInClassName ?? className}>
            {signedInLabel ?? t("nav.openApp")}
          </Link>
        ) : auth.signedIn || auth.bypass ? (
          <Link to={href} className={className}>
            {children}
          </Link>
        ) : (
          <button
            type="button"
            onClick={() => {
              if (intent) stashCreateIntent(browserStorage(), intent);
              auth.join();
            }}
            className={className}
          >
            {children}
          </button>
        )
      }
    </MarketingAuthGate>
  );
}

/** Hidden once the visitor is signed in. The face defaults to "Sign in" (`nav.signIn`). */
export function SignInButton({
  children,
  className,
}: {
  children?: ReactNode;
  className?: string;
}) {
  const { t } = useTranslation();
  const label = children ?? t("nav.signIn");
  return (
    <MarketingAuthGate>
      {(auth) =>
        auth.signedIn ? null : auth.bypass ? (
          <Link to={AFTER_AUTH} className={className}>
            {label}
          </Link>
        ) : (
          <button type="button" onClick={auth.signIn} className={className}>
            {label}
          </button>
        )
      }
    </MarketingAuthGate>
  );
}
