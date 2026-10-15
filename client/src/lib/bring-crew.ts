import type { BringCrewPhase, DiscordImportArrivals } from "@pqp/shared";

/**
 * "Traz tua galera": what the owner's strip says, if anything.
 *
 * The server decides the phase (`bringCrewPhase` in `@pqp/shared`); this
 * only adds the one thing the server cannot know, which is that this person
 * closed the strip on this browser. Closing it during the first day hides
 * the counter, and the reminder still comes once a day later if few people
 * arrived. Closing the reminder is final for that server.
 *
 * Furniture, not a show-once hint: written on dismiss, on every host, the
 * same way the download strip is (`docs/ONBOARDING.md`), so it does not go
 * through `lib/hints.ts`.
 */

export type BringCrewStripKind = "empty" | "arrived" | "reminder";

export interface BringCrewStripState {
  kind: BringCrewStripKind;
  count: number;
}

export function bringCrewStrip(
  arrivals: DiscordImportArrivals | null,
  dismissed: BringCrewPhase | null,
): BringCrewStripState | null {
  if (!arrivals?.enabled || !arrivals.phase || arrivals.phase === "over") {
    return null;
  }
  if (dismissed === "reminder" || dismissed === arrivals.phase) {
    return null;
  }
  const count = arrivals.arrived;
  if (arrivals.phase === "reminder") {
    return { kind: "reminder", count };
  }
  return { kind: count === 0 ? "empty" : "arrived", count };
}

/**
 * Whether the import's last screen may tell the owner to paste the
 * announcement. It is drawn only once the invite exists, so while the invite
 * mint is being retried the title and body must be the plain import ones:
 * an instruction that points at nothing is worse than none.
 */
export function showsCrewAnnouncement(done: {
  bringCrew: boolean;
  invite: unknown | null;
}): boolean {
  return done.bringCrew && done.invite != null;
}

const KEY_PREFIX = "pqp:bring-crew-dismissed:";

function storage(): Storage | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

export function readBringCrewDismissed(serverId: string): BringCrewPhase | null {
  try {
    const value = storage()?.getItem(KEY_PREFIX + serverId);
    return value === "fresh" || value === "reminder" ? value : null;
  } catch {
    return null;
  }
}

export function writeBringCrewDismissed(
  serverId: string,
  phase: BringCrewPhase,
): void {
  try {
    storage()?.setItem(KEY_PREFIX + serverId, phase);
  } catch {
    // Private mode or full storage: the strip comes back next load.
  }
}
