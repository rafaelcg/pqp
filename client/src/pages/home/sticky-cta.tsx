import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import { useLocation } from "react-router-dom";
import { useTranslation } from "@/lib/i18n";
import { useUpdateOffered } from "@/lib/update-prompt-state";
import { cn } from "@/lib/utils";
import { JoinButton } from "./shared/auth-buttons";
import { PIN_MEDIA, useMediaQuery } from "./cinema";
import { NOITE_CTAS_ID } from "./noite";
import { BTN_PRIMARY, CREATE_INTENT, useCta } from "./ui";

/** The hero's CTA row carries this id, so the bar knows when it has gone. */
export const HERO_CTAS_ID = "inicio-ctas";

/*
 * Whether the bar is up, for the header: below lg its create button steps
 * aside while the bar is shown, so one screen never offers two buttons for
 * one action. A module store rather than page state, so a toggle re-renders
 * the header and nothing else (the page holds the 1,300-line night).
 */
let barShown = false;
const barListeners = new Set<() => void>();

function publishBarShown(shown: boolean) {
  if (barShown === shown) return;
  barShown = shown;
  for (const listener of barListeners) listener();
}

function subscribeBarShown(listener: () => void) {
  barListeners.add(listener);
  return () => {
    barListeners.delete(listener);
  };
}

/** True while the sticky create bar is on screen (only ever below lg). */
export function useStickyCtaShown(): boolean {
  return useSyncExternalStore(
    subscribeBarShown,
    () => barShown,
    () => false,
  );
}

/** Places with their own create or import CTA: the bar steps aside there. */
const OWN_CTA_SECTIONS = [NOITE_CTAS_ID, "mudanca", "fim"] as const;

/**
 * Phones and tablets (below lg): one create button pinned to the bottom of the
 * screen once the hero's buttons have scrolled away. It steps aside wherever
 * the page already offers its own CTA (the night's closing pair, #mudanca,
 * #fim) and stays gone past #fim, so it never sits on the footer. Hidden, it
 * is inert: no taps, no Tab.
 */
export function StickyCta() {
  const { t } = useTranslation();
  const cta = useCta();
  const small = !useMediaQuery(PIN_MEDIA);
  // The review build's corner button (shared/preview-bar) sits bottom right;
  // the bar leaves it room only on /preview, the live page has none.
  const preview = useLocation().pathname.startsWith("/preview/");
  // While a new build is offered, the update indicator (a 36 px round button,
  // `StandaloneUpdateIndicator`, fixed bottom-4 left-4 above this bar) sits
  // bottom left. The bar leaves it the same room, read from the same signal
  // the indicator renders on, so the two never draw over each other.
  const updateCorner = useUpdateOffered();
  const barRef = useRef<HTMLDivElement>(null);
  const [shown, setShown] = useState(false);

  useEffect(() => {
    if (!small || typeof IntersectionObserver === "undefined") {
      setShown(false);
      return;
    }
    const hero = document.getElementById(HERO_CTAS_ID);
    if (!hero) return;
    const sections = OWN_CTA_SECTIONS.map((id) => document.getElementById(id)).filter(
      (el): el is HTMLElement => el !== null,
    );
    const fim = document.getElementById("fim");

    // Hidden until the first answers: the hero's buttons start on screen.
    let heroAhead = true;
    let fimReached = false;
    const onScreen = new Set<Element>();
    const update = () => setShown(!heroAhead && !fimReached && sections.every((s) => !onScreen.has(s)));

    // A jump (a nav link, End) can carry an element from below the screen to
    // above it without ever crossing it, which fires no plain observer. So
    // "still ahead" and "reached" are asked of the viewport stretched far
    // down and far up: those answers change at the screen's edge either way.
    const far = "1000000px";
    const ahead = new IntersectionObserver(
      ([e]) => {
        heroAhead = e.isIntersecting;
        update();
      },
      { rootMargin: `0px 0px ${far} 0px` },
    );
    const reached = new IntersectionObserver(
      ([e]) => {
        fimReached = e.isIntersecting;
        update();
      },
      { rootMargin: `${far} 0px 0px 0px` },
    );
    const visible = new IntersectionObserver((entries) => {
      for (const e of entries) {
        if (e.isIntersecting) onScreen.add(e.target);
        else onScreen.delete(e.target);
      }
      update();
    });
    ahead.observe(hero);
    if (fim) reached.observe(fim);
    for (const s of sections) visible.observe(s);
    return () => {
      ahead.disconnect();
      reached.disconnect();
      visible.disconnect();
    };
  }, [small]);

  // Tell the header; and when the bar goes away for good, say it is down.
  useEffect(() => {
    publishBarShown(shown);
  }, [shown]);
  useEffect(() => () => publishBarShown(false), []);

  // While the bar is up, a focused control is never scrolled in under it.
  useLayoutEffect(() => {
    const bar = barRef.current;
    if (!shown || !bar) return;
    const html = document.documentElement;
    const previous = html.style.scrollPaddingBottom;
    html.style.scrollPaddingBottom = `${bar.offsetHeight}px`;
    return () => {
      html.style.scrollPaddingBottom = previous;
    };
  }, [shown]);

  return (
    <aside
      aria-label={t("home.sticky.label")}
      ref={barRef}
      inert={!shown}
      className={cn(
        "pointer-events-none fixed inset-x-0 bottom-0 z-40 bg-gradient-to-t from-ink via-ink/85 to-transparent px-4 pb-[max(0.75rem,env(safe-area-inset-bottom))] pt-8 transition duration-300 ease-out motion-reduce:transition-none lg:hidden",
        preview && "pr-[4.5rem]",
        updateCorner && "pl-[4.5rem]",
        shown ? "translate-y-0 opacity-100" : "translate-y-4 opacity-0 motion-reduce:translate-y-0",
      )}
    >
      <JoinButton intent={CREATE_INTENT} className={cn(BTN_PRIMARY, "w-full", shown && "pointer-events-auto")}>
        {cta.create}
      </JoinButton>
    </aside>
  );
}
