import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import { MarketingAuthGate } from "@/components/marketing/marketing-auth-ctas";
import { browserStorage } from "@/lib/arrival";
import {
  createIntentHref,
  stashCreateIntent,
  type CreateIntent,
} from "@/lib/handle-intent";

const AFTER_AUTH = "/app";

/** Opens "Create community" on the name field after sign-up. */
export const CREATE_INTENT: CreateIntent = { mode: "name", source: null };
/** Opens "Create community" on the Discord template paste after sign-up. */
export const IMPORT_INTENT: CreateIntent = { mode: "import", source: null };

/**
 * The homepage previews draw their own buttons, so they take the landing's
 * Join and Sign in actions (Clerk modal, or a link to /app under the dev
 * bypass) and supply only the face. A signed-in visitor gets "Abrir o pqp".
 *
 * `intent` carries what the visitor came to do through the sign-up, the same
 * stash `/vem` uses (`lib/handle-intent.ts`): create a community, or import
 * one from a Discord template.
 */
export function JoinButton({
  children,
  className,
  signedInLabel = "Abrir o pqp",
  intent,
}: {
  children: ReactNode;
  className?: string;
  signedInLabel?: ReactNode;
  intent?: CreateIntent;
}) {
  const href = intent ? createIntentHref(intent) : AFTER_AUTH;
  return (
    <MarketingAuthGate>
      {(auth) =>
        auth.signedIn || auth.bypass ? (
          <Link to={href} className={className}>
            {auth.signedIn && !intent ? signedInLabel : children}
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

/** Hidden once the visitor is signed in. */
export function SignInButton({
  children = "Entrar",
  className,
}: {
  children?: ReactNode;
  className?: string;
}) {
  return (
    <MarketingAuthGate>
      {(auth) =>
        auth.signedIn ? null : auth.bypass ? (
          <Link to={AFTER_AUTH} className={className}>
            {children}
          </Link>
        ) : (
          <button type="button" onClick={auth.signIn} className={className}>
            {children}
          </button>
        )
      }
    </MarketingAuthGate>
  );
}
