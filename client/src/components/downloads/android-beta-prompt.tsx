import { X } from "lucide-react";
import { useEffect, useState } from "react";
import { AndroidPhone } from "@/components/marketing/android-phone";
import { Button } from "@/components/ui/button";
import {
  androidBetaLinks,
  isAndroidBetaPromptSeen,
  rememberAndroidBetaPrompt,
} from "@/lib/android-beta";
import { isAndroidDevice, isIOSDevice } from "@/lib/downloads";
import { useTranslation } from "@/lib/i18n";

/**
 * "There is an Android app now", once per session, in the corner of `/app`.
 *
 * WHO SEES IT, and why it is not "Android visitors only".
 *
 * The obvious rule would be to show this only on Android, the way the iOS beta
 * line is shown only on iPhones (`hero-download.tsx`). That rule is right for
 * TestFlight and wrong here, for two reasons.
 *
 *  - **The offer is not an install, it is a slot.** A Play closed track needs
 *    the tester's Google account in the group *before* the opt-in link does
 *    anything, so even a person holding the phone cannot go from this card to a
 *    running app in one tap. Joining the group is a thing you do perfectly well
 *    from a desktop, on the Google account you are already signed into.
 *  - **Desktop is where our people are.** Umami puts the audience at Windows
 *    76% / Android 14% (`docs/ANDROID.md`). Showing this only to the 14% would
 *    hide the announcement from five sixths of the people who own an Android
 *    phone and happen to be at a computer.
 *
 * So it shows on Android and on the desktop, with the body copy naming which
 * one you are on, and it is hidden on iOS. That last exclusion is the honest
 * one: an iPhone cannot run this build at any point in the future, so the card
 * would be pure noise, and those visitors already have `/beta`.
 *
 * NOT A DIALOG. No backdrop, no focus trap, nothing blocked, no autofocus
 * stealing the composer's caret mid-sentence. It is a card in the corner,
 * under every real dialog (z-30 against their z-[60]), that Escape or the X
 * closes and the session then never shows again.
 */
export function AndroidBetaPrompt() {
  const { t } = useTranslation();

  /**
   * Decided once, on mount, and never re-derived. Everything it reads is fixed
   * for the lifetime of the tab, and a card that could reappear because some
   * unrelated state changed is the failure mode this whole component is trying
   * to avoid.
   */
  const [state] = useState(() => {
    // No complete flow, no card. The landing page can degrade into "not open
    // yet, here is the browser and here is our address"; an unprompted popup
    // that cannot offer the thing it is announcing has no honest version of
    // itself, so it simply does not render.
    if (!androidBetaLinks() || isIOSDevice() || isAndroidBetaPromptSeen()) {
      return null;
    }
    return { onAndroid: isAndroidDevice() };
  });
  const [open, setOpen] = useState(true);

  // Written on display, not on dismiss: scrolling past it and moving on still
  // counts as having seen it.
  useEffect(() => {
    if (state) {
      rememberAndroidBetaPrompt();
    }
  }, [state]);

  useEffect(() => {
    if (!state || !open) {
      return;
    }
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setOpen(false);
      }
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [state, open]);

  if (!state || !open) {
    return null;
  }

  return (
    <aside
      aria-label={t("androidPrompt.title")}
      className="animate-fade-in safe-pb fixed inset-x-3 bottom-3 z-30 sm:inset-x-auto sm:right-4 sm:bottom-4 sm:w-[22rem]"
    >
      <div className="flex gap-4 rounded-2xl border border-ink-4 bg-ink-2 p-4 shadow-[var(--shadow-popover)]">
        {/* The same phone as `/android`, small. It is what makes the card read
            as one campaign with the page it links to. */}
        <AndroidPhone
          alt={t("androidPage.phone.alt")}
          variant="compact"
          className="w-14 shrink-0 self-center"
        />

        <div className="min-w-0 flex-1">
          <div className="flex items-start gap-2">
            <h2 className="min-w-0 flex-1 font-display text-sm font-bold tracking-tight text-paper">
              {t("androidPrompt.title")}
            </h2>
            <button
              type="button"
              onClick={() => setOpen(false)}
              aria-label={t("androidPrompt.dismiss")}
              className="-mr-1 -mt-1 inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-paper-muted outline-none hover:bg-ink-3 hover:text-paper focus-visible:ring-2 focus-visible:ring-signal/60"
            >
              <X className="h-3.5 w-3.5" aria-hidden />
            </button>
          </div>

          <p className="mt-1.5 text-pretty text-xs leading-relaxed text-paper-muted">
            {t(
              state.onAndroid
                ? "androidPrompt.body.android"
                : "androidPrompt.body.desktop",
            )}
          </p>

          {/* Straight to `/android`, in a new tab, and never straight to the
              Play opt-in: the page is where the two steps are explained, and a
              chat client should not throw away the session you are in. */}
          <Button asChild size="sm" className="cta-lift mt-3 rounded-full px-4">
            <a href="/android" target="_blank" rel="noopener">
              {t("androidPrompt.cta")}
            </a>
          </Button>
        </div>
      </div>
    </aside>
  );
}
