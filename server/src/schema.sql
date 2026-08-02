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

-- Full-text search vector. GENERATED ... STORED rather than a trigger: the
-- vector cannot drift from the body it describes, edits maintain it for free,
-- and existing rows are backfilled by the one ALTER.
--
-- 'english' is a deliberate trade: stemming is what makes "deploying" find
-- "deploy", which is most of why search feels like search. A multilingual server
-- pays for it in recall on its non-English messages — the escape hatch is to
-- change the configuration here, which rewrites the column on next boot.
ALTER TABLE messages ADD COLUMN IF NOT EXISTS search_tsv tsvector
  GENERATED ALWAYS AS (to_tsvector('english', body)) STORED;

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

-- Partial on both sides, because the two access patterns never overlap: reads
-- fetch attachments for a page of messages, the sweeper only ever looks at rows
-- with no message. A single full index would carry each set through the other's
-- lookups for nothing.
CREATE INDEX IF NOT EXISTS idx_message_attachments_message
  ON message_attachments (message_id) WHERE message_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_message_attachments_unclaimed
  ON message_attachments (created_at) WHERE message_id IS NULL;

CREATE INDEX IF NOT EXISTS idx_channels_server
  ON channels (server_id, position);

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
