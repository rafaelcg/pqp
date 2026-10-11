import { X } from "lucide-react";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { StatusDot } from "@/components/user/status-dot";
import { useTranslation } from "@/lib/i18n";
import {
  dismissRetroFoundCard,
  toggleRetroLook,
  useRetroState,
} from "@/lib/retro-look";
import { friendOnlineSynth, messageSynth } from "@/lib/retro-sounds";
import { playSynthSound, setSynthCueOverride } from "@/lib/sounds";

/**
 * Everything Modo 2005 adds that is not a restyle: its sounds and the
 * discovery card, in the bottom-right corner. Its stylesheet arrives with the
 * same lazy chunk. Mounted by the app shell only while the look is on.
 */
export default function RetroLayer() {
  const retro = useRetroState();

  useEffect(() => {
    if (!retro.sounds) {
      return;
    }
    setSynthCueOverride("message", messageSynth);
    return () => setSynthCueOverride("message", null);
  }, [retro.sounds]);

  return (
    <RetroCorner>
      {retro.foundCardPending && <FoundCard sounds={retro.sounds} />}
    </RetroCorner>
  );
}

/**
 * Bottom right, above whichever onboarding corner card is up, so the one
 * corner rule in docs/ONBOARDING.md holds.
 */
export function RetroCorner({ children }: { children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const root = document.documentElement;
    // The onboarding card comes and goes on its own schedule; a slow poll is
    // cheaper than watching every mutation of a chat app's DOM.
    const measureCard = () => {
      const card = document.querySelector("[data-corner-card]");
      const offset = card ? Math.round(card.getBoundingClientRect().height) + 8 : 0;
      root.style.setProperty("--retro-corner-offset", `${offset}px`);
    };
    measureCard();
    const timer = window.setInterval(measureCard, 1000);
    // Anything else in this corner (the DM cards) stacks above our own cards.
    const stack = ref.current;
    const observer =
      stack && typeof ResizeObserver !== "undefined"
        ? new ResizeObserver(() => {
            const height = Math.round(stack.getBoundingClientRect().height);
            root.style.setProperty(
              "--retro-stack-h",
              height > 0 ? `${height + 8}px` : "0px",
            );
          })
        : null;
    if (stack && observer) {
      observer.observe(stack);
    }
    return () => {
      window.clearInterval(timer);
      observer?.disconnect();
      root.style.removeProperty("--retro-corner-offset");
      root.style.removeProperty("--retro-stack-h");
    };
  }, []);
  return (
    <div ref={ref} className="retro-corner">
      {children}
    </div>
  );
}

function FoundCard({ sounds }: { sounds: boolean }) {
  const { t } = useTranslation();
  const chimed = useRef(false);
  useEffect(() => {
    if (sounds && !chimed.current) {
      chimed.current = true;
      playSynthSound(friendOnlineSynth);
    }
  }, [sounds]);
  const [leaving, leave] = useLeaving(dismissRetroFoundCard);
  return (
    <div
      className="retro-card w-[min(22rem,calc(100vw-2rem))]"
      role="status"
      data-enter=""
      data-leave={leaving ? "" : undefined}
      data-retro-found=""
    >
      <div className="retro-card-bar">
        <span>pqp</span>
        <button type="button" aria-label={t("retro.toast.close")} onClick={leave}>
          <X className="h-3 w-3" aria-hidden />
        </button>
      </div>
      <div className="retro-card-body">
        <StatusDot status="online" size="md" label="" className="h-6 w-6" />
        <div className="min-w-0">
          <p className="text-sm font-bold">{t("retro.found.title")}</p>
          <p className="mt-0.5 text-xs text-text-secondary">{t("retro.found.body")}</p>
        </div>
      </div>
      <div className="retro-card-actions">
        <button
          type="button"
          className="retro-button"
          onClick={() => void toggleRetroLook()}
        >
          {t("retro.found.undo")}
        </button>
        <button type="button" className="retro-button" onClick={leave}>
          {t("retro.found.ok")}
        </button>
      </div>
    </div>
  );
}

const LEAVE_MS = 350;

/** A card that slides back down before it goes (instantly under reduced motion). */
export function useLeaving(onGone: () => void): [boolean, () => void] {
  const [leaving, setLeaving] = useState(false);
  const gone = useRef(onGone);
  gone.current = onGone;
  const leave = useCallback(() => {
    let reduced = false;
    try {
      reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    } catch {
      reduced = true;
    }
    if (reduced) {
      gone.current();
      return;
    }
    setLeaving(true);
    window.setTimeout(() => gone.current(), LEAVE_MS);
  }, []);
  return [leaving, leave];
}
