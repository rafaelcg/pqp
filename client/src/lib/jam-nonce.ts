/**
 * An idempotency key for creating a song. The server answers a repeated nonce
 * with the song it already made (`POST .../jam-songs`, 200 instead of 201), which
 * is what makes a retry after a dropped answer safe, and is also why ONE nonce
 * must belong to ONE attempt: a second song made with the first one's nonce is
 * never created, its take lands in the first. Make one per attempt (a draft),
 * keep it across retries of that attempt, and never reuse it.
 */
export function newJamNonce(): string {
  return typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}
