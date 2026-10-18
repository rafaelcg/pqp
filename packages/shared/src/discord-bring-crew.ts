import { z } from "zod";

/**
 * "Traz tua galera": the half of a Discord import that brings the people.
 *
 * Copying a Discord layout is the easy half, and the data says it already
 * works (about four imports a day in Sept/Oct 2026). What does not happen on
 * its own is the group following: in the 30 days to 2026-10-10, of the
 * imported servers at least a week old, 40% had one person or nobody arrive
 * in their first week, 1 in 86 got past ten, and 22% still had a message in
 * their second week. So after an import the owner gets a ready announcement
 * for the old Discord, then a counter of who arrived, then one nudge a day
 * later if few did. See `docs/DISCORD_IMPORT.md` §"Bring your people".
 *
 * The rules live here so the server, which decides, and any client, which
 * draws, cannot disagree about when the nudge is due.
 */

/** How long after an import the owner's counter strip stays up. */
export const BRING_CREW_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

/** When the strip turns into the reminder, if few people came. */
export const BRING_CREW_REMIND_AFTER_MS = 24 * 60 * 60 * 1000;

/**
 * "Few people". Below this many arrivals a day after the import, the strip
 * reminds. The median imported server got two or three people in its first
 * week; three is where a room starts to have a conversation in it.
 */
export const BRING_CREW_REMIND_BELOW = 3;

/**
 * - `fresh`: the first day, or later with enough people: the counter.
 * - `reminder`: a day or more in and fewer than `BRING_CREW_REMIND_BELOW`
 *   arrived: one gentle nudge to paste the announcement again.
 * - `over`: the window closed; nothing is drawn.
 */
export type BringCrewPhase = "fresh" | "reminder" | "over";

export function bringCrewPhase(
  importedAtMs: number,
  nowMs: number,
  arrived: number,
): BringCrewPhase {
  const age = nowMs - importedAtMs;
  if (age >= BRING_CREW_WINDOW_MS) {
    return "over";
  }
  if (age >= BRING_CREW_REMIND_AFTER_MS && arrived < BRING_CREW_REMIND_BELOW) {
    return "reminder";
  }
  return "fresh";
}

/**
 * `GET /api/servers/:serverId/import-arrivals`, for somebody who may manage
 * the server. `importedAt` and `phase` are null for a server that was not
 * made by a Discord import, and everything is empty while the flag is off.
 */
export const discordImportArrivalsSchema = z.object({
  /** `discord_bring_crew` for this server. Off: draw nothing. */
  enabled: z.boolean(),
  importedAt: z.string().nullable(),
  phase: z.enum(["fresh", "reminder", "over"]).nullable(),
  /** People (never the owner, a bot or a character) who joined since. */
  arrived: z.number().int().nonnegative(),
  /** Of those, how many came through the import's own `?ref=discord` link. */
  viaLink: z.number().int().nonnegative(),
  /**
   * The invite the import made: no expiry and no use cap, so an announcement
   * pinned in the old Discord keeps working. Null if it was revoked.
   */
  inviteCode: z.string().nullable(),
  /**
   * Whether this server was made by a Discord import, answered only while
   * `discord_import_notice` is on (absent otherwise, and from an API that
   * predates it). It is independent of `enabled`: the notice that invites
   * people to import must know a server already came from one even when the
   * bring-your-crew strip is off. Read `=== false` to mean "not imported".
   */
  imported: z.boolean().optional(),
});

export type DiscordImportArrivals = z.infer<typeof discordImportArrivalsSchema>;
