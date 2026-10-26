import { Check, X } from "lucide-react";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import type { ForwardedSummary } from "@/components/forward/forward-picker";
import { useTranslation } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import { TOAST_CLOSE, TOAST_SURFACE } from "@/components/ui/toast";

/** Long enough to read and reach "Ver"; the work is already done. */
const SHOW_MS = 8_000;
const LEAVE_MS = 200;

/**
 * "Encaminhado para #geral · Ver". One card, top right like the other action
 * toasts, gone after eight seconds or on X. "Ver" opens the first place the
 * forward went. The motion classes are the app's own, which stand down under
 * `prefers-reduced-motion`.
 */
export function ForwardedToast({
  summary,
  onView,
  onDismiss,
}: {
  summary: (ForwardedSummary & { key: number }) | null;
  onView: (summary: ForwardedSummary) => void;
  onDismiss: () => void;
}) {
  const { t } = useTranslation();
  const [leaving, setLeaving] = useState(false);
  const key = summary?.key ?? null;

  useEffect(() => {
    setLeaving(false);
    if (key === null) {
      return;
    }
    const timer = window.setTimeout(() => setLeaving(true), SHOW_MS);
    return () => window.clearTimeout(timer);
  }, [key]);

  useEffect(() => {
    if (!leaving) {
      return;
    }
    const timer = window.setTimeout(onDismiss, LEAVE_MS);
    return () => window.clearTimeout(timer);
  }, [leaving, onDismiss]);

  if (!summary) {
    return null;
  }
  const { first, count } = summary;
  const where =
    first.kind === "channel"
      ? `#${first.label}${first.serverName ? ` · ${first.serverName}` : ""}`
      : first.label;
  return (
    <div
      role="status"
      aria-live="polite"
      data-forwarded-toast=""
      className={cn(
        TOAST_SURFACE,
        "pointer-events-auto fixed inset-x-3 bottom-[calc(env(safe-area-inset-bottom)+72px)] z-40 flex items-center gap-3 p-3 sm:inset-x-auto sm:bottom-auto sm:right-4 sm:top-[max(1rem,env(safe-area-inset-top))] sm:w-80",
        leaving ? "animate-toast-out" : "animate-toast-in",
      )}
    >
      <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-accent text-on-accent">
        <Check className="h-4 w-4" strokeWidth={3} aria-hidden />
      </span>
      <p className="min-w-0 flex-1 text-sm font-semibold text-text">
        {count > 1
          ? t("forward.toast.many", { places: count })
          : t("forward.toast.one", { where })}
      </p>
      <Button
        size="sm"
        data-forwarded-toast-view=""
        onClick={() => {
          onView(summary);
          setLeaving(true);
        }}
      >
        {t("forward.toast.view")}
      </Button>
      <button
        type="button"
        aria-label={t("dmToast.dismiss")}
        className={cn(TOAST_CLOSE, "self-start")}
        onClick={() => setLeaving(true)}
      >
        <X className="h-4 w-4" aria-hidden />
      </button>
    </div>
  );
}
