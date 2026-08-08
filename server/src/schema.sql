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
-- the picker returns a GIPHY URL, and re-hosting a GIF we are allowed to hot-link
-- would cost storage and egress to gain nothing.
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
CREATE INDEX IF NOT EXISTS idx_message_reactions_user
  ON message_reactions (user_id);
CREATE INDEX IF NOT EXISTS idx_message_attachments_uploader
  ON message_attachments (uploader_id);
CREATE INDEX IF NOT EXISTS idx_channel_reads_user
  ON channel_reads (user_id);
CREATE INDEX IF NOT EXISTS idx_audit_log_actor
  ON audit_log (actor_id) WHERE actor_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- push  — Web Push subscriptions (services/push.ts)
-- ---------------------------------------------------------------------------
--
-- One row per browser push endpoint. The endpoint is UNIQUE across users, not
-- per user: a browser profile holds exactly one subscription, and if another
-- account signs in on the same device the endpoint must follow the account —
-- two rows would push one person's mentions to whoever holds the phone now.
--
-- Rows are capped per user (MAX_PUSH_SUBSCRIPTIONS_PER_USER, enforced on
-- insert) and garbage-collected on the vendor's own signal: a 404/410 from the
-- push service deletes the row. Nothing else prunes them, because nothing else
-- knows a subscription is dead.
--
-- The p256dh/auth values are the browser-generated *public* encryption
-- parameters from PushSubscription.getKey() — no message content is ever
-- stored here, and the VAPID private key lives only in the environment.
CREATE TABLE IF NOT EXISTS push_subscriptions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  endpoint TEXT NOT NULL UNIQUE,
  p256dh TEXT NOT NULL,
  auth TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

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
