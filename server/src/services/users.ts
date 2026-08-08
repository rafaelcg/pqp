import { createHash } from "node:crypto";
import {
  formatUserTag,
  USER_SEARCH_PAGE_SIZE,
  type DmPrivacy,
  type PublicUser,
} from "@pqp/shared";
import type { DbUser } from "../db.js";
import { getPool } from "../db.js";
import type { AuthUser } from "../auth/clerk.js";
import { HttpError } from "../lib/http.js";
// One direction only: avatars.ts knows about storage and keys, this file knows
// about the `users` row those two columns live on. Nothing in avatars.ts
// imports back, so there is no cycle to reason about here.
import { discardAvatarObject } from "./avatars.js";
import { notBlockedSql } from "./blocks.js";
import { getPreferences } from "./preferences.js";
// A cycle: servers.ts imports `channelVisibleSql` from here. Both directions
// are function calls made from inside function bodies, never at module
// evaluation time, so the cycle resolves. It exists because the audience cache
// has to live beside the query it caches, and membership is written here.
import { invalidateServerAudience } from "./servers.js";

/** Every column of `DbUser`, single-sourced so the reads cannot drift apart. */
const DB_USER_COLUMNS = `id, clerk_id, display_name, username, discriminator, avatar_url, avatar_key, email_domains`;

const DISCRIMINATOR_MAX = 9999;
/** Random probes tried before falling back to a sweep that cannot miss. */
const DISCRIMINATOR_PROBES = 24;

function formatDiscriminator(value: number): string {
  return String(value).padStart(4, "0");
}

/**
 * Does this string look like an email address, taken whole?
 *
 * DELIBERATELY NARROW. This decides whether a name gets thrown away and
 * replaced, so a false positive costs a real person their name — and the far
 * more common shape is a name that merely *contains* an `@`: "Dave @ Acme",
 * "@rafa", "M@rio", "meet me @ 5.30". None of those match, because the pattern
 * is anchored at both ends, forbids whitespace anywhere, requires a non-empty
 * local part, and requires a dot followed by at least two letters on the right.
 * What it does match is the thing that actually leaked: a bare
 * `rafaelcg@gmail.com` sitting alone in the field.
 *
 * The accepted cost is the other direction: `Rafael <rafaelcg@gmail.com>` is
 * not matched. That form can only get here if a human typed it into the profile
 * form, which is a disclosure they chose; the bug being fixed is the address
 * arriving in the field without anybody deciding it should.
 *
 * THE SAME RULE IS RESTATED IN SQL in `schema.sql` (the `pqp-email-scrub`
 * block), which cleans the rows written before this existed. Change one and the
 * other has to change with it.
 */
const EMAIL_SHAPED = /^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i;

export function looksLikeEmailAddress(value: string): boolean {
  return EMAIL_SHAPED.test(value.trim());
}

/**
 * The name an account gets when nothing safe can be derived for it.
 *
 * Two requirements pull against each other here. It must disclose nothing — so
 * no part of an address, and no part of the Clerk id either, which is why the
 * suffix is a hash and not a slice. And it must not collapse everyone into one
 * string: a shared `"User"` would make every nameless account slug to `user`,
 * pile them all onto one 9,999-wide discriminator space, and render a channel
 * full of people who are indistinguishable on screen.
 *
 * Derived from the Clerk id rather than randomly so it is stable: the profile
 * cache expires every five minutes and two requests can create the same account
 * concurrently, and a random name would mean the handle depends on which call
 * happened to win.
 *
 * It reads as a placeholder on purpose. There is no onboarding step that asks
 * for a name, so this is what the person sees until they open settings — the
 * honest version of that is something that visibly wants replacing, not a
 * generated pseudonym they might mistake for a real identity.
 */
export function placeholderDisplayName(clerkId: string): string {
  const digest = createHash("sha256").update(clerkId).digest("hex").slice(0, 4);
  return `User ${digest}`;
}

/**
 * Derive the slug half of a handle from a display name.
 *
 * An email address is refused outright rather than slugified. Slugifying one is
 * not a partial disclosure but a complete one — `rafaelcg@gmail.com` became
 * `rafaelcg_gmail_com`, which is the address with two characters changed, and
 * it is the string other people type to mention them. There is nothing safe to
 * keep from it, so nothing is kept and the generated fallback below takes over.
 *
 * Accents are folded to their base letter *before* the character filter runs,
 * because after it every one of them is already an underscore. NFD splits `ã`
 * into `a` plus a combining tilde and every combining mark lives in
 * U+0300–U+036F, so dropping that range transliterates rather than mangles:
 * `João` becomes `joao`, not `jo_o`, and `Gonçalves` becomes `goncalves`, not
 * `gon_alves`. This is the handle a brand-new account is assigned without ever
 * being shown it, so getting it wrong is not cosmetic.
 *
 * The trim runs after the truncation — trimming first lets a cut at 32 leave a
 * trailing underscore behind.
 */
export function slugifyUsername(input: string): string {
  const source = looksLikeEmailAddress(input) ? "" : input;
  const slug = source
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, "_")
    .slice(0, 32)
    .replace(/^_+|_+$/g, "");
  return slug.length >= 2 ? slug : `user_${Math.random().toString(36).slice(2, 6)}`;
}

/**
 * A free number for `username`, or null when all 9,999 are genuinely taken.
 *
 * The previous version probed at random 40 times and then threw. That is fine
 * while a name is rare and quietly fatal once it is popular: with ~9,900 of
 * 9,999 slots used, 40 random probes come up empty about two thirds of the
 * time — so account creation would fail for precisely the names the most people
 * have. Reading the taken set once costs a single query instead of up to forty
 * and lets the fallback be a sweep, which finds a slot whenever one exists.
 *
 * The random probe is kept for the common case: allocating sequentially would
 * make handles guessable and leak signup order.
 */
async function allocateDiscriminator(username: string): Promise<string | null> {
  const result = await getPool().query<{ discriminator: string }>(
    `SELECT discriminator FROM users
     WHERE username = $1 AND discriminator IS NOT NULL`,
    [username],
  );
  const taken = new Set(result.rows.map((row) => row.discriminator));
  if (taken.size >= DISCRIMINATOR_MAX) {
    return null;
  }

  for (let probe = 0; probe < DISCRIMINATOR_PROBES; probe++) {
    const candidate = formatDiscriminator(
      Math.floor(Math.random() * DISCRIMINATOR_MAX) + 1,
    );
    if (!taken.has(candidate)) {
      return candidate;
    }
  }

  // The fallback has to be random too, not a sweep from 1.
  //
  // A sweep is correct for one caller and pathological for many: it returns the
  // *lowest* free number, so every concurrent signup that reaches it picks the
  // same one, one wins the unique index and the rest burn a retry and collide
  // again identically. Measured at 512 concurrent signups on a name with 532 of
  // 9,999 numbers left, that was 13% of accounts failing outright with a 503 —
  // and the odds of reaching this path at all rise exactly as a name fills, so
  // the failure lands on the most popular names and nowhere else.
  //
  // Collecting the free set costs one pass over 9,999 integers on a path that
  // is already rare, and it is what makes the retry in the caller worth having:
  // a fresh random pick genuinely avoids the collision it just lost.
  const free: string[] = [];
  for (let value = 1; value <= DISCRIMINATOR_MAX; value++) {
    const candidate = formatDiscriminator(value);
    if (!taken.has(candidate)) {
      free.push(candidate);
    }
  }
  if (free.length === 0) {
    return null;
  }
  return free[Math.floor(Math.random() * free.length)]!;
}

/**
 * Is this exact `name#number` pair already somebody else's? Used only to decide
 * whether a rename can keep the number it already has.
 */
async function isTagTaken(
  username: string,
  discriminator: string,
  excludeUserId: string,
): Promise<boolean> {
  const result = await getPool().query(
    `SELECT 1 FROM users
     WHERE username = $1 AND discriminator = $2 AND id <> $3`,
    [username, discriminator, excludeUserId],
  );
  return result.rows.length > 0;
}

/**
 * A unique violation on the handle index specifically, as opposed to any other
 * constraint on the table. Retrying is only ever the right answer for this one —
 * a clash on `clerk_id` means something entirely different and must not be
 * swallowed here.
 */
function isTagConflict(error: unknown): boolean {
  if (typeof error !== "object" || error === null) {
    return false;
  }
  const { code, constraint } = error as { code?: string; constraint?: string };
  return code === "23505" && (constraint ?? "").includes("username_discrim");
}

/**
 * A complete handle for a brand-new account.
 *
 * Auto-assignment has nowhere to fall back to — the user is never asked what
 * they want to be called — so this has to produce something. When a base slug is
 * genuinely exhausted, widen it with a suffix instead of failing the signup; a
 * `joao_k2f#0417` the user can change later beats an error page they cannot get
 * past.
 */
async function deriveHandle(
  displayName: string,
): Promise<{ username: string; discriminator: string }> {
  const base = slugifyUsername(displayName);
  for (let attempt = 0; attempt < 5; attempt++) {
    const username =
      attempt === 0
        ? base
        : `${base.slice(0, 28)}_${Math.random().toString(36).slice(2, 5)}`;
    const discriminator = await allocateDiscriminator(username);
    if (discriminator) {
      return { username, discriminator };
    }
  }
  throw new Error("Could not allocate a username");
}

/**
 * The `/api/me` shape. Async only because it carries the user's preferences:
 * folding that read in here means the client learns its theme and voice
 * defaults from the bootstrap request it already makes, instead of a second
 * round-trip it would have to wait on before first paint.
 *
 * THIS SHAPE CARRIES `clerkId` AND IS ONLY EVER SAFE TO SEND TO THE ACCOUNT'S
 * OWN OWNER. Anything that hands a user to somebody else — search results, the
 * participants of a conversation, a block list — must use `toPublicUserSummary`
 * below instead, which is the shape `publicUserSchema` describes.
 */
export async function toPublicUser(user: DbUser) {
  return {
    id: user.id,
    clerkId: user.clerk_id,
    displayName: user.display_name,
    username: user.username,
    discriminator: user.discriminator,
    tag: formatUserTag(user.username, user.discriminator),
    avatarUrl: user.avatar_url,
    preferences: await getPreferences(user.id),
    dmPrivacy: await getDmPrivacy(user.id),
  };
}

/** Columns every public-shaped read selects. */
const PUBLIC_USER_COLUMNS = `id, display_name, username, discriminator, avatar_url`;

interface PublicUserRow {
  id: string;
  display_name: string;
  username: string | null;
  discriminator: string | null;
  avatar_url: string | null;
}

/**
 * A user as somebody who is not that user may see them.
 *
 * Deliberately built from a row rather than from `DbUser`: the fields simply
 * are not there to leak. `clerk_id` is the account's identifier at the identity
 * provider and `toPublicUser` returns it, so the two shapes are kept apart by
 * construction rather than by remembering to delete a key.
 */
export function toPublicUserSummary(row: PublicUserRow): PublicUser {
  return {
    id: row.id,
    displayName: row.display_name,
    username: row.username,
    tag: formatUserTag(row.username, row.discriminator),
    avatarUrl: row.avatar_url,
  };
}

/**
 * Read fresh rather than carried on the session user.
 *
 * `resolveAuthUser` caches the row it authenticated with, so a value read off
 * that object would keep answering with the setting the user had when they
 * connected — and this one setting decides whether strangers may contact them,
 * which is precisely the case where a stale read is the wrong answer.
 */
export async function getDmPrivacy(userId: string): Promise<DmPrivacy> {
  const result = await getPool().query<{ dm_privacy: DmPrivacy }>(
    `SELECT dm_privacy FROM users WHERE id = $1`,
    [userId],
  );
  return result.rows[0]?.dm_privacy ?? "server_members";
}

/**
 * Exact handle lookup — the half of discovery that is not enumerable, because
 * the caller has to already know both the name and the number.
 */
export async function findUserByTag(
  username: string,
  discriminator: string,
): Promise<PublicUser | null> {
  const result = await getPool().query<PublicUserRow>(
    `SELECT ${PUBLIC_USER_COLUMNS} FROM users
     WHERE username = $1 AND discriminator = $2`,
    [username, discriminator],
  );
  const row = result.rows[0];
  return row ? toPublicUserSummary(row) : null;
}

/**
 * Prefix search over handles.
 *
 * `_` is a legal username character *and* a LIKE wildcard, so an unescaped
 * query for `a_b` would match `axb` — which turns a search for one person into
 * a pattern match over the directory. Escaping is done here rather than left to
 * the caller because forgetting it does not fail, it silently widens.
 *
 * The caller is excluded: every result is somebody you might open a
 * conversation with, and you are not one of them.
 */
export async function searchUsersByPrefix(
  prefix: string,
  viewerId: string,
  limit: number = USER_SEARCH_PAGE_SIZE,
): Promise<PublicUser[]> {
  const escaped = prefix.toLowerCase().replace(/[\\%_]/g, "\\$&");
  const result = await getPool().query<PublicUserRow>(
    `SELECT ${PUBLIC_USER_COLUMNS} FROM users
     WHERE username IS NOT NULL
       AND username LIKE $1 || '%' ESCAPE '\\'
       AND id <> $2
     ORDER BY username ASC, discriminator ASC
     LIMIT $3`,
    [escaped, viewerId, limit],
  );
  return result.rows.map(toPublicUserSummary);
}

export async function upsertUser(auth: AuthUser): Promise<DbUser> {
  const existing = await getPool().query<DbUser>(
    `SELECT ${DB_USER_COLUMNS}
     FROM users WHERE clerk_id = $1`,
    [auth.clerkId],
  );

  if (existing.rows[0]) {
    // Do not clobber profile edits on every auth; only fill empty avatar from
    // Clerk. `email_domains` is the exception — it is not user-editable, and it
    // is overwritten rather than merged so that *un*verifying or removing an
    // address actually revokes the access it granted.
    const result = await getPool().query<DbUser>(
      `UPDATE users SET
         avatar_url = COALESCE(avatar_url, $2),
         email_domains = $3
       WHERE clerk_id = $1
       RETURNING ${DB_USER_COLUMNS}`,
      [auth.clerkId, auth.avatarUrl, auth.emailDomains ?? []],
    );
    const user = result.rows[0]!;
    if (!user.username || !user.discriminator) {
      return ensureUsername(user);
    }
    return user;
  }

  return insertNewUser(auth);
}

/**
 * The first time an account is ever seen.
 *
 * `ON CONFLICT (clerk_id) DO NOTHING` rather than a bare INSERT because the
 * client authenticates over HTTP and opens its WebSocket at nearly the same
 * moment, so a brand-new account reaches this function twice concurrently.
 * Both callers found no row, both insert, and without this the loser's request —
 * the very first thing the account ever does — fails with a 500. A retry then
 * succeeds, which is exactly why this survives manual testing and only shows up
 * once real signups overlap. Losing the race is not an error here: the winner's
 * row is the row both callers wanted, so read it back.
 *
 * The surrounding retry is for the *other* unique index. Two display names that
 * slug alike can be handed the same number in the window between reading the
 * taken set and inserting; the answer to that is a fresh number, not an error.
 */
async function insertNewUser(auth: AuthUser): Promise<DbUser> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const { username, discriminator } = await deriveHandle(auth.displayName);
    try {
      const result = await getPool().query<DbUser>(
        `INSERT INTO users (clerk_id, display_name, username, discriminator, avatar_url, email_domains)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (clerk_id) DO NOTHING
         RETURNING ${DB_USER_COLUMNS}`,
        [
          auth.clerkId,
          auth.displayName,
          username,
          discriminator,
          auth.avatarUrl,
          auth.emailDomains ?? [],
        ],
      );
      const inserted = result.rows[0];
      if (inserted) {
        return inserted;
      }

      // DO NOTHING returns no row, so the conflict was on `clerk_id`: somebody
      // else created this account between our SELECT and our INSERT.
      const winner = await getPool().query<DbUser>(
        `SELECT ${DB_USER_COLUMNS} FROM users WHERE clerk_id = $1`,
        [auth.clerkId],
      );
      const row = winner.rows[0];
      if (row) {
        return row.username && row.discriminator ? row : ensureUsername(row);
      }
      // The row was deleted again in between. Vanishingly unlikely; fall
      // through and try the whole thing once more rather than return nothing.
    } catch (error) {
      if (!isTagConflict(error)) {
        throw error;
      }
    }
  }
  throw new Error("Could not create the account after repeated handle collisions");
}

/**
 * Backfill a handle for a row that somehow has none. Same conflict retry as
 * `insertNewUser` and for the same reason: the number is chosen from a set read
 * a moment earlier, so a concurrent allocation of the same pair is possible and
 * is not worth failing a request over.
 */
async function ensureUsername(user: DbUser): Promise<DbUser> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const { username, discriminator } = await deriveHandle(user.display_name);
    try {
      const result = await getPool().query<DbUser>(
        `UPDATE users SET username = $2, discriminator = $3
         WHERE id = $1
         RETURNING ${DB_USER_COLUMNS}`,
        [user.id, username, discriminator],
      );
      return result.rows[0]!;
    } catch (error) {
      if (!isTagConflict(error)) {
        throw error;
      }
    }
  }
  throw new Error("Could not allocate a username after repeated collisions");
}

export async function getUserById(userId: string): Promise<DbUser | null> {
  const result = await getPool().query<DbUser>(
    `SELECT ${DB_USER_COLUMNS}
     FROM users WHERE id = $1`,
    [userId],
  );
  return result.rows[0] ?? null;
}

export async function updateProfile(
  userId: string,
  updates: {
    displayName?: string;
    username?: string;
    avatarUrl?: string | null;
    /**
     * The object we hold behind `avatarUrl`, when there is one. Only the avatar
     * routes pass this; `PATCH /api/me` never does, and an absent value is
     * resolved below from what happened to `avatarUrl`.
     */
    avatarKey?: string | null;
    dmPrivacy?: DmPrivacy;
  },
): Promise<DbUser> {
  const current = await getUserById(userId);
  if (!current) {
    throw new Error("User not found");
  }

  let username = current.username;
  let discriminator = current.discriminator;

  if (updates.username && updates.username !== current.username) {
    username = updates.username;
    // Keep the number. It is half the handle people have already shared, and
    // re-rolling it on every rename silently invalidates it — only allocate a
    // new one when this exact pair is taken.
    const keepsCurrent =
      discriminator !== null &&
      !(await isTagTaken(updates.username, discriminator, userId));
    if (!keepsCurrent) {
      discriminator = await allocateDiscriminator(updates.username);
      // Unlike a brand-new account, a rename *does* have somewhere to fall back
      // to: the person is looking at a form. Say the name is full and let them
      // choose another, rather than silently handing them a suffixed variant of
      // the name they explicitly asked for.
      if (!discriminator) {
        throw new HttpError(
          409,
          "That username has no numbers left. Please pick a different one.",
        );
      }
    }
  }

  const avatarUrl =
    updates.avatarUrl !== undefined
      ? updates.avatarUrl === ""
        ? null
        : updates.avatarUrl
      : current.avatar_url;

  // Which object, if any, the new `avatar_url` is backed by.
  //
  // The avatar routes state it outright. Everything else — the settings form,
  // onboarding, a preset, a pasted link — states only a URL, and the rule for
  // those is: a URL that *changed* means the uploaded object is no longer what
  // is being shown, so the account no longer holds one. A URL that did not
  // change means nothing happened, which matters more than it looks: the
  // settings form re-sends the avatar it was given on every save, so treating
  // "sent again" as "replaced" would clear the key of a user who edited their
  // display name and delete the object out from under their own picture.
  const avatarKey =
    updates.avatarKey !== undefined
      ? updates.avatarKey
      : updates.avatarUrl !== undefined && avatarUrl !== current.avatar_url
        ? null
        : (current.avatar_key ?? null);

  // The pair was free a moment ago, but "a moment ago" is the whole problem:
  // another rename can claim it before this write lands. That is a lost race,
  // not a bad request, so take the next free number and try again instead of
  // handing the user an error for something they did nothing wrong in.
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const written = await writeProfile(
        userId,
        updates,
        username,
        discriminator,
        avatarUrl,
        avatarKey,
      );
      // AFTER the write commits, and never before: an object deleted first and
      // then rolled back is a picture that renders as a broken frame forever.
      // Nothing points at the old key any more, and this is the only moment it
      // is still known — there is no row for a sweeper to find it by later.
      // Fire-and-forget, because a storage hiccup must not fail a profile
      // change that has already happened; `discardAvatarObject` swallows and
      // logs its own errors.
      if (current.avatar_key && current.avatar_key !== avatarKey) {
        void discardAvatarObject(current.avatar_key);
      }
      return written;
    } catch (error) {
      if (!isTagConflict(error) || !username) {
        throw error;
      }
      const next = await allocateDiscriminator(username);
      if (!next) {
        throw new HttpError(
          409,
          "That username has no numbers left. Please pick a different one.",
        );
      }
      discriminator = next;
    }
  }
  throw new HttpError(
    409,
    "That username is being claimed by too many people right now. Try again.",
  );
}

async function writeProfile(
  userId: string,
  updates: {
    displayName?: string;
    dmPrivacy?: DmPrivacy;
  },
  username: string | null,
  discriminator: string | null,
  avatarUrl: string | null,
  avatarKey: string | null,
): Promise<DbUser> {
  const result = await getPool().query<DbUser>(
    `UPDATE users SET
       display_name = COALESCE($2, display_name),
       username = $3,
       discriminator = $4,
       avatar_url = $5,
       avatar_key = $6,
       dm_privacy = COALESCE($7, dm_privacy)
     WHERE id = $1
     RETURNING ${DB_USER_COLUMNS}`,
    [
      userId,
      updates.displayName ?? null,
      username,
      discriminator,
      avatarUrl,
      avatarKey,
      updates.dmPrivacy ?? null,
    ],
  );
  return result.rows[0]!;
}

export async function getMemberRole(
  serverId: string,
  userId: string,
): Promise<"owner" | "admin" | "member" | null> {
  const result = await getPool().query<{ role: "owner" | "admin" | "member" }>(
    `SELECT role FROM server_members WHERE server_id = $1 AND user_id = $2`,
    [serverId, userId],
  );
  return result.rows[0]?.role ?? null;
}

export async function isServerMember(
  serverId: string,
  userId: string,
): Promise<boolean> {
  return (await getMemberRole(serverId, userId)) !== null;
}

export async function listServerMemberIds(serverId: string): Promise<string[]> {
  const result = await getPool().query<{ user_id: string }>(
    `SELECT user_id FROM server_members WHERE server_id = $1`,
    [serverId],
  );
  return result.rows.map((row) => row.user_id);
}

export async function canManageServer(
  serverId: string,
  userId: string,
): Promise<boolean> {
  const role = await getMemberRole(serverId, userId);
  return role === "owner" || role === "admin";
}

/**
 * Membership of one channel's own list, as a subquery.
 *
 * The same text answers two questions that must never drift apart: who is on a
 * private server channel's allowlist, and who is in a conversation. For a
 * conversation it is the *whole* rule — there is no second source of truth and
 * no role that overrides it.
 */
function channelMemberSql(viewer: string): string {
  return `EXISTS (
           SELECT 1 FROM channel_members cm
           WHERE cm.channel_id = c.id AND cm.user_id = ${viewer}
         )`;
}

/**
 * Who may see a channel, as one SQL fragment every read path interpolates.
 *
 * It cannot be a bare constant: `getChannelAudience` asks the question of every
 * member in a single query, so there the viewer is the row's own `sm.user_id`,
 * while everywhere else it is a bound parameter whose number differs per call
 * site. Taking the viewer expression keeps the text itself single-sourced,
 * which is the whole point — a copy per call site is a private channel leaking
 * the day one copy is updated and the rest are not.
 *
 * THE TWO BRANCHES ARE NOT SYMMETRIC AND MUST NOT BE MADE SO. A server channel
 * has an owner and admins who can read a private channel without being on its
 * list, because a server is a thing they are responsible for. A conversation is
 * not: it belongs to nobody, so the only way in is a `channel_members` row.
 * Adding a role escape hatch to the `ELSE` branch would put every server
 * administrator inside their members' direct messages, which is the single
 * worst thing this predicate could be made to do.
 *
 * Callers must expose `channels c` and `server_members sm`. The join to `sm`
 * may be a LEFT JOIN — a conversation has no server and so no member rows, and
 * `sm.user_id IS NOT NULL` is what carries the "must be a member" half of the
 * server branch when it is. Unless the viewer *is* `sm.user_id`, the join must
 * also constrain `sm.user_id` to the same viewer, or the role branch answers
 * for some other member and grants access on their rank.
 */
export function channelVisibleSql(viewer: string): string {
  // --- threads ---
  //
  // A thread's privacy FOLLOWS ITS PARENT. The privacy disjunction below is
  // evaluated against `eff` — the row itself for an ordinary channel, the
  // parent row for a thread — because a thread row is never private and never
  // has members of its own, so asking the thread row directly would answer
  // "public" for every thread under a private channel: the exact leak this
  // predicate exists to make impossible. Threads cannot nest (enforced at
  // creation in services/threads.ts), so one level of parent is the whole
  // story, and a thread whose parent is gone (`parent_id` nulled) matches no
  // `eff` row and FAILS CLOSED.
  //
  // Server membership (`sm.user_id IS NOT NULL`) and the role escape hatch are
  // unchanged: an owner or admin who can read the private parent can read its
  // threads, a plain member needs the parent's `channel_members` row, and a
  // conversation still has no role escape hatch at all.
  return `(
         CASE WHEN c.kind = 'server' THEN
           sm.user_id IS NOT NULL
           AND EXISTS (
             SELECT 1 FROM channels eff
             WHERE eff.id = CASE WHEN c.type = 'thread' THEN c.parent_id ELSE c.id END
               AND (
                 eff.is_private = FALSE
                 OR sm.role IN ('owner', 'admin')
                 OR EXISTS (
                     SELECT 1 FROM channel_members cm
                     WHERE cm.channel_id = eff.id AND cm.user_id = ${viewer}
                   )
               )
           )
         ELSE ${channelMemberSql(viewer)}
         END
       )`;
}

/**
 * Canonical single-channel access check — the one predicate everything else
 * defers to. Private channels are visible to the server's owner and admins
 * without a `channel_members` row, and to plain members only with one; a
 * conversation is visible to its participants and to nobody else.
 *
 * The join to `server_members` is LEFT because a conversation has no server:
 * an inner join drops the row before the predicate is ever evaluated, which
 * would read as "no such channel" for every DM in the instance.
 */
export async function canAccessChannel(
  channelId: string,
  userId: string,
): Promise<boolean> {
  const result = await getPool().query(
    `SELECT 1 FROM channels c
     LEFT JOIN server_members sm
       ON sm.server_id = c.server_id AND sm.user_id = $2
     WHERE c.id = $1 AND ${channelVisibleSql("$2")}`,
    [channelId, userId],
  );
  return result.rows.length > 0;
}

/**
 * The older name, kept because callers outside this file still use it (and one,
 * `attachments.ts`, was not part of the consolidation). `canAccessChannel` is
 * canonical; nothing should acquire a new dependency on this name.
 */
export const isChannelMember = canAccessChannel;

export async function listServerMembers(serverId: string) {
  const result = await getPool().query<{
    id: string;
    display_name: string;
    username: string | null;
    discriminator: string | null;
    avatar_url: string | null;
    role: "owner" | "admin" | "member";
  }>(
    `SELECT u.id, u.display_name, u.username, u.discriminator, u.avatar_url, sm.role
     FROM server_members sm
     JOIN users u ON u.id = sm.user_id
     WHERE sm.server_id = $1
     ORDER BY
       CASE sm.role WHEN 'owner' THEN 0 WHEN 'admin' THEN 1 ELSE 2 END,
       u.display_name ASC`,
    [serverId],
  );
  return result.rows.map((row) => ({
    id: row.id,
    displayName: row.display_name,
    username: row.username,
    discriminator: row.discriminator,
    tag: formatUserTag(row.username, row.discriminator),
    avatarUrl: row.avatar_url,
    role: row.role,
  }));
}

export async function updateMemberRole(
  serverId: string,
  targetUserId: string,
  role: "admin" | "member",
): Promise<void> {
  await getPool().query(
    `UPDATE server_members SET role = $3
     WHERE server_id = $1 AND user_id = $2 AND role <> 'owner'`,
    [serverId, targetUserId, role],
  );
  // A demotion narrows access without touching a single membership row:
  // `channelVisibleSql` admits owners and admins to a private channel with no
  // `channel_members` row of their own, so `admin` → `member` takes away every
  // private channel they were not explicitly added to.
  invalidateServerAudience(serverId);
}

/** Remove all membership rows for a user in one server. */
async function deleteMembership(
  serverId: string,
  userId: string,
): Promise<void> {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `DELETE FROM server_members WHERE server_id = $1 AND user_id = $2`,
      [serverId, userId],
    );
    await client.query(
      `DELETE FROM channel_members
       WHERE user_id = $1 AND channel_id IN (
         SELECT id FROM channels WHERE server_id = $2
       )`,
      [userId, serverId],
    );
    await client.query("COMMIT");
    invalidateServerAudience(serverId);
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function leaveServer(
  serverId: string,
  userId: string,
): Promise<void> {
  const role = await getMemberRole(serverId, userId);
  if (!role) {
    throw new Error("Not a member of this server");
  }
  if (role === "owner") {
    throw new Error(
      "Transfer ownership or delete the server before leaving it",
    );
  }
  await deleteMembership(serverId, userId);
}

/**
 * Kick (and optionally ban) a member. Owners can act on anyone; admins can only
 * act on plain members, so an admin cannot depose a peer or the owner.
 */
export async function removeMember(
  serverId: string,
  actorId: string,
  targetUserId: string,
  ban: boolean,
): Promise<void> {
  if (actorId === targetUserId) {
    throw new Error("Use leave to remove yourself");
  }

  const actorRole = await getMemberRole(serverId, actorId);
  const targetRole = await getMemberRole(serverId, targetUserId);

  if (!targetRole) {
    throw new Error("Not a member of this server");
  }
  if (targetRole === "owner") {
    throw new Error("The owner cannot be removed");
  }
  if (actorRole !== "owner" && !(actorRole === "admin" && targetRole === "member")) {
    throw new Error("You do not have permission to remove this member");
  }

  await deleteMembership(serverId, targetUserId);

  if (ban) {
    await getPool().query(
      `INSERT INTO server_bans (server_id, user_id, banned_by)
       VALUES ($1, $2, $3)
       ON CONFLICT (server_id, user_id) DO NOTHING`,
      [serverId, targetUserId, actorId],
    );
  }
}

export async function isBanned(
  serverId: string,
  userId: string,
): Promise<boolean> {
  const result = await getPool().query(
    `SELECT 1 FROM server_bans WHERE server_id = $1 AND user_id = $2`,
    [serverId, userId],
  );
  return result.rows.length > 0;
}

export async function listBans(serverId: string) {
  const result = await getPool().query<{
    id: string;
    display_name: string;
    username: string | null;
    discriminator: string | null;
    avatar_url: string | null;
    created_at: Date;
  }>(
    `SELECT u.id, u.display_name, u.username, u.discriminator, u.avatar_url,
            b.created_at
     FROM server_bans b
     JOIN users u ON u.id = b.user_id
     WHERE b.server_id = $1
     ORDER BY b.created_at DESC`,
    [serverId],
  );
  return result.rows.map((row) => ({
    id: row.id,
    displayName: row.display_name,
    tag: formatUserTag(row.username, row.discriminator),
    avatarUrl: row.avatar_url,
    bannedAt: row.created_at.toISOString(),
  }));
}

export async function liftBan(
  serverId: string,
  userId: string,
): Promise<void> {
  await getPool().query(
    `DELETE FROM server_bans WHERE server_id = $1 AND user_id = $2`,
    [serverId, userId],
  );
}

/**
 * Unread counts for every channel of a server the viewer can see. A channel with
 * no `channel_reads` row counts everything, which is what a freshly joined
 * member should see.
 *
 * Server-scoped by construction: `c.server_id = $1` can only ever match
 * `kind = 'server'` rows, because the `channels_server_kind_check` constraint
 * makes a non-null server the definition of a server channel. Conversations are
 * counted by `listConversations` instead, which cannot reuse this query at all
 * — it joins through `server_members`, and a conversation has no rows there.
 *
 * A message from somebody the viewer has blocked does not count. The live
 * `channel-activity` frame already skips people who blocked the author, so
 * counting them here would make the badge that appears after a refresh
 * disagree with the badge that appeared at the time, about the same message.
 * The message is still delivered and still readable behind the client's
 * curtain — a block takes away the notification, not the content.
 */
export async function listUnread(serverId: string, userId: string) {
  const result = await getPool().query<{
    channel_id: string;
    count: string;
    mentions: string;
  }>(
    `SELECT c.id AS channel_id,
            COUNT(m.id)::text AS count,
            COUNT(mm.user_id)::text AS mentions
     FROM channels c
     JOIN server_members sm ON sm.server_id = c.server_id AND sm.user_id = $2
     LEFT JOIN channel_reads cr
       ON cr.channel_id = c.id AND cr.user_id = $2
     LEFT JOIN messages m
       ON m.channel_id = c.id
      AND m.author_id <> $2
      AND m.created_at > COALESCE(cr.last_read_at, TIMESTAMPTZ '-infinity')
      AND ${notBlockedSql("$2", "m.author_id")}
     LEFT JOIN message_mentions mm
       ON mm.message_id = m.id AND mm.user_id = $2
     WHERE c.server_id = $1
       AND ${channelVisibleSql("$2")}
     GROUP BY c.id`,
    [serverId, userId],
  );

  return result.rows.map((row) => ({
    channelId: row.channel_id,
    count: Number(row.count),
    mentions: Number(row.mentions),
  }));
}

export async function markChannelRead(
  channelId: string,
  userId: string,
): Promise<void> {
  await getPool().query(
    `INSERT INTO channel_reads (channel_id, user_id, last_read_at)
     VALUES ($1, $2, NOW())
     ON CONFLICT (channel_id, user_id)
     DO UPDATE SET last_read_at = NOW()`,
    [channelId, userId],
  );
}
