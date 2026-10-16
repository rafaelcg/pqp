import { Lock, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useNotInServerCount } from "@/lib/forward";
import { useTranslation } from "@/lib/i18n";
import { cn } from "@/lib/utils";

const SHOW_MS = 4_000;
const LEAVE_MS = 200;

/**
 * "Tu não participa desse servidor": what tapping a forward card from a server
 * you are not in says, instead of doing nothing. Same corner card as the other
 * action toasts, its motion classes stand down under `prefers-reduced-motion`.
 */
export function NotInServerToast() {
  const { t } = useTranslation();
  const count = useNotInServerCount();
  const seen = useRef(count);
  const [state, setState] = useState<"hidden" | "in" | "out">("hidden");

  useEffect(() => {
    if (count === seen.current) {
      return;
    }
    seen.current = count;
    setState("in");
    const leave = window.setTimeout(() => setState("out"), SHOW_MS);
    return () => window.clearTimeout(leave);
  }, [count]);

  useEffect(() => {
    if (state !== "out") {
      return;
    }
    const timer = window.setTimeout(() => setState("hidden"), LEAVE_MS);
    return () => window.clearTimeout(timer);
  }, [state]);

  if (state === "hidden") {
    return null;
  }
  return (
    <div
      role="status"
      aria-live="polite"
      data-not-in-server-toast=""
      className={cn(
        "elevation-3 pointer-events-auto fixed inset-x-3 bottom-[calc(env(safe-area-inset-bottom)+72px)] z-40 flex items-center gap-3 rounded-[var(--radius-card)] p-3 sm:inset-x-auto sm:bottom-auto sm:right-4 sm:top-[max(1rem,env(safe-area-inset-top))] sm:w-80",
        state === "out" ? "animate-toast-out" : "animate-toast-in",
      )}
    >
      <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-surface-3 text-text-secondary">
        <Lock className="h-4 w-4" aria-hidden />
      </span>
      <p className="min-w-0 flex-1 text-sm font-semibold text-text">
        {t("forward.notInServer")}
      </p>
      <button
        type="button"
        aria-label={t("dmToast.dismiss")}
        className="flex h-7 w-7 shrink-0 items-center justify-center rounded-[var(--radius-control)] text-text-tertiary hover:bg-surface-2 hover:text-text"
        onClick={() => setState("out")}
      >
        <X className="h-4 w-4" aria-hidden />
      </button>
    </div>
  );
}
