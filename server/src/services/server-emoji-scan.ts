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
} from "./content-scan.js";
import { createAutomatedInstanceReport } from "./reports.js";

/**
 * Image scanning for custom server emoji.
 *
 * The Baú claim's rules (`community-home-scan.ts`), applied to the emoji claim:
 *
 * - It runs on `POST /api/servers/:id/emoji`, before the row exists, so a
 *   refused image is never served: the image route only answers for a row.
 * - The bytes judged are pinned. The claim copies the upload to a key nobody
 *   holds a PUT URL for (`pinServerEmojiUpload` in `server-emoji.ts`) and
 *   scans the copy, so it cannot be swapped after the scan.
 * - A finding goes to the INSTANCE queue. Only Manage Emoji can upload emoji,
 *   a staff bit, so the uploader may well read that server's own queue.
 * - A refusal answers exactly like a failed verification, as Baú does, so the
 *   claim does not tell an uploader which images the scanner catches.
 *
 * With no provider configured this is a no-op and the emoji is `unscanned`.
 */

export const UNSCANNED_RESULT: ScanResult = {
  status: "unscanned",
  provider: null,
  score: null,
  labels: [],
  illegal: false,
};

export interface ServerEmojiScanTarget {
  serverId: string;
  uploaderId: string;
  name: string;
  /** The pinned key, never the one the uploader can still PUT to. */
  storageKey: string;
  contentType: string;
}

export type ServerEmojiScanOutcome =
  | { allowed: true; result: ScanResult }
  /** `retained` means the object is evidence now and must not be discarded. */
  | { allowed: false; retained: boolean };

/** Never throws. */
export async function checkServerEmojiUpload(
  target: ServerEmojiScanTarget,
): Promise<ServerEmojiScanOutcome> {
  if (!isContentScanConfigured()) {
    return { allowed: true, result: UNSCANNED_RESULT };
  }

  let result: ScanResult;
  try {
    result = await scanImage({
      imageUrl: presignGet(target.storageKey, { ttlSeconds: SCAN_URL_TTL_SECONDS }),
      contentType: target.contentType,
    });
  } catch (error) {
    // `scanImage` never throws; signing the URL can.
    console.error(
      `[content-safety] could not scan emoji upload ${target.storageKey}:`,
      error,
    );
    result = {
      status: "error",
      provider: contentScanProvider(),
      score: null,
      labels: ["scan_error:unsigned"],
      illegal: false,
    };
  }

  if (result.status === "rejected") {
    await quarantineWithRetry(target, result);
    await escalateServerEmojiScan(target, result);
    return { allowed: false, retained: true };
  }
  if (!scanAllowsAttachment(result)) {
    return { allowed: false, retained: false };
  }
  return { allowed: true, result };
}

async function quarantineWithRetry(
  target: ServerEmojiScanTarget,
  result: ScanResult,
): Promise<void> {
  let lastError: unknown = null;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      await getPool().query(
        `INSERT INTO server_emoji_quarantine
           (server_id, uploader_id, name, storage_key, scan_provider, scan_score, scan_labels)
         VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)
         ON CONFLICT (storage_key) DO NOTHING`,
        [
          target.serverId,
          target.uploaderId,
          target.name,
          target.storageKey,
          result.provider,
          result.score,
          JSON.stringify(result.labels),
        ],
      );
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 100 * (attempt + 1)));
    }
  }
  // The object is still kept: nothing sweeps an emoji key no row names, so
  // this line is how an operator finds it.
  console.error(
    `[content-safety] QUARANTINE NOT RECORDED for emoji upload ${target.storageKey} ` +
      `(server ${target.serverId}). The object was kept; the claim was refused.`,
    lastError,
  );
}

/**
 * The log line and the instance report, for a rejection or a flag. Errors are
 * logged and swallowed: a queue write must not decide the claim.
 */
export async function escalateServerEmojiScan(
  target: ServerEmojiScanTarget,
  result: ScanResult,
  emojiId?: string,
): Promise<void> {
  if (result.status !== "rejected" && result.status !== "flagged") {
    return;
  }

  if (result.illegal) {
    console.error(
      `[content-safety] ILLEGAL-CONTENT MATCH — emoji upload ${target.storageKey}, ` +
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
      placeLabel: `Emoji · ${serverName}`,
      reason: scanReportReason(result.labels),
      details:
        `Automated image scan (${result.provider}) returned ${result.status} ` +
        `for custom emoji :${target.name}: on server ${target.serverId} ` +
        `(object ${target.storageKey}` +
        (emojiId ? `, emoji ${emojiId}` : "") +
        `): ${result.labels.join(", ") || "no labels"} ` +
        `(score ${result.score ?? "n/a"}). ` +
        (result.status === "rejected"
          ? "The emoji was refused and never added; the image is held in quarantine."
          : "The emoji was added and shows in every message that uses it."),
    });
  } catch (error) {
    console.error(
      `[content-safety] could not file a report for emoji upload ${target.storageKey}:`,
      error,
    );
  }
}

/**
 * Expire quarantined emoji uploads after CONTENT_SCAN_QUARANTINE_DAYS. A row
 * labelled `illegal` or `csam_suspected` is never swept, at any age, the same
 * rule as `sweepQuarantinedCommunityHomeMedia`.
 */
export async function sweepQuarantinedServerEmoji(): Promise<number> {
  if (!isStorageConfigured()) {
    return 0;
  }
  const expired = await getPool().query<{ id: string; storage_key: string }>(
    `SELECT id, storage_key FROM server_emoji_quarantine
      WHERE quarantined_at < NOW() - ($1 || ' days')::interval
        AND NOT COALESCE(scan_labels @> '["illegal"]'::jsonb, FALSE)
        AND NOT COALESCE(scan_labels @> '["csam_suspected"]'::jsonb, FALSE)
      ORDER BY quarantined_at ASC
      LIMIT 100`,
    [quarantineDays()],
  );
  if (expired.rows.length === 0) {
    return 0;
  }
  const gone = await Promise.all(
    expired.rows.map((row) =>
      deleteObject(row.storage_key).then(
        () => row.id,
        (error: unknown) => {
          console.error(
            `[content-safety] could not delete quarantined emoji object ${row.storage_key}, will retry:`,
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
    `DELETE FROM server_emoji_quarantine WHERE id = ANY($1::uuid[])`,
    [ids],
  );
  return deleted.rowCount ?? 0;
}
