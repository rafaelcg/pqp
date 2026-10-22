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
  /**
   * A minor in sexual content. Its own reason, and the one reason that
   * decides ROUTING: whatever the subject, a report with it goes to the
   * instance queue and never to a server's own staff (see `createReport`).
   * A server owner must not be the one holding, or closing, that accusation.
   */
  "minor_sexual",
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
 *
 * `story` reports one story (stories.ts). It is filed from the story viewer
 * with the audience it was seen through: a server's story goes to that
 * server's queue, a friends story to the instance queue (no server owns it,
 * exactly like a conversation). A reported story does not expire while the
 * report is open, and its bytes are held for 30 days after it is resolved.
 */
export const reportSubjectTypeSchema = z.enum(["message", "user", "server", "story"]);
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
  /**
   * `serverId` is the audience the reporter saw the story through, checked
   * against the story's own audiences and the reporter's membership. Null or
   * absent means the friends audience.
   */
  z.object({
    subjectType: z.literal("story"),
    storyId: z.string().uuid(),
    serverId: z.string().uuid().nullable().optional(),
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

// ------------------------------------------------------ reported attachments
//
// What a moderator may know about the files on a REPORTED message, and whether
// they may look at one. Metadata is always served; the bytes never are, except
// through `POST /api/reports/:id/attachments/:attachmentId/reveal`, one click
// at a time, and only behind the `report_attachment_preview` runtime flag.
// See docs/CONTENT_SAFETY.md, "What a moderator sees of a reported attachment".

/** What the file is, in the words a moderator uses. Never a guess from bytes. */
export const REPORT_ATTACHMENT_KINDS = ["image", "gif", "video", "file"] as const;
export const reportAttachmentKindSchema = z.enum(REPORT_ATTACHMENT_KINDS);
export type ReportAttachmentKind = z.infer<typeof reportAttachmentKindSchema>;

/**
 * Whether the card may offer a look, decided by the server so the client has
 * no rule to get wrong:
 *
 * - `available`   the reveal button may be drawn
 * - `off`         the `report_attachment_preview` flag is off
 * - `blocked`     a guardrail refuses it; `blockReason` says which
 * - `unsupported` not a still or animated picture we may fetch (video, any
 *                 other file, storage not configured)
 */
export const reportAttachmentPreviewSchema = z.enum([
  "available",
  "off",
  "blocked",
  "unsupported",
]);
export type ReportAttachmentPreview = z.infer<typeof reportAttachmentPreviewSchema>;

/**
 * Why a guardrail refuses. These are the cases the illegal-content runbook in
 * docs/CONTENT_SAFETY.md says never to open: a scanner verdict of flagged,
 * rejected or error; an `illegal` or `csam_suspected` label; a quarantined
 * object; and a message somebody reported as a minor in sexual content.
 */
export const REPORT_ATTACHMENT_BLOCK_REASONS = [
  "scan_status",
  "illegal_label",
  "quarantined",
  "minor_report",
] as const;
export const reportAttachmentBlockReasonSchema = z.enum(
  REPORT_ATTACHMENT_BLOCK_REASONS,
);
export type ReportAttachmentBlockReason = z.infer<
  typeof reportAttachmentBlockReasonSchema
>;

export const reportAttachmentSchema = z.object({
  id: z.string().uuid(),
  kind: reportAttachmentKindSchema,
  contentType: z.string(),
  /** The scanner's verdict, straight off the row. No new scanning. */
  scan: z.object({
    /** `unscanned` | `skipped` | `pass` | `flagged` | `rejected` | `error` */
    status: z.string(),
    provider: z.string().nullable(),
    score: z.number().nullable(),
    labels: z.array(z.string()),
  }),
  preview: reportAttachmentPreviewSchema,
  blockReason: reportAttachmentBlockReasonSchema.nullable(),
});
export type ReportAttachment = z.infer<typeof reportAttachmentSchema>;

/** The reveal's answer: a URL good for `expiresInSeconds`, never cached. */
export const reportAttachmentRevealSchema = z.object({
  url: z.string().url(),
  expiresInSeconds: z.number().int().positive(),
});
export type ReportAttachmentReveal = z.infer<typeof reportAttachmentRevealSchema>;

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
  /**
   * The files on the reported message as it stands now (metadata only, never
   * bytes). Empty for a message with none, a deleted message, and any subject
   * that is not a message.
   */
  attachments: z.array(reportAttachmentSchema).default([]),
  channelId: z.string().uuid().nullable(),
  /** Snapshot of the channel name, so a renamed or deleted channel still reads. */
  channelName: z.string().nullable(),
  /**
   * The reported story, for a `story` report; null once its row is gone (a
   * week after it expired, past every hold). `contentSnapshot` then carries
   * its caption or text as it was when reported.
   */
  storyId: z.string().uuid().nullable().default(null),

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

/**
 * Evidence from the attachment scanner, carried on an `AllReport` row only
 * when the report is automated (`reporterId === null`) and the server could
 * match it back to the attachment that produced it — see the "attachment
 * ([0-9a-f-]{36})" hint in `createAutomatedReport`'s `details` string.
 *
 * `stillAttached` is `false` for a rejected upload (never claimed, so there
 * is nothing to attach) and for a flagged one whose message has since been
 * deleted; `true` for a flagged upload that is still visible in a channel.
 */
export const reportScanInfoSchema = z.object({
  status: z.string(),
  score: z.number().nullable(),
  labels: z.array(z.string()),
  provider: z.string().nullable(),
  contentType: z.string().nullable(),
  stillAttached: z.boolean(),
});
export type ReportScanInfo = z.infer<typeof reportScanInfoSchema>;

/**
 * `reportSchema` plus what only an instance moderator reading EVERY queue at
 * once needs: which server (if any) the report belongs to, and the scan
 * evidence behind an automated one. A server-scoped report through
 * `listServerReports` carries neither — its reader already knows which
 * server they opened.
 */
export const allReportSchema = reportSchema.extend({
  serverId: z.string().uuid().nullable(),
  /** Snapshot-free: the server's current name, or null for the instance queue. */
  serverName: z.string().nullable(),
  scan: reportScanInfoSchema.nullable(),
});
export type AllReport = z.infer<typeof allReportSchema>;

export const allReportPageSchema = z.object({
  reports: z.array(allReportSchema),
  hasMore: z.boolean(),
});
export type AllReportPage = z.infer<typeof allReportPageSchema>;

/** Human labels, kept beside the enum so a new reason cannot ship without one. */
export const REPORT_REASON_LABELS: Record<ReportReason, string> = {
  spam: "Spam or scam",
  harassment: "Harassment or bullying",
  hate_speech: "Hate speech",
  violence: "Violence or threats",
  sexual_content: "Unwanted sexual content",
  self_harm: "Self-harm or suicide",
  illegal_content: "Illegal content",
  minor_sexual: "A minor in sexual content",
  other: "Something else",
};

// ------------------------------------------------------------ report context
//
// `GET /api/reports/:id/context`: what a moderator needs to JUDGE a report
// rather than only read it. A report about an account (`subjectType: "user"`)
// carries no message and no details, so the queue row alone says "the account
// X, reported by Y" and nothing else. This is the read behind the card's
// "Contexto" panel.
//
// Two lenses, decided by the server from who is asking, never by the client:
//
//   * `instance`: an instance moderator. Sees the account across the whole
//     instance, and the one DM thread the reporter shared by filing.
//   * `server`: a manager of the report's server. Sees ONLY what happened in
//     that server. Every field that reaches outside it is null or empty.
//
// Nothing here ever carries the content of a conversation between the
// reported user and a third party. Those are counts and timestamps.

export const reportContextLensSchema = z.enum(["instance", "server"]);
export type ReportContextLens = z.infer<typeof reportContextLensSchema>;

export const reportContextMessageSchema = z.object({
  id: z.string().uuid(),
  authorId: z.string().uuid(),
  authorName: z.string(),
  /** `name#1234`, for a tooltip. The name is never replaced by it. */
  authorTag: z.string().nullable(),
  /** Which side of the report wrote it, so the panel can chip the speaker. */
  party: z.enum(["reporter", "reported", "other"]),
  body: z.string(),
  createdAt: z.string(),
  /** A call record ("Missed call") rather than something typed. */
  isCall: z.boolean(),
});
export type ReportContextMessage = z.infer<typeof reportContextMessageSchema>;

export const reportContextServerMessageSchema = z.object({
  id: z.string().uuid(),
  serverId: z.string().uuid(),
  serverName: z.string(),
  channelName: z.string(),
  isPrivate: z.boolean(),
  body: z.string(),
  attachmentCount: z.number().int().nonnegative(),
  createdAt: z.string(),
});
export type ReportContextServerMessage = z.infer<
  typeof reportContextServerMessageSchema
>;

const contactCountSchema = z.object({
  total: z.number().int().nonnegative(),
  firstHour: z.number().int().nonnegative(),
  /** Newest first, capped. A timestamp per event; never a name. */
  times: z.array(z.string()),
});

export const reportContextSchema = z.object({
  reportId: z.string(),
  lens: reportContextLensSchema,

  /** Null when the reported account no longer exists (or the report names none). */
  account: z
    .object({
      id: z.string().uuid(),
      displayName: z.string(),
      tag: z.string().nullable(),
      avatarUrl: z.string().nullable(),
      createdAt: z.string(),
      /** Set once the account has started deleting itself. */
      deletionStartedAt: z.string().nullable(),
      /** Instance lens only. A country code from the last connection. */
      lastCountry: z.string().nullable(),
    })
    .nullable(),

  /**
   * Instance lens only (null for a server's staff): behaviour that spans the
   * instance. Counts and timestamps, never names and never content.
   *
   * `dmsStarted`: 1:1 conversations whose FIRST message is theirs, with
   * somebody who is not an accepted friend. `callsPlaced`: missed-call records
   * they left in such conversations. An ANSWERED call leaves no record, so
   * this undercounts by exactly the calls that worked.
   */
  signals: z
    .object({
      dmsStarted: contactCountSchema,
      callsPlaced: contactCountSchema,
      blockedByCount: z.number().int().nonnegative(),
      /** When the reporter blocked them, if they did. The reporter is a party. */
      reporterBlockedAt: z.string().nullable(),
    })
    .nullable(),

  otherReports: z.array(
    z.object({
      id: z.string(),
      status: reportStatusSchema,
      reason: reportReasonSchema,
      subjectType: reportSubjectTypeSchema,
      createdAt: z.string(),
      /** Null for a report in the instance queue. */
      serverName: z.string().nullable(),
    }),
  ),

  sanctions: z.object({
    bans: z.array(
      z.object({
        serverId: z.string().uuid(),
        serverName: z.string(),
        reason: z.string().nullable(),
        createdAt: z.string(),
      }),
    ),
    timeouts: z.array(
      z.object({
        serverId: z.string().uuid(),
        serverName: z.string(),
        reason: z.string().nullable(),
        expiresAt: z.string(),
        createdAt: z.string(),
      }),
    ),
  }),

  /**
   * Instance lens, human-filed report only: the last messages of the one
   * conversation between the reporter and the reported user, oldest first.
   * Null when there is none, or when the viewer is a server's staff.
   */
  conversation: z.array(reportContextMessageSchema).nullable(),

  /**
   * Whole-thread counts of TYPED messages (call records excluded) for that
   * same conversation, not just the 20 shown. "11 from the reporter, 0 from
   * the reported account" is the line that says a report may be in bad faith.
   */
  conversationCounts: z
    .object({
      fromReporter: z.number().int().nonnegative(),
      fromReported: z.number().int().nonnegative(),
      /** The newest 1000 messages were counted and the thread is longer. */
      capped: z.boolean(),
    })
    .nullable(),

  /**
   * Instance lens, human-filed report only: who filed it, to spot a serial
   * reporter. Counts every report they have filed on the instance.
   */
  reporter: z
    .object({
      displayName: z.string(),
      tag: z.string().nullable(),
      createdAt: z.string(),
      filed: z.number().int().nonnegative(),
      actioned: z.number().int().nonnegative(),
      dismissed: z.number().int().nonnegative(),
    })
    .nullable(),

  /**
   * Where a reported MESSAGE lives, whatever queue the report was routed to.
   * A `minor_sexual` report goes to the instance queue by design, with no
   * server on the row, but the message still belongs to one.
   */
  messageServer: z
    .object({
      id: z.string().uuid(),
      name: z.string(),
      channelName: z.string(),
    })
    .nullable(),

  /** Newest first. Every server for the instance lens, one for the server lens. */
  serverMessages: z.array(reportContextServerMessageSchema),

  ownedServers: z.array(
    z.object({
      id: z.string().uuid(),
      name: z.string(),
      memberCount: z.number().int().nonnegative(),
      createdAt: z.string(),
    }),
  ),

  /**
   * A message report's neighbours in its channel: up to five on each side,
   * oldest first. `withheld` says why there are none, so the panel can say so
   * rather than look broken: a group conversation has third parties in it.
   */
  surrounding: z
    .object({
      /** The reported message itself, in its place between the two lists. */
      reported: reportContextMessageSchema.nullable(),
      before: z.array(reportContextMessageSchema),
      after: z.array(reportContextMessageSchema),
      withheld: z.enum(["group", "no_access"]).nullable(),
    })
    .nullable(),

  /** What this viewer may do about the reported account, from the card. */
  actions: z.object({
    /** Instance lens: `DELETE /api/admin/users/:id`. There is no softer instance ban. */
    canTerminate: z.boolean(),
    /** The report's own server, when it has one and the account is in play. */
    server: z
      .object({
        id: z.string().uuid(),
        name: z.string(),
        canBan: z.boolean(),
        canTimeout: z.boolean(),
        /** Already banned there: the ban button is not offered. */
        alreadyBanned: z.boolean(),
      })
      .nullable(),
  }),
});
export type ReportContext = z.infer<typeof reportContextSchema>;
