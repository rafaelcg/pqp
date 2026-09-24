/**
 * A per-attempt id for the `Idempotency-Key` header on a room-creating POST
 * (`createServer`, `applyDiscordImport` in `./api.ts`). Generated once when
 * an attempt starts and reused on a retry of that same attempt, so a client
 * that loses the response to a create (network drop, timeout) and tries
 * again gets the room it already made instead of a second one. See
 * `server/src/services/idempotency-keys.ts` for the server half.
 *
 * Same shape as `createSendNonce` in `./outbox.ts`, a stable id per attempt
 * rather than a counter that resets per session, kept as its own small
 * function because the two ids serve different retry lifecycles (a queued
 * chat send vs. a form the person may edit and resubmit).
 */
export function createIdempotencyKey(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  const bytes = new Uint8Array(16);
  if (typeof crypto !== "undefined" && typeof crypto.getRandomValues === "function") {
    crypto.getRandomValues(bytes);
  } else {
    for (let i = 0; i < bytes.length; i += 1) {
      bytes[i] = Math.floor(Math.random() * 256);
    }
  }
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Holds the key for one create attempt, keyed by the content being created
 * (a trimmed room name, an import source) so a retry with unchanged input
 * reuses the key and an edited input starts a fresh attempt rather than
 * accidentally replaying a stale one under new content.
 */
export class IdempotencyAttempt {
  private content: string | null = null;
  private key: string | null = null;

  /** Returns the key for this content, generating a new one only when the
   * content has changed since the last call. */
  keyFor(content: string): string {
    if (this.content !== content || !this.key) {
      this.content = content;
      this.key = createIdempotencyKey();
    }
    return this.key;
  }

  /** Call after a successful create: the attempt is over, and the next call
   * to `keyFor`, even with the same content, starts a new one. */
  reset(): void {
    this.content = null;
    this.key = null;
  }
}
