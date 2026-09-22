import {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { CornerCard } from "@/components/layout/corner-card";
import { Button } from "@/components/ui/button";
import {
  isFeatureHintSeen,
  isFeatureHintSpentForLoad,
  rememberFeatureHint,
  resetFeatureHintsForTests as resetSpentFeatureHints,
  spendFeatureHintForLoad,
  type AttachedFeatureHintId,
  type FeatureHintId,
} from "@/lib/feature-hints";
import { isAutomatedBrowser } from "@/lib/hints";
import { useTranslation } from "@/lib/i18n";

const FeatureHintContext = createContext<AttachedFeatureHintId | null>(null);

export function FeatureHintProvider({
  winner,
  children,
}: {
  winner: AttachedFeatureHintId | null;
  children: ReactNode;
}) {
  return (
    <FeatureHintContext.Provider value={winner}>
      {children}
    </FeatureHintContext.Provider>
  );
}

export function useFeatureHintEnabled(id: AttachedFeatureHintId): boolean {
  return useContext(FeatureHintContext) === id;
}

/**
 * Eligibility that survives a remount in the same page load.
 *
 * The stage swaps the collapsed strip for the expanded one when a share
 * starts, and React StrictMode remounts in dev. Both would otherwise
 * remember the hint on the discarded tree and hide it on the real one.
 */
const eligibleThisLoad = new Set<FeatureHintId>();

/**
 * And a dismissal that survives one too, for the same reason.
 *
 * `open` used to start true on every mount, which was invisible while a
 * hint's gate was a standing condition that could not move during a call:
 * nothing unmounted the card except leaving. A gate that follows live
 * state (a track starting, a panel opening) unmounts it and hands it
 * straight back, so Entendi stops meaning anything and the card becomes
 * something people learn to swat. The impression is already in storage by
 * then, so this only has to cover the rest of the page load.
 *
 * It lives in `lib/feature-hints.ts` rather than here because the QUEUE
 * has to read it too: a card that has had its turn must stop winning the
 * one attached slot, or every tip behind it waits for good.
 */
function markDismissed(id: FeatureHintId): void {
  spendFeatureHintForLoad(id);
}

/** Both sets are per page load, so a suite has to start each test fresh. */
export function resetFeatureHintsForTests(): void {
  eligibleThisLoad.clear();
  resetSpentFeatureHints();
}

function takeEligibility(id: FeatureHintId): boolean {
  if (eligibleThisLoad.has(id)) {
    return true;
  }
  const ok = !isAutomatedBrowser() && !isFeatureHintSeen(id);
  if (ok) {
    eligibleThisLoad.add(id);
  }
  return ok;
}

/**
 * One coachmark. Same CornerCard frame as the corner queue, laid out next to
 * the control it names. `lib/hints.ts` is the store; App is the queue.
 */
export function FeatureHint({
  id,
  enabled,
  title,
  body,
  actionLabel,
  onAction,
  actionBusy = false,
}: {
  id: FeatureHintId;
  enabled: boolean;
  title?: string;
  body: string;
  /** Replaces the default "Got it" when this hint has a real next step. */
  actionLabel?: string;
  /**
   * A real next step. The card closes when this resolves. A thrown
   * error (or a sync throw) leaves it open so the person can retry.
   */
  onAction?: () => void | Promise<void>;
  actionBusy?: boolean;
}) {
  const { t } = useTranslation();
  const [eligible] = useState(() => takeEligibility(id));
  const [open, setOpen] = useState(() => !isFeatureHintSpentForLoad(id));

  const close = () => {
    markDismissed(id);
    setOpen(false);
  };

  const shown = useRef(false);
  useEffect(() => {
    if (eligible && enabled) {
      rememberFeatureHint(id);
      shown.current = true;
      return;
    }
    if (shown.current) {
      /*
       * The gate that justified this card turned off after it was shown.
       * The moment has passed, so handing the card back when the gate
       * returns is the repeating card, not a second chance. A remount
       * with the gate unchanged does not come through here at all, which
       * is what `eligibleThisLoad` exists to protect.
       */
      markDismissed(id);
    }
  }, [eligible, enabled, id]);

  const show = eligible && enabled && open;

  return (
    <CornerCard
      layout="inline"
      open={show}
      onClose={close}
      label={title ?? body}
      dismissLabel={t("featureHint.dismiss")}
      dataAttribute={id}
      title={title}
      body={body}
      footer={
        <Button
          size="sm"
          className="cta-lift min-w-[7.5rem] rounded-full px-4"
          disabled={actionBusy}
          onClick={() => {
            if (!onAction) {
              close();
              return;
            }
            void Promise.resolve(onAction()).then(close, () => {});
          }}
        >
          {actionLabel ?? t("featureHint.gotIt")}
        </Button>
      }
    />
  );
}
