import {
  isImageContentType,
  type Report,
  type ReportAttachment,
  type ReportAttachmentBlockReason,
  type ReportAttachmentKind,
  type ReportAttachmentPreview,
} from "@pqp/shared";
import { getPool } from "../db.js";
import { isEnabled } from "../lib/flags.js";
import { isStorageConfigured, presignGet } from "../lib/s3.js";

/**
 * The files on a REPORTED message, as a moderator may know them.
 *
 * Two jobs, and the line between them is the point of this file:
 *
 * 1. METADATA, always (`withAttachments`): kind, content type and the scanner's
 *    own verdict, read off the `message_attachments` row. No bytes, no URL, no
 *    new scanning, and not behind the `report_attachment_preview` flag. It is
 *    the part that is useful when the preview is off, and the part that tells a
 *    moderator why a preview is NOT offered.
 *
 * 2. ONE LOOK, on request (`revealReportAttachment`): a 60 second signed URL
 *    for a picture, only when the flag is on and no guardrail refuses.
 *
 * THE GUARDRAILS are `docs/CONTENT_SAFETY.md`'s runbook turned into a
 * predicate, because "do not open the file" cannot depend on a moderator
 * remembering it at the moment they are curious. `guardrail` is the one place
 * that decides, and the list payload and the reveal route both call it, so the
 * card never offers what the route would refuse and the route never trusts the
 * card. It is deliberately a refusal list and not an allow list over
 * `scan_status`: `unscanned` and `skipped` (no scanner configured, or a type the
 * scanner does not read) are honest "nobody has looked" states a moderator is
 * entitled to resolve by looking, and the card prints the status so they know.
 */

/** How long a revealed URL lives. The card re-blurs about when it dies. */
export const REVEAL_URL_TTL_SECONDS = 60;

/**
 * How long after a report is resolved its attachments may still be looked at.
 * The same 30 days a reported story is held for (`story-media.ts`): an appeal
 * or a second look comes after the close, not before it.
 */
export const REVEAL_RESOLVED_WINDOW_DAYS = 30;

export function reportAttachmentPreviewEnabled(): boolean {
  return isEnabled("report_attachment_preview");
}

interface AttachmentRow {
  id: string;
  message_id: string;
  content_type: string;
  storage_key: string | null;
  remote_url: string | null;
  scan_status: string;
  scan_provider: string | null;
  scan_score: number | null;
  scan_labels: string[] | null;
  quarantined_at: Date | null;
  /** Some report on this same message is about a minor in sexual content. */
  minor_reported: boolean;
}

const ATTACHMENT_COLUMNS = `
  a.id::text AS id, a.message_id::text AS message_id, a.content_type,
  a.storage_key, a.remote_url, a.scan_status, a.scan_provider, a.scan_score,
  a.scan_labels, a.quarantined_at,
  EXISTS (
    SELECT 1 FROM reports rr
    WHERE rr.reported_message_id = a.message_id AND rr.reason = 'minor_sexual'
  ) AS minor_reported`;

export function attachmentKind(contentType: string): ReportAttachmentKind {
  const type = contentType.trim().toLowerCase();
  if (type === "image/gif") {
    return "gif";
  }
  if (type.startsWith("image/")) {
    return "image";
  }
  if (type.startsWith("video/")) {
    return "video";
  }
  return "file";
}

/**
 * Why this object must not be opened, or null. Order is severity, so the card
 * names the gravest reason when several hold.
 */
export function guardrail(
  row: Pick<
    AttachmentRow,
    "scan_status" | "scan_labels" | "quarantined_at" | "minor_reported"
  >,
): ReportAttachmentBlockReason | null {
  const labels = row.scan_labels ?? [];
  if (labels.includes("illegal") || labels.includes("csam_suspected")) {
    return "illegal_label";
  }
  if (row.quarantined_at) {
    return "quarantined";
  }
  if (
    row.scan_status === "flagged" ||
    row.scan_status === "rejected" ||
    row.scan_status === "error"
  ) {
    return "scan_status";
  }
  if (row.minor_reported) {
    return "minor_report";
  }
  return null;
}

/** What the card may offer for one row, and why not. */
export function previewDecision(
  row: AttachmentRow,
  flagOn: boolean,
  storageOn: boolean,
): { preview: ReportAttachmentPreview; blockReason: ReportAttachmentBlockReason | null } {
  // Only a still or animated picture is ever shown. Video and every other file
  // are metadata only, whatever the scanner said. `isImageContentType` is the
  // inline-image allowlist (png, jpeg, gif, webp, avif); an SVG is not on it.
  if (!isImageContentType(row.content_type)) {
    return { preview: "unsupported", blockReason: null };
  }
  // Bytes we hold need storage to sign; a remote GIF is already a public URL.
  if (!row.remote_url && (!row.storage_key || !storageOn)) {
    return { preview: "unsupported", blockReason: null };
  }
  const blocked = guardrail(row);
  if (blocked) {
    return { preview: "blocked", blockReason: blocked };
  }
  return { preview: flagOn ? "available" : "off", blockReason: null };
}

function toReportAttachment(
  row: AttachmentRow,
  flagOn: boolean,
  storageOn: boolean,
): ReportAttachment {
  return {
    id: row.id,
    kind: attachmentKind(row.content_type),
    contentType: row.content_type,
    scan: {
      status: row.scan_status,
      provider: row.scan_provider,
      score: row.scan_score,
      labels: row.scan_labels ?? [],
    },
    ...previewDecision(row, flagOn, storageOn),
  };
}

/**
 * Fill `attachments` on a page of reports. ONLY the reported message's own
 * files: the join key is the report's `messageId` and nothing else, so a
 * neighbour in the same channel, or another message by the same author, cannot
 * be reached from here. A deleted message has no `messageId` left and its
 * attachment rows are orphaned for the sweeper, so a report on a deleted
 * message shows none.
 */
export async function withAttachments<R extends Report>(
  reports: R[],
): Promise<R[]> {
  const messageIds = [
    ...new Set(
      reports
        .filter((r) => r.subjectType === "message" && r.messageId)
        .map((r) => r.messageId as string),
    ),
  ];
  if (messageIds.length === 0) {
    return reports;
  }
  const result = await getPool().query<AttachmentRow>(
    `SELECT ${ATTACHMENT_COLUMNS}
     FROM message_attachments a
     WHERE a.message_id = ANY($1::uuid[])
     ORDER BY a.message_id, a.position, a.created_at, a.id`,
    [messageIds],
  );
  const flagOn = reportAttachmentPreviewEnabled();
  const storageOn = isStorageConfigured();
  const byMessage = new Map<string, ReportAttachment[]>();
  for (const row of result.rows) {
    const list = byMessage.get(row.message_id) ?? [];
    list.push(toReportAttachment(row, flagOn, storageOn));
    byMessage.set(row.message_id, list);
  }
  return reports.map((r) => ({
    ...r,
    attachments: r.messageId ? (byMessage.get(r.messageId) ?? []) : [],
  }));
}

export type RevealOutcome =
  | { ok: true; url: string; expiresInSeconds: number }
  | { ok: false; reason: "not_found" }
  | { ok: false; reason: "unsupported" }
  | { ok: false; reason: "blocked"; blockReason: ReportAttachmentBlockReason };

/**
 * A signed URL for one attachment of the reported message, or the refusal.
 *
 * The row is read AGAIN here, by attachment id AND the report's message id, and
 * the guardrails are asked against that fresh row: nothing the list payload
 * said earlier is trusted, because a verdict can land between the list and the
 * click, and an attachment id from another message must read as "not found".
 */
export async function revealReportAttachment(input: {
  messageId: string;
  attachmentId: string;
}): Promise<RevealOutcome> {
  const result = await getPool().query<AttachmentRow>(
    `SELECT ${ATTACHMENT_COLUMNS}
     FROM message_attachments a
     WHERE a.id = $1::uuid AND a.message_id = $2::uuid`,
    [input.attachmentId, input.messageId],
  );
  const row = result.rows[0];
  if (!row) {
    return { ok: false, reason: "not_found" };
  }
  // The flag is the caller's gate; here it is passed as ON so a refusal reads
  // as `unsupported` or `blocked` and never as `off`.
  const decision = previewDecision(row, true, isStorageConfigured());
  if (decision.preview === "unsupported") {
    return { ok: false, reason: "unsupported" };
  }
  if (decision.preview === "blocked") {
    return { ok: false, reason: "blocked", blockReason: decision.blockReason! };
  }
  const url = row.remote_url
    ? row.remote_url
    : presignGet(row.storage_key!, {
        ttlSeconds: REVEAL_URL_TTL_SECONDS,
        // A moderator's copy must not be kept by a shared cache on the way.
        cacheControl: "no-store",
      });
  return { ok: true, url, expiresInSeconds: REVEAL_URL_TTL_SECONDS };
}
