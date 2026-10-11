import { getPool } from "../db.js";
import { deleteObject, isStorageConfigured, presignGet } from "../lib/s3.js";
import {
  contentScanProvider,
  isContentScanConfigured,
  quarantineDays,
  SCAN_URL_TTL_SECONDS,
  scanAllowsAttachment,
  scanImage,
  scanReportReason,
  type ScanResult,
  type ScanStatus,
} from "./content-scan.js";
import { createAutomatedInstanceReport } from "./reports.js";

/**
 * Image scanning for Baú (Community Home) media.
 *
 * The same scanner, the same policy and the same fail-closed rule as chat
 * attachments (`verifyPendingAttachments` in `attachments.ts`, and
 * `docs/CONTENT_SAFETY.md`). Only the place differs, and for the same three
 * reasons the chat scan sits where it does:
 *
 * 1. It runs on `POST .../home/media/claim`, which has no transaction open.
 * 2. The upload has never been visible. Nothing can put an upload on a post
 *    until the claim sets `verified_at` (`claimUploadOntoPost` refuses one
 *    without it), so a refused image never reaches a feed, a draft, a cover or
 *    a phone cut. Every Baú file, the cover of a video included, goes through
 *    that one claim.
 * 3. "The check said no" is already a defined outcome there: the claim answers
 *    "Upload could not be verified", exactly as it does for a failed HEAD, and
 *    the unverified row is left for the orphan sweep.
 *
 * Two differences from chat, both on purpose:
 *
 * - A finding goes to the INSTANCE queue, never to the server's own. Only
 *   Manage Server can upload here, so the uploader is somebody who reads that
 *   server's queue. See `createAutomatedInstanceReport`.
 * - The bytes judged are pinned. Before an image is scanned the claim copies
 *   it to a key nobody holds a PUT URL for (`pinCommunityHomeUpload`), so it
 *   cannot be swapped after the scan, which chat attachments still can
 *   (residual risk 9 in the safety doc).
 * - An upload is judged once. A verdict on an image is always a verdict on a
 *   pinned key, so a re-claim of a row that already passed (or was flagged,
 *   or skipped as a non-image) does not call the provider again: those bytes
 *   cannot have changed, and a repeated claim would otherwise be a way to
 *   spend the scanner's quota. An `error` is not a verdict, so it is scanned
 *   again; a quarantined row is refused before this is reached.
 */

/** Verdicts that already settled this upload; a re-claim does not re-scan. */
const SETTLED: ReadonlySet<ScanStatus> = new Set(["pass", "flagged", "skipped"]);

export interface CommunityHomeScanTarget {
  id: string;
  serverId: string;
  uploaderId: string;
  storageKey: string;
  /** What the bytes are (the sniffed type for an image), not the file name. */
  contentType: string;
  /** The row's verdict so far. */
  scanStatus: ScanStatus;
}

/**
 * Scan one Baú upload and act on the verdict. Returns whether the upload may
 * be marked verified (and so go onto a post).
 *
 * Never throws: the verdict is recorded and escalated best-effort, and only
 * `scanAllowsAttachment` decides, so a moderation-queue hiccup cannot fail a
 * claim and a broken scanner cannot pass one (under the default fail mode).
 */
export async function checkCommunityHomeUpload(
  target: CommunityHomeScanTarget,
): Promise<boolean> {
  if (SETTLED.has(target.scanStatus)) {
    return true;
  }
  if (!isContentScanConfigured()) {
    // Off: the row keeps `unscanned`, which is the honest statement that
    // nobody looked, and the upload goes through, as a chat attachment does.
    return true;
  }

  let result: ScanResult;
  try {
    result = await scanImage({
      imageUrl: presignGet(target.storageKey, {
        ttlSeconds: SCAN_URL_TTL_SECONDS,
      }),
      contentType: target.contentType,
    });
  } catch (error) {
    // `scanImage` never throws; signing the URL can. Same answer as a
    // provider that could not be reached.
    console.error(`[content-safety] could not scan Baú upload ${target.id}:`, error);
    result = {
      status: "error",
      provider: contentScanProvider(),
      score: null,
      labels: ["scan_error:unsigned"],
      illegal: false,
    };
  }

  await recordWithRetry(target, result);
  await escalateCommunityHomeScan(target, result);

  return scanAllowsAttachment(result);
}

/**
 * `recordCommunityHomeScan`, tried three times. A rejection that is never
 * written is a row without `quarantined_at`, which the orphan sweep deletes an
 * hour later together with the evidence, so a transient database error is
 * worth two more attempts. If all three fail the claim is still refused (the
 * caller does not wait on this to decide) and the loud line below is the
 * operator's only record; it names the key so the object can be kept by hand.
 */
async function recordWithRetry(
  target: CommunityHomeScanTarget,
  result: ScanResult,
): Promise<void> {
  let lastError: unknown = null;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      await recordCommunityHomeScan(target.id, result);
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 100 * (attempt + 1)));
    }
  }
  console.error(
    `[content-safety] VERDICT NOT RECORDED for Baú upload ${target.id} ` +
      `(${result.status}, key ${target.storageKey}). A rejected object here ` +
      `is not quarantined and the orphan sweep will delete it.`,
    lastError,
  );
}

/**
 * Write the verdict on the upload row, and quarantine it if it was refused.
 * `quarantined_at` is what keeps the orphan sweep off it; see the schema.
 */
async function recordCommunityHomeScan(
  uploadId: string,
  result: ScanResult,
): Promise<void> {
  if (result.status === "unscanned") {
    return;
  }
  await getPool().query(
    `UPDATE community_home_media_uploads
        SET scan_status = $2, scan_provider = $3, scan_score = $4,
            scan_labels = $5::jsonb, scanned_at = NOW(),
            quarantined_at = CASE WHEN $6 THEN NOW() ELSE quarantined_at END
      WHERE id = $1`,
    [
      uploadId,
      result.status,
      result.provider,
      result.score,
      JSON.stringify(result.labels),
      result.status === "rejected",
    ],
  );
}

/**
 * The log line and the report, for a rejection or a flag. Errors are logged and
 * swallowed: a queue write must not be able to fail the claim.
 */
async function escalateCommunityHomeScan(
  target: CommunityHomeScanTarget,
  result: ScanResult,
): Promise<void> {
  if (result.status !== "rejected" && result.status !== "flagged") {
    return;
  }

  // The same shouty line as the chat path, so one log search finds both.
  // `docs/CONTENT_SAFETY.md` carries the runbook it points at.
  if (result.illegal) {
    console.error(
      `[content-safety] ILLEGAL-CONTENT MATCH — Baú upload ${target.id}, ` +
        `server ${target.serverId}, uploader ${target.uploaderId}, provider ` +
        `${result.provider}, labels ${result.labels.join(",")}. Object ` +
        `retained under quarantine and NOT deleted. See ` +
        `docs/CONTENT_SAFETY.md before touching it.`,
    );
  }

  try {
    const server = await getPool().query<{ name: string }>(
      `SELECT name FROM servers WHERE id = $1`,
      [target.serverId],
    );
    const serverName = server.rows[0]?.name ?? target.serverId;
    await createAutomatedInstanceReport({
      reportedUserId: target.uploaderId,
      placeLabel: `Baú · ${serverName}`,
      reason: scanReportReason(result.labels),
      // "Baú upload <uuid>" is the phrase `listAllReports` reads the evidence
      // back from; keep it.
      details:
        `Automated image scan (${result.provider}) returned ` +
        `${result.status} for Baú upload ${target.id} on server ` +
        `${target.serverId}: ${result.labels.join(", ") || "no labels"} ` +
        `(score ${result.score ?? "n/a"}). ` +
        (result.status === "rejected"
          ? "The file was refused and never posted; it is held in quarantine."
          : "The file was allowed and is visible on any post that carries it."),
    });
  } catch (error) {
    console.error(
      `[content-safety] could not file a report for Baú upload ${target.id}:`,
      error,
    );
  }
}

/**
 * Expire quarantined Baú uploads, the twin of `sweepQuarantinedAttachments`:
 * an ordinary rejection goes after CONTENT_SCAN_QUARANTINE_DAYS, and a row
 * labelled `illegal` or `csam_suspected` is NEVER swept, at any age. Read that
 * function's comment for why.
 *
 * Skipped without storage: every Baú row has an object behind it, and dropping
 * the row while the object stays would leak the object with nothing left that
 * names it.
 */
export async function sweepQuarantinedCommunityHomeMedia(): Promise<number> {
  if (!isStorageConfigured()) {
    return 0;
  }
  const expired = await getPool().query<{ id: string; storage_key: string }>(
    `SELECT id, storage_key FROM community_home_media_uploads
      WHERE quarantined_at IS NOT NULL
        AND quarantined_at < NOW() - ($1 || ' days')::interval
        AND NOT COALESCE(scan_labels @> '["illegal"]'::jsonb, FALSE)
        AND NOT COALESCE(scan_labels @> '["csam_suspected"]'::jsonb, FALSE)
      ORDER BY quarantined_at ASC
      LIMIT 100`,
    [quarantineDays()],
  );
  if (expired.rows.length === 0) {
    return 0;
  }
  // Only rows whose object is really gone are dropped. A failed delete keeps
  // its row, and with it the key, for the next sweep to try again.
  const gone = await Promise.all(
    expired.rows.map((row) =>
      deleteObject(row.storage_key).then(
        () => row.id,
        (error: unknown) => {
          console.error(
            `[content-safety] could not delete quarantined Baú object ${row.storage_key}, will retry:`,
            error instanceof Error ? error.message : error,
          );
          return null;
        },
      ),
    ),
  );
  const ids = gone.filter((id): id is string => id !== null);
  if (ids.length === 0) {
    return 0;
  }
  const deleted = await getPool().query(
    `DELETE FROM community_home_media_uploads WHERE id = ANY($1::uuid[])`,
    [ids],
  );
  return deleted.rowCount ?? 0;
}
