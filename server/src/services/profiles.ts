import {
  canRenameHandle,
  handleRenameAvailableAt,
  HANDLE_RENAME_COOLDOWN_DAYS,
  monthStamp,
  normalizeHandle,
  PUBLIC_PROFILE_DEPOIMENTO_LIMIT,
  validateHandle,
  type HandleRejection,
  type ProfileBadge,
  type PublicDepoimento,
  type PublicProfile,
} from "@pqp/shared";
import { getPool } from "../db.js";
import { HttpError } from "../lib/http.js";
import { listUserAchievements } from "./feedback.js";

/**
 * Handles and the thin public profile they address.
 *
 * TWO JOBS, and they have opposite threat models, which is why they share a file
 * rather than living beside `users.ts`:
 *
 *  - CLAIMING is an authenticated write in a race with every other person who
 *    wants the same word. Correctness here means exactly one winner, decided by
 *    the unique index and nothing else.
 *  - READING is unauthenticated and served to the open internet. Correctness
 *    here means the shape that comes back contains nothing the account holder
 *    did not agree to publish.
 */

/** Postgres' unique-violation SQLSTATE. */
const UNIQUE_VIOLATION = "23505";

/** Communities shown on a profile. More than this is a wall, not a badge row. */
const MAX_PROFILE_BADGES = 8;

export class HandleTakenError extends HttpError {
  constructor() {
    super(409, "That handle is already taken");
  }
}

export class HandleCooldownError extends HttpError {
  constructor(readonly availableAt: Date) {
    super(
      429,
      `You can change your handle again on ${availableAt.toISOString().slice(0, 10)}`,
    );
  }
}

/**
 * Claim a handle, or change the one this account already holds.
 *
 * THE RACE IS THE WHOLE FUNCTION. Two people type `neymar` into the claim
 * landing at the same second; both availability checks answer "free", because a
 * read cannot reserve anything. There is no arrangement of SELECT-then-UPDATE
 * that closes that window, and every attempt to close it with a pre-check makes
 * the code look safer while being exactly as racy. So this does not pre-check:
 * it attempts the write and lets `idx_users_handle` decide, converting the
 * 23505 into the 409 the loser deserves. That is why the index is described in
 * schema.sql as the arbiter — it is not a backstop here, it is the mechanism.
 *
 * The guard in the WHERE clause is about the COOLDOWN and not about uniqueness:
 * it re-reads `handle_changed_at` inside the same statement that writes, so an
 * account cannot spend its one rename twice by firing two requests at once.
 * `canRenameHandle` above it is the friendly answer; this is the true one.
 *
 * Claiming the handle you already hold is a no-op that succeeds and does NOT
 * spend the cooldown — the settings form re-sends every field on save, and
 * treating "sent again" as "renamed" would lock somebody out of their own name
 * for a month for editing their display name.
 */
export async function claimHandle(
  userId: string,
  requested: string,
): Promise<{ handle: string; handleChangedAt: string }> {
  const handle = normalizeHandle(requested);
  const rejection = validateHandle(handle);
  if (rejection) {
    throw new HttpError(400, handleRejectionMessage(rejection));
  }

  const current = await getPool().query<{
    handle: string | null;
    handle_changed_at: string | null;
    is_character: boolean | null;
  }>(
    `SELECT handle, handle_changed_at, is_character FROM users WHERE id = $1`,
    [userId],
  );
  const row = current.rows[0];
  if (!row) {
    throw new HttpError(404, "User not found");
  }
  // A character has no public page (see `getPublicProfileByHandle`), so a handle
  // on one would be a URL that 404s forever. Refused rather than silently
  // dropped: the caller here is an operator's script, and a clear answer is what
  // gets the mistake fixed.
  if (row.is_character) {
    throw new HttpError(403, "Character accounts cannot claim a handle");
  }

  if (row.handle === handle) {
    return {
      handle,
      handleChangedAt: row.handle_changed_at ?? new Date().toISOString(),
    };
  }

  if (!canRenameHandle(row.handle_changed_at, row.handle)) {
    throw new HandleCooldownError(
      handleRenameAvailableAt(row.handle_changed_at, row.handle)!,
    );
  }

  try {
    const written = await getPool().query<{ handle: string; handle_changed_at: string }>(
      `UPDATE users
          SET handle = $2, handle_changed_at = NOW()
        WHERE id = $1
          AND (handle IS NULL
               OR handle_changed_at IS NULL
               OR handle_changed_at <= NOW() - ($3 || ' days')::interval)
        RETURNING handle, handle_changed_at`,
      [userId, handle, String(HANDLE_RENAME_COOLDOWN_DAYS)],
    );
    const updated = written.rows[0];
    if (!updated) {
      // The guard matched nothing, which at this point can only be the cooldown
      // losing a race with itself — a second request from the same account
      // landed first. Re-read so the message names the real date.
      const after = await getPool().query<{
        handle: string | null;
        handle_changed_at: string | null;
      }>(`SELECT handle, handle_changed_at FROM users WHERE id = $1`, [userId]);
      const fresh = after.rows[0];
      throw new HandleCooldownError(
        handleRenameAvailableAt(fresh?.handle_changed_at, fresh?.handle) ??
          new Date(),
      );
    }
    return {
      handle: updated.handle,
      handleChangedAt: new Date(updated.handle_changed_at).toISOString(),
    };
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw new HandleTakenError();
    }
    throw error;
  }
}

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { code?: string }).code === UNIQUE_VIOLATION
  );
}

function handleRejectionMessage(rejection: HandleRejection): string {
  switch (rejection) {
    case "length":
      return "A handle is between 3 and 20 characters";
    case "format":
      return "Use lowercase letters, numbers, and . _ - between them";
    case "reserved":
      return "That handle is reserved";
    case "blocked":
      return "That handle cannot be used";
  }
}

/**
 * Whether the depoimentos table exists in this database.
 *
 * FEATURE-DETECTED, not assumed. Depoimentos — the Orkut testimonial, the
 * feature this profile page is half built for — are being written in a
 * different branch, and this file must work whether or not that has landed. The
 * alternative was to guess, and guessing wrong in either direction is a 500 on
 * the one page strangers see.
 *
 * Cached after the first answer because it can only change with a deploy: the
 * schema runs at boot, so a table that is absent when this is first asked stays
 * absent for the life of the process. `resetProfileFeatureCache` exists for
 */
export function resetProfileFeatureCache(): void {
  // Nothing cached since the depoimentos table became a schema fact.
}

async function countApprovedDepoimentos(userId: string): Promise<number> {
  // The parallel branch landed: the table always exists, and `approved_at` is
  // its whole state machine — NULL is pending, and pending must never count.
  const result = await getPool().query<{ n: string }>(
    `SELECT COUNT(*)::text AS n FROM depoimentos
      WHERE subject_id = $1 AND approved_at IS NOT NULL`,
    [userId],
  );
  return Number(result.rows[0]?.n ?? 0);
}

/**
 * The communities this person is in, as badges.
 *
 * LISTED communities only, and never a suspended one: `is_community` is what
 * makes a server public, and `is_community_suspended` is the operator's kill
 * switch (see schema.sql). A private server must never appear here — that would
 * turn a public page into a disclosure of who somebody talks to, which is the
 * single worst thing this feature could do.
 *
 * TODO(coordinator): a per-membership `show_on_profile` opt-out is being added
 * in a parallel branch. When it lands, add `AND m.show_on_profile` to the WHERE
 * below and default the column to TRUE. It cannot be written defensively here —
 * naming a column that does not exist fails the statement outright, and
 * inspecting the catalogue per request to decide would cost a round trip on the
 * hottest public read in the product.
 */
async function listProfileBadges(userId: string): Promise<ProfileBadge[]> {
  const result = await getPool().query<{
    id: string;
    name: string;
    community_category: string;
  }>(
    `SELECT s.id, s.name, s.community_category
       FROM server_members m
       JOIN servers s ON s.id = m.server_id
      WHERE m.user_id = $1
        AND m.show_on_profile
        AND s.is_community
        AND NOT s.is_community_suspended
      ORDER BY s.member_count DESC, s.id DESC
      LIMIT $2`,
    [userId, MAX_PROFILE_BADGES],
  );
  return result.rows.map((row) => ({
    id: row.id,
    name: row.name,
    category: row.community_category,
  }));
}

/**
 * The approved depoimentos this profile shows, newest published first.
 *
 * WHY THIS IS ALLOWED TO BE UNAUTHENTICATED, when `listApprovedDepoimentos` in
 * depoimentos.ts is scoped to people who share a server or a friendship.
 *
 * That scoping answers a different question. There, the subject is any account
 * on the instance and the viewer is a logged-in stranger, so the rule is "no
 * wider than what the profile card already shows you". Here, the subject is
 * somebody who claimed a PUBLIC HANDLE — an opt-in whose entire purpose is a
 * page on the open internet — and every row returned was published by that
 * person from a preview that said so. The consent is per-row and it was given
 * twice: the author wrote it for a profile, the subject put it on one.
 *
 * WHAT STILL DOES NOT TRAVEL. The author's id, tag, and (unless they claimed
 * one) handle. A depoimento must never become a way to enumerate the people who
 * know somebody — so the author is a face and a name, which is exactly what
 * a screenshot of the page would have shown anyway.
 *
 * BLOCKS ARE NOT CONSULTED, and cannot be: there is no viewer to have blocked
 * anybody. The rows that a block would have hidden are already gone — the
 * block trigger deletes any depoimento between the pair — and a third party's
 * block is not a fact about this page.
 *
 * A WEBHOOK OR CHARACTER AUTHOR IS DROPPED. Neither can be friends with
 * anybody, so neither can have written one; the predicate is here so that stays
 * true if some future seeding path forgets it.
 */
async function listPublicDepoimentos(
  subjectId: string,
): Promise<PublicDepoimento[]> {
  const result = await getPool().query<{
    id: string;
    body: string;
    display_name: string;
    handle: string | null;
    avatar_url: string | null;
  }>(
    `SELECT d.id, d.body, u.display_name, u.handle, u.avatar_url
       FROM depoimentos d
       JOIN users u ON u.id = d.author_id
      WHERE d.subject_id = $1
        AND d.approved_at IS NOT NULL
        AND COALESCE(u.is_character, FALSE) = FALSE
        AND COALESCE(u.is_webhook, FALSE) = FALSE
      ORDER BY d.approved_at DESC, d.id DESC
      LIMIT $2`,
    [subjectId, PUBLIC_PROFILE_DEPOIMENTO_LIMIT],
  );
  return result.rows.map((row) => ({
    id: row.id,
    body: row.body,
    author: {
      displayName: row.display_name,
      handle: row.handle ?? null,
      avatarUrl: row.avatar_url,
    },
  }));
}

/**
 * One public profile, by handle, for anybody on the internet.
 *
 * NULL COVERS EVERYTHING and that is deliberate: no such handle, a handle on a
 * webhook's pseudo-row, a handle on a character. All three mean "there is no
 * page here", and answering them apart would make this a probe for which kinds
 * of account exist. Characters in particular are hidden for the same reason
 * `discoverableSql` hides them from search — the house cast is findable inside
 * its own community and enumerable from nowhere.
 *
 * The shape returned is `publicProfileSchema` and cannot widen by accident: it
 * is built field by field from a narrow SELECT rather than by spreading a row.
 */
export async function getPublicProfileByHandle(
  rawHandle: string,
): Promise<PublicProfile | null> {
  const handle = normalizeHandle(rawHandle);
  if (validateHandle(handle)) {
    return null;
  }

  const result = await getPool().query<{
    id: string;
    handle: string;
    display_name: string;
    avatar_url: string | null;
    banner_url: string | null;
    created_at: Date | null;
  }>(
    `SELECT id, handle, display_name, avatar_url, banner_url, created_at
       FROM users
      WHERE handle = $1
        AND COALESCE(is_character, FALSE) = FALSE
        AND COALESCE(is_webhook, FALSE) = FALSE`,
    [handle],
  );
  const row = result.rows[0];
  if (!row) {
    return null;
  }

  const [badges, achievements, depoimentoCount, depoimentos] =
    await Promise.all([
      listProfileBadges(row.id),
      listUserAchievements(row.id),
      countApprovedDepoimentos(row.id),
      listPublicDepoimentos(row.id),
    ]);

  return {
    handle: row.handle,
    displayName: row.display_name,
    avatarUrl: row.avatar_url,
    bannerUrl: row.banner_url,
    badges,
    achievements,
    depoimentoCount,
    depoimentos,
    // MONTH, NEVER A DAY, and the truncation happens here rather than in the
    // client so the day never leaves this process. "no pqp desde julho de 2026"
    // is a badge; a date is a timestamp, and a timestamp on a page served to
    // the open internet is a fact about when somebody was at a computer.
    memberSince: monthStamp(row.created_at),
  };
}

/**
 * Resolve a handle to the account behind it — for SIGNED-IN callers only.
 *
 * This is the other half of `?add=<handle>`: the public page deliberately does
 * not carry a user id, because a stranger needs a name and a picture and has no
 * business with an identifier they could feed to another endpoint. Somebody who
 * has signed in does, and this is the same discovery surface `/api/users/lookup`
 * already is — so it lives behind the same budget and returns the same narrow
 * `publicUserSchema` shape.
 */
export async function findUserIdByHandle(
  rawHandle: string,
): Promise<string | null> {
  const handle = normalizeHandle(rawHandle);
  if (validateHandle(handle)) {
    return null;
  }
  const result = await getPool().query<{ id: string }>(
    `SELECT id FROM users
      WHERE handle = $1
        AND COALESCE(is_webhook, FALSE) = FALSE`,
    [handle],
  );
  return result.rows[0]?.id ?? null;
}
