import type { PoolClient } from "pg";
import { getPool } from "../db.js";

/**
 * The object keys a jam owns, for the three deletes that cascade the rows
 * away (a channel, a server, an account). Same rule as the attachments and the
 * soundboard: these keys are named only by rows that the cascade destroys, so
 * they are READ BEFORE the delete and the objects are deleted after it
 * (`deleteObjectsInBackground`). Kept apart from `jam.ts` because `servers.ts`
 * and `account.ts` import it and `jam.ts` imports both of them.
 *
 * The keys are read WHATEVER the storage configuration says: a deployment that
 * turned storage off after recordings existed must not lose the only names of
 * them to the cascade (the delete then fails loudly and logs each key as a
 * leaked object, `deleteObjectsInBackground`, which is the record to clean up
 * from).
 *
 * Every key is read from the ledger (`jam_uploads`, which has a row for every
 * object ever signed, claimed or not) and from the tracks (which name the same
 * keys): the union is the complete set, including an object a deleted track
 * still holds before the purge sweep reached it.
 */
type Db = Pick<PoolClient, "query">;

const KEYS_OF_TRACKS = `t.audio_key AS key FROM jam_tracks t`;

/** Objects of every song in these channels. */
export async function jamKeysForChannels(
  channelIds: readonly string[],
  db: Db = getPool(),
): Promise<string[]> {
  if (channelIds.length === 0) {
    return [];
  }
  const result = await db.query<{ key: string }>(
    `SELECT u.storage_key AS key FROM jam_uploads u WHERE u.channel_id = ANY($1::uuid[])
     UNION
     SELECT ${KEYS_OF_TRACKS} JOIN jam_songs s ON s.id = t.song_id
       WHERE s.channel_id = ANY($1::uuid[])
     UNION
     SELECT t.video_key FROM jam_tracks t JOIN jam_songs s ON s.id = t.song_id
       WHERE s.channel_id = ANY($1::uuid[]) AND t.video_key IS NOT NULL`,
    [channelIds],
  );
  return result.rows.map((row) => row.key);
}

/** Objects of every song in a server. */
export async function jamKeysForServer(
  serverId: string,
  db: Db = getPool(),
): Promise<string[]> {
  const result = await db.query<{ key: string }>(
    `SELECT u.storage_key AS key FROM jam_uploads u WHERE u.server_id = $1
     UNION
     SELECT ${KEYS_OF_TRACKS} JOIN jam_songs s ON s.id = t.song_id
       WHERE s.server_id = $1
     UNION
     SELECT t.video_key FROM jam_tracks t JOIN jam_songs s ON s.id = t.song_id
       WHERE s.server_id = $1 AND t.video_key IS NOT NULL`,
    [serverId],
  );
  return result.rows.map((row) => row.key);
}

/** Objects a person recorded or signed: their tracks and their uploads. */
export async function jamKeysForUser(
  userId: string,
  db: Db = getPool(),
): Promise<string[]> {
  const result = await db.query<{ key: string }>(
    `SELECT u.storage_key AS key FROM jam_uploads u WHERE u.uploader_id = $1
     UNION
     SELECT t.audio_key FROM jam_tracks t WHERE t.author_id = $1
     UNION
     SELECT t.video_key FROM jam_tracks t WHERE t.author_id = $1 AND t.video_key IS NOT NULL`,
    [userId],
  );
  return result.rows.map((row) => row.key);
}
