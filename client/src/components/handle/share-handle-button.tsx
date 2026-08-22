import { useState } from "react";
import { Check, Share2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useTranslation } from "@/lib/i18n";
import {
  browserShareCapabilities,
  shareHandle,
  type ShareOutcome,
} from "@/lib/share-handle";

/**
 * "Eu fui pra pqp" — the one growth loop that does not need us in it.
 *
 * Offered at the moment somebody has just taken a name and is, briefly, pleased
 * about it. That is the only moment this button is not an ask; five minutes
 * later it is an interruption, which is why it lives on the claim confirmation
 * and not in a toolbar.
 *
 * The label reflects what the device actually did, because a phone opens a
 * sheet and a desktop copies a line, and saying "shared" when the text is
 * sitting silently on somebody's clipboard is how a share button loses their
 * trust the first time they use it.
 */
export function ShareHandleButton({ handle }: { handle: string }) {
  const { t, locale } = useTranslation();
  const [outcome, setOutcome] = useState<ShareOutcome | null>(null);

  const label =
    outcome === "copied"
      ? t("handle.share.copied")
      : outcome === "failed"
        ? t("handle.share.failed")
        : t("handle.share.cta");

  return (
    <Button
      size="sm"
      variant="secondary"
      className="shrink-0 gap-1.5"
      onClick={() => {
        void shareHandle(handle, locale, browserShareCapabilities()).then(
          (result) => {
            // A dismissed sheet leaves the button exactly as it was. The person
            // decided not to send it, and saying anything about that would be
            // commenting on their choice.
            if (result !== "dismissed") {
              setOutcome(result);
            }
          },
        );
      }}
    >
      {outcome === "copied" ? (
        <Check aria-hidden className="h-3.5 w-3.5" />
      ) : (
        <Share2 aria-hidden className="h-3.5 w-3.5" />
      )}
      {label}
    </Button>
  );
}
