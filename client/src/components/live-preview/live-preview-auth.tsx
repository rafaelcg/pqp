import { SignUp, useClerk } from "@clerk/clerk-react";
import { useMemo, useState, type ReactNode } from "react";
import { Dialog } from "@/components/ui/dialog";
import { useTranslation } from "@/lib/i18n";

/**
 * How the live preview reaches sign-up and sign-in, handed in by the surface.
 *
 * WHY AN ADAPTER. Under the dev auth bypass `main.tsx` renders no
 * `ClerkProvider`, and any Clerk hook in the panel would crash the very page
 * the bypass exists to show. So the panel never touches Clerk: the community
 * page and the invite gate build the Clerk adapter inside the Clerk tree, and
 * the dev branch builds `devLivePreviewAuth`. The panel runs its stashes (the
 * join intent, the channel, the attribution) before calling `signUp` or
 * `signIn`, and on the first touch of the inline form.
 */
export interface LivePreviewAuth {
  /** Clerk's sign-up modal, the one the home page opens. */
  signUp: () => void;
  /** Clerk's sign-in modal. */
  signIn: () => void;
  /**
   * Clerk's own `<SignUp>` drawn inline (the end sheet, the chat card), or
   * null where there is no Clerk (the dev bypass), and the panel draws one
   * "Criar conta" button instead.
   */
  renderInlineSignUp: (() => ReactNode) | null;
}

/**
 * The inline form sits inside our own sheet or card, which already has the
 * title, so Clerk's card chrome and heading step aside. Everything else
 * (the provider buttons with their logos, the email field, pqp's pt-BR
 * wording, the theme colours) comes from the `ClerkProvider` in `main.tsx`,
 * which this merges into rather than forks. Clerk's own "Already have an
 * account?" footer is hidden because the panel draws that line itself and
 * opens the sign-in modal from it, with the same redirect.
 */
const INLINE_APPEARANCE = {
  // Style objects rather than utility classes: Clerk's own styles outrank a
  // class of the same specificity, and `display: none` has to win.
  elements: {
    rootBox: { width: "100%" },
    cardBox: {
      width: "100%",
      maxWidth: "none",
      border: "none",
      borderRadius: 0,
      boxShadow: "none",
      background: "transparent",
    },
    card: {
      width: "100%",
      padding: 0,
      border: "none",
      boxShadow: "none",
      background: "transparent",
    },
    header: { display: "none" },
    footer: { background: "transparent" },
    footerAction: { display: "none" },
  },
};

function ClerkInlineSignUp({ redirectUrl }: { redirectUrl: string }) {
  return (
    <SignUp
      // Hash routing, the React default: the steps after the first (the
      // email code, an OAuth return) live in `#/...` on this same page.
      routing="hash"
      forceRedirectUrl={redirectUrl}
      signInForceRedirectUrl={redirectUrl}
      appearance={INLINE_APPEARANCE}
    />
  );
}

/**
 * The Clerk path. `redirectUrl` is where the account lands: `/app?join=<slug>`
 * from a community page, the invite path from the invite gate. Both modals
 * carry it for sign-up AND sign-in, so switching from one to the other inside
 * Clerk lands in the same place. If Clerk is not ready, the person goes to
 * `redirectUrl` itself, which hosts the same forms (the home page's rule,
 * `marketing-auth-ctas.tsx`).
 */
export function useClerkLivePreviewAuth(redirectUrl: string): LivePreviewAuth {
  const clerk = useClerk();
  return useMemo<LivePreviewAuth>(() => {
    const goInstead = () => window.location.assign(redirectUrl);
    const openOrGo = (open: () => unknown) => {
      if (!clerk.loaded) {
        goInstead();
        return;
      }
      try {
        void Promise.resolve(open()).catch(goInstead);
      } catch {
        goInstead();
      }
    };
    return {
      signUp: () =>
        openOrGo(() =>
          clerk.openSignUp({
            forceRedirectUrl: redirectUrl,
            signInForceRedirectUrl: redirectUrl,
          }),
        ),
      signIn: () =>
        openOrGo(() =>
          clerk.openSignIn({
            forceRedirectUrl: redirectUrl,
            signUpForceRedirectUrl: redirectUrl,
          }),
        ),
      renderInlineSignUp: () => <ClerkInlineSignUp redirectUrl={redirectUrl} />,
    };
  }, [clerk, redirectUrl]);
}

/** Renders `children` with the Clerk adapter. Mount only inside `ClerkProvider`. */
export function ClerkLivePreviewAuth({
  redirectUrl,
  children,
}: {
  redirectUrl: string;
  children: (auth: LivePreviewAuth) => ReactNode;
}) {
  const auth = useClerkLivePreviewAuth(redirectUrl);
  return <>{children(auth)}</>;
}

/** The hash steps Clerk's inline sign-up can come back on after a navigation. */
const CLERK_RETURN_HASH = /^#\/(sso-callback|continue|verify)/;

/**
 * Finishes an inline sign-up that left the page: a provider (Google, Apple,
 * Twitch) sends the browser back here on `#/sso-callback`, and a missing
 * field or an email link can come back on `#/continue` or `#/verify...`. The
 * inline form lived inside the preview, which is not open on a fresh load
 * (and is not drawn at all if the party ended meanwhile), so this mounts the
 * same `<SignUp>` in a sheet to complete the step, and Clerk then goes to
 * `redirectUrl`. Read once, on load: the inline form changes the hash too
 * while somebody is typing in it, and that must not open a second one.
 */
export function ClerkSignUpReturn({ redirectUrl }: { redirectUrl: string }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(
    () => typeof window !== "undefined" && CLERK_RETURN_HASH.test(window.location.hash),
  );
  if (!open) {
    return null;
  }
  return (
    <Dialog
      open
      title={t("livePreview.finishing.title")}
      onClose={() => setOpen(false)}
      size="sm"
    >
      <div className="safe-pb px-5 pt-4">
        <ClerkInlineSignUp redirectUrl={redirectUrl} />
      </div>
    </Dialog>
  );
}

/**
 * DEV ONLY, the dev auth bypass: every button goes to the existing dev
 * sign-up, which is opening the app as the `pqp:dev-user-suffix` account.
 */
export function devLivePreviewAuth(go: () => void): LivePreviewAuth {
  return {
    signUp: go,
    signIn: go,
    renderInlineSignUp: null,
  };
}
