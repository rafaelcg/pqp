import { z } from "zod";
import { safeTextSchema } from "./api.js";
import { TIMEOUT_MAX_MINUTES, TIMEOUT_MIN_MINUTES } from "./sanctions.js";

/**
 * User- and message-reporting: the path a member takes when the thing that
 * happened to them is somebody else's job to act on.
 *
 * Deliberately a small, closed set of reasons rather than free text alone. A
 * category is what a moderator filters and counts by; the free-text box exists
 * to add what the category cannot say, not to replace it. `other` is last so
 * the list can grow without renumbering anything a client already knows.
 */
export const REPORT_REASONS = [
  "spam",
  "harassment",
  "hate_speech",
  "violence",
  "sexual_content",
  "self_harm",
  "illegal_content",
  "other",
] as const;

export const reportReasonSchema = z.enum(REPORT_REASONS);
export type ReportReason = z.infer<typeof reportReasonSchema>;

/**
 * What a report is about.
 *
 * `server` reports a whole community from the directory — the room, its name
 * and its stated purpose, rather than any one thing said in it. It exists
 * because a public directory is the one surface where the *listing* is the
 * problem: "Eu odeio acordar cedo" is a joke and a valid community, and the
 * anti-`nordestino` communities that got Orkut's operators criminally charged
 * were the same shape with a different name. Reporting the person who posted a
 * message inside is no remedy when nobody has posted anything.
 */
export const reportSubjectTypeSchema = z.enum(["message", "user", "server"]);
export type ReportSubjectType = z.infer<typeof reportSubjectTypeSchema>;

/**
 * Where a report is routed, decided by the server from the reported thing and
 * never by the client.
 *
 * `server` is the only value a server owner or admin can ever see. `dm` and
 * `group` name a conversation, which has no owner and therefore no server
 * moderator — those go to the instance queue instead. `none` is a user report
 * filed with no context at all (from a profile rather than from a place).
 *
 * This mirrors `channels.kind` on purpose: the whole permission story is that
 * the routing of a report is a fact about the row, derived once at write time,
 * rather than a filter a later query has to remember to apply.
 */
export const reportContextKindSchema = z.enum(["server", "dm", "group", "none"]);
export type ReportContextKind = z.infer<typeof reportContextKindSchema>;

export const reportStatusSchema = z.enum(["open", "actioned", "dismissed"]);
export type ReportStatus = z.infer<typeof reportStatusSchema>;

/** Resolution is the only status a moderator may write; nothing reopens. */
export const reportResolutionSchema = z.enum(["actioned", "dismissed"]);
export type ReportResolution = z.infer<typeof reportResolutionSchema>;

export const REPORT_DETAILS_MAX_LENGTH = 1000;
export const REPORT_NOTE_MAX_LENGTH = 1000;

export const REPORT_PAGE_SIZE = 25;
export const REPORT_PAGE_MAX = 100;

/**
 * Length first, then the control-character refinement — `safeTextSchema` is a
 * `ZodEffects`, which has no `.max()`, so the two compose in this order and not
 * the other. Same shape as `messageSearchQuerySchema`'s `.pipe(safeTextSchema)`.
 */
const detailsSchema = z
  .string()
  .max(REPORT_DETAILS_MAX_LENGTH)
  .pipe(safeTextSchema)
  .nullable()
  .optional();

/**
 * A discriminated union rather than one object with two optional ids: the two
 * subjects need different context, and "exactly one of these is set" is a rule
 * worth having the parser enforce instead of the handler.
 *
 * A user report may carry a `serverId` — "this person, in this place" — which
 * is what routes it to that server's moderators. It is validated against the
 * reporter's own membership before it is trusted; a client cannot file into a
 * server it is not in, and cannot file about somebody who is not there either.
 * With no `serverId` the report has no server and goes to the instance queue.
 *
 * A message report carries no context at all. The channel, and therefore the
 * server or the conversation, is read from the message itself — a client that
 * could name the destination could aim a report at the wrong moderators.
 *
 * A `server` report names the community and nothing else. It is accepted only
 * for a server that is actually listed in the directory, and it is routed to
 * the INSTANCE queue rather than to that server's own moderators — see
 * `resolveServerSubject`. Filing one does not require membership: the whole
 * point is that you saw the listing and did not want to go inside.
 */
export const createReportSchema = z.discriminatedUnion("subjectType", [
  z.object({
    subjectType: z.literal("message"),
    messageId: z.string().uuid(),
    reason: reportReasonSchema,
    details: detailsSchema,
  }),
  z.object({
    subjectType: z.literal("user"),
    userId: z.string().uuid(),
    serverId: z.string().uuid().nullable().optional(),
    reason: reportReasonSchema,
    details: detailsSchema,
  }),
  z.object({
    subjectType: z.literal("server"),
    serverId: z.string().uuid(),
    reason: reportReasonSchema,
    details: detailsSchema,
  }),
]);
export type CreateReportRequest = z.infer<typeof createReportSchema>;

export const resolveReportSchema = z.object({
  status: reportResolutionSchema,
  note: z
    .string()
    .max(REPORT_NOTE_MAX_LENGTH)
    .pipe(safeTextSchema)
    .nullable()
    .optional(),
  /**
   * Time the reported member out, in the same action that closes the report.
   *
   * Two things happen to every actionable report: it gets closed, and somebody
   * gets sanctioned. Making those two separate trips — close the queue entry,
   * then find the person in the members panel, then remember what the report
   * said — is how the second one stops happening on a busy day. The note the
   * moderator already typed becomes the timeout's reason, so the sanction
   * carries its justification without asking for it twice.
   *
   * Only meaningful for a report with a server behind it and a reported user
   * still on the instance; the route refuses it otherwise rather than closing
   * the report and silently skipping the sanction. Absent means "just close
   * it", which stays the default and the only thing a `dismissed` resolution
   * may do.
   */
  timeoutMinutes: z
    .number()
    .int()
    .min(TIMEOUT_MIN_MINUTES)
    .max(TIMEOUT_MAX_MINUTES)
    .nullable()
    .optional(),
});
export type ResolveReportRequest = z.infer<typeof resolveReportSchema>;

/**
 * What a moderator sees. Every identity field is nullable because the row is
 * built to outlive the things it points at — see the `reports` table comment
 * for why a deleted message must not take the report about it with it.
 */
export const reportSchema = z.object({
  /** A BIGSERIAL, so a bare id is also the pagination cursor. */
  id: z.string(),
  subjectType: reportSubjectTypeSchema,
  contextKind: reportContextKindSchema,
  reason: reportReasonSchema,
  details: z.string().nullable(),
  status: reportStatusSchema,
  createdAt: z.string(),

  reporterId: z.string().uuid().nullable(),
  reporterName: z.string().nullable(),

  /**
   * The account behind the subject. For a `server` report that is the
   * community's OWNER — the person answering for the listing — so the queue
   * names somebody rather than only a room.
   *
   * It is deliberately NOT sanctionable through `resolveReportSchema`'s
   * `timeoutMinutes`: a community report has no `serverId`, and that route
   * already refuses a timeout on a report with no server behind it. The remedy
   * for a bad community is `is_community_suspended` — an operator's UPDATE, not
   * a timeout — because timing the owner out of their own server changes
   * nothing about the listing strangers are still walking into.
   */
  reportedUserId: z.string().uuid().nullable(),
  /**
   * Snapshot of the subject, taken at report time: a user's name and tag, or —
   * for a `server` report — the community's own name, which is the string a
   * moderator is actually judging.
   */
  reportedUserName: z.string().nullable(),

  /** Null once the message has been deleted; `contentSnapshot` survives it. */
  messageId: z.string().uuid().nullable(),
  /** True when a message report's message is gone — the snapshot is all there is. */
  messageDeleted: z.boolean(),
  /** The reported message body, copied at report time. */
  contentSnapshot: z.string().nullable(),
  channelId: z.string().uuid().nullable(),
  /** Snapshot of the channel name, so a renamed or deleted channel still reads. */
  channelName: z.string().nullable(),

  resolvedAt: z.string().nullable(),
  resolvedByName: z.string().nullable(),
  resolutionNote: z.string().nullable(),
});
export type Report = z.infer<typeof reportSchema>;

/**
 * What the person who filed it sees.
 *
 * Deliberately narrower than `reportSchema`: no moderator name, no other
 * reporter, no snapshot of anyone else's content. Filing a report must not
 * become a way to learn who reviewed it — that is how a reporter ends up
 * confronting a moderator, and it is not information the reporter needs to
 * know whether they were heard.
 */
export const reportSummarySchema = z.object({
  id: z.string(),
  subjectType: reportSubjectTypeSchema,
  reason: reportReasonSchema,
  status: reportStatusSchema,
  createdAt: z.string(),
  resolvedAt: z.string().nullable(),
  reportedUserName: z.string().nullable(),
});
export type ReportSummary = z.infer<typeof reportSummarySchema>;

export const reportPageSchema = z.object({
  reports: z.array(reportSchema),
  hasMore: z.boolean(),
});
export type ReportPage = z.infer<typeof reportPageSchema>;

export const reportSummaryPageSchema = z.object({
  reports: z.array(reportSummarySchema),
  hasMore: z.boolean(),
});
export type ReportSummaryPage = z.infer<typeof reportSummaryPageSchema>;

/** Human labels, kept beside the enum so a new reason cannot ship without one. */
export const REPORT_REASON_LABELS: Record<ReportReason, string> = {
  spam: "Spam or scam",
  harassment: "Harassment or bullying",
  hate_speech: "Hate speech",
  violence: "Violence or threats",
  sexual_content: "Unwanted sexual content",
  self_harm: "Self-harm or suicide",
  illegal_content: "Illegal content",
  other: "Something else",
};
