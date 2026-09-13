import { useState } from "react";
import { CornerCard } from "@/components/layout/corner-card";
import { Button } from "@/components/ui/button";
import { useTranslation } from "@/lib/i18n";

/**
 * The one-time "Voz limpa" nudge: try advanced, RNNoise-based noise
 * suppression (`client/src/lib/noise-suppression.ts`). RNNoise itself is
 * never named here — see `docs/NOISE_SUPPRESSION.md` and the Settings
 * description, the one place it may appear in parentheses.
 *
 * Same shell as every other hint (`CornerCard`, `docs/ONBOARDING.md`), but
 * `layout="inline"` and mounted above the user bar rather than in the
 * bottom-right corner. It still rides the corner queue
 * (`lib/corner-hints.ts`, id `"voiceClean"`) so it can never be on screen at
 * the same time as another card; `enabled` is that queue's verdict, already
 * folding in every eligibility rule (`lib/voice-clean.ts`,
 * `shouldOfferVoiceCleanNudge`), so this component only animates and reports
 * which of the two buttons was pressed.
 */
export function VoiceCleanHint({
  enabled,
  onActivate,
  onDismiss,
}: {
  enabled: boolean;
  /** "Ativar": turn advanced suppression on and show the confirmation toast. */
  onActivate: () => void;
  /** "Depois", the X, or Escape — all three are "not now". */
  onDismiss: () => void;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(true);
  const show = enabled && open;

  function dismiss() {
    setOpen(false);
    onDismiss();
  }

  function activate() {
    setOpen(false);
    onActivate();
  }

  return (
    <CornerCard
      layout="inline"
      open={show}
      onClose={dismiss}
      label={t("voiceClean.hint.title")}
      dismissLabel={t("voiceClean.hint.dismiss")}
      dataAttribute="voice-clean"
      title={
        <span className="inline-flex flex-wrap items-center gap-2">
          {t("voiceClean.hint.title")}
          <span className="shrink-0 rounded-full bg-accent/15 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-accent">
            {t("voiceClean.badge")}
          </span>
        </span>
      }
      body={t("voiceClean.hint.body")}
      footer={
        <div className="flex gap-2">
          <Button
            size="sm"
            className="cta-lift rounded-full px-4"
            onClick={activate}
          >
            {t("voiceClean.hint.activate")}
          </Button>
          <Button
            size="sm"
            variant="secondary"
            className="rounded-full px-4"
            onClick={dismiss}
          >
            {t("voiceClean.hint.later")}
          </Button>
        </div>
      }
    />
  );
}

/**
 * "Voz limpa ativada", for a couple of seconds where the nudge just was.
 * Not a `CornerCard` — nothing to dismiss, nothing to queue against, it
 * clears itself. `App` mounts it in the same slot the nudge occupied.
 */
export function VoiceCleanActivatedToast({ show }: { show: boolean }) {
  const { t } = useTranslation();
  if (!show) {
    return null;
  }
  return (
    <div
      role="status"
      data-voice-clean-activated-toast=""
      className="relative z-30 w-[min(100%,17rem)] animate-pop-in rounded-2xl border border-ink-4 bg-ink-2 px-4 py-2.5 text-sm text-paper shadow-[var(--shadow-popover)]"
    >
      {t("voiceClean.hint.activatedToast")}
    </div>
  );
}
