import { createHmac } from "node:crypto";

/**
 * THE PER-APP IDENTITY (PLAN D11).
 *
 * An app is shown a name, a picture and a random seat id for the session. An
 * app whose manifest says `capabilities.identity: "user-id"` may also be handed
 * a STABLE id of its own, so it can keep a score between sessions, but only for
 * a person who ticked "Deixar este app ver o meu id do pqp" in the join sheet,
 * and never the pqp id itself:
 *
 *     key        = HMAC-SHA256(secret, "pqp-app-identity")
 *     appUserId  = base64url(HMAC-SHA256(key, appId + "\0" + userId))
 *
 * Computed, never stored. The key is derived from `CLERK_SECRET_KEY` for the
 * same reason the playlist tokens' key is: nothing new to provision or to leak,
 * and the label binds it to this one purpose, so no other part of the server
 * can be made to produce, or to verify, an app identity. Two apps get two
 * unrelated ids for the same person, so they cannot be joined up, and nobody
 * can walk an id back to an account without the secret.
 *
 * With no secret at all (a production process that somehow lost it) there is no
 * id: `null`, and the caller sends none. Failing closed means an app simply
 * does not get the capability; it never means a guessable id.
 */

function identityKey(): Buffer | null {
  const secret = process.env.CLERK_SECRET_KEY
    ? process.env.CLERK_SECRET_KEY
    : process.env.DEV_AUTH_BYPASS === "true"
      ? "pqp-dev-app-identity"
      : null;
  if (!secret) {
    return null;
  }
  return createHmac("sha256", secret).update("pqp-app-identity").digest();
}

/** The stable, per-app id of a person who consented. Null when the server has no secret. */
export function deriveAppUserId(appId: string, userId: string): string | null {
  const key = identityKey();
  if (!key) {
    return null;
  }
  return createHmac("sha256", key).update(`${appId}\u0000${userId}`).digest("base64url");
}
