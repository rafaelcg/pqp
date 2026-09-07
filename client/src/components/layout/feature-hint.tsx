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
 * One coachmark. Same CornerCard frame as the corner queue, laid out next to
 * the control it names. `lib/hints.ts` is the store; App is the queue.
 */
export function FeatureHint({
  id,
  enabled,
  title,
  body,
}: {
  id: FeatureHintId;
  enabled: boolean;
  title?: string;
  body: string;
}) {
  const { t } = useTranslation();
  const [eligible] = useState(
    () => !isAutomatedBrowser() && !isFeatureHintSeen(id),
  );
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
          className="cta-lift rounded-full px-4"
          onClick={() => setOpen(false)}
        >
          {t("featureHint.gotIt")}
        </Button>
      }
    />
  );
}
