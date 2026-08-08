import { randomBytes, createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { getPool, type DbUser } from "../db.js";
import { deriveHandle } from "./users.js";

/**
 * Character accounts — the production identity for the house cast.
 *
 * A character is an ordinary `users` row that a long-lived bearer token can
 * authenticate as. That last clause is the whole feature and the whole risk:
 * webhooks already mint a `users` row with a synthetic `clerk_id` that *nothing*
 * authenticates as, and this adds the one thing that row was missing. So this
 * file is auth code, not tooling, and the rules it keeps are:
 *
 *   1. THE TOKEN IS NEVER STORED. Only its SHA-256. `createCharacterAccount`
 *      returns the secret exactly once and there is no read path that can
 *      produce it again.
 *   2. THE TOKEN IS NEVER LOGGED. Nothing in this file, and nothing that calls
 *      it, puts the secret in an error message — including the failure paths,
 *      which is where credentials usually leak.
 *   3. THE WHOLE BRANCH IS GATED. `CHARACTER_ACCOUNTS_ENABLED` must be `true`
 *      or `resolveCharacterToken` refuses before it touches the database. A
 *      deploy that has not opted in cannot be reached by a stolen token at all.
 *   4. CREATION SATISFIES THE GATES. A character has no date of birth and no
 *      browser, so the age gate and the onboarding flag are written at creation
 *      — otherwise the account's socket closes 4401 and its first-run modal
 *      never gets clicked.
 *
 * Provisioning is an operator action against `DATABASE_URL`
 * (`tools/ambient/scripts/provision.mjs`), deliberately not an API route: there
 * is no request that should be able to mint a credential of this class, and the
 * people who can provision one are exactly the people who already hold the
 * database URL.
 */

/** The `Authorization: Bearer` prefix that routes a token to this file. */
export const CHARACTER_TOKEN_PREFIX = "character:";

/** The synthetic `clerk_id` prefix, mirroring `webhook:<uuid>`. */
const CHARACTER_CLERK_PREFIX = "character:";

/**
 * The gate. Off by default, and read per call rather than cached at boot so an
 * operator can pull the whole cast offline with a restart-free config change on
 * the platforms that support one.
 *
 * Deliberately NOT tied to `NODE_ENV` the way `DEV_AUTH_BYPASS` is inverted
 * against it: the dev bypass mints a session for a *fixed public string* and
 * must never run in production, whereas this checks a 256-bit secret against a
 * hash and production is where it is meant to run. What it shares with the
 * bypass is that it is explicit — an environment that has not said the word
 * cannot authenticate a character.
 */
export function isCharacterAccountsEnabled(): boolean {
  return process.env.CHARACTER_ACCOUNTS_ENABLED === "true";
}

/**
 * 32 random bytes, base64url. Same size and reasoning as a webhook token: it is
 * the only credential the request carries, so guessing one must not be a
 * realistic attack even against an attacker who can try forever.
 */
export function mintCharacterToken(): string {
  return randomBytes(32).toString("base64url");
}

export function hashCharacterToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

export interface CharacterAccount {
  id: string;
  user_id: string;
  label: string;
  created_by: string | null;
  created_at: Date;
  revoked_at: Date | null;
}

const CHARACTER_COLUMNS = `id, user_id, label, created_by, created_at, revoked_at`;

export interface CreateCharacterInput {
  /** The operator's stable name for this account — the persona id. Unique. */
  label: string;
  displayName: string;
  avatarUrl?: string | null;
  /** Free text for the audit trail: who ran the script, and why. */
  createdBy?: string | null;
}

export interface CreatedCharacter {
  account: CharacterAccount;
  user: DbUser;
  /** The secret, returned exactly once. Never readable again. */
  token: string;
}

/**
 * Mint one character account: a `users` row, its gates pre-cleared, and a token
 * whose hash is all that survives this call.
 *
 * Everything runs in one transaction because a half-created character is worse
 * than none: a `users` row with no `character_accounts` row is an account
 * nobody can authenticate as and nothing will ever clean up, and it would take
 * the unique `label` with it so the retry could not use the same name.
 *
 * The handle is derived exactly the way a person's is (`deriveHandle`), because
 * a character is mentioned, searched and tagged by the same code paths as
 * anybody else — a row with no `username` would simply be unmentionable.
 */
export async function createCharacterAccount(
  input: CreateCharacterInput,
): Promise<CreatedCharacter> {
  const token = mintCharacterToken();
  const tokenHash = hashCharacterToken(token);
  const client = await getPool().connect();

  try {
    for (let attempt = 0; attempt < 5; attempt++) {
      const { username, discriminator } = await deriveHandle(input.displayName);
      try {
        await client.query("BEGIN");
        const inserted = await client.query<DbUser>(
          `INSERT INTO users (
             clerk_id, display_name, username, discriminator, avatar_url,
             is_character, dm_privacy, age_checked_at, age_check_passed
           )
           VALUES ($1, $2, $3, $4, $5, TRUE, 'nobody', NOW(), TRUE)
           RETURNING id, clerk_id, display_name, username, discriminator,
                     avatar_url, is_character`,
          [
            `${CHARACTER_CLERK_PREFIX}${randomUUID()}`,
            input.displayName,
            username,
            discriminator,
            input.avatarUrl ?? null,
          ],
        );
        const user = inserted.rows[0]!;

        // The onboarding wizard's completion flag. A preference rather than a
        // column (see `onboardedAt` in @pqp/shared), so it is written here and
        // not in the INSERT above.
        await client.query(
          `INSERT INTO user_preferences (user_id, settings)
           VALUES ($1, jsonb_build_object('onboardedAt', to_char(NOW() AT TIME ZONE 'UTC',
                   'YYYY-MM-DD"T"HH24:MI:SS"Z"')))
           ON CONFLICT (user_id) DO NOTHING`,
          [user.id],
        );

        const account = await client.query<CharacterAccount>(
          `INSERT INTO character_accounts (user_id, label, token_hash, created_by)
           VALUES ($1, $2, $3, $4)
           RETURNING ${CHARACTER_COLUMNS}`,
          [user.id, input.label, tokenHash, input.createdBy ?? null],
        );

        await client.query("COMMIT");
        return { account: account.rows[0]!, user, token };
      } catch (error) {
        await client.query("ROLLBACK").catch(() => {});
        // A handle collision is a fresh number, not an error — the same retry
        // `insertNewUser` makes, and for the same reason.
        if (isHandleConflict(error)) {
          continue;
        }
        throw error;
      }
    }
    throw new Error(
      `Could not allocate a handle for character "${input.label}" after repeated collisions`,
    );
  } finally {
    client.release();
  }
}

function isHandleConflict(error: unknown): boolean {
  if (typeof error !== "object" || error === null) {
    return false;
  }
  const { code, constraint } = error as { code?: string; constraint?: string };
  return code === "23505" && (constraint ?? "").includes("username_discrim");
}

export interface CharacterIdentity {
  userId: string;
  label: string;
  clerkId: string;
  displayName: string;
  avatarUrl: string | null;
}

interface CharacterRow {
  user_id: string;
  label: string;
  token_hash: string;
  clerk_id: string;
  display_name: string;
  avatar_url: string | null;
}

/**
 * Resolve a presented token to the character it authenticates as, or null.
 *
 * Null for every failure and for every reason — disabled gate, unknown token,
 * revoked account, tampered row — because the caller is `verifyAuthHeader`,
 * whose only vocabulary is "an identity" or "not one". Telling the four apart
 * would build an oracle into the auth chokepoint.
 *
 * WHY THE LOOKUP IS AN EQUALITY ON THE HASH. The indexed probe is on
 * SHA-256(secret), not on the secret: a timing difference in the index walk
 * leaks something about which *hash* was searched for, and inverting that to a
 * 256-bit preimage is the thing SHA-256 exists to prevent. What a hash lookup
 * cannot do on its own is prove that the row it found is the row for this
 * token — a partial-index scan and a row read are two different steps — so the
 * digests are compared again, in constant time, before the identity is
 * returned. That second compare is what makes a HAND-EDITED `token_hash` fail
 * closed instead of authenticating whoever the row now points at.
 */
export async function resolveCharacterToken(
  token: string,
): Promise<CharacterIdentity | null> {
  if (!isCharacterAccountsEnabled()) {
    return null;
  }
  if (typeof token !== "string" || token.length === 0) {
    return null;
  }

  const presented = hashCharacterToken(token);
  const result = await getPool().query<CharacterRow>(
    `SELECT ca.user_id, ca.label, ca.token_hash,
            u.clerk_id, u.display_name, u.avatar_url
       FROM character_accounts ca
       JOIN users u ON u.id = ca.user_id
      WHERE ca.token_hash = $1
        AND ca.revoked_at IS NULL
        AND u.is_character = TRUE`,
    [presented],
  );

  const row = result.rows[0];
  if (!row) {
    return null;
  }
  if (!constantTimeEquals(row.token_hash, presented)) {
    return null;
  }

  return {
    userId: row.user_id,
    label: row.label,
    clerkId: row.clerk_id,
    displayName: row.display_name,
    avatarUrl: row.avatar_url,
  };
}

/**
 * `timingSafeEqual` throws on a length mismatch, which would itself be a
 * branch on the secret-derived input. Both operands here are hex SHA-256 so a
 * differing length means the stored value is not a digest at all — answer false
 * rather than throw, and let the caller's single "not an identity" path handle
 * it.
 */
export function constantTimeEquals(a: string, b: string): boolean {
  const left = Buffer.from(a, "utf8");
  const right = Buffer.from(b, "utf8");
  if (left.length !== right.length) {
    return false;
  }
  return timingSafeEqual(left, right);
}

/** Is this `users.id` a character? Used by the guardrail checks. */
export async function isCharacterUser(userId: string): Promise<boolean> {
  const result = await getPool().query<{ is_character: boolean }>(
    `SELECT is_character FROM users WHERE id = $1`,
    [userId],
  );
  return result.rows[0]?.is_character === true;
}

export async function getCharacterAccountByLabel(
  label: string,
): Promise<CharacterAccount | null> {
  const result = await getPool().query<CharacterAccount>(
    `SELECT ${CHARACTER_COLUMNS} FROM character_accounts WHERE label = $1`,
    [label],
  );
  return result.rows[0] ?? null;
}

export async function listCharacterAccounts(): Promise<CharacterAccount[]> {
  const result = await getPool().query<CharacterAccount>(
    `SELECT ${CHARACTER_COLUMNS} FROM character_accounts ORDER BY created_at ASC`,
  );
  return result.rows;
}

/**
 * Replace the secret on an existing account, keeping the `users` row.
 *
 * The account keeps its id, its handle, its memberships and everything it has
 * ever said; only the credential changes. That is what makes a leaked token
 * survivable — the alternative, deleting and re-minting, would put a second
 * stranger with the same name in every server the first one was in.
 */
export async function rotateCharacterToken(
  label: string,
): Promise<{ account: CharacterAccount; token: string } | null> {
  const token = mintCharacterToken();
  const result = await getPool().query<CharacterAccount>(
    `UPDATE character_accounts
        SET token_hash = $2, revoked_at = NULL
      WHERE label = $1
      RETURNING ${CHARACTER_COLUMNS}`,
    [label, hashCharacterToken(token)],
  );
  const account = result.rows[0];
  return account ? { account, token } : null;
}

/**
 * Stop a character, now. One UPDATE, no deletion: the row is the only record of
 * which account a token belonged to, and an incident is exactly when that
 * record is wanted.
 */
export async function revokeCharacterAccount(
  label: string,
): Promise<CharacterAccount | null> {
  const result = await getPool().query<CharacterAccount>(
    `UPDATE character_accounts
        SET revoked_at = COALESCE(revoked_at, NOW())
      WHERE label = $1
      RETURNING ${CHARACTER_COLUMNS}`,
    [label],
  );
  return result.rows[0] ?? null;
}
