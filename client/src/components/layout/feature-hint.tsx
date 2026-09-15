import {
  createContext,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from "react";
import { CornerCard } from "@/components/layout/corner-card";
import { Button } from "@/components/ui/button";
import {
  isFeatureHintSeen,
  rememberFeatureHint,
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
  onAction?: () => void;
  actionBusy?: boolean;
}) {
  const { t } = useTranslation();
  const [eligible] = useState(() => takeEligibility(id));
  const [open, setOpen] = useState(true);

  useEffect(() => {
    if (eligible && enabled) {
      rememberFeatureHint(id);
    }
  }, [eligible, enabled, id]);

  const show = eligible && enabled && open;

  return (
    <CornerCard
      layout="inline"
      open={show}
      onClose={() => setOpen(false)}
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
            if (onAction) {
              onAction();
              return;
            }
            setOpen(false);
          }}
        >
          {actionLabel ?? t("featureHint.gotIt")}
        </Button>
      }
    />
  );
}
