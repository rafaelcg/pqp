import {
  VOICE_NOTE_RECEIPTS_MAX_PARTICIPANTS,
  type Attachment,
  type VoiceNoteListen,
  type VoiceNoteListened,
} from "@pqp/shared";
import { getPool } from "../db.js";
import { noBlockBetweenSql } from "./blocks.js";
import { canAccessChannel } from "./users.js";

/**
 * Who has played a voice note.
 *
 * Two jobs, kept apart on purpose:
 *
 *   - `recordListen` writes the first play and says who should hear about it;
 *   - `overlayListens` fills the per-viewer fields on the attachments a read
 *     is about to hand back.
 *
 * The table is filled for EVERY channel (the listener's own dot has to
 * survive a reload everywhere), and what other people may see of it is decided
 * here on read, by one rule: receipts exist for the AUTHOR of a note in a
 * CONVERSATION of at most `VOICE_NOTE_RECEIPTS_MAX_PARTICIPANTS` people.
 * Anywhere else nobody but the listener learns anything.
 */

/** The route answers 404: no such note, or not one this caller may see. */
export class VoiceNoteNotFoundError extends Error {
  constructor() {
    super("Attachment not found");
    this.name = "VoiceNoteNotFoundError";
  }
}

export interface ListenOutcome {
  /**
   * Set only when THIS call recorded the first play. A replay, and a note
   * played by its own author, are `null`: nothing changed, so nothing is sent.
   */
  frame: VoiceNoteListened | null;
  /**
   * Whose sockets get the frame: always the listener (so the dot clears on
   * their other devices), plus the author when receipts are shown for this
   * note. Never anybody else.
   */
  addressees: string[];
}

interface ListenTarget {
  attachment_id: string;
  message_id: string;
  channel_id: string;
  author_id: string;
  server_id: string | null;
  participants: number;
}

/**
 * Record that `listenerId` played a note.
 *
 * Throws `VoiceNoteNotFoundError` for an attachment that does not exist, is
 * not a voice note, is not attached to a message yet, or sits in a channel
 * the caller cannot see: one answer for all four, so the route confirms
 * nothing about a note it will not let them hear.
 */
export async function recordListen(
  attachmentId: string,
  listenerId: string,
): Promise<ListenOutcome> {
  const found = await getPool().query<ListenTarget>(
    `SELECT a.id AS attachment_id, a.message_id, a.channel_id,
            m.author_id, c.server_id,
            (SELECT COUNT(*)::int FROM channel_members cm
              WHERE cm.channel_id = c.id) AS participants
     FROM message_attachments a
     JOIN message_attachment_voice v ON v.attachment_id = a.id
     JOIN messages m ON m.id = a.message_id
     JOIN channels c ON c.id = a.channel_id
     WHERE a.id = $1 AND a.message_id IS NOT NULL`,
    [attachmentId],
  );
  const target = found.rows[0];
  if (!target || !(await canAccessChannel(target.channel_id, listenerId))) {
    throw new VoiceNoteNotFoundError();
  }

  // Playing your own note changes nothing for anybody.
  if (target.author_id === listenerId) {
    return { frame: null, addressees: [] };
  }

  // Decided BEFORE the insert, not after: the lookup can fail, and a failure
  // after the row committed would leave a retry hitting the conflict, which
  // sends nothing, so the first-play frame would be lost for good. Asked first,
  // a failure leaves the whole call retryable.
  const addressees = [listenerId];
  if (
    receiptsShown(target) &&
    !(await blockedBetween(listenerId, target.author_id))
  ) {
    addressees.push(target.author_id);
  }

  const inserted = await getPool().query<{ listened_at: Date }>(
    `INSERT INTO voice_note_listens (attachment_id, user_id)
     VALUES ($1, $2)
     ON CONFLICT (attachment_id, user_id) DO NOTHING
     RETURNING listened_at`,
    [attachmentId, listenerId],
  );
  const row = inserted.rows[0];
  if (!row) {
    return { frame: null, addressees: [] };
  }

  return {
    frame: {
      type: "voice-note-listened",
      channelId: target.channel_id,
      messageId: target.message_id,
      attachmentId,
      userId: listenerId,
      listenedAt: row.listened_at.toISOString(),
    },
    addressees,
  };
}

/** The receipt rule: a conversation, and a small one. */
function receiptsShown(target: {
  server_id: string | null;
  participants: number;
}): boolean {
  return (
    target.server_id === null &&
    target.participants <= VOICE_NOTE_RECEIPTS_MAX_PARTICIPANTS
  );
}

/**
 * A block is enforced both ways everywhere else, so the author of a note does
 * not learn that somebody they blocked (or who blocked them) played it. The
 * listener's own dot is unaffected.
 */
async function blockedBetween(a: string, b: string): Promise<boolean> {
  const result = await getPool().query(
    `SELECT 1 WHERE NOT ${noBlockBetweenSql("$1::uuid", "$2::uuid")}`,
    [a, b],
  );
  return result.rows.length > 0;
}

/**
 * Fill `voice.listenedByMe` (and, on the author's copy, `voice.listenedBy`)
 * on the voice notes among `attachments`, in place.
 *
 * Batched: nothing runs for a page with no voice note, and for one with notes
 * it is one `ANY()` for the viewer's own plays, one for which of these notes
 * are theirs and may show receipts, and, only when some are, one for the
 * listeners. Never per row.
 *
 * `listenedByMe` is true for a note the viewer wrote: their own play is a
 * no-op by design, and a card that stayed "unplayed" on your own message
 * would stop the auto-continue on it forever.
 *
 * `listenedBy` is `[]` on a qualifying author's copy with no plays yet, so the
 * client can tell "nobody yet" from "not shown here" (absent).
 */
export async function overlayListens(
  attachments: Attachment[],
  viewerId: string,
): Promise<void> {
  const notes = attachments.filter(
    (
      attachment,
    ): attachment is Attachment & { voice: NonNullable<Attachment["voice"]> } =>
      attachment.voice !== undefined,
  );
  if (notes.length === 0) {
    return;
  }
  const ids = notes.map((note) => note.id);

  const [mine, authored] = await Promise.all([
    getPool().query<{ attachment_id: string }>(
      `SELECT attachment_id FROM voice_note_listens
       WHERE user_id = $1 AND attachment_id = ANY($2::uuid[])`,
      [viewerId, ids],
    ),
    getPool().query<{ id: string; receipts: boolean }>(
      `SELECT a.id,
              (c.server_id IS NULL AND
               (SELECT COUNT(*) FROM channel_members cm
                 WHERE cm.channel_id = c.id) <= $3) AS receipts
       FROM message_attachments a
       JOIN messages m ON m.id = a.message_id AND m.author_id = $1
       JOIN channels c ON c.id = m.channel_id
       WHERE a.id = ANY($2::uuid[])`,
      [viewerId, ids, VOICE_NOTE_RECEIPTS_MAX_PARTICIPANTS],
    ),
  ]);

  const heard = new Set(mine.rows.map((row) => row.attachment_id));
  const own = new Set(authored.rows.map((row) => row.id));
  const withReceipts = authored.rows
    .filter((row) => row.receipts)
    .map((row) => row.id);

  const listeners = new Map<string, VoiceNoteListen[]>();
  if (withReceipts.length > 0) {
    const plays = await getPool().query<{
      attachment_id: string;
      user_id: string;
      listened_at: Date;
    }>(
      // Joined to the CURRENT members: somebody who left (or was replaced) is
      // not a receipt, and it bounds the rows per note to the room size
      // however many people have ever listened.
      `SELECT l.attachment_id, l.user_id, l.listened_at
       FROM voice_note_listens l
       JOIN message_attachments a ON a.id = l.attachment_id
       JOIN channel_members cm
         ON cm.channel_id = a.channel_id AND cm.user_id = l.user_id
       WHERE l.attachment_id = ANY($1::uuid[])
         AND ${noBlockBetweenSql("l.user_id", "$2::uuid")}
       ORDER BY l.listened_at ASC, l.user_id ASC`,
      [withReceipts, viewerId],
    );
    for (const play of plays.rows) {
      const list = listeners.get(play.attachment_id) ?? [];
      list.push({
        userId: play.user_id,
        listenedAt: play.listened_at.toISOString(),
      });
      listeners.set(play.attachment_id, list);
    }
  }

  const receiptIds = new Set(withReceipts);
  for (const note of notes) {
    note.voice.listenedByMe = own.has(note.id) || heard.has(note.id);
    if (receiptIds.has(note.id)) {
      note.voice.listenedBy = listeners.get(note.id) ?? [];
    }
  }
}
