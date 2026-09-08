import { getPool } from "../db.js";

/**
 * The one-time "you are responsible for what you stream" sheet a host sees
 * the first time they start a watch-party / HLS broadcast in a given server.
 * Persisted server-side (`hls_host_acks`, one row per user+server) so it
 * never shows again for that pair once confirmed -- across devices, across
 * sessions, forever, the same way any other per-user setting in this app is
 * "once and done" rather than a client-local flag that a reinstall forgets.
 */
export async function hasAcknowledgedHlsHost(
  userId: string,
  serverId: string,
): Promise<boolean> {
  const result = await getPool().query(
    `SELECT 1 FROM hls_host_acks WHERE user_id = $1 AND server_id = $2`,
    [userId, serverId],
  );
  return result.rowCount !== null && result.rowCount > 0;
}

export async function acknowledgeHlsHost(
  userId: string,
  serverId: string,
): Promise<void> {
  await getPool().query(
    `INSERT INTO hls_host_acks (user_id, server_id)
     VALUES ($1, $2)
     ON CONFLICT (user_id, server_id) DO NOTHING`,
    [userId, serverId],
  );
}
