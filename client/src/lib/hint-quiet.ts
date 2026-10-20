import { useEffect, useSyncExternalStore, useState } from "react";
import {
  getAppSessionsSnapshot,
  isSeated,
  useAppSessions,
  type AppSessionsSnapshot,
} from "@/lib/apps/app-sessions-store";

/**
 * QUIET CONTEXTS (`hint_budget`, global, default OFF).
 *
 * The audit's worst moments were not too many hints in total but hints at
 * the wrong time: Voz limpa two seconds after the mic opened, then three
 * coach marks over a live call, and a Halloween card on top of a running
 * game. With the flag on, an UNSOLICITED hint waits while the person is busy:
 *
 *  - voice is connected (any call, DM or server);
 *  - an app session they sit in is running (a game, Locadora);
 *  - they are sharing a screen, watching one, or watching a live party;
 *  - the message composer has focus or holds a draft;
 *  - a modal dialog is open.
 *
 * WAIT, NOT NEVER. Nothing here writes a stamp. A card that was held back
 * recorded no impression (a corner card records on the render where it is
 * `enabled`), so when the context ends the same queue answers the same way
 * it would have a minute earlier and the card shows then. An attached coach
 * mark that is up when a context starts is HELD, not spent: the queue keeps
 * its winner and tells the provider it is yielding, exactly as it does for a
 * corner card (`FeatureHintProvider`'s `yielding`).
 *
 * NEVER QUIET, because the person needs them or asked for them: real
 * failures (mic fallback, audio health, a stale chunk, sanctions), the update
 * indicator, event notifications (DMs, reminders, toasts about events), the
 * arrival banner, and the consent-needing voice note transcription notice.
 * Those do not go through the winner functions at all, except two corner ids
 * that ARE events and are listed in `QUIET_EXEMPT_CORNER_IDS`
 * (`lib/corner-hints.ts`).
 *
 * Answered by `GET /api/onboarding/config` as `hintBudget`
 * (`lib/hint-config.ts`). Anything but an explicit `true` is off.
 */

export type HintQuietReason =
  | "call"
  | "app"
  | "share"
  | "party"
  | "composer"
  | "dialog";

export interface HintQuietFacts {
  /** Voice is not idle: connecting, connected, reconnecting. */
  inCall: boolean;
  /** This person sits in a live app or game session. */
  appRunning: boolean;
  /** They are presenting a screen, or somebody else's share is on their stage. */
  sharing: boolean;
  /** The open channel's watch party is live. */
  partyLive: boolean;
  /** The composer has focus, or what is typed in it is not empty. */
  composerBusy: boolean;
  /** A modal dialog is on screen. */
  dialogOpen: boolean;
}

export function hintQuietReasons(facts: HintQuietFacts): HintQuietReason[] {
  const reasons: HintQuietReason[] = [];
  if (facts.inCall) reasons.push("call");
  if (facts.appRunning) reasons.push("app");
  if (facts.sharing) reasons.push("share");
  if (facts.partyLive) reasons.push("party");
  if (facts.composerBusy) reasons.push("composer");
  if (facts.dialogOpen) reasons.push("dialog");
  return reasons;
}

/**
 * The one answer both queues read. `settled` false (the two hint switches
 * have not been read yet) holds everything; with the budget flag off the
 * contexts are not consulted at all, so nothing but that first moment can
 * hold a hint.
 */
export function hintsAreQuiet(input: {
  settled: boolean;
  budgetOn: boolean;
  facts: HintQuietFacts;
}): { quiet: boolean; reasons: HintQuietReason[] } {
  const reasons = input.budgetOn ? hintQuietReasons(input.facts) : [];
  return { quiet: !input.settled || reasons.length > 0, reasons };
}

// ------------------------------------------------------------- the flag

let budgetOn = false;
const budgetListeners = new Set<() => void>();

export function setHintBudget(on: boolean): void {
  if (on === budgetOn) {
    return;
  }
  budgetOn = on;
  for (const listener of [...budgetListeners]) {
    listener();
  }
}

export function isHintBudgetOn(): boolean {
  return budgetOn;
}

/** Anything but an explicit `true` is off: an older API sends no field. */
export function hintBudgetFromConfig(answer: { hintBudget?: unknown }): boolean {
  return answer.hintBudget === true;
}

export function useHintBudget(): boolean {
  return useSyncExternalStore(
    (listener) => {
      budgetListeners.add(listener);
      return () => {
        budgetListeners.delete(listener);
      };
    },
    isHintBudgetOn,
    () => false,
  );
}

// ------------------------------------------------- the composer, as a fact

/**
 * Every message composer on screen (the channel's, a thread's) reports here
 * under its own token: `focused` while the textarea has focus, `draft` while
 * it holds text. App cannot see either, because the composer owns its value.
 */
const composerState = new Map<symbol, { focused: boolean; draft: boolean }>();
let composerBusySnapshot = false;
const composerListeners = new Set<() => void>();

function recomputeComposerBusy(): void {
  let busy = false;
  for (const entry of composerState.values()) {
    if (entry.focused || entry.draft) {
      busy = true;
      break;
    }
  }
  if (busy === composerBusySnapshot) {
    return;
  }
  composerBusySnapshot = busy;
  for (const listener of [...composerListeners]) {
    listener();
  }
}

/** A composer mounted. Returns what it calls to report and to go away. */
export function registerComposerActivity(): {
  report: (next: { focused?: boolean; draft?: boolean }) => void;
  release: () => void;
} {
  const token = Symbol("composer");
  composerState.set(token, { focused: false, draft: false });
  return {
    report: (next) => {
      const current = composerState.get(token);
      if (!current) {
        return;
      }
      composerState.set(token, {
        focused: next.focused ?? current.focused,
        draft: next.draft ?? current.draft,
      });
      recomputeComposerBusy();
    },
    release: () => {
      composerState.delete(token);
      recomputeComposerBusy();
    },
  };
}

export function isComposerBusy(): boolean {
  return composerBusySnapshot;
}

export function useComposerBusy(): boolean {
  return useSyncExternalStore(
    (listener) => {
      composerListeners.add(listener);
      return () => {
        composerListeners.delete(listener);
      };
    },
    isComposerBusy,
    () => false,
  );
}

/** Test seam. */
export function resetHintQuietForTests(): void {
  budgetOn = false;
  budgetListeners.clear();
  composerState.clear();
  composerBusySnapshot = false;
  composerListeners.clear();
}

// ----------------------------------------------------------- the dialogs

/** The one marker every modal in the app carries (`ui/dialog.tsx`, the lightbox, the story viewer). */
export const MODAL_SELECTOR = '[aria-modal="true"]';

export function isModalDialogOpen(
  root: Pick<Document, "querySelector"> | null = typeof document === "undefined"
    ? null
    : document,
): boolean {
  try {
    return Boolean(root?.querySelector(MODAL_SELECTOR));
  } catch {
    return false;
  }
}

/**
 * Whether a modal is on screen. Watches the DOM only while `enabled`, so with
 * the budget flag off no observer exists at all.
 */
export function useModalDialogOpen(enabled: boolean): boolean {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!enabled || typeof document === "undefined") {
      setOpen(false);
      return;
    }
    let frame = 0;
    const check = () => {
      frame = 0;
      setOpen(isModalDialogOpen());
    };
    check();
    const observer = new MutationObserver(() => {
      // Coalesced to one read per frame: a transcript streaming in mutates the
      // DOM constantly and the question only changes when a dialog mounts.
      if (frame === 0) {
        frame = window.requestAnimationFrame(check);
      }
    });
    observer.observe(document.body, { childList: true, subtree: true });
    return () => {
      observer.disconnect();
      if (frame !== 0) {
        window.cancelAnimationFrame(frame);
      }
    };
  }, [enabled]);
  return enabled && open;
}

// ------------------------------------------------------------- apps

/** Seated, as a player or a spectator, in any live app session. */
export function viewerSeatedInAnApp(state: AppSessionsSnapshot): boolean {
  const viewer = state.viewerId;
  if (viewer === null) {
    return false;
  }
  for (const session of state.live.values()) {
    if (isSeated(session, viewer)) {
      return true;
    }
  }
  return false;
}

export function useAppRunning(): boolean {
  return useAppSessions(viewerSeatedInAnApp);
}

/** Without React, for tests. */
export function appRunningNow(): boolean {
  return viewerSeatedInAnApp(getAppSessionsSnapshot());
}

// --------------------------------------------------------------- the hook

/**
 * What App cannot read from its own state: the composer, the dialogs and the
 * app sessions. Called near the top of App with its other hooks (the queue is
 * computed past an early return, and a hook there would not run every render).
 */
export function useHintQuietSources(): {
  budgetOn: boolean;
  composerBusy: boolean;
  dialogOpen: boolean;
  appRunning: boolean;
} {
  const budgetOn = useHintBudget();
  return {
    budgetOn,
    composerBusy: useComposerBusy(),
    dialogOpen: useModalDialogOpen(budgetOn),
    appRunning: useAppRunning(),
  };
}
