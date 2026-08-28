import { z } from "zod";

/**
 * Numbered founding mark. Issued once, to the first
 * {@link TURMA_1000_SIZE} human accounts, then never again.
 * The slug is locale-free; the display name is the same proper noun
 * in both languages.
 *
 * Lives here (not in `feedback.ts`) so `publicProfileSchema` can reuse the
 * shape without a cycle: `feedback.ts` imports `api.ts`, which imports
 * `profiles.ts`.
 */
export const TURMA_1000_BADGE = "turma-1000";
export const TURMA_1000_SIZE = 1000;

export const profileAchievementSchema = z.object({
  badge: z.string(),
  name: z.string(),
  /**
   * Signup-order number for `turma-1000`. Null on every other badge,
   * and on a payload from a server that predates the column.
   */
  ordinal: z.number().int().positive().nullable().optional().default(null),
});
export type ProfileAchievement = z.infer<typeof profileAchievementSchema>;
