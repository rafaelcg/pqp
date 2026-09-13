/**
 * "Seu mic está mudo: ninguém te ouve, nem na transmissão."
 *
 * A recording on 2026-09-13 lost the host's voice for an hour: her mic
 * stayed muted while she presented, and the only hint anywhere in the app
 * was the small "Mic mutado" pill in the bar, one glance among many during a
 * live show. This is the rule for when that fact earns an unmissable,
 * persistent warning instead of a pill a host can look straight past.
 *
 * PRESENTING AND MUTED, exactly. Muted while NOT presenting is the ordinary
 * "listening, not talking" state every voice call has and is not this
 * warning's business. Presenting and UNMUTED is the fine state everyone is
 * aiming for. Only the intersection is the failure this exists to catch: a
 * screen on stage with no voice behind it, which is invisible from both the
 * host's own speakers (they hear the film fine) and the room's WebRTC (the
 * room hears whatever the host's mic is actually doing, which is nothing).
 *
 * Reused in three places, all fed by this one rule so they cannot drift
 * apart: the persistent bar warning (`watch-party-panel.tsx`), the
 * outgoing-audio silence warning it is folded into when both are true at
 * once (`watch-party-transmission.tsx`, postmortem B2), and the go-live
 * checklist's mic row (`watch-party-go-live-checklist.ts`, postmortem B3).
 */
export type PresenterMicWarning = "warn" | "none";

export function presenterMicWarning(
  isPresenting: boolean,
  isMuted: boolean,
): PresenterMicWarning {
  return isPresenting && isMuted ? "warn" : "none";
}

/**
 * The room hears nothing from this mic, whether that is because it is
 * muted or because it was never in the call at all (Farol, 2026-09-13):
 * `micState` distinguishes "off" from "muted" for the bar's own pill, but
 * every caller of `presenterMicWarning` and the go-live checklist's mic row
 * asks the coarser question this warning exists for — can the room hear
 * this person — and "off" answers it exactly like "muted" does. Feeding
 * only `=== "muted"` into either left an OFF mic reading as fine on the
 * checklist and silent on the persistent banner, the same failure this
 * module was written to catch.
 */
export function micIsInaudible(
  micState: "off" | "muted" | "room" | "everyone" | undefined,
): boolean {
  return micState === "muted" || micState === "off";
}
