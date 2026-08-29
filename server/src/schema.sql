CREATE EXTENSION IF NOT EXISTS "pgcrypto";

CREATE TABLE IF NOT EXISTS users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  clerk_id TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  username TEXT,
  discriminator TEXT,
  avatar_url TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE users ADD COLUMN IF NOT EXISTS username TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS discriminator TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_users_username_discrim
  ON users (username, discriminator)
  WHERE username IS NOT NULL AND discriminator IS NOT NULL;

-- A webhook's pseudo-identity: `messages.author_id` is NOT NULL, and every
-- read path already assumes an author row to join, so a webhook message gets
-- a real row here rather than teaching every one of those paths to handle a
-- null author. `is_webhook` is what excludes it from search, lookup, and
-- mention resolution without a second predicate copied into each of those
-- queries — see the WHERE clause on `searchUsersByPrefix`/`findUserByTag`.
ALTER TABLE users ADD COLUMN IF NOT EXISTS is_webhook BOOLEAN NOT NULL DEFAULT FALSE;

-- A CHARACTER account: an operator-provisioned member of the house cast.
--
-- Deliberately NOT `is_webhook`. A webhook's pseudo-row is a posting mechanism —
-- the client badges every one of its messages "not a member", it cannot react,
-- cannot show typing, and never appears in the member list. A character is the
-- opposite: an ordinary account in every read path, which is the entire point.
-- Reusing the webhook flag would have inherited all three of those behaviours
-- and made the cast read as an RSS feed.
--
-- What the flag is FOR is the small set of places where an operator-owned
-- account must behave differently from a person, and each of them names this
-- column rather than guessing from the `clerk_id` prefix:
--
--   * discovery — `searchUsersByPrefix` / `findUserByTag` hide a character from
--     anyone who does not already share a server with it, so the cast is
--     findable inside its community and not enumerable from outside it;
--   * contact — friend requests are refused (services/friends.ts) and DMs are
--     refused in both directions (services/dms.ts), on top of the
--     `dm_privacy = 'nobody'` these rows are created with;
--   * voice — refused at the `join-voice-room` chokepoint (ws/voice.ts);
--   * self-service account lifecycle — deletion and export are refused, because
--     a long-lived bearer token must not be able to erase or exfiltrate the
--     account it authenticates as.
--
-- See services/characters.ts and `character_accounts` at the foot of this file.
ALTER TABLE users ADD COLUMN IF NOT EXISTS is_character BOOLEAN NOT NULL DEFAULT FALSE;

-- The two pseudo-identity flags are mutually exclusive. They are opposite
-- answers to the same question — "is there a person behind this row" — and a
-- row claiming both would be read one way by the client's webhook badge and
-- another by every check listed above.
DO $$
BEGIN
  ALTER TABLE users DROP CONSTRAINT IF EXISTS users_pseudo_identity_exclusive;
  ALTER TABLE users
    ADD CONSTRAINT users_pseudo_identity_exclusive
    CHECK (NOT (is_character AND is_webhook));
EXCEPTION
  WHEN others THEN NULL;
END $$;

-- The object-storage key of an *uploaded* profile picture, or NULL.
--
-- `avatar_url` above stays what it always was: whatever string is rendered as
-- this person's picture. That may be a Clerk image copied in at signup, a
-- preset the user picked, or a URL they typed — and for an uploaded avatar it
-- is this server's own `/api/avatars/:userId?v=…` route. Keeping the two apart
-- is what lets every existing read (a dozen joins that select `u.avatar_url`
-- and hand it straight to a client) go on working untouched while uploads gain
-- the one thing a URL cannot express: *which object in the bucket this is*.
--
-- That is needed for exactly one reason — deleting it. An avatar that is
-- replaced or cleared leaves bytes behind, and unlike `message_attachments`
-- there is no row here for a sweeper to find later: the account keeps one
-- avatar, so the moment the column is overwritten is the only moment the old
-- key is still known. `updateProfile` is where that happens.
--
-- NULL for every account that predates this, for every Clerk-supplied picture,
-- and for every typed URL — all of which are bytes somebody else holds and we
-- must never try to delete.
ALTER TABLE users ADD COLUMN IF NOT EXISTS avatar_key TEXT;

-- Who is allowed to open a conversation with this user. 'server_members' —
-- "someone I already share a server with" — is the default because a shared
-- server is the only relationship this product models, and expressing the rule
-- in those terms is what avoids building a friend graph to gate it.
--
-- It governs opening a conversation, not an existing one: tightening this must
-- not silently cut off people already talking to you.
ALTER TABLE users ADD COLUMN IF NOT EXISTS dm_privacy TEXT NOT NULL
  DEFAULT 'server_members'
  CHECK (dm_privacy IN ('everyone', 'server_members', 'nobody'));

-- The 18+ age gate. The Terms state a hard 18 minimum and that accounts found
-- to be under it are terminated; these three columns are what makes that claim
-- true of the product rather than only of the page.
--
-- WHAT IS STORED, AND WHY IT IS NOT EVERYONE'S DATE OF BIRTH (LGPD art. 6, III
-- — necessidade). The purpose here is one yes/no: did this account declare an
-- age of at least eighteen. Once that is answered, an adult's exact date of
-- birth adds nothing to the purpose and a great deal to the risk — a full DOB
-- is a strong identifier and a routine knowledge-based-authentication factor
-- somewhere else. So a *passing* declaration is reduced on the spot to a
-- boolean plus the moment of the check, and the date itself is never written.
-- The boolean and the timestamp are what demonstrate diligence: they say the
-- check ran, when, and what it concluded, which is the whole of what an
-- operator or a regulator needs to see for an account that is allowed in.
--
-- A *failing* declaration keeps the date, because there it is the evidence for
-- an irreversible sanction. The appeals path in the Terms is somebody writing
-- "I typed the wrong year"; with only a boolean there is nothing to review, and
-- reviewing it is the difference between an appeal and a form letter. It is the
-- narrower retention of the two — the small set of blocked accounts, not the
-- whole user table.
--
-- All three live on `users` so that deleting the row (LGPD art. 18, VI) takes
-- them with it. There is deliberately no second table to remember.
--
-- EXISTING ACCOUNTS. Every row that predates this migration reads NULL, which
-- is `pending`, which means prompted on next request. They are NOT
-- grandfathered: an account created before the gate is exactly an account whose
-- age was never asked, and the Terms make no exception for when you signed up.
-- The cost is one dialog for everybody; the alternative is a permanent cohort
-- the gate does not cover.
ALTER TABLE users ADD COLUMN IF NOT EXISTS age_checked_at TIMESTAMPTZ;
ALTER TABLE users ADD COLUMN IF NOT EXISTS age_check_passed BOOLEAN;
-- Retained only when `age_check_passed` is FALSE — see above.
ALTER TABLE users ADD COLUMN IF NOT EXISTS age_check_dob DATE;

-- The two answer columns are written together or not at all, and the whole "one
-- attempt only" rule is expressed as `WHERE age_checked_at IS NULL`. If those
-- two ever disagreed, a blocked account would read as never-asked and get a
-- second try — which is the one failure that empties this feature of meaning.
-- ADD CONSTRAINT is not idempotent, so this uses the same DROP-then-ADD block
-- the other constraints in this file use.
DO $$
BEGIN
  ALTER TABLE users DROP CONSTRAINT IF EXISTS users_age_check_complete;
  ALTER TABLE users
    ADD CONSTRAINT users_age_check_complete
    CHECK ((age_checked_at IS NULL) = (age_check_passed IS NULL));
EXCEPTION
  WHEN others THEN NULL;
END $$;

-- pqp-email-scrub: take the email addresses back out of the rows that already
-- have them.
--
-- `auth/clerk.ts` used to end its display-name chain at
-- `?? primaryEmailAddress?.emailAddress`, so every Clerk account with no name
-- set — which is every account created by "continue with email" — was written
-- in here as its own address. That address was then rendered as the author of
-- every message, shown in the voice roster, and slugified into the handle other
-- people type to mention them (`rafaelcg@gmail.com` -> `rafaelcg_gmail_com`).
-- The code path is fixed; these are the rows it already wrote, and they stay
-- public until something rewrites them.
--
-- WHAT COUNTS AS AN EMAIL HERE. The whole trimmed value, anchored at both ends,
-- no whitespace anywhere, a non-empty local part, and a dot plus two or more
-- letters at the end. That is deliberately narrow, because a false positive
-- destroys a real person's chosen name: "Dave @ Acme", "@rafa", "M@rio" and
-- "meet me @ 5.30" all contain an `@` and none of them match. The same rule is
-- written in TypeScript as `looksLikeEmailAddress` in services/users.ts —
-- change one and change the other.
--
-- WHAT THE ROW BECOMES. Exactly what `placeholderDisplayName` would have
-- produced for that account: `User` plus the first four hex of sha256 over the
-- Clerk id. Same input, same output, so a scrubbed row is indistinguishable
-- from one created after the fix, and nothing about the account leaks — the
-- suffix is a hash, and it exists only so that nameless accounts stay
-- distinguishable from each other on screen.
--
-- THE USERNAME IS ONLY REWRITTEN WHEN IT IS DEMONSTRABLY DERIVED, i.e. when it
-- is character-for-character what `slugifyUsername` would have made of that
-- address, or that slug with the `_xyz` suffix `deriveHandle` adds when a base
-- is full. A handle the person picked themselves is left alone even on a
-- contaminated row: it is the name other people already know them by, and this
-- migration has no business guessing at it. The known gap is a non-ASCII local
-- part — the TypeScript slug folds accents (NFD) and this SQL does not, so
-- `joão@…` would fail the equality test and keep its handle. The display name,
-- which is the disclosure that was actually on screen, is scrubbed regardless.
--
-- IDEMPOTENCE. The predicate is self-limiting — after one pass no row matches —
-- but that is not the reason this is safe to leave in a file that runs on every
-- boot. The reason is the fingerprint: without it, a user who later sets their
-- display name to their own address *on purpose* would have it silently
-- rewritten by the next deploy. The marker in the column comment says the
-- cleanup has run, and changing any part of the rule above changes the marker
-- and re-runs it — the same guard shape as the search-vector migration below.
DO $$
DECLARE
  -- The rule as one string. The fingerprint is taken over this, so a change to
  -- the match, the replacement name, or the handle test all re-arm the pass.
  email_re CONSTANT TEXT := '^[^[:space:]@]+@[^[:space:]@]+\.[a-z]{2,}$';
  name_rule CONSTANT TEXT := 'User <sha256(clerk_id)[1..4]>';
  handle_rule CONSTANT TEXT := 'username = slug(display_name) | left(slug,28)_[a-z0-9]{3}';
  marker CONSTANT TEXT := 'pqp-email-scrub '
    || md5(email_re || '|' || name_rule || '|' || handle_rule);
  col_attnum SMALLINT;
  row_ users%ROWTYPE;
  digest TEXT;
  base TEXT;
  candidate TEXT;
  probe INT;
  scrubbed INT := 0;
BEGIN
  SELECT a.attnum INTO col_attnum FROM pg_attribute a
  WHERE a.attrelid = 'users'::regclass AND a.attname = 'display_name'
    AND NOT a.attisdropped;

  IF col_description('users'::regclass, col_attnum) IS NOT DISTINCT FROM marker THEN
    RETURN; -- already scrubbed under this exact rule
  END IF;

  -- FOR UPDATE so two servers booting at once cannot both rewrite the same row:
  -- the loser blocks, then re-evaluates the predicate under READ COMMITTED and
  -- finds the row no longer matches.
  FOR row_ IN
    SELECT * FROM users
    WHERE is_webhook = FALSE
      -- A webhook's name was typed by whoever created it, not derived from an
      -- identity provider, so it is not this migration's to rewrite.
      AND display_name ~* email_re
    FOR UPDATE
  LOOP
    digest := encode(sha256(convert_to(row_.clerk_id, 'UTF8')), 'hex');

    -- `slugifyUsername`, restated: lowercase, every run of anything outside
    -- [a-z0-9_] to one underscore, cut to 32, then trim the edges.
    base := regexp_replace(
              left(regexp_replace(lower(row_.display_name), '[^a-z0-9_]+', '_', 'g'), 32),
              '^_+|_+$', '', 'g');

    candidate := NULL;
    IF row_.username IS NOT NULL AND base <> '' AND (
         row_.username = base
         OR row_.username ~ ('^' || left(base, 28) || '_[a-z0-9]{3}$')
       ) THEN
      -- `user_<digest>`, the handle this account would have been given had it
      -- signed up after the fix. Widen the digest on the (negligible) chance
      -- that another scrubbed row already holds this exact name and number.
      FOR probe IN 4..16 LOOP
        candidate := 'user_' || left(digest, probe);
        EXIT WHEN NOT EXISTS (
          SELECT 1 FROM users u
          WHERE u.username = candidate
            AND u.discriminator IS NOT DISTINCT FROM row_.discriminator
            AND u.id <> row_.id);
        candidate := NULL;
      END LOOP;
      -- Unreachable short of 13 colliding digests; the id cannot collide.
      IF candidate IS NULL THEN
        candidate := left('user_' || replace(row_.id::text, '-', ''), 32);
      END IF;
    END IF;

    UPDATE users
    SET display_name = 'User ' || left(digest, 4),
        username = COALESCE(candidate, username)
    WHERE id = row_.id;
    scrubbed := scrubbed + 1;
  END LOOP;

  IF scrubbed > 0 THEN
    RAISE NOTICE 'pqp: removed an email address from % user row(s)', scrubbed;
  END IF;

  EXECUTE format('COMMENT ON COLUMN users.display_name IS %L', marker);
END $$;

-- Blocking is one-directional (blocker → blocked) and self-serve. It exists
-- because a DM is a contact channel nobody else moderates: every other sanction
-- in the product is something a moderator does on a server's behalf, and none
-- of them help a user who just wants one person out of their own feed.
CREATE TABLE IF NOT EXISTS user_blocks (
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  blocked_user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, blocked_user_id),
  CHECK (user_id <> blocked_user_id)
);

-- Enforcement asks "does either of these two block the other", so half of every
-- check reads the pair backwards — a direction the primary key cannot serve,
-- and it sits on the message-send path.
CREATE INDEX IF NOT EXISTS idx_user_blocks_blocked
  ON user_blocks (blocked_user_id, user_id);

-- One JSONB blob per user rather than a column per setting: the set of
-- preferences churns, and a column each would mean a migration each. The shape
-- is validated by `userPreferencesSchema` before anything is written.
CREATE TABLE IF NOT EXISTS user_preferences (
  user_id    UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  settings   JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- One-shot data migrations, by name.
--
-- Everything else in this file is a *structural* statement that is safe to
-- replay: CREATE TABLE IF NOT EXISTS, ADD COLUMN IF NOT EXISTS, DROP-then-ADD
-- for constraints. A backfill is not like that. It writes rows whose meaning
-- depends on *when* it ran, so replaying it on every boot would keep applying
-- yesterday's answer to accounts created since. This table is what makes
-- "already done" a fact the next boot can read.
CREATE TABLE IF NOT EXISTS data_migrations (
  name       TEXT PRIMARY KEY,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Grandfather every account that existed before first-run onboarding shipped.
--
-- Onboarding runs for a user whose preferences carry no `onboardedAt`. Without
-- this block that is every account ever created, so the day it deploys, every
-- existing user signs in and is handed a wizard about a handle they have been
-- using for months — which is exactly the surprise the flow exists to prevent.
--
-- Marking them instead of dating them: `users.created_at` is right here and it
-- is tempting to write `WHERE created_at < <deploy time>`, but that constant has
-- to be guessed at authoring time and is wrong on every self-hosted instance
-- that deploys later. "Whoever already existed the first time this ran" needs no
-- constant and is correct on every instance.
--
-- Runs exactly once per database. On a fresh one it marks nothing and records
-- itself, which is also correct: there is nobody to grandfather, and everyone
-- who signs up afterwards should see the flow.
--
-- ONE EXCEPTION, AND IT IS THE POINT. An account whose display name is still
-- `placeholderDisplayName` — `User` plus four hex — has provably never been
-- asked what it wants to be called. Either nothing was derivable from its
-- identity provider, or the `pqp-email-scrub` pass above just took an address
-- out of that column. Age is the wrong test for those: they are old accounts in
-- exactly the state onboarding exists to fix, and grandfathering them would
-- leave a permanent cohort called "User 3f9a" with no prompt to fix it. They are
-- left unmarked, so they get the flow once — and finishing or skipping it writes
-- the key, so it is once and not every session. This block runs AFTER the scrub
-- for that reason: before it, those rows still read as email addresses and would
-- be grandfathered by mistake. Keep the order.
--
-- The pattern is `placeholderDisplayName`'s output restated. Someone who
-- deliberately names themselves "User 1a2b" gets one dismissible dialog.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM data_migrations WHERE name = 'onboarding_grandfather_2026_08'
  ) THEN
    INSERT INTO user_preferences (user_id, settings)
    SELECT
      id,
      jsonb_build_object(
        'onboardedAt',
        to_char(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')
      )
    FROM users
    WHERE display_name !~ '^User [0-9a-f]{4}$'
    ON CONFLICT (user_id) DO UPDATE
      -- `||` is a shallow merge with the right side winning, the same rule
      -- `mergePreferences` relies on: an account that already stored a theme
      -- keeps it and gains this key.
      SET settings = user_preferences.settings || EXCLUDED.settings;

    INSERT INTO data_migrations (name) VALUES ('onboarding_grandfather_2026_08');
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS servers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  owner_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS server_members (
  server_id UUID NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('owner', 'admin', 'member')),
  joined_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (server_id, user_id)
);

-- Expand role check if table already existed with old constraint
DO $$
BEGIN
  ALTER TABLE server_members DROP CONSTRAINT IF EXISTS server_members_role_check;
  ALTER TABLE server_members
    ADD CONSTRAINT server_members_role_check
    CHECK (role IN ('owner', 'admin', 'member'));
EXCEPTION
  WHEN others THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS channels (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  server_id UUID NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('text', 'voice')),
  position INTEGER NOT NULL DEFAULT 0,
  is_private BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE channels ADD COLUMN IF NOT EXISTS is_private BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE channels ADD COLUMN IF NOT EXISTS topic TEXT;
ALTER TABLE channels ADD COLUMN IF NOT EXISTS image_url TEXT;

-- A conversation — a DM or a group DM — is a channel with no server. Modelling
-- it as a channel row rather than as its own table is what lets messages, read
-- cursors, reactions, mentions and attachments carry over untouched; a parallel
-- messaging path is how this feature turns into a rewrite.
ALTER TABLE channels ALTER COLUMN server_id DROP NOT NULL;

ALTER TABLE channels ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'server'
  CHECK (kind IN ('server', 'dm', 'group'));

-- `kind` and `server_id` have to agree in both directions or the access
-- predicates answer the wrong question. A row claiming kind='server' with no
-- server joins to no `server_members` row and vanishes from every read path,
-- while a conversation that kept a server_id would be visible to that server's
-- owners and admins through the role branch of `channelVisibleSql` — a private
-- conversation leaking to people who were never in it. Pairing them is what
-- makes "is this a conversation" a fact about the row itself.
--
-- ADD CONSTRAINT is not idempotent, so it uses the same DROP-then-ADD block as
-- the server_members role check above. An exception rolls the whole block back,
-- so a database whose rows currently violate this keeps the constraint it
-- already had, and heals on the next boot after the rows are fixed.
DO $$
BEGIN
  ALTER TABLE channels DROP CONSTRAINT IF EXISTS channels_server_kind_check;
  ALTER TABLE channels
    ADD CONSTRAINT channels_server_kind_check
    CHECK ((kind = 'server') = (server_id IS NOT NULL));
EXCEPTION
  WHEN others THEN NULL;
END $$;

-- Participants of a conversation are rows here, same as the allowlist of a
-- private server channel — so `channel_members` is the one membership table and
-- idx_channel_members_user_channel below already indexes the user→channels
-- direction the conversation list needs.
CREATE TABLE IF NOT EXISTS channel_members (
  channel_id UUID NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  added_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (channel_id, user_id)
);

-- The 1:1 conversation index, keyed by the *sorted* uuid pair.
--
-- Sorting is the entire reason this table exists rather than a unique index
-- over an unordered pair: (a,b) and (b,a) are two different rows to Postgres,
-- so two people tapping "message" on each other in the same instant would each
-- insert their own and end up in two different conversations, each seeing half
-- the thread. Sorted, both inserts collide on one primary key and the loser
-- reads the winner's channel — which is what makes POST /api/dms idempotent
-- under concurrency without taking a lock. The CHECK is what keeps that true:
-- an unsorted row written by mistake re-opens the race for that pair forever.
--
-- Group DMs are deliberately absent. They have no canonical identity — the same
-- three people may want two separate rooms — so a group is always created new.
CREATE TABLE IF NOT EXISTS dm_pairs (
  low_user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  high_user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  channel_id UUID NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  PRIMARY KEY (low_user_id, high_user_id),
  CHECK (low_user_id < high_user_id)
);

-- Unique rather than plain: one channel is at most one pair. It also gives the
-- ON DELETE CASCADE an index to use, without which every channel delete
-- seq-scans this table.
CREATE UNIQUE INDEX IF NOT EXISTS idx_dm_pairs_channel
  ON dm_pairs (channel_id);

CREATE TABLE IF NOT EXISTS server_invites (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  server_id UUID NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  code TEXT NOT NULL UNIQUE,
  created_by UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  max_uses INTEGER,
  uses INTEGER NOT NULL DEFAULT 0,
  expires_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Bans outlive membership, so a kicked user cannot walk back in with an invite.
CREATE TABLE IF NOT EXISTS server_bans (
  server_id UUID NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  banned_by UUID REFERENCES users(id) ON DELETE SET NULL,
  reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (server_id, user_id)
);

-- CREATE TABLE IF NOT EXISTS never adds a column to a table that already exists,
-- so databases created before `reason` need it backfilled explicitly.
ALTER TABLE server_bans ADD COLUMN IF NOT EXISTS reason TEXT;

CREATE TABLE IF NOT EXISTS messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  channel_id UUID NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  author_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  body TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  edited_at TIMESTAMPTZ
);

ALTER TABLE messages ADD COLUMN IF NOT EXISTS edited_at TIMESTAMPTZ;

-- Replies point at the message they answer. ON DELETE SET NULL, never CASCADE:
-- deleting one message must not silently take every answer to it with it.
ALTER TABLE messages ADD COLUMN IF NOT EXISTS reply_to_id UUID
  REFERENCES messages(id) ON DELETE SET NULL;

-- Partial: the overwhelming majority of messages are not replies, and this index
-- only exists to make the parent lookup and the SET NULL sweep cheap.
CREATE INDEX IF NOT EXISTS idx_messages_reply_to
  ON messages (reply_to_id) WHERE reply_to_id IS NOT NULL;

-- ------------------------------------------------------------------ chance + polls
--
-- A slash randomizer stores its structured result on the message. The plaintext
-- `body` is still written so search, notifications, and older clients have
-- something to show. A poll is a sibling of the message (one-to-one) rather
-- than a JSON blob: votes need a real unique constraint per option and user.
ALTER TABLE messages ADD COLUMN IF NOT EXISTS chance JSONB;

CREATE TABLE IF NOT EXISTS polls (
  message_id UUID PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,
  question TEXT NOT NULL,
  allow_multiselect BOOLEAN NOT NULL DEFAULT FALSE,
  closes_at TIMESTAMPTZ NOT NULL,
  closed_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS poll_options (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  message_id UUID NOT NULL REFERENCES polls(message_id) ON DELETE CASCADE,
  position INT NOT NULL,
  label TEXT NOT NULL,
  UNIQUE (message_id, position)
);

CREATE TABLE IF NOT EXISTS poll_votes (
  option_id UUID NOT NULL REFERENCES poll_options(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  PRIMARY KEY (option_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_poll_options_message
  ON poll_options (message_id, position);

CREATE INDEX IF NOT EXISTS idx_poll_votes_user
  ON poll_votes (user_id);

-- One shuffled shoe per channel. /draw takes from the front; /shuffle replaces it.
CREATE TABLE IF NOT EXISTS channel_decks (
  channel_id UUID PRIMARY KEY REFERENCES channels(id) ON DELETE CASCADE,
  remaining JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ------------------------------------------------------------------ search
--
-- Full-text search. Everything the index and the query have to agree on lives
-- in this block: the two text search configurations, the expression the stored
-- column is generated from, and the two functions services/search.ts calls.
-- The application names no configuration at all — if it could, the query could
-- be stemmed differently from the index, which does not fail, it just quietly
-- stops matching.
--
-- Portuguese AND English, both accent-folded, indexed side by side. The
-- audience is Brazilian and the product's own vocabulary is English, and a
-- single configuration cannot serve both: measured over 30 Portuguese and 15
-- English word pairs a reader would expect to match each other,
--
--   config          pt      en
--   'english'        2/30   15/15   <- what this used to be
--   'portuguese'    10/30    2/15   <- merely the inverse mistake
--   'simple'         0/30    0/15
--   pt||en          10/30   15/15   <- stemming both ways, still accent-blind
--   pqp_pt||pqp_en  25/30   15/15   <- this
--
-- Half of the Portuguese failures are nothing to do with stemming: Brazilians
-- type "nao", "voce", "reuniao" and the message says "não", "você", "reunião".
-- unaccent fixes those and costs a little stemmer accuracy on the words that
-- keep their accents (the snowball rules read them), which the numbers say is
-- a trade worth taking.
--
-- Cost, measured on 100k chat-length rows: GIN index 2.5 MB -> 3.9 MB, stored
-- vectors 12 MB -> 18 MB, and ~6 microseconds more per INSERT. Two ORed halves
-- also make stop words harmless in both directions — a query that is all
-- Portuguese stop words survives in the English half and vice versa, so
-- neither list can silently empty a query.
--
-- Consequence to know about: `||` shifts the second half's positions past the
-- first, so ts_rank_cd's proximity is only meaningful within a half, and a word
-- both stemmers agree on is counted twice. Rank order is approximate anyway.

-- unaccent is a *trusted* extension from PG13 on, so the database owner can
-- install it without superuser. If a host refuses anyway, warn and carry on
-- with plain snowball: initDb() throwing is process.exit(1), and search being
-- accent-sensitive is not worth a boot loop.
DO $$
BEGIN
  CREATE EXTENSION IF NOT EXISTS unaccent;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'pqp: unaccent unavailable (%) — search will be accent-sensitive',
    SQLERRM;
END $$;

-- pqp_pt / pqp_en. Two configurations rather than one with both stemmers
-- chained: a snowball dictionary accepts every token it is handed, so anything
-- after it in a mapping is unreachable.
--
-- ALTER MAPPING replaces, so re-running this is a catalog write and nothing
-- more. It does NOT recompute stored vectors — that is what the fingerprint
-- below is for.
DO $$
DECLARE
  dicts TEXT;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_ts_config WHERE cfgname = 'pqp_pt') THEN
    CREATE TEXT SEARCH CONFIGURATION pqp_pt (COPY = portuguese);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_ts_config WHERE cfgname = 'pqp_en') THEN
    CREATE TEXT SEARCH CONFIGURATION pqp_en (COPY = english);
  END IF;

  -- Visible, not merely present: an unaccent installed into a schema outside
  -- search_path is one the ALTER below could not resolve by bare name.
  dicts := CASE
    WHEN EXISTS (
      SELECT 1 FROM pg_ts_dict d
      WHERE d.dictname = 'unaccent' AND pg_ts_dict_is_visible(d.oid))
    THEN 'unaccent, ' ELSE '' END;

  EXECUTE format(
    'ALTER TEXT SEARCH CONFIGURATION pqp_pt
       ALTER MAPPING FOR hword, hword_part, word WITH %sportuguese_stem', dicts);
  EXECUTE format(
    'ALTER TEXT SEARCH CONFIGURATION pqp_en
       ALTER MAPPING FOR hword, hword_part, word WITH %senglish_stem', dicts);
END $$;

-- Two plural classes snowball's Portuguese stemmer does not handle, patched
-- ahead of it. These are not obscure: "mensagem"/"mensagens" is the first
-- example anyone reaches for, and this product's own nouns are the -ção family
-- — "configurações", "notificações", "opções", "sessões". Postgres stems every
-- one of those to something the singular does not share:
--
--   mensagem -> mensag   but  mensagens    -> mensagens
--   opção    -> opçã     but  opções       -> opçõ
--
-- Two word-final rewrites fix both classes, run before unaccent so they see the
-- accented spelling and before the stemmer so it gets a singular:
--
--   -ns  -> -m    mensagens, imagens, homens, ordens, fins, sons
--   -ões -> -ão   opções, configurações, reuniões, irmãos  (and the unaccented
--                 -oes/-aos/-aes people actually type)
--
-- Two chars of stem are required first, which is what keeps "uns", "aos" and
-- "nos" out of it. Being deterministic and applied to the query as well as the
-- body, a wrong rewrite cannot lose a match — "runs" becomes "rum" on both
-- sides and still finds itself (and the English half stems it properly
-- regardless). The only cost of a bad rule is two unrelated words colliding.
--
-- Not attempted: -l/-is ("canal"/"canais"). Its rules need the accent to
-- disambiguate — "papéis" is "papel" but "fáceis" is "fácil" — which the
-- unaccented spellings people type do not carry. Doing it properly needs a
-- hunspell pt_BR dictionary, and that means dictionary files on the database
-- host, which managed Postgres does not give us.
CREATE OR REPLACE FUNCTION pqp_pt_plurals(t TEXT) RETURNS TEXT
  LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE AS $$
  SELECT regexp_replace(
           regexp_replace(t, '(\m\w{2,})(ões|ãos|ães|oes|aos|aes)\M', '\1ao', 'gi'),
           '(\m\w{2,})ns\M', '\1m', 'gi')
$$;

-- The query side of the pair. services/search.ts calls these and never names a
-- configuration itself, so index and query cannot disagree.
CREATE OR REPLACE FUNCTION pqp_search_query(q TEXT) RETURNS tsquery
  LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE AS $$
  SELECT websearch_to_tsquery('pqp_pt', pqp_pt_plurals(q))
      || websearch_to_tsquery('pqp_en', q)
$$;

-- ts_headline re-parses the body under one configuration, so a hit found by the
-- other half would come back with nothing marked up. Try Portuguese, and only
-- when it highlighted nothing pay for the English pass. `marker` is the
-- caller's StartSel so the highlight delimiters stay defined in one place
-- (@pqp/shared) rather than being restated in SQL.
CREATE OR REPLACE FUNCTION pqp_search_headline(
  body TEXT, q tsquery, opts TEXT, marker TEXT
) RETURNS TEXT LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE AS $$
  SELECT CASE WHEN pt.h LIKE '%' || marker || '%' THEN pt.h
              ELSE ts_headline('pqp_en', body, q, opts) END
  FROM (SELECT ts_headline('pqp_pt', body, q, opts) AS h) pt
$$;
-- When neither half highlights anything both calls return the same thing —
-- the opening fragment of the body — so the fallback needs no third branch.

-- The stored vector. GENERATED ... STORED rather than a trigger: it cannot
-- drift from the body it describes, edits maintain it for free, and existing
-- rows are backfilled by the ALTER.
--
-- Changing the expression means dropping and re-adding the column, which
-- rewrites the table under ACCESS EXCLUSIVE and rebuilds the GIN index. This
-- file runs on EVERY boot, so doing that unconditionally would be a rewrite per
-- restart. The guard is a fingerprint stashed in the column's COMMENT: the
-- expression text plus the lexemes the whole pipeline actually produces for a
-- canary string. Comparing the expression alone would not be enough — ALTERing
-- a configuration, replacing pqp_pt_plurals, or unaccent appearing on a host
-- that lacked it all change the lexemes without changing one character of the
-- expression, and Postgres does not recompute stored generated columns when
-- that happens. Running the canary through the real expression catches every
-- one of those; the comment lives and dies with the column, so a dropped
-- column cannot leave a marker claiming it is current.
--
-- This is the cheapest moment this migration will ever have: production holds
-- 26 messages. A version of this against a large table would need a new column
-- written in batches, CREATE INDEX CONCURRENTLY, and a swap — none of which is
-- possible inside schema.sql, because the whole file is one implicit
-- transaction and CONCURRENTLY cannot run in one.
DO $$
DECLARE
  -- One template, filled with `body` to build the column and with the canary to
  -- fingerprint it — so the fingerprint is the output of this exact expression
  -- rather than a second description of it that could fall behind.
  expr CONSTANT TEXT :=
    'to_tsvector(''pqp_pt'', pqp_pt_plurals(%1$s)) || to_tsvector(''pqp_en'', %1$s)';
  -- Accents, both plural classes, stemming, and both stop word lists in one
  -- string. Anything the fingerprint should notice has to be exercised here.
  canary CONSTANT TEXT :=
    'não configurações mensagens jogando deploying the de para com';
  column_expr TEXT;
  lexemes TEXT;
  marker TEXT;
  col_attnum SMALLINT;
BEGIN
  column_expr := format(expr, 'body');
  EXECUTE format('SELECT (%s)::text', format(expr, quote_literal(canary)))
    INTO lexemes;
  marker := 'pqp-search ' || md5(column_expr || '|' || lexemes);

  SELECT a.attnum INTO col_attnum FROM pg_attribute a
  WHERE a.attrelid = 'messages'::regclass AND a.attname = 'search_tsv'
    AND NOT a.attisdropped;

  IF col_attnum IS NULL THEN
    EXECUTE format(
      'ALTER TABLE messages ADD COLUMN search_tsv tsvector
         GENERATED ALWAYS AS (%s) STORED', column_expr);
  ELSIF col_description('messages'::regclass, col_attnum) IS DISTINCT FROM marker THEN
    -- Dropping the column takes idx_messages_search with it; the CREATE INDEX
    -- below puts it back.
    ALTER TABLE messages DROP COLUMN search_tsv;
    EXECUTE format(
      'ALTER TABLE messages ADD COLUMN search_tsv tsvector
         GENERATED ALWAYS AS (%s) STORED', column_expr);
  ELSE
    RETURN; -- already current: no rewrite, no comment write
  END IF;

  EXECUTE format('COMMENT ON COLUMN messages.search_tsv IS %L', marker);
END $$;

CREATE INDEX IF NOT EXISTS idx_messages_search
  ON messages USING GIN (search_tsv);

-- (channel_id, created_at, id) keeps keyset pagination ordering stable when two
-- messages land in the same millisecond.
CREATE INDEX IF NOT EXISTS idx_messages_channel_created
  ON messages (channel_id, created_at DESC, id DESC);

-- Who was @-mentioned, resolved at write time so unread badges are a join
-- rather than a scan of every message body.
CREATE TABLE IF NOT EXISTS message_mentions (
  message_id UUID NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  PRIMARY KEY (message_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_message_mentions_user
  ON message_mentions (user_id);

-- Per-user read cursor. Absent row means "never opened", which reads as
-- everything unread.
CREATE TABLE IF NOT EXISTS channel_reads (
  channel_id UUID NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  last_read_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (channel_id, user_id)
);

CREATE TABLE IF NOT EXISTS message_reactions (
  message_id UUID NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  emoji TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (message_id, user_id, emoji)
);

-- Uploaded files. The bytes live in S3-compatible object storage (R2 hosted,
-- MinIO for self-hosters); this table is the index that names them.
--
-- storage_key is generated by the server when the upload URL is minted, never
-- taken from the client: a client-chosen key lets one user sign a PUT over
-- another user's object.
--
-- A row is born with message_id NULL and is claimed by the message insert in
-- the same transaction, so "unclaimed" is an ordinary in-flight state rather
-- than corruption.
--
-- ON DELETE SET NULL, not CASCADE. CASCADE is the obvious-looking choice and it
-- is the one that leaks forever: deleting a message would delete the only row
-- that records its storage keys, leaving the objects in the bucket with nothing
-- left to name them. SET NULL instead files a deleted message's attachments
-- back under exactly the predicate that already covers uploads nobody ever
-- posted, so one sweeper — message_id IS NULL AND created_at older than an hour
-- — deletes both the row and the object for both cases.
CREATE TABLE IF NOT EXISTS message_attachments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  message_id UUID REFERENCES messages(id) ON DELETE SET NULL,
  channel_id UUID NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  uploader_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  storage_key TEXT NOT NULL UNIQUE,
  filename TEXT NOT NULL,
  content_type TEXT NOT NULL,
  byte_size BIGINT NOT NULL,
  width INTEGER,
  height INTEGER,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- The sender's order, recorded at claim time. created_at is mint order, which
-- is not the same thing: mints are issued concurrently and an image waits on a
-- decode before it mints, so dropping photo.png then clip.mp4 routinely mints
-- the video first and the message would silently reorder itself on the next
-- reload. Rows claimed before this column existed all read 0 and keep falling
-- back to created_at.
ALTER TABLE message_attachments
  ADD COLUMN IF NOT EXISTS position SMALLINT NOT NULL DEFAULT 0;

-- An attachment whose bytes live on somebody else's host. GIFs are the case:
-- the picker returns a GIF provider URL, and re-hosting a GIF we are allowed
-- to hot-link would cost storage and egress to gain nothing.
--
-- Making a GIF an attachment rather than the message body is what lets it carry
-- a caption, be edited without exposing the URL, and be previewed before
-- sending. While a GIF *was* the body, adding a word to it stopped it rendering
-- as media, because the render test is "the body is nothing but a GIF URL".
--
-- Exactly one source per row: `storage_key` for bytes we hold, `remote_url` for
-- bytes we do not. The CHECK is what stops a row from being silently both or
-- neither, which the delete and sweep paths would each read the wrong way.
ALTER TABLE message_attachments ALTER COLUMN storage_key DROP NOT NULL;
ALTER TABLE message_attachments ADD COLUMN IF NOT EXISTS remote_url TEXT;

DO $$
BEGIN
  ALTER TABLE message_attachments DROP CONSTRAINT IF EXISTS message_attachments_source_check;
  ALTER TABLE message_attachments
    ADD CONSTRAINT message_attachments_source_check
    CHECK ((storage_key IS NULL) <> (remote_url IS NULL));
EXCEPTION
  WHEN others THEN NULL;
END $$;

-- Partial on both sides, because the two access patterns never overlap: reads
-- fetch attachments for a page of messages, the sweeper only ever looks at rows
-- with no message. A single full index would carry each set through the other's
-- lookups for nothing.
CREATE INDEX IF NOT EXISTS idx_message_attachments_message
  ON message_attachments (message_id) WHERE message_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_message_attachments_unclaimed
  ON message_attachments (created_at) WHERE message_id IS NULL;

-- ---------------------------------------------------------------- image safety
--
-- The verdict a content scanner reached about this object, kept on the row
-- rather than in a side table because it is a property OF the attachment and
-- every path that reads an attachment already has this row in hand.
--
-- It exists to be evidence. A takedown, a police request or an appeal all ask
-- the same question months later — "what did you know, when, and who told you"
-- — and a boolean `is_safe` cannot answer any of it. Provider, score, labels
-- and timestamp are recorded together so the answer is reconstructable from the
-- row alone, without the provider's own logs (which a free tier does not keep).
--
-- `unscanned` is the default and is deliberately NOT a synonym for `pass`. It
-- is the honest state of every row written before scanning existed, and of
-- every row on a deployment with no scanner configured. Anything that treats
-- the two as equivalent is claiming a check that never ran.
--
--   unscanned  no scanner configured, or the row predates scanning
--   skipped    scanner configured, but this type is not scannable (video, pdf)
--   pass       the scanner looked and found nothing over threshold
--   flagged    over the review threshold: visible, but a report was filed
--   rejected   over the block threshold: never attached, object quarantined
--   error      the scanner could not answer (down, timed out, garbage back)
--
-- `error` is a terminal recorded state and not a retry queue. Under the default
-- fail-closed mode an `error` row is dropped from its message exactly like a
-- failed HEAD, so it is already invisible; the row survives so that "the
-- scanner was broken between 14:00 and 15:00" is a fact on disk rather than an
-- inference from missing images.
ALTER TABLE message_attachments
  ADD COLUMN IF NOT EXISTS scan_status TEXT NOT NULL DEFAULT 'unscanned';

DO $$
BEGIN
  ALTER TABLE message_attachments DROP CONSTRAINT IF EXISTS message_attachments_scan_status_check;
  ALTER TABLE message_attachments
    ADD CONSTRAINT message_attachments_scan_status_check
    CHECK (scan_status IN ('unscanned', 'skipped', 'pass', 'flagged', 'rejected', 'error'));
EXCEPTION
  WHEN others THEN NULL;
END $$;

-- Which scanner said so. Null while `scan_status = 'unscanned'`; a provider name
-- afterwards, so switching provider does not silently reinterpret old verdicts
-- against a new one's scale.
ALTER TABLE message_attachments ADD COLUMN IF NOT EXISTS scan_provider TEXT;

-- The highest category score the provider returned, 0..1. Normalised by the
-- adapter, because "0.94" means nothing without knowing whose 0.94 it is — which
-- is what `scan_provider` above is for.
ALTER TABLE message_attachments ADD COLUMN IF NOT EXISTS scan_score REAL;

-- The categories that crossed the threshold, as a JSON array of strings. The
-- score says how sure; this says of what, and it is the part a human reading a
-- report actually needs.
ALTER TABLE message_attachments ADD COLUMN IF NOT EXISTS scan_labels JSONB;

ALTER TABLE message_attachments ADD COLUMN IF NOT EXISTS scanned_at TIMESTAMPTZ;

-- Set when a scan rejected the object. Two things follow from it, and they are
-- the whole reason it is a timestamp and not a flag on `scan_status`:
--
-- 1. THE SWEEPER MUST NOT TOUCH IT. A rejected attachment is never claimed, so
--    its `message_id` stays NULL and the orphan sweep would delete row and
--    object within the hour — destroying the only evidence that the upload ever
--    happened, at the exact moment a moderator is being asked to look at it.
-- 2. IT IS NOT KEPT FOREVER EITHER. Holding illegal material indefinitely is
--    its own problem, and an operator who has not looked at their queue in a
--    month is not going to. The sweeper collects quarantined rows once
--    `CONTENT_SCAN_QUARANTINE_DAYS` (default 30) has passed, which is long
--    enough to answer a request and short enough not to become an archive.
ALTER TABLE message_attachments ADD COLUMN IF NOT EXISTS quarantined_at TIMESTAMPTZ;

-- The quarantine sweep's whole working set, and tiny — partial so it costs
-- nothing on a deployment that has never quarantined anything, which is every
-- deployment with no scanner configured.
CREATE INDEX IF NOT EXISTS idx_message_attachments_quarantined
  ON message_attachments (quarantined_at) WHERE quarantined_at IS NOT NULL;

-- Pinned messages surface the ones worth finding again without a search. Kept
-- on the message row rather than a join table: a message can be pinned in
-- only one place (its own channel), so a separate table would let two rows
-- reference the same pin for no reason, and every existing read path already
-- has the message row in hand.
ALTER TABLE messages ADD COLUMN IF NOT EXISTS pinned_at TIMESTAMPTZ;
-- ON DELETE SET NULL, matching reply_to_id and message_attachments: the
-- account that pinned something leaving the server must not silently unpin it
-- or leave a dangling reference.
ALTER TABLE messages ADD COLUMN IF NOT EXISTS pinned_by UUID
  REFERENCES users(id) ON DELETE SET NULL;

-- Partial for the same reason idx_messages_reply_to is: the overwhelming
-- majority of rows are never pinned, and this index exists only to make "list
-- this channel's pins" and the cap check on pinning a new one cheap.
CREATE INDEX IF NOT EXISTS idx_messages_pinned
  ON messages (channel_id, pinned_at DESC) WHERE pinned_at IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_channels_server
  ON channels (server_id, position);

-- A category is another channel row (type='category') rather than a separate
-- table: Discord's own model, and it means permission-overwrite inheritance —
-- not built yet — will one day walk one table instead of two. `parent_id`
-- only ever points at such a row; that a category cannot itself have a parent
-- is enforced in the service layer, where the type of the prospective parent
-- is already known from the same read that validates the rest of a move.
--
-- ON DELETE SET NULL, not CASCADE: deleting a category must not delete every
-- channel that was ever inside it, only uncategorize them.
--
-- `position` is scoped by (parent_id, type) at the top level rather than by
-- parent_id alone: the sidebar renders top-level text, top-level voice and
-- categories as three separate lists, not one interleaved one, so `type` has
-- to be part of a top-level sibling group or reordering one list would
-- silently perturb the position numbers of a completely different one. Inside
-- a real category the group is not type-scoped — text and voice channels mix
-- together there, matching how the sidebar nests them under one heading. See
-- the comment on `moveChannel` in services/servers.ts for where this is
-- actually enforced.
ALTER TABLE channels ADD COLUMN IF NOT EXISTS parent_id UUID
  REFERENCES channels(id) ON DELETE SET NULL;

DO $$
BEGIN
  ALTER TABLE channels DROP CONSTRAINT IF EXISTS channels_type_check;
  ALTER TABLE channels
    ADD CONSTRAINT channels_type_check
    CHECK (type IN ('text', 'voice', 'category'));
EXCEPTION
  WHEN others THEN NULL;
END $$;

CREATE INDEX IF NOT EXISTS idx_channels_parent
  ON channels (server_id, parent_id, position);

CREATE INDEX IF NOT EXISTS idx_server_members_user
  ON server_members (user_id);

-- Look up a user's rows across channels — the reverse of the (channel_id,
-- user_id) primary key, which cannot serve this direction.
CREATE INDEX IF NOT EXISTS idx_channel_members_user_channel
  ON channel_members (user_id, channel_id);

-- Redundant with existing UNIQUE constraints (server_invites.code is UNIQUE;
-- message_reactions' UNIQUE leads with message_id), so they only cost writes.
DROP INDEX IF EXISTS idx_server_invites_code;
DROP INDEX IF EXISTS idx_message_reactions_message;
DROP INDEX IF EXISTS idx_channel_members_user;

-- A pasted link's unfurl, cached by the URL itself rather than by the message
-- that posted it: the same link shared in ten channels costs one fetch, not
-- ten, and `server/src/lib/safe-fetch.ts` is the only thing in this process
-- ever allowed to make that fetch. `url_hash` is sha256 of the normalised URL
-- (see embeds.ts) rather than the URL itself as the key, so an absurdly long
-- URL cannot make this the row that breaks a btree entry size limit.
--
-- `failed` gets its own short TTL in the service layer rather than its own
-- column here: a site that was briefly down is worth retrying sooner than a
-- working unfurl is worth re-fetching, and that is a policy decision, not a
-- fact about the row.
CREATE TABLE IF NOT EXISTS link_embeds (
  url_hash TEXT PRIMARY KEY,
  url TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('link', 'image')),
  title TEXT,
  description TEXT,
  site_name TEXT,
  image_url TEXT,
  image_width INTEGER,
  image_height INTEGER,
  failed BOOLEAN NOT NULL DEFAULT FALSE,
  fetched_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- `id` (not `(created_at, id)`) is the whole cursor: a BIGSERIAL is already a
-- strict total order matching insertion order, so unlike message history
-- there is no tie to break and no "cursor row was deleted" fragility — the
-- cursor is a bare integer, never a lookup of a row that retention may have
-- already purged.
CREATE TABLE IF NOT EXISTS audit_log (
  id BIGSERIAL PRIMARY KEY,
  server_id UUID NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  -- SET NULL rather than CASCADE: the departed actor is exactly the fact an
  -- audit entry exists to preserve, so their account going away must not take
  -- the record of what they did with it.
  actor_id UUID REFERENCES users(id) ON DELETE SET NULL,
  action TEXT NOT NULL,
  target_type TEXT,
  target_id UUID,
  reason TEXT,
  changes JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_audit_log_server_id ON audit_log (server_id, id DESC);

-- Null means keep forever. Server-wide rather than per-channel for v1 — a
-- community that wants different windows per channel is a real but much
-- rarer request than "auto-clean this whole server after N days."
ALTER TABLE servers ADD COLUMN IF NOT EXISTS message_retention_days INTEGER;

DO $$
BEGIN
  ALTER TABLE servers DROP CONSTRAINT IF EXISTS servers_retention_positive;
  ALTER TABLE servers
    ADD CONSTRAINT servers_retention_positive
    CHECK (message_retention_days IS NULL OR message_retention_days > 0);
EXCEPTION
  WHEN others THEN NULL;
END $$;

-- Incoming webhooks: an external service POSTs Discord's own wire format
-- (`content`/`username`/`avatar_url`/`embeds`) to
-- `/api/webhooks/:id/:token` with no Clerk auth at all — `token` is the only
-- credential, so it has to be long and looked up by unique index, not
-- guessed. Deleting a webhook removes the row here but never the pseudo-user
-- it posted as (see the `users.is_webhook` comment) or the messages it sent —
-- Discord itself keeps a deleted webhook's history too.
CREATE TABLE IF NOT EXISTS webhooks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  channel_id UUID NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  server_id UUID NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  avatar_url TEXT,
  token TEXT NOT NULL,
  pseudo_user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_webhooks_token ON webhooks (token);
CREATE INDEX IF NOT EXISTS idx_webhooks_channel ON webhooks (channel_id);

-- The rich-embed subset a webhook payload supplied (title/description/url/
-- color/fields/footer) — a wholly different concept from `link_embeds`,
-- which is the server's own automatic unfurl of a URL someone typed. A
-- webhook message can carry both: pasted a link (auto-unfurled) and been
-- sent with its own `embeds` array (this column) in the same request.
ALTER TABLE messages ADD COLUMN IF NOT EXISTS webhook_embeds JSONB;

-- Discord's own webhooks let a single execution override the display name
-- and avatar the webhook otherwise defaults to — one CI job posting as
-- "Build Bot" and another as "Deploy Bot" through the same token. Per
-- message rather than on the pseudo-user itself, since two executions of
-- the same webhook can each choose a different override.
ALTER TABLE messages ADD COLUMN IF NOT EXISTS webhook_username TEXT;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS webhook_avatar_url TEXT;

-- Outgoing channel webhooks: pqp POSTs a signed event to a URL the owner
-- pasted, after a human message commits. A different table from `webhooks`
-- on purpose — incoming tokens and outgoing HMAC secrets are not the same
-- credential, and merging them would make a rotate of one look like a rotate
-- of the other.
CREATE TABLE IF NOT EXISTS outgoing_webhooks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  server_id UUID NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  url TEXT NOT NULL,
  -- Text-channel allowlist. Empty is refused at write time; the CHECK is the
  -- last line of defence if a caller skips that.
  channel_ids UUID[] NOT NULL,
  signing_secret TEXT NOT NULL,
  signing_secret_previous TEXT,
  previous_secret_expires_at TIMESTAMPTZ,
  auth_header_name TEXT,
  auth_header_value TEXT,
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'disabled', 'failing')),
  last_error TEXT,
  last_delivered_at TIMESTAMPTZ,
  disabled_reason TEXT,
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT outgoing_webhooks_channel_ids_nonempty
    CHECK (cardinality(channel_ids) >= 1),
  CONSTRAINT outgoing_webhooks_auth_header_pair
    CHECK (
      (auth_header_name IS NULL AND auth_header_value IS NULL)
      OR (auth_header_name IS NOT NULL AND auth_header_value IS NOT NULL)
    ),
  CONSTRAINT outgoing_webhooks_auth_header_name_ok
    CHECK (
      auth_header_name IS NULL
      OR auth_header_name IN ('Authorization', 'X-Webhook-Secret', 'X-Api-Key')
    )
);
CREATE INDEX IF NOT EXISTS idx_outgoing_webhooks_server
  ON outgoing_webhooks (server_id);

-- Outbox + DLQ. `id` is the Standard Webhooks `webhook-id` and stays stable
-- across retries. UNIQUE (hook, message) so a double enqueue from a retrying
-- worker cannot fire the same event twice.
CREATE TABLE IF NOT EXISTS outgoing_webhook_deliveries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  outgoing_webhook_id UUID NOT NULL REFERENCES outgoing_webhooks(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL DEFAULT 'message.created',
  payload JSONB NOT NULL,
  message_id UUID NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'delivering', 'delivered', 'dead')),
  attempt_count INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_status_code INTEGER,
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (outgoing_webhook_id, message_id)
);
CREATE INDEX IF NOT EXISTS idx_outgoing_webhook_deliveries_pending
  ON outgoing_webhook_deliveries (next_attempt_at)
  WHERE status IN ('pending', 'delivering');

-- SSO / enterprise domain join. Clerk performs the actual SAML/OIDC handshake,
-- so nothing here speaks SAML — what the app needs is the piece Clerk cannot
-- know: which pqp server a federated user should land in.
--
-- Only the *domain* is stored, never the address. It is all this feature needs,
-- and a domain is not personal data the way a mailbox is.
--
-- Written only from Clerk emails whose verification status is "verified".
-- An unverified address is self-asserted, so honouring one would let anyone
-- type `someone@acme.com` and walk into Acme's private server.
--
-- Every verified address contributes, not just the primary: someone whose
-- primary is personal and whose work address is a verified secondary would
-- otherwise be locked out of their own employer's server.
ALTER TABLE users ADD COLUMN IF NOT EXISTS email_domains TEXT[] NOT NULL DEFAULT '{}';

-- Null means the feature is off for this server (the default). When set, any
-- user whose verified `users.email_domain` matches exactly may join without an
-- invite. Exact match only — no subdomain or suffix matching, or `acme.com`
-- would also admit `acme.com.evil.test`.
ALTER TABLE servers ADD COLUMN IF NOT EXISTS sso_email_domain TEXT;
CREATE INDEX IF NOT EXISTS idx_servers_sso_email_domain
  ON servers (sso_email_domain) WHERE sso_email_domain IS NOT NULL;

-- Public status page samples. One row per component per probe, which is what
-- turns "is it up right now" into a real uptime figure rather than a claim.
--
-- Deliberately not tied to any user or server: this is the only table whose
-- contents are readable without authenticating, so nothing about who uses the
-- instance may ever be recorded here.
CREATE TABLE IF NOT EXISTS status_samples (
  id BIGSERIAL PRIMARY KEY,
  component TEXT NOT NULL,
  ok BOOLEAN NOT NULL,
  latency_ms INTEGER,
  checked_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_status_samples_component
  ON status_samples (component, checked_at DESC);

-- Reports: a member telling somebody whose job it is that a message or a person
-- needs looking at.
--
-- THE REPORT MUST OUTLIVE EVERYTHING IT POINTS AT. The first thing a moderator
-- does with a bad message is delete it, and the first thing the author does
-- when they see a report coming is the same — so `ON DELETE CASCADE` on
-- `reported_message_id` would destroy the evidence at exactly the moment it
-- starts to matter, and would hand anyone a one-click way to erase the record
-- of their own conduct. Every reference here is therefore `ON DELETE SET NULL`,
-- and the row carries its own copy of what it is about:
--
--   * `content_snapshot`  — the reported message body, verbatim, at report time.
--     This is the evidence. Copying user content into a second table is a real
--     privacy cost, which is why it is bounded to the *one* message that was
--     reported (never the surrounding thread) and why the sweep below exists.
--   * `subject_label` / `channel_label` — display names at report time, so a
--     queue still reads sensibly after a rename, a departure, or a delete.
--
-- The FKs are kept alongside the snapshots rather than replaced by them: while
-- the message still exists a moderator wants to jump to it in context, and
-- `message_id IS NULL AND content_snapshot IS NOT NULL` is precisely the
-- "reported content has since been deleted" state the queue renders.
--
-- WHERE A REPORT GOES IS A FACT ABOUT THE ROW, not a filter a later query has
-- to remember. `context_kind` is copied from `channels.kind` (or 'none' for a
-- report filed about a person with no place attached), and the CHECK below
-- pairs it with `server_id` in both directions, exactly the way
-- `channels_server_kind_check` pairs kind with server_id. A conversation report
-- therefore *cannot* carry a server_id, so the server-scoped queue query
-- (`WHERE server_id = $1`) can never return one however it is written later.
-- See the `channelVisibleSql` comment in services/users.ts: a conversation has
-- no role escape hatch, and neither does a report about one.
CREATE TABLE IF NOT EXISTS reports (
  id BIGSERIAL PRIMARY KEY,
  -- SET NULL rather than CASCADE, same reasoning as `audit_log.actor_id`: a
  -- reporter deleting their account must not wipe an open queue. The report is
  -- a record about somebody else's conduct, not about the reporter.
  reporter_id UUID REFERENCES users(id) ON DELETE SET NULL,
  subject_type TEXT NOT NULL CHECK (subject_type IN ('message', 'user')),
  context_kind TEXT NOT NULL CHECK (context_kind IN ('server', 'dm', 'group', 'none')),

  reported_message_id UUID REFERENCES messages(id) ON DELETE SET NULL,
  -- The author of the reported message, or the person a user report is about.
  -- Always set at write time; null only once that account is gone.
  reported_user_id UUID REFERENCES users(id) ON DELETE SET NULL,

  server_id UUID REFERENCES servers(id) ON DELETE CASCADE,
  channel_id UUID REFERENCES channels(id) ON DELETE SET NULL,

  content_snapshot TEXT,
  subject_label TEXT,
  channel_label TEXT,

  reason TEXT NOT NULL,
  details TEXT,

  status TEXT NOT NULL DEFAULT 'open'
    CHECK (status IN ('open', 'actioned', 'dismissed')),
  resolved_by UUID REFERENCES users(id) ON DELETE SET NULL,
  resolved_at TIMESTAMPTZ,
  resolution_note TEXT,

  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- Exactly one subject, and it agrees with `subject_type`. A message report
  -- also names the author (in `reported_user_id`) so acting on the person is
  -- one click away; a user report has no message.
  CHECK (
    (subject_type = 'message') = (reported_message_id IS NOT NULL OR content_snapshot IS NOT NULL)
  ),
  -- Server context and server id imply each other. This is the constraint the
  -- DM-report permission rule rests on.
  CHECK ((context_kind = 'server') = (server_id IS NOT NULL)),
  -- A resolution is all-or-nothing: an entry that says "actioned" with nobody
  -- and no time attached is not an audit trail.
  CHECK (
    (status = 'open') = (resolved_at IS NULL)
  )
);

-- The server queue: open reports first, newest first, keyset-paginated on the
-- bare `id` — a BIGSERIAL is already a total order matching insertion, so the
-- cursor is an integer and never a lookup of a row that may have been resolved
-- since (the same reasoning as `audit_log`).
CREATE INDEX IF NOT EXISTS idx_reports_server_status
  ON reports (server_id, status, id DESC) WHERE server_id IS NOT NULL;

-- The instance queue: everything with no server, which is exactly the set no
-- server moderator may ever see.
CREATE INDEX IF NOT EXISTS idx_reports_instance_status
  ON reports (status, id DESC) WHERE server_id IS NULL;

-- "Show me what I reported", and the per-reporter flood cap.
CREATE INDEX IF NOT EXISTS idx_reports_reporter
  ON reports (reporter_id, id DESC);

-- Duplicate suppression, declared rather than checked-then-inserted: two taps
-- on a slow "Report" button are one report, and a script hammering the endpoint
-- gets a unique violation rather than a thousand rows in the queue.
--
-- Scoped to `status = 'open'` on purpose. Once a report is closed the same
-- person may report the same target again — that is a repeat offence, which is
-- the single most useful thing a queue can surface, not a duplicate.
CREATE UNIQUE INDEX IF NOT EXISTS idx_reports_open_message_dedupe
  ON reports (reporter_id, reported_message_id)
  WHERE status = 'open' AND reported_message_id IS NOT NULL;

-- The same rule for user reports, with the context folded in so "this person,
-- in this server" and "this person, in that server" stay distinct. COALESCE is
-- what makes it work at all: NULLs are distinct to a unique index, so a bare
-- (reporter, user, server) index would let unlimited duplicates through for the
-- instance-queue case where server_id is null.
CREATE UNIQUE INDEX IF NOT EXISTS idx_reports_open_user_dedupe
  ON reports (
    reporter_id,
    reported_user_id,
    COALESCE(server_id, '00000000-0000-0000-0000-000000000000'::uuid)
  )
  WHERE status = 'open' AND subject_type = 'user';

-- Spill space for cluster-bus frames that do not fit in a NOTIFY payload.
--
-- Postgres refuses a NOTIFY payload of 8000 bytes or more, and real frames do
-- exceed that: a 4000-character message body is up to ~16KB of UTF-8 before
-- JSON escaping, and a webhook message can carry ten embeds. The publisher
-- writes the frame here and notifies its id in the same statement; every other
-- instance reads it back by id. See `server/src/lib/bus-postgres.ts`.
--
-- Rows live for seconds and are swept on a timer — this is a mailbox, not
-- storage, and nothing may ever be recovered from it after the fact. Unused
-- entirely unless CLUSTER_BUS=postgres.
CREATE TABLE IF NOT EXISTS cluster_bus_payloads (
  id UUID PRIMARY KEY,
  payload TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_cluster_bus_payloads_created
  ON cluster_bus_payloads (created_at);

-- ---------------------------------------------------------------------------
-- Self-serve account deletion (LGPD art. 18, IV / VI)
-- ---------------------------------------------------------------------------

-- Set the instant a deletion is committed to, and cleared only by the row
-- ceasing to exist. It is the crash marker that makes `DELETE /api/me`
-- recoverable rather than a half-deleted account.
--
-- THE ORDER IS: stamp this column → delete the Clerk user → delete this row.
-- Every place that sequence can be interrupted leaves a row that still carries
-- this stamp, and `sweepPendingAccountDeletions` (services/account.ts) finishes
-- the job on a timer. Without the column there is nothing to find: a process
-- that dies between the Clerk call and the local DELETE would leave an account
-- that can never sign in again and whose data nobody knows to remove.
--
-- Nullable, with no default, so it costs an existing table nothing and every
-- account that has not asked to be deleted reads NULL.
ALTER TABLE users ADD COLUMN IF NOT EXISTS deletion_started_at TIMESTAMPTZ;

-- Partial, over the handful of rows mid-deletion at any moment — the sweeper is
-- the only reader and a full index would carry every account for nothing.
CREATE INDEX IF NOT EXISTS idx_users_deletion_started
  ON users (deletion_started_at) WHERE deletion_started_at IS NOT NULL;

-- ---------------------------------------------------------------------------
-- Temporary sanctions — timeouts
-- ---------------------------------------------------------------------------
--
-- The middle of the enforcement ladder. Everything about this table follows
-- from one requirement: A TIMEOUT MUST BE CORRECT WITHOUT A SWEEPER.
--
-- `expires_at` is the whole mechanism. Every read in services/sanctions.ts
-- carries `AND expires_at > NOW()`, so a timeout ends at the instant it says it
-- ends whether or not any background job is running, whether or not the process
-- restarted, and whether or not a replica's timer fired. The alternative — an
-- `active` boolean flipped by a cron — is wrong in the one direction that
-- matters: a sweeper that is late keeps somebody silenced past their sentence,
-- and nobody is watching for that failure because it looks exactly like the
-- feature working. `pruneExpiredTimeouts` exists, is called on the same daily
-- timer as the audit prune, and is *only* disk hygiene; deleting it would
-- change nothing about who may speak.
--
-- ONE ROW PER (SERVER, USER), not an append-only log of every sanction ever.
-- The primary key is the pair, and re-timing somebody out replaces the row.
-- Two reasons: the enforcement question is "is this person timed out right
-- now", and a history table forces every read to answer "which of these five
-- rows is the live one" — a question with a wrong answer. History lives in
-- `audit_log` (`member.timeout` / `member.timeout_lift`), which is where the
-- rest of this product's moderation history already lives and which is already
-- pruned at 90 days.
--
-- `issued_by` is `ON DELETE SET NULL` for the same reason `server_bans.banned_by`
-- is: the row is a fact about the *sanctioned* person and about the server, and
-- a moderator deleting their account must not silently un-silence everybody
-- they ever acted on. `user_id` is CASCADE, because a timeout on an account
-- that no longer exists is not a fact about anything.
CREATE TABLE IF NOT EXISTS member_timeouts (
  server_id UUID NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  issued_by UUID REFERENCES users(id) ON DELETE SET NULL,
  reason TEXT,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (server_id, user_id)
);

-- The enforcement lookup, which runs on the hot path of every WebSocket send
-- and every server-scoped HTTP write. Leading with `user_id` rather than
-- reusing the primary key is deliberate: the channel- and message-scoped
-- variants of the query join `channels`/`messages` to reach a server id, so
-- Postgres wants to start from the one column the query always has in hand.
CREATE INDEX IF NOT EXISTS idx_member_timeouts_user
  ON member_timeouts (user_id, expires_at);

-- Indexes that exist for the *delete*, not for a read.
--
-- `DELETE FROM users WHERE id = $1` fires every ON DELETE CASCADE / SET NULL
-- referencing this table, and Postgres does not index a referencing column for
-- you. Un-indexed, each of those is a sequential scan of the whole child table,
-- so deleting one account reads every message, every reaction and every audit
-- entry on the instance — inside one transaction. These five cover the children
-- that actually grow without bound; the rest (bans, invites, webhooks, dm_pairs,
-- reports) are small enough that a scan is cheaper than the index would be.
--
-- The messages one is deliberately `(author_id, created_at, id)` rather than
-- `(author_id)`: `GET /api/me/export` keyset-paginates one person's messages on
-- exactly that tuple, so the same index serves both halves of art. 18.
CREATE INDEX IF NOT EXISTS idx_messages_author_created
  ON messages (author_id, created_at, id);

-- `(created_at)` alone: the operator metrics (`GET /api/admin/metrics`) ask
-- "how many messages in the last 24/48 hours, by hour" with no channel or
-- author in the predicate, which neither index above can serve. Small, and
-- the only thing standing between that endpoint and a full scan per refresh.
CREATE INDEX IF NOT EXISTS idx_messages_created
  ON messages (created_at);
CREATE INDEX IF NOT EXISTS idx_message_reactions_user
  ON message_reactions (user_id);
CREATE INDEX IF NOT EXISTS idx_message_attachments_uploader
  ON message_attachments (uploader_id);
CREATE INDEX IF NOT EXISTS idx_channel_reads_user
  ON channel_reads (user_id);
CREATE INDEX IF NOT EXISTS idx_audit_log_actor
  ON audit_log (actor_id) WHERE actor_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- push  — Web Push subscriptions + APNs device tokens (services/push.ts)
-- ---------------------------------------------------------------------------
--
-- One row per *device registration*, whichever transport reaches it. The
-- identity column is UNIQUE across users, not per user: a browser profile holds
-- exactly one subscription and a phone holds exactly one APNs token, and if
-- another account signs in on that device the registration must follow the
-- account — two rows would push one person's mentions to whoever holds the
-- phone now.
--
-- Rows are capped per user (MAX_PUSH_SUBSCRIPTIONS_PER_USER, enforced on
-- insert) and garbage-collected on the vendor's own signal: a 404/410 from a
-- push service, or 410 Unregistered / 400 BadDeviceToken from APNs, deletes the
-- row. Nothing else prunes them, because nothing else knows a registration is
-- dead.
--
-- The p256dh/auth values are the browser-generated *public* encryption
-- parameters from PushSubscription.getKey() — no message content is ever
-- stored here, and neither the VAPID private key nor the APNs signing key ever
-- leaves the environment.
CREATE TABLE IF NOT EXISTS push_subscriptions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  endpoint TEXT NOT NULL UNIQUE,
  p256dh TEXT NOT NULL,
  auth TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- APNs arrives as a SECOND SHAPE IN THE SAME TABLE rather than a table of its
-- own. The whole point of the arrangement in services/push.ts is that the
-- decision "who deserves to hear about this" is made once and the last mile
-- fans out by platform; a second table would mean a second query on every
-- fan-out and two places that could disagree about the per-user cap.
--
-- So: `platform` is the discriminant, and the CHECK below is what makes it a
-- real one instead of a hint. A `web` row is the original shape. An `apns` row
-- carries a device token and nothing else — no endpoint (there is no URL), no
-- keys (APNs bodies are plain JSON over TLS; see services/apns.ts).
--
-- The three DROP NOT NULLs are what an existing deployment needs and are
-- replay-safe: dropping a constraint that is already absent is a no-op. They
-- are also why the CHECK exists — without it, relaxing those columns for the
-- APNs shape would have quietly permitted a `web` row with no endpoint, which
-- is a row that can never be sent to and never be cleaned up.
ALTER TABLE push_subscriptions
  ADD COLUMN IF NOT EXISTS platform TEXT NOT NULL DEFAULT 'web';
ALTER TABLE push_subscriptions ADD COLUMN IF NOT EXISTS token TEXT;
ALTER TABLE push_subscriptions ALTER COLUMN endpoint DROP NOT NULL;
ALTER TABLE push_subscriptions ALTER COLUMN p256dh DROP NOT NULL;
ALTER TABLE push_subscriptions ALTER COLUMN auth DROP NOT NULL;

-- DROP-then-ADD, the same shape every other constraint in this file uses: the
-- rule is stated once, here, and editing it re-applies it on the next boot
-- instead of leaving an old version in place.
ALTER TABLE push_subscriptions
  DROP CONSTRAINT IF EXISTS push_subscriptions_platform_shape;
ALTER TABLE push_subscriptions
  ADD CONSTRAINT push_subscriptions_platform_shape CHECK (
    (platform = 'web'
      AND endpoint IS NOT NULL AND p256dh IS NOT NULL AND auth IS NOT NULL
      AND token IS NULL)
    OR
    (platform = 'apns'
      AND token IS NOT NULL
      AND endpoint IS NULL AND p256dh IS NULL AND auth IS NULL)
  );

-- The APNs half of "one row per device". A partial UNIQUE index rather than a
-- column constraint, because the `endpoint` uniqueness already permits many
-- NULLs and this must do the same for the many `web` rows whose token is null.
CREATE UNIQUE INDEX IF NOT EXISTS idx_push_subscriptions_token
  ON push_subscriptions (token) WHERE platform = 'apns';

-- The send-time lookup ("every subscription these offline users hold") and the
-- account-deletion cascade both start from user_id.
CREATE INDEX IF NOT EXISTS idx_push_subscriptions_user
  ON push_subscriptions (user_id);

-- ---------------------------------------------------------------------------
-- friends
-- ---------------------------------------------------------------------------
--
-- ONE ROW PER UNORDERED PAIR, exactly the `dm_pairs` arrangement and for the
-- same reason: the primary key on the sorted pair IS the uniqueness guarantee,
-- so two people who friend-request each other in the same instant race to one
-- row instead of creating two half-relationships that would each need the
-- other consulted to answer "are these two friends".
--
-- `status` is the whole lifecycle: a request is a `pending` row, a friendship
-- is an `accepted` one, and a decline / cancel / unfriend is the row's
-- DELETION. Declined requests are deliberately not tombstoned: keeping them
-- would make one mis-click of "decline" permanent, and the defence against a
-- re-request pest is the rate limit and the block below, not a graveyard
-- every send has to consult.
--
-- `requested_by` records direction — who has to accept — and is meaningful in
-- both states (after acceptance it is "who asked first", which the UI does not
-- currently show but costs nothing to keep true). It carries NO foreign key on
-- purpose: the CHECK pins it to one of the pair columns, both of which already
-- cascade on user deletion, so an FK of its own would only add a third cascade
-- scan (and the index to serve it) for an integrity the CHECK provides
-- transitively.
CREATE TABLE IF NOT EXISTS friendships (
  low_user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  high_user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'accepted')),
  requested_by UUID NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  accepted_at TIMESTAMPTZ,
  PRIMARY KEY (low_user_id, high_user_id),
  CHECK (low_user_id < high_user_id),
  CHECK (requested_by = low_user_id OR requested_by = high_user_id),
  CHECK ((status = 'accepted') = (accepted_at IS NOT NULL))
);

-- Every read asks "rows this user is on either side of". The primary key
-- serves the low side; this serves the high side. Same pair of shapes as
-- user_blocks and its reverse index.
CREATE INDEX IF NOT EXISTS idx_friendships_high
  ON friendships (high_user_id, low_user_id);

-- The outgoing-pending cap in services/friends.ts counts
-- `WHERE requested_by = ? AND status = 'pending'` on every send. Partial,
-- because accepted rows can only grow and the cap never reads them.
CREATE INDEX IF NOT EXISTS idx_friendships_outgoing_pending
  ON friendships (requested_by) WHERE status = 'pending';

-- A BLOCK ENDS THE FRIENDSHIP AT THE STORAGE LAYER, in every state and both
-- directions, silently. Enforced here rather than in services/blocks.ts so it
-- holds for every path that will ever write a block — the API route today,
-- anything added later — without each one having to remember friendships
-- exist. The row is DELETED, not suspended: unblocking must not resurrect a
-- friendship (or worse, a pending request) the block was supposed to have
-- killed, and a surviving row would also be a way to prove, after an unblock,
-- that a block had happened. The send path in services/friends.ts carries the
-- matching no-block predicate inside its INSERT, which closes the race this
-- trigger cannot see: a request written a moment after the block landed.
CREATE OR REPLACE FUNCTION friendships_end_on_block() RETURNS TRIGGER AS $$
BEGIN
  DELETE FROM friendships
  WHERE low_user_id = LEAST(NEW.user_id, NEW.blocked_user_id)
    AND high_user_id = GREATEST(NEW.user_id, NEW.blocked_user_id);
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_friendships_end_on_block ON user_blocks;
CREATE TRIGGER trg_friendships_end_on_block
  AFTER INSERT ON user_blocks
  FOR EACH ROW EXECUTE FUNCTION friendships_end_on_block();

-- threads
--
-- A THREAD IS A CHANNEL: `type = 'thread'`, `kind = 'server'` (it lives inside
-- a server, so `channels_server_kind_check` holds), `parent_id` pointing at
-- the text channel it was started in, and `thread_root_message_id` pointing at
-- the message it grew out of. Choosing a channel row over a
-- `messages.thread_root_id` self-reference is the load-bearing decision:
-- retention, search, unread cursors, mentions, attachments, timeouts,
-- reporting and the fan-out audience are all keyed by channel id, so every one
-- of them covers threads by construction instead of needing its own patch —
-- and every patch skipped is a leak that cannot happen.
--
-- VISIBILITY FOLLOWS THE PARENT. A thread row is never `is_private` itself and
-- never has `channel_members` of its own; `channelVisibleSql` in
-- services/users.ts evaluates the privacy disjunction against the *parent* row
-- when `type = 'thread'`. A thread whose parent is gone (`parent_id` nulled by
-- the parent's ON DELETE SET NULL) therefore FAILS CLOSED — no parent, no
-- answer, invisible to everyone — though `deleteChannel` deletes child threads
-- explicitly so that state is a crash-window artifact, not a steady state.
--
-- `parent_id` is the same column categories use, with the same meaning ("the
-- channel this row sits under"); a thread's parent is a text channel where a
-- text channel's parent is a category. Threads never nest — the service layer
-- refuses to start a thread from a message that already lives in one, which
-- keeps the parent lookup in the visibility predicate one level deep.

DO $$
BEGIN
  ALTER TABLE channels DROP CONSTRAINT IF EXISTS channels_type_check;
  ALTER TABLE channels
    ADD CONSTRAINT channels_type_check
    CHECK (type IN ('text', 'voice', 'category', 'thread'));
EXCEPTION
  WHEN others THEN NULL;
END $$;

-- The anchor. ON DELETE SET NULL, matching reply_to_id: deleting the origin
-- message must not take the conversation that grew out of it. The thread keeps
-- its name and its messages; only the chip's home is gone.
ALTER TABLE channels ADD COLUMN IF NOT EXISTS thread_root_message_id UUID
  REFERENCES messages(id) ON DELETE SET NULL;

-- One thread per message, enforced where the race actually happens: two people
-- tapping "start thread" on the same message collide on this index and the
-- loser reads the winner's row (`ON CONFLICT ... DO NOTHING` in
-- services/threads.ts). Partial, because almost no channel row is a thread.
CREATE UNIQUE INDEX IF NOT EXISTS idx_channels_thread_root
  ON channels (thread_root_message_id)
  WHERE thread_root_message_id IS NOT NULL;

-- Only threads carry an anchor. Deliberately one-directional (not an equality
-- check): the SET NULL above means a thread legitimately outlives its anchor,
-- so `type = 'thread' AND thread_root_message_id IS NULL` must stay legal.
DO $$
BEGIN
  ALTER TABLE channels DROP CONSTRAINT IF EXISTS channels_thread_root_check;
  ALTER TABLE channels
    ADD CONSTRAINT channels_thread_root_check
    CHECK (type = 'thread' OR thread_root_message_id IS NULL);
EXCEPTION
  WHEN others THEN NULL;
END $$;

-- There is deliberately NO last_activity_at column and NO archival sweeper.
-- "Archived" is computed at read time from the thread's newest message (an
-- index-only lookup on idx_messages_channel_created), so a thread un-archives
-- itself by receiving a message and nothing can ever be late to flip a flag.
-- See THREAD_AUTO_ARCHIVE_DAYS in @pqp/shared.

-- ---------------------------------------------------------------------------
-- Communities: the public, joinable half of a server
-- ---------------------------------------------------------------------------
--
-- A community is not a new kind of row. It is a `servers` row with `is_community`
-- set, which puts it in a directory anyone signed in can browse and lets anyone
-- browsing join without an invite. Channels, messages, roles, bans and invites
-- are untouched — the whole feature is a listing plus a join path.
--
-- WHY THESE COLUMNS EXIST BEHIND A FLAG. `COMMUNITIES_ENABLED` gates every route
-- that reads or writes them; with it unset (the default, and the only value
-- production has today) these columns are dead weight and nothing can set them.
-- That is on purpose, and the reason is legal rather than aesthetic. See
-- docs/research/communities-orkut.html §08: the STF's 26 June 2025 ruling left
-- e-mail, private meetings and instant messaging inside Art. 19's shelter, and
-- a public directory of joinable rooms is precisely what moves an instance out
-- of it. The schema can land ahead of that decision; the routes must not.

ALTER TABLE servers ADD COLUMN IF NOT EXISTS is_community BOOLEAN NOT NULL DEFAULT FALSE;

-- One line, owner-written. NULL is legal and common — half of Orkut's own
-- directory was a name and nothing else, and a card falls back to the name.
ALTER TABLE servers ADD COLUMN IF NOT EXISTS community_tagline TEXT;

-- A slug from COMMUNITY_CATEGORIES in @pqp/shared, defaulted rather than
-- nullable so the directory's category filter never has to model "uncategorised"
-- as a fourth state alongside "all", "this one" and "none of these".
ALTER TABLE servers ADD COLUMN IF NOT EXISTS community_category TEXT NOT NULL DEFAULT 'geral';

-- The list is duplicated from @pqp/shared on purpose: the schema is the last
-- line of defence for a value the API layer is supposed to have validated, and
-- a CHECK that merely says "some text" defends nothing. Adding a slug means
-- editing both; that friction is the feature. REMOVING one would fail this block
-- (rows already carry it), leave the previous constraint standing, and strand
-- those servers — retire a category by hiding its chip in the client instead.
DO $$
BEGIN
  ALTER TABLE servers DROP CONSTRAINT IF EXISTS servers_community_category_check;
  ALTER TABLE servers
    ADD CONSTRAINT servers_community_category_check
    CHECK (community_category IN (
      'games', 'musica', 'futebol', 'estudos', 'anime',
      'tech', 'humor', 'series-filmes', 'corre', 'geral'
    ));
EXCEPTION
  WHEN others THEN NULL;
END $$;

-- The language the room is held in — the directory's second filter axis.
--
-- NOT A CATEGORY, and not a locale. See `COMMUNITY_LANGUAGES` in @pqp/shared for
-- the argument in full; the short version is that an English football server
-- belongs on the `futebol` shelf next to the Portuguese ones, so language has to
-- be something you narrow by *after* picking a subject rather than instead of
-- picking one. Two axes, one filter each.
--
-- NOT NULL DEFAULT 'pt' for the same reason `community_category` is defaulted
-- rather than nullable: a filter with three states ("all", "this one", "unset")
-- is a filter whose third state nobody can name in the UI. This is a Brazilian
-- instance; a row that never thinks about this column is Portuguese.
ALTER TABLE servers ADD COLUMN IF NOT EXISTS community_language TEXT NOT NULL DEFAULT 'pt';

-- Same shape, and the same argument, as the category CHECK above: the list is
-- duplicated from @pqp/shared on purpose, because a constraint that says "some
-- text" defends nothing against an API layer that was supposed to have
-- validated. Wrapped in the same DO block so a boot against a database whose
-- rows predate the column cannot abort the rest of the schema.
DO $$
BEGIN
  ALTER TABLE servers DROP CONSTRAINT IF EXISTS servers_community_language_check;
  ALTER TABLE servers
    ADD CONSTRAINT servers_community_language_check
    CHECK (community_language IN ('pt', 'en'));
EXCEPTION
  WHEN others THEN NULL;
END $$;

-- THE OPERATOR'S KILL SWITCH, AND IT IS NOT THE OWNER'S.
--
-- Set by whoever holds the DATABASE_URL, with one UPDATE, and reachable by no
-- in-app write path at all — there is deliberately no route, no role and no
-- setting that flips it. It exists because a community owner must not be able to
-- shelter their own listing from the person answering for the instance: the
-- research doc's §08 timeline is what happens when the only remedy available is
-- asking the owner nicely, and "Mate Um Negro, Ganhe Um Brinde" is what the
-- owner does with that remedy.
--
-- Suspending UNLISTS, it does not delete. The server, its members and its
-- messages carry on exactly as a private server would; what stops is being
-- findable by strangers and joinable without an invite. That asymmetry is
-- deliberate — pulling a listing is a reversible, low-evidence act an operator
-- should be willing to take within the hour, and deleting a room full of people
-- is not. See docs/CONTENT_SAFETY.md for the runbook and the exact SQL.
ALTER TABLE servers ADD COLUMN IF NOT EXISTS is_community_suspended BOOLEAN NOT NULL DEFAULT FALSE;

-- The member count the directory renders, maintained rather than counted.
--
-- WHY A COLUMN. The directory's default order is "biggest first", so a COUNT(*)
-- over `server_members` per row would run once per card per page — the exact
-- N+1 that makes a listing page slow in a way no index fixes, because the work
-- is proportional to the members of every server shown and not to the page.
-- One integer read off the row the query already has costs nothing.
--
-- IT IS APPROXIMATE AND NOTHING IS AUTHORISED BY IT. Access is always
-- `server_members`; this column decorates a card. A drift shows a wrong number
-- to a browser, never a wrong permission to anyone.
ALTER TABLE servers ADD COLUMN IF NOT EXISTS member_count INTEGER NOT NULL DEFAULT 0;

-- Maintained by a trigger and not by the join/leave paths, because there are
-- six of them and counting: createServer, redeemInvite, joinServerBySso,
-- joinCommunity, leaveServer, the kick/ban route, plus two ON DELETE CASCADEs
-- (a deleted account, a deleted server) that no application code ever sees. A
-- counter kept in application code is a counter that is wrong the first time
-- somebody adds a seventh path — and the cascades mean it would already be
-- wrong today.
--
-- Statement-level would be cheaper under a bulk insert; row-level is used
-- because every real write here is a single membership. A cascading server
-- delete makes this UPDATE match zero rows (the parent is already gone in this
-- transaction), which is correct and silent.
CREATE OR REPLACE FUNCTION pqp_sync_server_member_count() RETURNS TRIGGER AS $$
BEGIN
  IF (TG_OP = 'INSERT') THEN
    UPDATE servers SET member_count = member_count + 1 WHERE id = NEW.server_id;
  ELSIF (TG_OP = 'DELETE') THEN
    -- GREATEST, not a bare subtraction: a count that has somehow drifted low
    -- must not go negative and start rendering "-1 membros" forever.
    UPDATE servers SET member_count = GREATEST(member_count - 1, 0)
    WHERE id = OLD.server_id;
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_server_member_count ON server_members;
CREATE TRIGGER trg_server_member_count
  AFTER INSERT OR DELETE ON server_members
  FOR EACH ROW EXECUTE FUNCTION pqp_sync_server_member_count();

-- Seed the counter for every server that existed before the column did.
--
-- A one-shot, for the reason `data_migrations` exists: the trigger above keeps
-- the number true from the moment it is installed, so this only has to answer
-- for history. Replaying it on every boot would be a full scan of
-- `server_members` at startup forever, to fix a drift the trigger makes
-- impossible.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM data_migrations WHERE name = 'server_member_count_backfill_2026_08'
  ) THEN
    UPDATE servers s
    SET member_count = counted.n
    FROM (
      SELECT server_id, COUNT(*)::int AS n FROM server_members GROUP BY server_id
    ) counted
    WHERE counted.server_id = s.id AND s.member_count <> counted.n;

    INSERT INTO data_migrations (name) VALUES ('server_member_count_backfill_2026_08');
  END IF;
END $$;

-- The directory's one index, and it carries the whole default query: filter to
-- listed-and-not-suspended, optionally narrow by category, order by size.
--
-- Partial on the listing predicate because the overwhelming majority of servers
-- on any instance are private and must never be walked. `id` is the tiebreaker
-- so keyset pagination over (member_count, id) is a total order — without it two
-- communities of equal size can swap places between pages and one of them is
-- never shown.
CREATE INDEX IF NOT EXISTS idx_servers_community_directory
  ON servers (community_category, member_count DESC, id DESC)
  WHERE is_community AND NOT is_community_suspended;

-- Name/tagline search is a plain ILIKE with no index behind it, and that is a
-- considered choice rather than an oversight: it scans only the partial set
-- above (listed communities), which is orders of magnitude smaller than
-- `servers` and is expected to stay in the hundreds while this is flagged off in
-- production. `pg_trgm` is the answer when it stops being — one extension and
-- one GIN index away, with no change to the query shape.

-- Community reports: `subject_type = 'server'`.
--
-- A report about a whole community, filed from the directory by somebody who
-- may never have gone inside. The subject is the LISTING — its name and its
-- stated purpose — which is the one thing a message report cannot reach: the
-- communities that got Orkut's operators criminally charged were rooms whose
-- names were the offence, and most of them never hosted a conversation at all.
DO $$
BEGIN
  ALTER TABLE reports DROP CONSTRAINT IF EXISTS reports_subject_type_check;
  ALTER TABLE reports
    ADD CONSTRAINT reports_subject_type_check
    CHECK (subject_type IN ('message', 'user', 'server'));
EXCEPTION
  WHEN others THEN NULL;
END $$;

-- The reported community. A SEPARATE COLUMN FROM `server_id`, and the separation
-- is the entire routing decision.
--
-- `server_id` means "file this in that server's own queue", and the table's
-- CHECK ties it to `context_kind = 'server'`. A report ABOUT a community must
-- never land there: it would be readable, and resolvable, by the very owner it
-- accuses. So a community report carries `context_kind = 'none'` and a NULL
-- `server_id` — which is exactly what `idx_reports_instance_status` selects —
-- and names its subject here instead. The owner sees nothing; the instance
-- moderator sees it in the queue they already read.
--
-- SET NULL rather than CASCADE, same reasoning as `reported_message_id`: an
-- owner deleting the community must not delete the open report about it. The
-- name survives in `subject_label`, which is the evidence.
ALTER TABLE reports ADD COLUMN IF NOT EXISTS reported_server_id UUID
  REFERENCES servers(id) ON DELETE SET NULL;

DO $$
BEGIN
  ALTER TABLE reports DROP CONSTRAINT IF EXISTS reports_server_subject_check;
  ALTER TABLE reports
    ADD CONSTRAINT reports_server_subject_check
    -- One-directional, not an equality: the SET NULL above means a community
    -- report legitimately outlives the community, so
    -- `subject_type = 'server' AND reported_server_id IS NULL` must stay legal.
    CHECK (subject_type = 'server' OR reported_server_id IS NULL);
EXCEPTION
  WHEN others THEN NULL;
END $$;

-- Same duplicate suppression every other subject gets, scoped to open reports
-- so a repeat offence after a resolution is a new row rather than a silent
-- no-op. No COALESCE needed: both columns are NOT NULL for the rows this
-- predicate selects.
CREATE UNIQUE INDEX IF NOT EXISTS idx_reports_open_server_dedupe
  ON reports (reporter_id, reported_server_id)
  WHERE status = 'open' AND subject_type = 'server';
-- ============================================================ character accounts
--
-- The production identity for the house cast: a `users` row that a long-lived
-- bearer token can authenticate as. Webhooks already proved half of this — a
-- real row with a synthetic `clerk_id` that nothing authenticates as — and this
-- table is the other half, and only the other half.
--
-- WHAT IS STORED IS A HASH, NEVER THE TOKEN. `token_hash` is the hex SHA-256 of
-- a 256-bit random secret that exists exactly once, in the provisioning script's
-- output. There is no route, no log line and no column that can hand it back:
-- losing it means minting a new one (`provision.mjs --rotate`), which is the
-- correct trade for a credential that is checked on every request a character
-- makes.
--
-- REVOCATION IS ONE UPDATE. `revoked_at` is checked in the auth lookup, so
-- stopping a character is `UPDATE character_accounts SET revoked_at = NOW()` and
-- takes effect on its next request — without deleting the row, which would take
-- the audit trail of which account the token belonged to with it.
--
-- `label` is the operator's name for the account (the persona id in the ambient
-- runner's YAML). Unique, so provisioning is idempotent: re-running the script
-- finds the existing account instead of minting a second one that would join the
-- server as a duplicate stranger.
CREATE TABLE IF NOT EXISTS character_accounts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  label TEXT NOT NULL UNIQUE,
  token_hash TEXT NOT NULL UNIQUE,
  -- Free text: who provisioned this and why. Not a foreign key, because the
  -- operator running a script against DATABASE_URL may not be a `users` row.
  created_by TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  revoked_at TIMESTAMPTZ
);

-- The auth lookup's only index. Partial on the live rows because a revoked
-- token must never be found by it, and the overwhelming majority of lookups are
-- for live accounts.
CREATE INDEX IF NOT EXISTS idx_character_accounts_live
  ON character_accounts (token_hash)
  WHERE revoked_at IS NULL;

-- Character invariants, repaired on boot under a fingerprint guard.
--
-- Three facts have to be true of every character row, and all three are written
-- at creation by `createCharacterAccount`. They are restated here because the
-- creation path is not the only way a row can reach this table — a hand-run
-- INSERT during an incident, a restored backup taken before a rule existed, or
-- this rule itself changing — and a character that trips the age gate is a
-- socket that closes 4401 with no error anyone will connect to the cause.
--
--   age gate  — a character has no date of birth to declare, so the gate is
--               satisfied at creation. `age_check_dob` stays NULL exactly as it
--               does for a person who passed (see the age-gate block above).
--   dm_privacy — 'nobody'. The hard guardrail is that characters are never in
--               anyone's inbox; this makes the server enforce it with the
--               machinery it already has, rather than trusting the runner to
--               have no code path.
--   onboarding — the wizard's completion flag, so the client never opens a
--               first-run modal at an account with no browser.
--
-- The guard is the same shape as the email scrub and the search-vector
-- migration above: a fingerprint of the rule, stashed in the column comment.
-- Changing any part of the rule string re-arms the pass; leaving it alone makes
-- every subsequent boot a single `col_description` read.
DO $$
DECLARE
  rule CONSTANT TEXT := 'age_checked_at=NOW,age_check_passed=TRUE,dm_privacy=nobody,prefs.onboardedAt';
  marker CONSTANT TEXT := 'pqp-character-invariants ' || md5(rule);
  col_attnum SMALLINT;
  repaired INT := 0;
BEGIN
  SELECT a.attnum INTO col_attnum FROM pg_attribute a
  WHERE a.attrelid = 'users'::regclass AND a.attname = 'is_character'
    AND NOT a.attisdropped;

  IF col_description('users'::regclass, col_attnum) IS NOT DISTINCT FROM marker THEN
    RETURN;
  END IF;

  WITH fixed AS (
    UPDATE users
       SET age_checked_at = COALESCE(age_checked_at, NOW()),
           age_check_passed = TRUE,
           age_check_dob = NULL,
           dm_privacy = 'nobody'
     WHERE is_character
       AND (age_checked_at IS NULL
            OR age_check_passed IS DISTINCT FROM TRUE
            OR dm_privacy <> 'nobody')
    RETURNING id
  )
  SELECT count(*) INTO repaired FROM fixed;

  INSERT INTO user_preferences (user_id, settings)
  SELECT u.id, jsonb_build_object('onboardedAt', to_char(NOW() AT TIME ZONE 'UTC',
           'YYYY-MM-DD"T"HH24:MI:SS"Z"'))
    FROM users u WHERE u.is_character
  ON CONFLICT (user_id) DO UPDATE
    SET settings = user_preferences.settings
        || jsonb_build_object('onboardedAt',
             COALESCE(user_preferences.settings ->> 'onboardedAt',
               to_char(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')));

  IF repaired > 0 THEN
    RAISE NOTICE 'pqp: repaired invariants on % character row(s)', repaired;
  END IF;

  EXECUTE format('COMMENT ON COLUMN users.is_character IS %L', marker);
END $$;

-- ---------------------------------------------------------------------------
-- A server's own two pictures: the icon in the rail, the banner over the
-- channel list.
--
-- FOUR COLUMNS AND NO TABLE, exactly as `users.avatar_url` / `avatar_key` is
-- four-columns-fewer than an `avatars` table would be. An attachment needs a
-- row because it exists in a pending state before any message refers to it and
-- because unclaimed rows must be swept; a server picture's whole lifecycle is
-- "the key of the object we hold, and the URL everything else already reads".
--
-- WHY BOTH A KEY AND A URL, per picture. The URL is what every payload carries
-- and what an `<img src>` is pointed at; the key is what the bucket is asked
-- about. Keeping the key is also the only way to tell "this is the object we
-- stored" from "somebody typed a link", which is what decides whether a
-- replaced object has become an orphan to delete. Same reasoning as avatars.
--
-- Nothing here is NOT NULL: a server without a picture is the overwhelmingly
-- common case and the monogram is a real design, not a placeholder.
ALTER TABLE servers ADD COLUMN IF NOT EXISTS icon_key TEXT;
ALTER TABLE servers ADD COLUMN IF NOT EXISTS icon_url TEXT;
ALTER TABLE servers ADD COLUMN IF NOT EXISTS banner_key TEXT;
ALTER TABLE servers ADD COLUMN IF NOT EXISTS banner_url TEXT;
-- ============================================================== depoimentos
--
-- Orkut's testimonials, and the one mechanic Brazilians name unprompted when
-- asked what they miss. A friend writes a short thing about you; it is
-- invisible to everyone — including them, after sending — until YOU publish it.
-- `docs/research/communities-orkut.html` §05 is the argument; what follows is
-- the part of it the storage layer has to hold up.
--
-- THE APPROVAL IS THE FEATURE, so `approved_at` is the whole state machine.
-- NULL means pending and readable by the subject alone; non-NULL means the
-- subject chose to display it. There is deliberately no third state and no
-- `status` column: a boolean-plus-timestamp pair invites the classic drift
-- where one says published and the other says nothing.
--
-- REJECTION DELETES THE ROW. No graveyard, no 'declined' state, nothing to
-- mine later. This is not tidiness — it is the direct fix for §02's documented
-- failure, "Não aceita!": because Orkut's unaccepted queue was readable by the
-- recipient FOREVER, Brazilians discovered a depoimento was a private message,
-- and the folklore is what happened when a recipient published one of those by
-- accident. An approval queue that retains what it refuses IS a covert DM
-- channel. The compose flow answers the same problem from the other end by
-- offering a real DM as a first-class second option.
--
-- ONE STANDING DEPOIMENTO PER PAIR — `UNIQUE (author_id, subject_id)`. Writing
-- again REPLACES what is there and returns it to pending, which is also how
-- "editable by the author while pending" is spelled without an edit route.
-- Replacing an already-approved one un-publishes it: the author could have
-- achieved exactly that by withdrawing and rewriting, so refusing here would
-- only add an error message to a sequence that stays possible.
CREATE TABLE IF NOT EXISTS depoimentos (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  author_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  subject_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  body TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  approved_at TIMESTAMPTZ,
  UNIQUE (author_id, subject_id),
  -- Writing about yourself is not a testimonial. Refused here as well as in
  -- the service so no future path can invent one.
  CHECK (author_id <> subject_id)
);

-- The profile read: approved rows for one subject, newest published first.
-- Partial, because the pending half is never in this order and is never shown
-- to anybody but the subject.
CREATE INDEX IF NOT EXISTS idx_depoimentos_subject_approved
  ON depoimentos (subject_id, approved_at DESC)
  WHERE approved_at IS NOT NULL;

-- The inbox, and the badge that counts it. Also partial: pending rows are the
-- small, hot set, and this index is read on every friends poll.
CREATE INDEX IF NOT EXISTS idx_depoimentos_subject_pending
  ON depoimentos (subject_id, created_at DESC)
  WHERE approved_at IS NULL;

-- The daily write cap counts `author_id` over a time window, and the author's
-- own "what have I written" read uses the same index.
CREATE INDEX IF NOT EXISTS idx_depoimentos_author
  ON depoimentos (author_id, created_at DESC);

-- A BLOCK DESTROYS THE DEPOIMENTO IN BOTH DIRECTIONS, published or not.
--
-- Same placement and the same argument as `friendships_end_on_block()` right
-- above: enforced at the storage layer so it holds for every path that will
-- ever write a block, without each one having to remember this table exists.
-- Deleted rather than hidden, for the reason the whole feature deletes rather
-- than archives — a surviving row is a thing to mine, and after an unblock it
-- would also be a way to prove a block had happened.
CREATE OR REPLACE FUNCTION depoimentos_end_on_block() RETURNS TRIGGER AS $$
BEGIN
  DELETE FROM depoimentos
  WHERE (author_id = NEW.user_id AND subject_id = NEW.blocked_user_id)
     OR (author_id = NEW.blocked_user_id AND subject_id = NEW.user_id);
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_depoimentos_end_on_block ON user_blocks;
CREATE TRIGGER trg_depoimentos_end_on_block
  AFTER INSERT ON user_blocks
  FOR EACH ROW EXECUTE FUNCTION depoimentos_end_on_block();

-- UNFRIENDING WITHDRAWS A PENDING DEPOIMENTO, AND ONLY A PENDING ONE.
--
-- The asymmetry is the point, and it is the answer to the one harassment shape
-- the friends-only gate does not close: a stranger can never write, but an
-- ex-friend can leave something sitting in your queue. Ending the friendship
-- takes it away.
--
-- An APPROVED one survives, because by then it is not theirs. The subject
-- published it, it is on the subject's profile as a thing the subject chose to
-- display, and a falling-out should not silently rewrite somebody's profile.
-- The subject can remove it from the same menu that approved it, whenever they
-- like — which is the version of this where the person the depoimento is about
-- is the one deciding.
CREATE OR REPLACE FUNCTION depoimentos_withdraw_on_unfriend() RETURNS TRIGGER AS $$
BEGIN
  DELETE FROM depoimentos
  WHERE approved_at IS NULL
    AND ((author_id = OLD.low_user_id AND subject_id = OLD.high_user_id)
      OR (author_id = OLD.high_user_id AND subject_id = OLD.low_user_id));
  RETURN OLD;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_depoimentos_withdraw_on_unfriend ON friendships;
CREATE TRIGGER trg_depoimentos_withdraw_on_unfriend
  AFTER DELETE ON friendships
  FOR EACH ROW EXECUTE FUNCTION depoimentos_withdraw_on_unfriend();

-- ------------------------------------------- community badges on a profile
--
-- Which of your communities appear as chips on your profile card. TRUE by
-- default, because a listed community is already public — it is in a directory
-- anyone signed in can browse, and the member count on its card already counts
-- you. The badge discloses no new fact; it only makes an existing one legible.
--
-- The opt-out exists anyway, per membership rather than per account, because
-- "public" and "advertised on my profile" are different consents and the
-- interesting cases are always one specific room: a support community, a
-- fandom you are not out about at work, the server for the job you are quietly
-- leaving. One switch for all of them would be no switch at all.
--
-- ONLY LISTED COMMUNITIES ARE EVER CHIPPED — the read path adds
-- `is_community AND NOT is_community_suspended`. A private server is nobody
-- else's business, so this column is inert on the overwhelming majority of
-- rows, and a community the operator has unlisted stops appearing on every
-- profile the moment they pull it, with no per-member fan-out.
ALTER TABLE server_members ADD COLUMN IF NOT EXISTS show_on_profile BOOLEAN NOT NULL DEFAULT TRUE;

-- The profile read: this person's memberships, joined to `servers` and filtered
-- to the listed ones. Partial on the opt-in so an opted-out membership costs
-- nothing to skip, and ordered by `server_id` only as a stable tiebreaker — the
-- real order is by community size, which lives on the joined row.
CREATE INDEX IF NOT EXISTS idx_server_members_profile
  ON server_members (user_id, server_id)
  WHERE show_on_profile;
-- Public handles: the `pqp.gg/@rafa` half of an account
-- ---------------------------------------------------------------------------
--
-- WHY THIS IS NOT `username`. `username` is not unique — uniqueness lives on the
-- pair (`username`, `discriminator`), which is what `idx_users_username_discrim`
-- above enforces and what `name#1234` exists to express. A dozen accounts can be
-- `rafa`, so `pqp.gg/rafa` has no answer that does not invent a winner. A handle
-- is therefore a second name that IS unique, claimed first-come, and NULL for
-- almost everybody: nothing in the product requires one, and the only thing it
-- unlocks is a public URL. See packages/shared/src/profiles.ts for the rules.
--
-- The column is nullable and stays nullable. An account with no handle has no
-- public page, which is the correct default for a product whose public surface
-- is deliberately thin.
ALTER TABLE users ADD COLUMN IF NOT EXISTS handle TEXT;

-- When the handle last moved. NULL means "never claimed one", which is the
-- state the 30-day rename cooldown treats as free — see `canRenameHandle`.
-- The cooldown is anti-squatting, not punishment: without it one account can
-- rotate through every desirable name, screenshotting each.
ALTER TABLE users ADD COLUMN IF NOT EXISTS handle_changed_at TIMESTAMPTZ;

-- The format, duplicated from `HANDLE_PATTERN` in @pqp/shared on purpose — same
-- argument as the community-category CHECK above. This is the last line of
-- defence for a value the API is supposed to have validated, and a constraint
-- that only says "some text" defends nothing. `profiles.test.ts` pins the two
-- expressions as equal so a change to one fails the suite rather than the users.
DO $$
BEGIN
  ALTER TABLE users DROP CONSTRAINT IF EXISTS users_handle_format;
  ALTER TABLE users
    ADD CONSTRAINT users_handle_format
    CHECK (handle IS NULL OR handle ~ '^[a-z0-9][a-z0-9_.-]{1,18}[a-z0-9]$');
EXCEPTION
  WHEN others THEN NULL;
END $$;

-- THE ARBITER OF "FIRST COME, FIRST SERVED", and the only one.
--
-- Two people typing `neymar` into the claim landing at the same second both see
-- the availability check answer "free" — that check is a read, and a read cannot
-- reserve anything. The application layer's job is to attempt the write and let
-- exactly one of them win; this index is what decides which, and the loser gets
-- a 409 from the 23505 it raises. `claimHandle` in services/profiles.ts is built
-- around that and never tries to pre-check its way out of the race.
--
-- Partial, because NULL is the overwhelmingly common value and a full unique
-- index over a mostly-NULL column is index no query will ever use.
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_handle
  ON users (handle)
  WHERE handle IS NOT NULL;

-- ---------------------------------------------------------------------------
-- A person's banner: the strip across the top of `pqp.gg/@rafa`
-- ---------------------------------------------------------------------------
--
-- TWO COLUMNS AND NO TABLE, the third time this product has made that choice
-- and for the third time the same reason: an attachment needs a row because it
-- exists in a pending state before anything refers to it and unclaimed rows
-- must be swept, and a banner's whole lifecycle is "the key of the object we
-- hold, and the URL everything else already reads". `users.avatar_key` /
-- `avatar_url` above is the pattern; `servers.banner_key` / `banner_url` is the
-- other copy.
--
-- WHY IT RIDES THE AVATAR MACHINERY RATHER THAN THE SERVER-IMAGE MACHINERY.
-- The storage key contains the owning ACCOUNT's id, so "is this object mine" is
-- answerable from the string alone and the claim needs no permission check
-- beyond having a session. A server image key names a server that many people
-- are members of, which is why that path is owner-gated at the route. Same
-- bucket, same signer, different authorisation shape — see the file comment on
-- server/src/services/server-images.ts for why the two were never merged.
--
-- Nullable and staying nullable. Almost nobody will upload one, and the profile
-- page draws a gradient generated from the display name's own hue instead — a
-- real design rather than a placeholder, the same deal the avatar monogram gets.
ALTER TABLE users ADD COLUMN IF NOT EXISTS banner_key TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS banner_url TEXT;

-- ---------------------------------------------------------------------------
-- Community slugs: the `pqp.gg/c/valorant-brasil` half of a listing
-- ---------------------------------------------------------------------------
--
-- WHY A SECOND IDENTIFIER FOR A ROW THAT ALREADY HAS ONE. `servers.id` is a
-- uuid, which is exactly right for the thing the API talks about and exactly
-- wrong for the thing a person says out loud, prints on a poster, or types from
-- memory. The public page exists so discovery is easy; `/c/3f2a1c9e-…` is not
-- easy. Same argument `users.handle` makes against `users.id`, one level up.
--
-- NULLABLE, and the nullability is load-bearing rather than lazy. A private
-- server has no public address and must not carry one; a community listed
-- before this column existed gets its slug from the one-shot backfill below,
-- and a name that cannot produce a valid slug (pure emoji, two characters) is
-- refused at the route with a field to type one in — never silently given
-- `server-4f2a`, which is a URL nobody would share.
ALTER TABLE servers ADD COLUMN IF NOT EXISTS community_slug TEXT;

-- The format, duplicated from `COMMUNITY_SLUG_PATTERN` in @pqp/shared on
-- purpose — the third instance of the argument the handle CHECK and the
-- category CHECK both make. `communities.test.ts` pins the two expressions as
-- equal so a change to one fails the suite rather than the users.
DO $$
BEGIN
  ALTER TABLE servers DROP CONSTRAINT IF EXISTS servers_community_slug_format;
  ALTER TABLE servers
    ADD CONSTRAINT servers_community_slug_format
    CHECK (community_slug IS NULL
           OR community_slug ~ '^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$');
EXCEPTION
  WHEN others THEN NULL;
END $$;

-- THE ARBITER OF "FIRST COME, FIRST SERVED" FOR SLUGS, exactly as
-- `idx_users_handle` is for handles: two owners opting in at the same second
-- both see the availability check answer "free", because a read cannot reserve
-- anything. `updateCommunitySettings` attempts the write and converts the 23505
-- into a refusal naming the `slug` field; this index is what decides who won.
--
-- PARTIAL ON `is_community`, which is a narrower predicate than "not null" and
-- the difference matters. Unlisting a community deliberately LEAVES its slug on
-- the row — the same way it leaves the tagline and the category, so relisting a
-- week later needs no retyping — and an unlisted row must not go on holding a
-- public address against everybody else. So the constraint is "no two LISTED
-- communities share an address", which is the only sentence that is actually
-- true of the URL space, and an unlisted holder loses the race to a live
-- claimant rather than squatting from a room nobody can see.
CREATE UNIQUE INDEX IF NOT EXISTS idx_servers_community_slug
  ON servers (community_slug)
  WHERE is_community AND community_slug IS NOT NULL;

-- The public page's read: one listed, unsuspended community by slug. Its own
-- index rather than a share of the directory's, because the directory's leading
-- column is the category and this query has no category to give it.
CREATE INDEX IF NOT EXISTS idx_servers_community_slug_public
  ON servers (community_slug)
  WHERE is_community AND NOT is_community_suspended;

-- ONE-SHOT BACKFILL for communities listed before slugs existed.
--
-- Runs on every boot and is a no-op after the first, because it only touches
-- rows whose slug is still NULL. The derivation is the SQL twin of
-- `slugifyCommunityName`: lowercase, strip accents through `unaccent`-free
-- ASCII folding (`translate` over the vowels a Brazilian keyboard actually
-- produces, which is what `normalize('NFD')` buys the TypeScript version),
-- collapse everything else to single hyphens, trim the ends, cap at forty.
--
-- COLLISIONS ARE LEFT UNRESOLVED ON PURPOSE, and this is the interesting part.
-- The window function picks one winner per derived slug — oldest listing first,
-- which is the same "first come" rule the live path enforces — and every loser
-- keeps a NULL slug. A loser is then a listed community with no public page,
-- which the directory renders exactly as it renders a community listed before
-- this change: everything works, the share button is simply absent, and its
-- owner picks an address in settings whenever they get round to it. The
-- alternative — appending `-2` — mints URLs nobody chose, nobody would share,
-- and nobody can tell apart.
--
-- Anything that fails the CHECK (a name that folds to nothing, or to two
-- characters) is filtered out by the length test rather than written and
-- rejected, so this block can never abort a boot.
DO $$
DECLARE
  filled INTEGER;
BEGIN
  WITH derived AS (
    SELECT
      s.id,
      s.created_at,
      NULLIF(
        LEFT(
          TRIM(BOTH '-' FROM
            REGEXP_REPLACE(
              TRANSLATE(
                LOWER(s.name),
                'áàâãäéèêëíìîïóòôõöúùûüçñ',
                'aaaaaeeeeiiiiooooouuuucn'
              ),
              '[^a-z0-9]+', '-', 'g'
            )
          ),
          40
        ),
        ''
      ) AS slug
    FROM servers s
    WHERE s.is_community AND s.community_slug IS NULL
  ),
  ranked AS (
    SELECT id, TRIM(BOTH '-' FROM slug) AS slug,
           ROW_NUMBER() OVER (
             PARTITION BY TRIM(BOTH '-' FROM slug)
             ORDER BY created_at ASC, id ASC
           ) AS rank
    FROM derived
    WHERE slug IS NOT NULL
  )
  UPDATE servers s
     SET community_slug = r.slug
    FROM ranked r
   WHERE s.id = r.id
     AND r.rank = 1
     AND LENGTH(r.slug) BETWEEN 3 AND 40
     AND r.slug ~ '^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$'
     -- Reserved words are refused here too, so the backfill cannot hand out an
     -- address the live claim path would never allow. Kept short deliberately:
     -- this list only has to agree with RESERVED_COMMUNITY_SLUGS on the words
     -- a real community name could plausibly fold to.
     AND r.slug NOT IN ('new', 'nova', 'novo', 'all', 'todas', 'todos',
                        'search', 'busca', 'explore', 'explorar', 'admin',
                        'staff', 'equipe', 'moderacao', 'suporte', 'support',
                        'oficial', 'official', 'pqp', 'api', 'app', 'www',
                        'null', 'undefined')
     -- The unique index is the real arbiter; this only keeps the statement from
     -- colliding with a slug some other boot (or a live claim) already wrote.
     AND NOT EXISTS (
       SELECT 1 FROM servers other
        WHERE other.community_slug = r.slug
          AND other.is_community
          AND other.id <> s.id
     );

  GET DIAGNOSTICS filled = ROW_COUNT;
  IF filled > 0 THEN
    RAISE NOTICE 'pqp: derived community slugs for % listing(s)', filled;
  END IF;
END $$;

-- --------------------------------------------------------------- feedback
--
-- Product feedback from the box in settings — a different thing from
-- `reports`, which are about people and route to moderators. Feedback is
-- about the product and is read only by the operator (the same
-- INSTANCE_MODERATOR_CLERK_IDS gate the instance report queue uses).
--
-- `status` has one fun value: 'confirmed' marks a bug report as a real
-- catch, and confirming it is what grants the reporter the caça-bugs badge
-- in `user_badges`. BIGSERIAL id so the queue keysets the same way reports
-- do. The author is SET NULL, not CASCADE: feedback about a bug outlives
-- the account that filed it.
CREATE TABLE IF NOT EXISTS feedback (
  id BIGSERIAL PRIMARY KEY,
  user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  kind TEXT NOT NULL CHECK (kind IN ('bug', 'idea', 'other')),
  body TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open'
    CHECK (status IN ('open', 'confirmed', 'closed')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_feedback_status_id
  ON feedback (status, id DESC);

-- Earned marks, keyed by a stable badge slug ('caca-bugs', 'turma-1000').
-- Deliberately generic — the next achievement is one INSERT away — and
-- deliberately NOT the community-membership "badges" on the public profile,
-- which are derived from server_members at read time and mean membership,
-- not merit.
--
-- `ordinal` is the signup-order number for numbered badges (Turma dos 1000).
-- Null on unnumbered marks. The unique pair forbids two people sharing #47.
-- Deleting an account cascades the row and leaves a gap; numbers are not
-- recycled (the stamp is one-shot: if any turma-1000 row exists, it stops).
CREATE TABLE IF NOT EXISTS user_badges (
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  badge TEXT NOT NULL,
  granted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, badge)
);

ALTER TABLE user_badges ADD COLUMN IF NOT EXISTS ordinal INTEGER;
ALTER TABLE user_badges DROP CONSTRAINT IF EXISTS user_badges_ordinal_positive;
ALTER TABLE user_badges ADD CONSTRAINT user_badges_ordinal_positive
  CHECK (ordinal IS NULL OR ordinal >= 1);
CREATE UNIQUE INDEX IF NOT EXISTS idx_user_badges_badge_ordinal
  ON user_badges (badge, ordinal)
  WHERE ordinal IS NOT NULL;

-- ------------------------------------------------------ call ratings
--
-- One prompted score per call, asked once when a call ends. Distinct from
-- `feedback` on purpose: feedback is volunteered, which selects for people
-- already annoyed enough to open settings, while this is asked, and is the
-- only signal here a quiet majority ever produces. Averaging the two together
-- would make both meaningless.
--
-- What is NOT here is the point: no peer ids, no message content, no channel
-- name, no address. A row is a score, the shape of the call it scored, and a
-- time. `user_id` goes NULL rather than cascading away, because a rating from
-- somebody who later deleted their account is still a true thing about how the
-- product performed that day.
CREATE TABLE IF NOT EXISTS call_ratings (
  id BIGSERIAL PRIMARY KEY,
  user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  channel_id UUID REFERENCES channels(id) ON DELETE SET NULL,
  rating SMALLINT NOT NULL CHECK (rating BETWEEN 1 AND 5),
  -- Only ever written on a low score, where the number does not say what broke.
  note TEXT,
  duration_seconds INTEGER NOT NULL CHECK (duration_seconds >= 0),
  peer_count SMALLINT NOT NULL CHECK (peer_count >= 0),
  transport TEXT NOT NULL CHECK (transport IN ('mesh', 'livekit')),
  had_screen_share BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- The dashboard reads "everything since <time>", grouped. Nothing reads a
-- single row by id, so the index follows the only query that exists.
CREATE INDEX IF NOT EXISTS idx_call_ratings_created_at
  ON call_ratings (created_at DESC);

-- ------------------------------------------------------ acquisition
--
-- Where an account came from, as the landing page saw it: the `utm_source`,
-- `utm_medium`, `utm_campaign`, `gclid` and `ref` parameters on the URL the
-- person first arrived with, plus the path they landed on. This exists so a
-- paid or organic channel can be judged by signups rather than by clicks,
-- WITHOUT a cookie, a pixel or any third-party tag on the site: the client
-- remembers the parameters in its own localStorage through the sign-up, sends
-- them once, and deletes them.
--
-- FIRST TOUCH, AND NEVER OVERWRITTEN. The write in services/acquisition.ts is
-- `WHERE acquisition_at IS NULL` and is refused outright for an account older
-- than a day, so a later campaign click by somebody who already has an account
-- is a visit, not an acquisition. Nothing here is ever read back into a user
-- payload; the only reader is the operator's GET /api/admin/acquisition, which
-- groups counts by source/medium/campaign. The columns are deliberately absent
-- from DB_USER_COLUMNS for that reason. Every value is bounded at the API
-- (acquisitionSchema) because a query string is user-writable.
ALTER TABLE users ADD COLUMN IF NOT EXISTS acquisition_source TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS acquisition_medium TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS acquisition_campaign TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS acquisition_gclid TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS acquisition_ref TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS acquisition_landing TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS acquisition_at TIMESTAMPTZ;

-- --------------------------------------------------------------- connections
--
-- Linked Steam / Battle.net / Twitch accounts. Not a login: Clerk stays the
-- identity, these rows are proven badges. Disconnecting one does not sign
-- anyone out.
--
-- WHAT IS STORED. The stable id the provider returned (SteamID64, Battle.net
-- numeric id, Twitch user id), a display name and optional avatar/profile URL
-- snapshotted at link time, and a visibility. Access tokens are deliberately
-- absent — we only needed them to learn who the person is, and keeping one
-- would be a credential vault for a feature that does not call those APIs
-- again. Refresh is "connect again".
--
-- UNIQUENESS. One row per (user, provider): a pqp account has at most one
-- Steam. One row per (provider, provider_user_id): a Steam account belongs
-- to at most one pqp user. The second index is what stops two people claiming
-- the same BattleTag by racing the first.
--
-- ON DELETE CASCADE with the user row, so account deletion (LGPD art. 18)
-- takes the links with it. The OAuth-state table below is the same.
--
-- `visibility`: hidden (settings only) / shared (in-app profile card) /
-- public (also pqp.gg/@handle). Default shared — putting a Steam URL on a
-- page served to the open internet is an extra, explicit tap.

CREATE TABLE IF NOT EXISTS user_connections (
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider TEXT NOT NULL
    CHECK (provider IN ('steam', 'battlenet', 'twitch')),
  provider_user_id TEXT NOT NULL,
  display_name TEXT NOT NULL,
  avatar_url TEXT,
  profile_url TEXT,
  visibility TEXT NOT NULL DEFAULT 'shared'
    CHECK (visibility IN ('hidden', 'shared', 'public')),
  connected_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, provider)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_user_connections_provider_subject
  ON user_connections (provider, provider_user_id);

-- One-time OAuth / OpenID state. The nonce is the CSRF token in `state`
-- (and in Steam's return_to). Consumed on complete, swept after 10 minutes
-- if the person never came back. `pkce_verifier` is Twitch-only; Steam and
-- Battle.net leave it NULL.

CREATE TABLE IF NOT EXISTS connection_oauth_states (
  nonce TEXT PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider TEXT NOT NULL
    CHECK (provider IN ('steam', 'battlenet', 'twitch')),
  redirect_origin TEXT NOT NULL,
  pkce_verifier TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_connection_oauth_states_created
  ON connection_oauth_states (created_at);

-- --------------------------------------------------------------- permissions
--
-- Discord's published 8-step overwrite algorithm
-- (https://docs.discord.com/developers/topics/permissions), stored as BIGINT
-- bitfields. Wire format is a decimal string; JS math is always bigint.
--
-- Bits 0–20, matching packages/shared/src/permissions.ts:
--   0 CREATE_INVITE          1
--   1 KICK_MEMBERS           2
--   2 BAN_MEMBERS            4
--   3 ADMINISTRATOR          8
--   4 MANAGE_CHANNELS        16
--   5 MANAGE_SERVER          32
--   6 VIEW_CHANNEL           64
--   7 SEND_MESSAGES          128
--   8 MANAGE_MESSAGES        256
--   9 ATTACH_FILES           512
--  10 READ_MESSAGE_HISTORY   1024
--  11 MENTION_EVERYONE       2048
--  12 CONNECT                4096
--  13 SPEAK                  8192
--  14 MUTE_MEMBERS           16384
--  15 CHANGE_NICKNAME        32768
--  16 MANAGE_NICKNAMES       65536
--  17 MANAGE_ROLES           131072
--  18 MODERATE_MEMBERS       262144
--  19 ADD_REACTIONS          524288
--  20 MANAGE_WEBHOOKS        1048576
--
-- ALL = 2097151. Default @everyone = 571073.
--
-- Seeded roles per server: `@everyone` (implicit, never a member_roles row),
-- Moderator, Manager, Admin (ADMINISTRATOR), and Owner (display only;
-- servers.owner_id is still the source of ownership and short-circuits to ALL).

ALTER TABLE servers ADD COLUMN IF NOT EXISTS permissions_version INTEGER NOT NULL DEFAULT 0;

ALTER TABLE server_members ADD COLUMN IF NOT EXISTS nickname TEXT;

ALTER TABLE messages ADD COLUMN IF NOT EXISTS mention_everyone BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS mention_here BOOLEAN NOT NULL DEFAULT FALSE;

CREATE TABLE IF NOT EXISTS roles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  server_id UUID NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  color TEXT,
  hoist BOOLEAN NOT NULL DEFAULT FALSE,
  mentionable BOOLEAN NOT NULL DEFAULT FALSE,
  permissions BIGINT NOT NULL DEFAULT 0,
  position INTEGER NOT NULL DEFAULT 0,
  is_everyone BOOLEAN NOT NULL DEFAULT FALSE,
  system_key TEXT CHECK (system_key IN ('everyone', 'owner', 'admin', 'manager', 'moderator', 'vip')),
  show_badge BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_roles_everyone
  ON roles (server_id) WHERE is_everyone;

CREATE UNIQUE INDEX IF NOT EXISTS idx_roles_system_key
  ON roles (server_id, system_key) WHERE system_key IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_roles_name_ci
  ON roles (server_id, LOWER(name));

CREATE INDEX IF NOT EXISTS idx_roles_server_position
  ON roles (server_id, position);

CREATE TABLE IF NOT EXISTS member_roles (
  server_id UUID NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role_id UUID NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  PRIMARY KEY (server_id, user_id, role_id)
);

CREATE INDEX IF NOT EXISTS idx_member_roles_user_server
  ON member_roles (user_id, server_id);

-- Role grants are membership. Kick, ban, and leave delete server_members;
-- without this FK those rows survived, so a rejoining moderator kept KICK /
-- BAN / MANAGE_ROLES. Sweep orphans first so the constraint can land on a
-- database that already ran the table create without it.
DELETE FROM member_roles mr
 WHERE NOT EXISTS (
   SELECT 1 FROM server_members sm
    WHERE sm.server_id = mr.server_id AND sm.user_id = mr.user_id
 );

DO $$
BEGIN
  ALTER TABLE member_roles DROP CONSTRAINT IF EXISTS member_roles_membership_fk;
  ALTER TABLE member_roles
    ADD CONSTRAINT member_roles_membership_fk
    FOREIGN KEY (server_id, user_id)
    REFERENCES server_members (server_id, user_id)
    ON DELETE CASCADE;
EXCEPTION
  WHEN others THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS channel_overwrites (
  channel_id UUID NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  target_type TEXT NOT NULL CHECK (target_type IN ('role', 'member')),
  target_id UUID NOT NULL,
  allow BIGINT NOT NULL DEFAULT 0,
  deny BIGINT NOT NULL DEFAULT 0,
  PRIMARY KEY (channel_id, target_type, target_id)
);

-- `@everyone` is implicit membership. A row here would OR its bits twice.
CREATE OR REPLACE FUNCTION reject_everyone_member_role()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM roles r
     WHERE r.id = NEW.role_id
       AND (r.is_everyone OR r.system_key IN ('everyone', 'owner'))
  ) THEN
    RAISE EXCEPTION 'cannot assign the @everyone or Owner role';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS member_roles_reject_everyone ON member_roles;
CREATE TRIGGER member_roles_reject_everyone
  BEFORE INSERT OR UPDATE ON member_roles
  FOR EACH ROW
  EXECUTE FUNCTION reject_everyone_member_role();

-- Keep the seeded Admin role in sync with the derived rank column, so a raw
-- INSERT of role='admin' (tests, older paths) still receives ADMINISTRATOR.
CREATE OR REPLACE FUNCTION sync_admin_member_role()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_admin_id UUID;
BEGIN
  -- Rank refresh writes the compatibility column from cargos. Skip so that
  -- assigning Manager does not also grant the Admin cargo.
  IF current_setting('pqp.skip_rank_sync', true) = 'on' THEN
    RETURN NEW;
  END IF;
  SELECT id INTO v_admin_id
    FROM roles
   WHERE server_id = NEW.server_id AND system_key = 'admin';
  IF v_admin_id IS NULL THEN
    RETURN NEW;
  END IF;
  IF NEW.role = 'admin' THEN
    INSERT INTO member_roles (server_id, user_id, role_id)
    VALUES (NEW.server_id, NEW.user_id, v_admin_id)
    ON CONFLICT DO NOTHING;
  ELSIF NEW.role = 'member' THEN
    DELETE FROM member_roles
     WHERE server_id = NEW.server_id
       AND user_id = NEW.user_id
       AND role_id = v_admin_id;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS server_members_sync_admin_role ON server_members;
CREATE TRIGGER server_members_sync_admin_role
  AFTER INSERT OR UPDATE OF role ON server_members
  FOR EACH ROW
  EXECUTE FUNCTION sync_admin_member_role();

-- Seed @everyone + Admin on every existing server, then write private-channel
-- overwrites so channel_viewable can replace the old is_private OR rank hatch.
-- Must run BEFORE the function is first used on this boot.
DO $$
DECLARE
  filled INTEGER;
BEGIN
  IF EXISTS (
    SELECT 1 FROM data_migrations WHERE name = 'permissions_roles_backfill_2026_08'
  ) THEN
    RETURN;
  END IF;

  INSERT INTO roles (server_id, name, permissions, position, is_everyone, system_key, mentionable)
  SELECT s.id, 'everyone', 571073, 0, TRUE, 'everyone', FALSE
    FROM servers s
   WHERE NOT EXISTS (
     SELECT 1 FROM roles r WHERE r.server_id = s.id AND r.is_everyone
   );

  INSERT INTO roles (server_id, name, permissions, position, is_everyone, system_key, mentionable)
  SELECT s.id, 'Admin', 1048575, 1, FALSE, 'admin', FALSE
    FROM servers s
   WHERE NOT EXISTS (
     SELECT 1 FROM roles r WHERE r.server_id = s.id AND r.system_key = 'admin'
   );

  INSERT INTO member_roles (server_id, user_id, role_id)
  SELECT sm.server_id, sm.user_id, r.id
    FROM server_members sm
    JOIN roles r ON r.server_id = sm.server_id AND r.system_key = 'admin'
   WHERE sm.role = 'admin'
  ON CONFLICT DO NOTHING;

  -- Private channels: @everyone deny VIEW (64), listed members allow VIEW.
  INSERT INTO channel_overwrites (channel_id, target_type, target_id, allow, deny)
  SELECT c.id, 'role', r.id, 0, 64
    FROM channels c
    JOIN roles r ON r.server_id = c.server_id AND r.is_everyone
   WHERE c.kind = 'server' AND c.is_private
  ON CONFLICT DO NOTHING;

  INSERT INTO channel_overwrites (channel_id, target_type, target_id, allow, deny)
  SELECT cm.channel_id, 'member', cm.user_id, 64, 0
    FROM channel_members cm
    JOIN channels c ON c.id = cm.channel_id
   WHERE c.kind = 'server' AND c.is_private
  ON CONFLICT DO NOTHING;

  GET DIAGNOSTICS filled = ROW_COUNT;
  INSERT INTO data_migrations (name) VALUES ('permissions_roles_backfill_2026_08');
  RAISE NOTICE 'pqp: seeded roles/overwrites (last insert % rows)', filled;
END $$;

-- @everyone must not carry kick/ban/timeout/Administrator (bits 1, 2, 3, 18).
UPDATE roles
   SET permissions = permissions & ~262158
 WHERE is_everyone
   AND (permissions & 262158) <> 0;

-- Seeded Admin is hoisted so the member list matches the old Owner/Admins
-- headings without hardcoding rank names.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM data_migrations WHERE name = 'admin_role_hoist_2026_08'
  ) THEN
    RETURN;
  END IF;
  UPDATE roles SET hoist = TRUE WHERE system_key = 'admin' AND NOT hoist;
  INSERT INTO data_migrations (name) VALUES ('admin_role_hoist_2026_08');
END $$;

-- Existing databases still have the old CHECK. Drop every system_key check
-- (the inline name is usually roles_system_key_check, but do not depend on it).
-- Widen it, then add Owner / Manager / Moderator / VIP without colliding with
-- homemade names, and park custom cargos *below* staff so a homemade cargo
-- does not outrank Admin.
DO $$
DECLARE
  cname TEXT;
BEGIN
  FOR cname IN
    SELECT con.conname
      FROM pg_constraint con
     WHERE con.conrelid = 'roles'::regclass
       AND con.contype = 'c'
       AND pg_get_constraintdef(con.oid) ILIKE '%system_key%'
  LOOP
    EXECUTE format('ALTER TABLE roles DROP CONSTRAINT %I', cname);
  END LOOP;
END $$;
ALTER TABLE roles ADD CONSTRAINT roles_system_key_check
  CHECK (system_key IS NULL OR system_key IN ('everyone', 'owner', 'admin', 'manager', 'moderator', 'vip'));

ALTER TABLE roles ADD COLUMN IF NOT EXISTS show_badge BOOLEAN NOT NULL DEFAULT TRUE;

CREATE OR REPLACE FUNCTION pqp_unique_role_name(p_server_id UUID, p_wanted TEXT)
RETURNS TEXT
LANGUAGE plpgsql
AS $$
DECLARE
  candidate TEXT := p_wanted;
  n INTEGER := 2;
  stem TEXT := left(p_wanted, 28);
BEGIN
  WHILE EXISTS (
    SELECT 1 FROM roles
     WHERE server_id = p_server_id AND LOWER(name) = LOWER(candidate)
  ) LOOP
    candidate := stem || '_' || n::text;
    n := n + 1;
  END LOOP;
  RETURN candidate;
END;
$$;

-- Moderator extras: KICK(2) | MANAGE_MESSAGES(256) | MUTE(16384) |
-- MANAGE_NICKNAMES(65536) | MODERATE_MEMBERS(262144) = 344322.
-- Manager: ALL(2097151) minus ADMINISTRATOR(8) = 2097143.
-- VIP is a colour and a hoist with no extra bits (0).
-- Insert colours match STAFF_ROLE_COLORS in packages/shared/src/permissions.ts.
CREATE OR REPLACE FUNCTION pqp_ensure_staff_ladder(p_server_id UUID)
RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
  v_pos INTEGER;
  r RECORD;
BEGIN
  -- Claim a homemade cargo named VIP so existing halls keep their grants
  -- and colour instead of growing a second row called VIP_2.
  UPDATE roles
     SET system_key = 'vip',
         hoist = TRUE,
         show_badge = TRUE
   WHERE server_id = p_server_id
     AND system_key IS NULL
     AND LOWER(name) = 'vip'
     AND NOT EXISTS (
       SELECT 1 FROM roles x
        WHERE x.server_id = p_server_id AND x.system_key = 'vip'
     );

  IF NOT EXISTS (
    SELECT 1 FROM roles WHERE server_id = p_server_id AND system_key = 'vip'
  ) THEN
    INSERT INTO roles (
      server_id, name, permissions, position, is_everyone, system_key,
      mentionable, hoist, show_badge, color
    )
    VALUES (
      p_server_id, pqp_unique_role_name(p_server_id, 'VIP'), 0, 1,
      FALSE, 'vip', FALSE, TRUE, TRUE, '#B794D4'
    );
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM roles WHERE server_id = p_server_id AND system_key = 'moderator'
  ) THEN
    INSERT INTO roles (
      server_id, name, permissions, position, is_everyone, system_key,
      mentionable, hoist, show_badge, color
    )
    VALUES (
      p_server_id, pqp_unique_role_name(p_server_id, 'Moderator'), 344322, 1,
      FALSE, 'moderator', FALSE, TRUE, TRUE, '#4EC4B0'
    );
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM roles WHERE server_id = p_server_id AND system_key = 'manager'
  ) THEN
    INSERT INTO roles (
      server_id, name, permissions, position, is_everyone, system_key,
      mentionable, hoist, show_badge, color
    )
    VALUES (
      p_server_id, pqp_unique_role_name(p_server_id, 'Manager'), 2097143, 2,
      FALSE, 'manager', FALSE, TRUE, TRUE, '#6BA3E8'
    );
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM roles WHERE server_id = p_server_id AND system_key = 'owner'
  ) THEN
    INSERT INTO roles (
      server_id, name, permissions, position, is_everyone, system_key,
      mentionable, hoist, show_badge, color
    )
    VALUES (
      p_server_id, pqp_unique_role_name(p_server_id, 'Owner'), 0, 4,
      FALSE, 'owner', FALSE, TRUE, TRUE, '#E0B84C'
    );
  END IF;

  UPDATE roles SET hoist = TRUE
   WHERE server_id = p_server_id
     AND system_key IN ('vip', 'admin', 'manager', 'moderator', 'owner')
     AND NOT hoist;

  UPDATE roles SET color = '#B794D4'
   WHERE server_id = p_server_id AND system_key = 'vip' AND color IS NULL;

  UPDATE roles SET position = 0
   WHERE server_id = p_server_id AND is_everyone;

  v_pos := 1;
  FOR r IN
    SELECT id FROM roles
     WHERE server_id = p_server_id AND system_key IS NULL
     ORDER BY position ASC, LOWER(name) ASC, id ASC
  LOOP
    UPDATE roles SET position = v_pos WHERE id = r.id;
    v_pos := v_pos + 1;
  END LOOP;

  UPDATE roles SET position = v_pos
   WHERE server_id = p_server_id AND system_key = 'vip';
  v_pos := v_pos + 1;
  UPDATE roles SET position = v_pos
   WHERE server_id = p_server_id AND system_key = 'moderator';
  v_pos := v_pos + 1;
  UPDATE roles SET position = v_pos
   WHERE server_id = p_server_id AND system_key = 'manager';
  v_pos := v_pos + 1;
  UPDATE roles SET position = v_pos
   WHERE server_id = p_server_id AND system_key = 'admin';
  v_pos := v_pos + 1;
  UPDATE roles SET position = v_pos
   WHERE server_id = p_server_id AND system_key = 'owner';
END;
$$;

DO $$
DECLARE
  s RECORD;
BEGIN
  IF EXISTS (
    SELECT 1 FROM data_migrations WHERE name = 'staff_ladder_2026_08'
  ) THEN
    RETURN;
  END IF;

  FOR s IN SELECT id FROM servers LOOP
    PERFORM pqp_ensure_staff_ladder(s.id);
  END LOOP;

  INSERT INTO data_migrations (name) VALUES ('staff_ladder_2026_08');
END $$;

-- Paint seeded staff cargos that still have no colour. Do not overwrite a
-- colour someone already set, and do not re-run pqp_ensure_staff_ladder
-- (that would re-park custom cargos below staff). Hexes match STAFF_ROLE_COLORS.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM data_migrations WHERE name = 'staff_colors_2026_08'
  ) THEN
    RETURN;
  END IF;
  UPDATE roles SET color = '#E0B84C' WHERE system_key = 'owner' AND color IS NULL;
  UPDATE roles SET color = '#D46A8A' WHERE system_key = 'admin' AND color IS NULL;
  UPDATE roles SET color = '#6BA3E8' WHERE system_key = 'manager' AND color IS NULL;
  UPDATE roles SET color = '#4EC4B0' WHERE system_key = 'moderator' AND color IS NULL;
  INSERT INTO data_migrations (name) VALUES ('staff_colors_2026_08');
END $$;

-- Seed VIP on halls that already ran staff_ladder_2026_08. Claims a homemade
-- cargo named VIP (keeps grants and colour) instead of inserting VIP_2.
DO $$
DECLARE
  s RECORD;
BEGIN
  IF EXISTS (
    SELECT 1 FROM data_migrations WHERE name = 'staff_vip_2026_08'
  ) THEN
    RETURN;
  END IF;

  FOR s IN SELECT id FROM servers LOOP
    PERFORM pqp_ensure_staff_ladder(s.id);
  END LOOP;

  INSERT INTO data_migrations (name) VALUES ('staff_vip_2026_08');
END $$;

-- MANAGE_WEBHOOKS (bit 20 = 1048576). Owner/Administrator already resolve to
-- PERMISSION_ALL in application code, but stored system-role masks must carry
-- the new bit so a manager who is not the owner person still passes
-- requirePermission. The fingerprint is the same shape as the email-scrub
-- and character-invariants repairs: changing the rule re-arms the pass.
DO $$
DECLARE
  rule CONSTANT TEXT := 'OR MANAGE_WEBHOOKS(1048576) onto manager/admin/owner';
  marker CONSTANT TEXT := 'pqp-manage-webhooks-bit ' || md5(rule);
  col_attnum SMALLINT;
BEGIN
  SELECT a.attnum INTO col_attnum FROM pg_attribute a
  WHERE a.attrelid = 'roles'::regclass AND a.attname = 'permissions'
    AND NOT a.attisdropped;

  IF col_description('roles'::regclass, col_attnum) IS NOT DISTINCT FROM marker THEN
    RETURN;
  END IF;

  UPDATE roles
     SET permissions = permissions | 1048576
   WHERE system_key IN ('manager', 'admin', 'owner');

  EXECUTE format(
    'COMMENT ON COLUMN roles.permissions IS %L',
    marker
  );
END $$;

-- Who may VIEW this channel (the effective row: parent for a thread).
-- Conversations never call this; channelVisibleSql keeps that branch as
-- channel_members only.
CREATE OR REPLACE FUNCTION channel_viewable(p_channel_id UUID, p_user_id UUID)
RETURNS BOOLEAN
LANGUAGE plpgsql
STABLE
AS $$
DECLARE
  v_server_id UUID;
  v_owner_id UUID;
  v_everyone_id UUID;
  v_base BIGINT;
  v_role_deny BIGINT;
  v_role_allow BIGINT;
  v_member_deny BIGINT;
  v_member_allow BIGINT;
  v_admin BIGINT := 8;
  v_view BIGINT := 64;
BEGIN
  SELECT c.server_id, s.owner_id
    INTO v_server_id, v_owner_id
    FROM channels c
    JOIN servers s ON s.id = c.server_id
   WHERE c.id = p_channel_id AND c.kind = 'server';

  IF NOT FOUND THEN
    RETURN FALSE;
  END IF;

  IF v_owner_id = p_user_id THEN
    RETURN TRUE;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM server_members
     WHERE server_id = v_server_id AND user_id = p_user_id
  ) THEN
    RETURN FALSE;
  END IF;

  SELECT id INTO v_everyone_id
    FROM roles
   WHERE server_id = v_server_id AND is_everyone;

  IF v_everyone_id IS NULL THEN
    RETURN FALSE;
  END IF;

  SELECT COALESCE((
           SELECT r.permissions FROM roles r WHERE r.id = v_everyone_id
         ), 0)
         | COALESCE((
           SELECT bit_or(r.permissions)
             FROM member_roles mr
             JOIN roles r ON r.id = mr.role_id
            WHERE mr.server_id = v_server_id AND mr.user_id = p_user_id
         ), 0)
    INTO v_base;

  IF (v_base & v_admin) <> 0 THEN
    RETURN TRUE;
  END IF;

  SELECT COALESCE(o.allow, 0), COALESCE(o.deny, 0)
    INTO v_role_allow, v_role_deny
    FROM (SELECT 1) AS _
    LEFT JOIN channel_overwrites o
      ON o.channel_id = p_channel_id
     AND o.target_type = 'role'
     AND o.target_id = v_everyone_id;
  v_base := (v_base & ~COALESCE(v_role_deny, 0)) | COALESCE(v_role_allow, 0);

  SELECT COALESCE(bit_or(o.deny), 0), COALESCE(bit_or(o.allow), 0)
    INTO v_role_deny, v_role_allow
    FROM channel_overwrites o
   WHERE o.channel_id = p_channel_id
     AND o.target_type = 'role'
     AND o.target_id <> v_everyone_id
     AND o.target_id IN (
       SELECT mr.role_id FROM member_roles mr
        WHERE mr.server_id = v_server_id AND mr.user_id = p_user_id
     );
  v_base := (v_base & ~COALESCE(v_role_deny, 0)) | COALESCE(v_role_allow, 0);

  SELECT o.allow, o.deny
    INTO v_member_allow, v_member_deny
    FROM channel_overwrites o
   WHERE o.channel_id = p_channel_id
     AND o.target_type = 'member'
     AND o.target_id = p_user_id;
  IF FOUND THEN
    v_base := (v_base & ~v_member_deny) | v_member_allow;
  END IF;

  RETURN (v_base & v_view) <> 0;
END;
$$;

-- ---------------------------------------------------------------- community home (Baú)
--
-- Durable media feed per server. Not a channel type. Drafts / scheduled posts
-- are staff-only; members only ever see status = published. Members-only
-- visibility strips body/media on the wire unless the viewer has MANAGE_SERVER
-- or the VIP cargo. Likes are a unique (post_id, user_id) pair, never a counter
-- column. Media bytes live in object storage under community-home/{serverId}/;
-- YouTube is URL-only. Schedule is first-class: scheduled_at + IANA timezone,
-- published by an in-process catch-up on the single Node process (no worker).

CREATE TABLE IF NOT EXISTS community_home_posts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  server_id UUID NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  author_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title TEXT,
  body TEXT NOT NULL DEFAULT '',
  teaser TEXT,
  visibility TEXT NOT NULL DEFAULT 'free',
  status TEXT NOT NULL DEFAULT 'draft',
  comments_enabled BOOLEAN NOT NULL DEFAULT TRUE,
  media_kind TEXT,
  media_name TEXT,
  media_content_type TEXT,
  media_byte_size BIGINT,
  media_storage_key TEXT,
  media_youtube_url TEXT,
  scheduled_at TIMESTAMPTZ,
  schedule_timezone TEXT,
  published_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

DO $$
BEGIN
  ALTER TABLE community_home_posts DROP CONSTRAINT IF EXISTS community_home_posts_visibility_check;
  ALTER TABLE community_home_posts
    ADD CONSTRAINT community_home_posts_visibility_check
    CHECK (visibility IN ('free', 'members'));
EXCEPTION
  WHEN others THEN NULL;
END $$;

DO $$
BEGIN
  ALTER TABLE community_home_posts DROP CONSTRAINT IF EXISTS community_home_posts_status_check;
  ALTER TABLE community_home_posts
    ADD CONSTRAINT community_home_posts_status_check
    CHECK (status IN ('draft', 'published', 'scheduled'));
EXCEPTION
  WHEN others THEN NULL;
END $$;

DO $$
BEGIN
  ALTER TABLE community_home_posts DROP CONSTRAINT IF EXISTS community_home_posts_media_kind_check;
  ALTER TABLE community_home_posts
    ADD CONSTRAINT community_home_posts_media_kind_check
    CHECK (
      media_kind IS NULL
      OR media_kind IN ('image', 'video', 'youtube', 'file')
    );
EXCEPTION
  WHEN others THEN NULL;
END $$;

-- Feed: published newest-first per server. Partial so drafts/scheduled stay
-- out of the hot index members walk.
CREATE INDEX IF NOT EXISTS idx_community_home_posts_feed
  ON community_home_posts (server_id, published_at DESC)
  WHERE status = 'published';

-- Staff drafts list.
CREATE INDEX IF NOT EXISTS idx_community_home_posts_staff
  ON community_home_posts (server_id, updated_at DESC);

-- Schedule catch-up: due rows only.
CREATE INDEX IF NOT EXISTS idx_community_home_posts_due
  ON community_home_posts (scheduled_at)
  WHERE status = 'scheduled';

CREATE TABLE IF NOT EXISTS community_home_comments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  post_id UUID NOT NULL REFERENCES community_home_posts(id) ON DELETE CASCADE,
  author_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  body TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_community_home_comments_post
  ON community_home_comments (post_id, created_at DESC);

-- The one post an owner keeps at the top: a welcome, a video, the rules. A
-- timestamp rather than a boolean so the feed can order by it and support can
-- see when it was set.
ALTER TABLE community_home_posts ADD COLUMN IF NOT EXISTS pinned_at TIMESTAMPTZ;

-- ONE PINNED POST PER SERVER, enforced here rather than in the service: a
-- wall of pinned posts is just a feed with extra steps, and two writers
-- racing to pin must not both win. The service unpins the previous one in the
-- same transaction, so this index is the backstop, not the error path.
CREATE UNIQUE INDEX IF NOT EXISTS idx_community_home_posts_pinned_one
  ON community_home_posts (server_id)
  WHERE pinned_at IS NOT NULL;

-- How far each person has read this server's Baú. Mirrors `channel_reads`:
-- one row per (server, person), stamped when the feed is opened. The unread
-- count is derived from it, never stored, so it cannot drift.
CREATE TABLE IF NOT EXISTS community_home_reads (
  server_id UUID NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (server_id, user_id)
);

CREATE TABLE IF NOT EXISTS community_home_likes (
  post_id UUID NOT NULL REFERENCES community_home_posts(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (post_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_community_home_likes_user
  ON community_home_likes (user_id);

-- Pending media mint → claim. Same orphan-sweep idea as message_attachments:
-- an upload never attached to a post is deleted after a grace period.
CREATE TABLE IF NOT EXISTS community_home_media_uploads (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  server_id UUID NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  uploader_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  storage_key TEXT NOT NULL UNIQUE,
  filename TEXT NOT NULL,
  content_type TEXT NOT NULL,
  byte_size BIGINT NOT NULL,
  kind TEXT NOT NULL,
  claimed_post_id UUID REFERENCES community_home_posts(id) ON DELETE SET NULL,
  verified_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

DO $$
BEGIN
  ALTER TABLE community_home_media_uploads DROP CONSTRAINT IF EXISTS community_home_media_uploads_kind_check;
  ALTER TABLE community_home_media_uploads
    ADD CONSTRAINT community_home_media_uploads_kind_check
    CHECK (kind IN ('image', 'video', 'file'));
EXCEPTION
  WHEN others THEN NULL;
END $$;

CREATE INDEX IF NOT EXISTS idx_community_home_media_unclaimed
  ON community_home_media_uploads (created_at)
  WHERE claimed_post_id IS NULL AND verified_at IS NULL;

-- The rollout flag above only decides whether a client may offer Baú at all.
-- Each server opts in separately, and existing servers stay off.
ALTER TABLE servers ADD COLUMN IF NOT EXISTS community_home_enabled BOOLEAN NOT NULL DEFAULT FALSE;
