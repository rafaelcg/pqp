import { z } from "zod";
import { safeTextSchema } from "./api.js";

/**
 * Product feedback — the box in settings, not the moderation queue.
 *
 * A report is about a person or a message and routes to moderators; feedback
 * is about the product and routes to the operator. Keeping them separate means
 * neither queue buries the other, and the feedback form never needs the
 * report form's "who are you accusing" machinery.
 */
export const FEEDBACK_KINDS = ["bug", "idea", "other"] as const;
export type FeedbackKind = (typeof FEEDBACK_KINDS)[number];

export const FEEDBACK_BODY_MAX_LENGTH = 2000;

export const createFeedbackSchema = z.object({
  kind: z.enum(FEEDBACK_KINDS),
  body: z
    .string()
    .trim()
    .min(1)
    .max(FEEDBACK_BODY_MAX_LENGTH)
    .pipe(safeTextSchema),
});
export type CreateFeedbackRequest = z.infer<typeof createFeedbackSchema>;

/**
 * `confirmed` is the fun one: it marks a bug report as a real catch, and
 * confirming it is what grants the reporter the caça-bugs badge. `closed` is
 * everything else — handled, duplicate, not actionable.
 */
export const FEEDBACK_STATUSES = ["open", "confirmed", "closed"] as const;
export const feedbackStatusSchema = z.enum(FEEDBACK_STATUSES);
export type FeedbackStatus = z.infer<typeof feedbackStatusSchema>;

export const resolveFeedbackSchema = z.object({
  status: z.enum(["confirmed", "closed"]),
});
export type ResolveFeedbackRequest = z.infer<typeof resolveFeedbackSchema>;

/**
 * What the operator sees. `userId`/`username` are nullable because the row
 * outlives the account — feedback about a deleted-account bug is still
 * feedback.
 */
export const feedbackItemSchema = z.object({
  id: z.string(),
  userId: z.string().uuid().nullable(),
  username: z.string().nullable(),
  kind: z.enum(FEEDBACK_KINDS),
  body: z.string(),
  status: feedbackStatusSchema,
  createdAt: z.string(),
});
export type FeedbackItem = z.infer<typeof feedbackItemSchema>;

export const FEEDBACK_PAGE_SIZE = 25;
export const FEEDBACK_PAGE_MAX = 100;

/**
 * The badge a confirmed bug earns, as it travels on the public profile.
 * The key is stable and locale-free; the display name is the same proper noun
 * in both of this product's languages, like the brand itself.
 */
export const CACA_BUGS_BADGE = "caca-bugs";

export {
  TURMA_1000_BADGE,
  TURMA_1000_SIZE,
  profileAchievementSchema,
  type ProfileAchievement,
} from "./badges.js";
