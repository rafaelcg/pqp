# Forum channels

**Status:** spec, nothing built. Owner decision (Rafael, 2026-10-03): build them.
A Brazilian dev community asked for a place where support questions, feature
requests, guides and bug reports do not scroll away and can be found later.

**One-paragraph model.** A forum is a new channel type, `forum`, that holds no
messages of its own. Each post is a **thread channel** (`type = 'thread'`)
whose `parent_id` is the forum and whose `thread_root_message_id` is NULL. A
small side table, `forum_posts`, carries what a chat thread does not need:
author, opening message, pinned / locked / resolved, and a bumped
`last_activity_at` that the list sorts on. Tags are two more small tables.
Messages, attachments, mentions, reactions, read cursors, search, retention,
reports, timeouts, slow mode and the fan-out audience all apply to a post
already, because a post is a channel and the visibility and overwrite code
already resolves a thread to its parent.

**Reading order.** The `-- threads` block in `server/src/schema.sql`,
`server/src/services/threads.ts` and `packages/shared/src/threads.ts` first:
this plan is that model with a different parent. Then `docs/FEATURE_FLAGS.md`
(the flag), CLAUDE.md pitfall 22 (boot DDL), `docs/ONBOARDING.md` (the one
hint), `docs/DISCORD_IMPORT.md` (phase 3), `docs/CONTENT_SAFETY.md`
§Communities (reports, SEO position).

---

## 1. Data model

### 1.1 Decision: a post is a thread channel, the post's extras are a side table

| Option | Verdict | Why |
|---|---|---|
| Post = `channels` row `type='thread'`, `parent_id` = forum, extras in `forum_posts` | **Chosen** | Every system keyed by channel id covers posts for free (the reason threads are channels, see the schema comment). `channelVisibleSql` (`server/src/services/users.ts`) and `applyChannelOverwrites` (`server/src/services/permissions.ts`) already resolve `type='thread'` to the parent, so a private forum's posts are private with zero new code. The `thread-join` WS slot already accepts any `type='thread'` id, so "forum list + open post" is the existing "channel + thread panel" pair. |
| New `type='forum_post'` | Rejected | Every `type = 'thread'` branch above (visibility, overwrites, `thread-join`, slow mode, `deleteChannel`'s child sweep, `fetchAllServerChannels`' exclusion) would need a second arm. Each one missed is a leak. |
| Columns on `channels` (`pinned_at`, `locked_at`, ...) | Rejected | `channels` is one of the 27 tables the boot DDL re-locks (pitfall 22), every `ADD COLUMN IF NOT EXISTS` takes ACCESS EXCLUSIVE before it checks, and 99% of channel rows would carry NULLs. A new table locks nothing that exists. |
| Posts as rows in a new `forum_posts` table with their own messages table | Rejected | A parallel messaging path, which CLAUDE.md calls "how this feature turns into a rewrite". |

A forum channel itself is an ordinary `channels` row: name, topic, position,
category, `is_private`, overwrites, `slowmode_seconds`. It never holds a message
(the send path refuses, §1.6).

### 1.2 Schema (additive, idempotent)

One new block at the end of `server/src/schema.sql`, `-- forum channels`.

```sql
-- forum channels
--
-- A FORUM IS A CHANNEL THAT HOLDS POSTS, AND A POST IS A THREAD. The forum row
-- is `type = 'forum'` and never carries a message. Each post is a `channels`
-- row with `type = 'thread'`, `parent_id` = the forum, and
-- `thread_root_message_id` NULL (it grew out of no message; the CHECK
-- `channels_thread_root_check` already allows that). Visibility, overwrites,
-- slow mode, read cursors, mentions, search, retention and reports therefore
-- cover posts by construction. `forum_posts` carries only what a chat thread
-- does not need. See docs/plans/FORUM_CHANNELS.md.

DO $$
BEGIN
  ALTER TABLE channels DROP CONSTRAINT IF EXISTS channels_type_check;
  ALTER TABLE channels
    ADD CONSTRAINT channels_type_check
    CHECK (type IN ('text', 'voice', 'category', 'thread', 'watch_party', 'forum'));
EXCEPTION WHEN others THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS forum_posts (
  -- The post's own thread channel. Deleting the channel deletes the post.
  channel_id UUID PRIMARY KEY REFERENCES channels(id) ON DELETE CASCADE,
  -- Denormalised copy of channels.parent_id, so the list index lives here.
  -- Posts never move between forums in v1, so the two cannot disagree.
  forum_id UUID NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  author_id UUID REFERENCES users(id) ON DELETE SET NULL,
  -- NO FOREIGN KEY, on purpose. A FK into `messages` would add a lookup on
  -- this table to every message delete in the product, and CREATE TABLE would
  -- lock `messages` once. A deleted opening message reads as NULL through the
  -- LEFT JOIN in the list query, which is the same answer SET NULL would give.
  opening_message_id UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- NULL while the post is a shell waiting for its opening message (§1.5).
  -- Every read path filters on it; a shell is never listed.
  published_at TIMESTAMPTZ,
  -- BUMP semantics, written by the send path (§1.4). Deleting a reply does not
  -- un-bump, which is what every forum does and what a reader expects.
  last_activity_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  pinned_at TIMESTAMPTZ,
  locked_at TIMESTAMPTZ,
  resolved_at TIMESTAMPTZ,
  -- Idempotent create: a retried POST with the same nonce returns the post.
  client_nonce TEXT
);

-- The two list orders. Keyset on (sort key, channel_id) so two posts in the
-- same millisecond page stably. Partial: shells are never listed.
CREATE INDEX IF NOT EXISTS idx_forum_posts_activity
  ON forum_posts (forum_id, last_activity_at DESC, channel_id DESC)
  WHERE published_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_forum_posts_created
  ON forum_posts (forum_id, created_at DESC, channel_id DESC)
  WHERE published_at IS NOT NULL;
-- Pinned posts are a handful per forum; read them apart from the page.
CREATE INDEX IF NOT EXISTS idx_forum_posts_pinned
  ON forum_posts (forum_id) WHERE pinned_at IS NOT NULL;
-- "Meus posts", and the cascade when an account is deleted.
CREATE INDEX IF NOT EXISTS idx_forum_posts_author
  ON forum_posts (author_id, forum_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_forum_posts_nonce
  ON forum_posts (forum_id, author_id, client_nonce)
  WHERE client_nonce IS NOT NULL;
-- The shell sweep (§1.5).
CREATE INDEX IF NOT EXISTS idx_forum_posts_shells
  ON forum_posts (created_at) WHERE published_at IS NULL;

CREATE TABLE IF NOT EXISTS forum_tags (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  forum_id UUID NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  name TEXT NOT NULL CHECK (char_length(name) BETWEEN 1 AND 20),
  -- One unicode emoji or NULL. No custom emoji in v1.
  emoji TEXT CHECK (emoji IS NULL OR char_length(emoji) <= 16),
  -- Only MANAGE_MESSAGES may put it on or take it off a post ("Confirmado").
  moderated BOOLEAN NOT NULL DEFAULT FALSE,
  position INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
-- Leads with forum_id, so it also serves the cascade from channels.
CREATE UNIQUE INDEX IF NOT EXISTS idx_forum_tags_name
  ON forum_tags (forum_id, lower(name));

CREATE TABLE IF NOT EXISTS forum_post_tags (
  post_id UUID NOT NULL REFERENCES forum_posts(channel_id) ON DELETE CASCADE,
  tag_id UUID NOT NULL REFERENCES forum_tags(id) ON DELETE CASCADE,
  PRIMARY KEY (post_id, tag_id)
);
CREATE INDEX IF NOT EXISTS idx_forum_post_tags_tag
  ON forum_post_tags (tag_id, post_id);
```

Caps live in `packages/shared/src/forums.ts` and are enforced by the routes, not
by triggers: 20 tags per forum, 5 tags per post, 3 pinned posts per forum, title
1 to 100 characters (Discord's forum limit, so an imported habit fits).

**Pitfall 22 check.**

- No `ALTER TABLE ... ADD COLUMN` on any existing table. The only statement
  touching an existing table is the `channels_type_check` DO block, which is
  the same DROP/ADD every boot that runs the file already does three times
  (`schema.sql` ~1053, ~1920, ~4018). The block for `'forum'` goes after the
  watch party one. The older blocks fail on a database that has forum rows,
  their `EXCEPTION WHEN others THEN NULL` rolls each back, and the last block
  leaves the full list in place: the same mechanism `thread` and `watch_party`
  already rely on.
- `CREATE TABLE IF NOT EXISTS` with FKs into `channels` and `users` takes a
  SHARE ROW EXCLUSIVE on those two tables the first time only. On later runs
  the table exists and nothing is locked.
- The `CREATE INDEX IF NOT EXISTS` lines are on the new tables, so the lock
  they take while the schema transaction is open holds back nothing but
  forum writes, and only on a boot where the file changed.
- With `BOOT_SCHEMA_MODE=changed` (the default) the deploy that carries this
  block runs the whole file once, under the advisory lock and the 2 s
  `lock_timeout` with retries (`server/src/db.ts`). Merge P1 outside a live
  watch party (the `freeze` label applies).
- No backfill. Nothing goes into `BOOT_EVERY_TIME_SWEEPS`.
  `server/src/db-boot-schema.test.ts` must still pass (it fails on an
  unclassified top-level DML statement, and this block has none).

### 1.3 The list query, and why it is cheap at 50 posts

Two reads per page. The first is the same for every viewer who can see the
forum and goes through `coalesce` in `server/src/lib/read-cache.ts` (key
`forum:posts:<forumId>:<sort>:<filterHash>`, first page only, 2 s TTL,
invalidated with `invalidate("forum:posts:<forumId>:")` on every write on this
process). The second is per viewer and never cached.

```sql
-- Shared half (sort = activity; created swaps the key column and index).
-- $1 forum, $2/$3 keyset cursor (NULL on page 1), $4 limit + 1,
-- $5 tag ids (NULL = any), $6 status ('open' | 'resolved' | NULL),
-- $7 author (NULL unless "Meus posts", which bypasses the cache).
SELECT p.channel_id, c.name AS title, p.author_id, p.created_at,
       p.last_activity_at, p.pinned_at, p.locked_at, p.resolved_at,
       left(regexp_replace(om.body, '\s+', ' ', 'g'), 200) AS preview,
       (SELECT count(*) FROM message_attachments a
         WHERE a.message_id = om.id)::int AS attachment_count,
       (SELECT count(*) FROM messages m
         WHERE m.channel_id = p.channel_id
           AND m.id IS DISTINCT FROM p.opening_message_id)::int AS reply_count,
       ARRAY(SELECT t.tag_id FROM forum_post_tags t
              WHERE t.post_id = p.channel_id) AS tag_ids
  FROM forum_posts p
  JOIN channels c ON c.id = p.channel_id
  LEFT JOIN messages om ON om.id = p.opening_message_id
 WHERE p.forum_id = $1
   AND p.published_at IS NOT NULL
   AND p.pinned_at IS NULL
   AND ($2::timestamptz IS NULL
        OR (p.last_activity_at, p.channel_id) < ($2, $3::uuid))
   AND ($5::uuid[] IS NULL OR EXISTS (
         SELECT 1 FROM forum_post_tags t
          WHERE t.post_id = p.channel_id AND t.tag_id = ANY($5)))
   AND ($6::text IS NULL
        OR ($6 = 'resolved') = (p.resolved_at IS NOT NULL))
   AND ($7::uuid IS NULL OR p.author_id = $7)
 ORDER BY p.last_activity_at DESC, p.channel_id DESC
 LIMIT $4;
```

Page 1 also reads the pinned posts (same columns, `pinned_at IS NOT NULL`, same
filters, at most 3) and puts them on top. Later pages never repeat them.

**Does "computed on read" hold for 50 posts?** For the reply count, yes: it is
one `count(*)` per post over `idx_messages_channel_created`, an index-only scan
bounded by that post's size, so 50 posts at a typical 5 to 50 replies is a few
thousand index entries. A pathological 20,000-reply post costs a few ms on its
own. For the **sort key, no**, and that is why `last_activity_at` is stored:
ordering by a computed `max(created_at)` means computing it for every post in
the forum before the LIMIT applies (the shape `listActiveThreadsByParent`
already has to fight), and keyset pagination over a computed value is not
possible at all. The stored bump costs one primary-key UPDATE per message in a
post and nothing for any other channel (§1.4). Tag and status filters are
residual predicates on the activity index: fine to the low tens of thousands of
posts per forum, which is far beyond any pqp server today. Past that, the
answer is a `(tag_id, ...)` driven query, not a change of model.

Per-viewer half, one statement over the page's ids (§4.2 for what the two
flags mean):

```sql
SELECT p.post_id, cr.last_read_at
  FROM unnest($1::uuid[]) AS p(post_id)
  LEFT JOIN channel_reads cr
    ON cr.channel_id = p.post_id AND cr.user_id = $2;
```

### 1.4 Last activity without a write on every message

`postChannelMessageAttempt` (`server/src/ws/chat.ts`) already knows the channel
row. After `createMessage` commits, and only when `channel.type === 'thread'`:

```sql
UPDATE forum_posts
   SET last_activity_at = GREATEST(last_activity_at, $2)
 WHERE channel_id = $1 AND published_at IS NOT NULL
RETURNING forum_id;
```

- For a chat thread this is a primary-key probe that matches nothing. For a
  text, voice or DM channel it does not run.
- `GREATEST` makes it order-free, so it may run outside the message
  transaction and two concurrent sends cannot move it backwards (pitfall 13 is
  about writes whose order matters; this one's does not).
- When it returns a row, the same function reads that one post's summary
  (the list query with `WHERE p.channel_id = $1`) and broadcasts
  `forum-post-upsert` to the forum (§4.1). This sits beside the existing
  `getThreadInfo` call, which already skips posts because
  `rootMessageId` is NULL.

### 1.5 Creating a post: one request, no half posts

`POST /api/channels/:forumId/posts`, body
`{ title, body, tagIds?, attachmentIds?, nonce }`:

1. Access and gates: `requireChannelAccess(forumId)`, `type === 'forum'`, flag
   on for the server (§8), `SEND_MESSAGES` on the forum through
   `requirePermission(serverId, userId, bit, forumId)` (overwrites apply),
   `ATTACH_FILES` when `attachmentIds` is non-empty, the timeout check
   (`findTimeoutForChannel`, the same one the WS chokepoint runs), moderated
   tags only with `MANAGE_MESSAGES`. (`findTimeoutForChannel` lives in
   `server/src/services/sanctions.ts`.)
2. Budgets: `takeMessageBudget` (the per-user send bucket the WS and the bot
   HTTP send share), the per-user post bucket (§5.4), then `chargeSlowMode`
   (`server/src/services/slow-mode.ts`) on the **forum** id, so a forum's slow
   mode is the interval between new posts.
3. AutoMod on the title: `checkAutomod` (`server/src/services/automod.ts`)
   with the title as the body. A hit refunds the slow-mode charge and returns
   the same `automod` rejection the composer already renders.
4. Insert the shell, one transaction: the `channels` row
   (`type 'thread'`, `kind 'server'`, `parent_id` = forum, `name` = title),
   the `forum_posts` row with `published_at` NULL and the nonce, and the
   `forum_post_tags` rows. A nonce conflict returns the existing post (200).
5. The opening message: `postChannelMessage({ author, channelId: postId, body,
   attachmentIds, nonce })`. This is the path every message takes: access
   (the parent's answer), `SEND_MESSAGES`, AutoMod on the body, attachment
   claims and their `HEAD` (outside any transaction, as `docs/ATTACHMENTS.md`
   requires), mentions, `channel-activity`, push for mentions.
6. On `ok`: `UPDATE forum_posts SET opening_message_id = $2, published_at =
   now(), last_activity_at = now()`, then broadcast `forum-post-upsert` and a
   `channel-activity` for the forum (§4.1). 201 with the summary.
7. On any rejection: `deleteChannel(postId)` (cascades the shell), refund slow
   mode, and answer 422 with the same `reason` / `retryAfterMs` /
   `automodMessage` the WS `message-rejected` frame carries, so the client
   reuses its copy.

A crash between 4 and 6 leaves a shell nobody can see. A sweep in
`server/src/jobs.ts` (beside `sweepSlowModeClocks`, so it runs on `pqp-worker`
when that exists) deletes shells older than 10 minutes through
`deleteChannel`, reading `idx_forum_posts_shells`.

### 1.6 What else changes on the server, by file

| File | Change |
|---|---|
| `packages/shared/src/api.ts` | `channelTypeSchema` gains `"forum"`, which `createChannelSchema` then accepts like `text` (private allowed, topic as guidelines). |
| `packages/shared/src/forums.ts` (new) | Caps, `forumPostSummarySchema`, `forumTagSchema`, request schemas, the two WS frames. Imports nothing from `api.ts`, same rule as `threads.ts`. |
| `packages/shared/src/chat.ts` | Add the two frames to `chatServerMessageSchema`. Add `"locked"` to `messageRejectReasonSchema` (only forum-aware clients can reach a post, so an old client never sees it). Optional `parentChannelId` on `channelActivitySchema` (P2, §4.2). |
| `server/src/services/forums.ts` (new) | List, create, update, delete, tags. The SQL above. |
| `server/src/api/index.ts` | The routes in §3.6, `GET /api/forum/config`. |
| `server/src/services/servers.ts` | `createChannel`'s `type` union gains `"forum"`. Its position query groups siblings by `type = $2`, but the sidebar shows forums among text channels, so `createChannel` and `moveChannel` count `forum` in the **text** group (`type IN ('text', 'forum')`), or two rows share position 0 in one visible list. `deleteChannel`: read the child threads' attachment keys in **one** query (`channel_id = ANY($1)`) instead of `Promise.all` over `channelAttachmentKeys` per thread: a forum with 2,000 posts would otherwise fire 2,000 queries at the pool at once. |
| `server/src/ws/chat.ts` | `postChannelMessageAttempt`: refuse `type === 'forum'` (`no-access`); refuse a reply in a locked post unless `MANAGE_MESSAGES` or `MANAGE_CHANNELS` (`locked`); the bump in §1.4. The slow-mode type list gains nothing (a forum is charged by the post route, a post is a `thread`). |
| `server/src/services/users.ts` | `listUnread`: exclude posts, add forum rows (§4.2). |
| `server/src/services/retention.ts` | `sweepMessageRetention` exempts opening messages (`id IN (SELECT opening_message_id FROM forum_posts ...)`), the way it already exempts pins: a post whose question was swept is a title with orphaned answers. |
| `server/src/services/servers.ts`, `server/src/services/outgoing-webhooks.ts`, the incoming webhook create route | A forum cannot be a webhook target, an AutoMod alert channel, or a purge target. Each already checks `type === 'text'`; confirm, do not assume. |
| `server/src/lib/flags.ts`, `flags.test.ts`, `tools/admin-dashboard/site/novo.js` | The flag (§8). |
| `server/src/jobs.ts` | The shell sweep. |

---

## 2. Permissions

**No new bit.** Every forum action maps to a bit people already understand, and
pqp has no thread bits to copy from (starting a chat thread only needs channel
access today).

| Action | Who | Bit and scope |
|---|---|---|
| See the forum and every post | anyone who can see the forum | `VIEW_CHANNEL` on the forum; posts follow the parent by construction |
| Read history | same | `READ_MESSAGE_HISTORY`, as for any channel |
| Create a post | members | `SEND_MESSAGES` on the forum (plus `ATTACH_FILES` for files) |
| Reply | members | `SEND_MESSAGES`, resolved through the parent's overwrites by `applyChannelOverwrites` |
| Reply in a locked post | staff | `MANAGE_MESSAGES` or `MANAGE_CHANNELS` on the forum (the same pair that walks through slow mode) |
| Edit own title and own tags, mark own post resolved / reopen | the author | authorship (`forum_posts.author_id`) |
| Apply a moderated tag | staff | `MANAGE_MESSAGES` on the forum |
| Pin, lock, rename / retag / resolve anyone's post, delete a post | staff | `MANAGE_MESSAGES` on the forum (or `MANAGE_CHANNELS`) |
| Create, edit, reorder, delete tags; set the guidelines (topic) and slow mode | channel managers | `MANAGE_CHANNELS` on the forum, the bit that owns every other channel setting |
| Create a forum channel | channel managers | `MANAGE_CHANNELS` on the server, as for any channel |

- **Deleting a whole post is staff only.** The author deletes their opening
  message the ordinary way (the post stays, the preview reads "A mensagem
  original foi apagada", the existing `thread.originDeleted` string). Letting
  an author delete the post would delete everyone else's answers with it.
  Open question 2.
- **Channel-scoped checks.** Every post route passes the forum id to
  `memberHasPermission`, so a "Suporte" cargo given `MANAGE_MESSAGES` only on
  `#ajuda` can moderate that forum and nothing else. Note that today's message
  delete route (`DELETE /api/messages/:messageId`) checks `MANAGE_MESSAGES`
  server-wide without a channel id; the forum routes do not copy that.
- **Default for a new forum:** no overwrites, so `@everyone` can read, post and
  reply with the seeded defaults (`PERMISSION_DEFAULT_EVERYONE` has
  `SEND_MESSAGES`). A read-only announcements-style forum is one overwrite:
  deny `SEND_MESSAGES` for `@everyone`, allow it for a cargo.
- **Community servers:** no difference. A community is a server with a public
  address; posts are members-only like every channel. The extra exposure is
  drive-by accounts joining through the link and posting, handled in §5.4.
- **VIP / members-only:** a VIP forum is the existing per-channel overwrite
  (deny `VIEW_CHANNEL` to `@everyone`, allow it to the `vip` cargo). There is
  no per-post visibility in v1: "visibility follows the parent" is the rule
  that makes posts safe, and a post more private than its forum would be the
  first exception to it.

---

## 3. Product behaviour

### 3.1 What we copy, what we skip

| Product | What it does | Copy | Skip |
|---|---|---|---|
| Discord forums | Posts are threads in a forum channel; tags (20, some moderator-only); sort by activity or creation; guidelines; gallery layout; required tag; default reaction; follow | Posts as threads, moderated tags, the two sorts, guidelines, pinned post, "Novo" badge | Gallery layout, default reaction, required tag, per-post slow mode setting, auto-archive (our posts never leave the list) |
| Reddit | Votes, hot ranking, flair, stickied posts, nested comments | Flair is our tags; stickied is our pin (cap 3) | Votes and ranking, nested replies, public indexed pages |
| Discourse | Categories of topics, bump on reply, "new" vs "unread" topic states, accepted solution, similar-topic warning while composing | Bump semantics, the new/unread split, "resolvido" as a first-class state, title search | Trust levels, likes, email digests, wiki posts |
| Slack lists | Items with a status field, assignees, due dates | One status field (open / resolved) | Custom fields, assignees, due dates |

### 3.2 The list

One row per post, newest activity first by default:

- **Title** (two lines max), **unread dot** or **Novo** badge before it, a pin
  icon for pinned posts, a lock for locked ones, a check for resolved.
- **Preview**: the first 200 characters of the opening message, flattened,
  one line on desktop, two on phone. A paperclip and the count when it has
  files. No thumbnail in v1 (attachment URLs are signed per request; that is
  P2 polish at best).
- **Tags** as chips (emoji + name), up to 5.
- **Meta line**: author avatar and name, "{count} respostas", relative last
  activity ("há 3 h").

Above the list: the **guidelines** (the channel topic, existing column and
settings field, max 200, shown as one banner the reader can collapse), then a
filter row: sort (Atividade recente / Mais novos), tag chips, status (Todos /
Abertos / Resolvidos), Meus posts, and the title search box. The sort and
filters are remembered per forum in `localStorage` (a per-viewer convenience,
never state the server needs). "Novo post" is the primary button.

Pagination is infinite scroll on the keyset cursor, 25 per page.

**Empty states.** No posts: "Ninguém postou aqui ainda." with "Criar o
primeiro post". Filter with no match: "Nenhum post com esses filtros." with
"Limpar filtros". Flag off for this server (§8): the list stays readable and
the button is replaced by "Novos posts estão pausados neste fórum."

### 3.3 The post

The post opens in the existing thread panel (`client/src/components/chat/thread-panel.tsx`)
with its own chat controller on the `thread-join` slot, so the list stays live
beside it on desktop. The panel's header gains the title (editable inline for
the author and staff), tags, and the post menu: Marcar como resolvido /
Reabrir, Editar tags, Fixar post, Fechar pra respostas, Copiar link, Excluir
post. The opening message renders first and is not collapsed; replies follow.
The thread panel's "Arquivada" hint is never shown for a post (§3.7). A locked
post replaces the composer with "Post fechado: só a staff responde aqui."

### 3.4 The composer

A dialog (full-screen sheet on phone) built from `ui/` primitives: `Input` for
the title, the existing `MessageComposer` for the body (so markdown, mentions,
emoji, GIFs and attachments through the existing presigned path come for free),
a tag picker (Menu with `CheckRow` rows, moderated tags hidden from members),
and "Publicar". While the title is typed, up to five existing posts whose
titles match appear under the field ("Posts parecidos"), the Discourse trick
that stops the same question being asked ten times. That is one title search
request, debounced, and can slip to P2 if P1 runs long.

Errors reuse the composer's rejection copy (slow mode with the countdown,
AutoMod with the rule's own message, attachment errors), plus "Dá um título pro
post."

### 3.5 Mobile widths

Below the desktop breakpoint the list is the whole pane, rows stack (title,
tags scrolling horizontally, meta), the filter row scrolls horizontally, the
composer is a full-screen sheet, and a post takes the full viewport (the thread
panel already does this on mobile). Back returns to the list at the same scroll
position.

### 3.6 Routes

| Route | Who |
|---|---|
| `GET /api/forum/config?serverId=` → `{ enabled }` | member (the flag, §8) |
| `GET /api/channels/:forumId/posts?sort=&tag=&status=&mine=&q=&cursor=&limit=` → `{ pinned, posts, nextCursor }` | can see the forum |
| `GET /api/forum-posts/:postId` → summary | can see the forum (deep links) |
| `POST /api/channels/:forumId/posts` | §1.5 |
| `PATCH /api/forum-posts/:postId` `{ title?, tagIds?, resolved?, pinned?, locked? }` | per §2, field by field |
| `DELETE /api/forum-posts/:postId` | staff; `deleteChannel(postId)`, audit `forum.post_delete` |
| `GET /api/channels/:forumId/forum-tags`, `PUT` (replace the list) | read: can see; write: `MANAGE_CHANNELS` |

Pin, lock, delete and staff edits of someone else's post write `logAudit`
(`server/src/services/audit.ts`) rows (`forum.post_pin`, `forum.post_lock`,
`forum.post_delete`, `forum.post_edit`).

### 3.7 Archive semantics

**A post never auto-archives.** `THREAD_AUTO_ARCHIVE_DAYS` exists so a
finished side conversation stops holding a row in the sidebar; a forum is the
opposite, a place things are kept so they can be found. Nothing has to change
on the server: `listActiveThreadsByParent` is only asked about `text` parents
(`GET /api/servers/:serverId/threads` filters `channel.type === "text"`), so
posts never enter the sidebar thread list, and the forum list does not read
`isThreadArchived`. `forumPostSummarySchema` has no `archived` field. The
"closed" state Discord calls archived is our **lock**, which a person chooses.

### 3.8 Onboarding

One inline hint through the one queue, nothing in the corner:

| Surface | Component | Shape | Shows when | Goes away |
|---|---|---|---|---|
| Forum | `components/layout/feature-hint.tsx` beside the "Novo post" button | Inline CornerCard | first time a forum list is open, for someone who can post | `pqp:feature-hint-forum-2026-10` (impression), via `lib/feature-hints.ts` |

Copy: title "Cada post é uma conversa", body "Dá um título, escolhe as tags e
quem chegar depois acha pela busca. Antes de postar, dá uma olhada se alguém já
perguntou." A row goes into `docs/ONBOARDING.md` and the id into
`FEATURE_HINT_IDS` / `ATTACHED_FEATURE_HINT_ORDER` (after `channelPin`).

The create channel dialog shows Fórum with the existing `BetaTag` while the
flag is per server. When a forum is created, the tag editor offers four
starter chips the owner can keep or drop: Dúvida, Bug, Sugestão, Tutorial.

### 3.9 Copy (pt-BR first)

Keys under `forum.*`, written in Portuguese first per `AGENTS.md`, with `en` and
`es` beside them (`i18n:check` fails otherwise). "Post", "tag" and "feed" stay
English, as the QG says them.

| Key | pt-BR | en |
|---|---|---|
| `channel.type.forum` | Fórum | Forum |
| `forum.newPost` | Novo post | New post |
| `forum.composer.title` | Título | Title |
| `forum.composer.titleRequired` | Dá um título pro post. | Give the post a title. |
| `forum.composer.bodyPlaceholder` | Conta os detalhes: o que você tentou, o que deu errado, print se tiver | Add the details: what you tried, what went wrong, a screenshot if you have one |
| `forum.composer.similar` | Posts parecidos | Similar posts |
| `forum.composer.publish` | Publicar | Post |
| `forum.sort.activity` | Atividade recente | Recent activity |
| `forum.sort.created` | Mais novos | Newest |
| `forum.filter.open` | Abertos | Open |
| `forum.filter.resolved` | Resolvidos | Resolved |
| `forum.filter.mine` | Meus posts | My posts |
| `forum.search` | Buscar nos títulos | Search titles |
| `forum.replies_zero` / `_one` / `_other` | Sem respostas / {count} resposta / {count} respostas | No replies / {count} reply / {count} replies |
| `forum.new` | Novo | New |
| `forum.resolve` / `forum.reopen` | Marcar como resolvido / Reabrir | Mark as resolved / Reopen |
| `forum.pin` / `forum.unpin` | Fixar post / Desafixar post | Pin post / Unpin post |
| `forum.lock` / `forum.unlock` | Fechar pra respostas / Reabrir pra respostas | Close to replies / Reopen to replies |
| `forum.locked` | Post fechado: só a staff responde aqui. | Closed: only staff can reply here. |
| `forum.delete.confirm` | Excluir este post? As respostas somem junto. | Delete this post? Its replies go with it. |
| `forum.empty` | Ninguém postou aqui ainda. | Nobody has posted here yet. |
| `forum.empty.cta` | Criar o primeiro post | Create the first post |
| `forum.paused` | Novos posts estão pausados neste fórum. | New posts are paused in this forum. |
| `forum.tags.moderatedHint` | Só a staff coloca essa tag. | Only staff can add this tag. |

No em dash in either language (`client/src/locales/no-em-dash.test.ts`).

---

## 4. Realtime and unreads

### 4.1 Frames and who gets them

Opening a forum list is `join-channel` on the forum id (access is
`canAccessChannel`, the parent check). Opening a post is `thread-join` on the
post id, which already validates `type = 'thread'` and the parent's access.
Nothing new on the socket side.

| Event | Frame | Audience | Path |
|---|---|---|---|
| New post published | `forum-post-upsert { forumId, post }` | sockets viewing the forum | `broadcastToChannel(forumId, ...)` |
| New post published | `channel-activity { channelId: forumId, mention: false }` | everyone who can see the forum and is not looking at it | the same pair `postChannelMessageAttempt` uses: `publishToCluster(ACTIVITY_TOPIC, ...)` plus `notifyChannelActivity(forumId, ...)` |
| Opening message and replies | `message-broadcast`, `channel-activity { channelId: postId }`, mention push | as for any thread today | unchanged |
| Reply bumps a post | `forum-post-upsert` (fresh counts and time) | forum viewers | the bump in §1.4 |
| Title, tags, pin, lock, resolve change | `forum-post-upsert` | forum viewers | the PATCH route |
| Post deleted | `forum-post-removed { forumId, postId }` | forum viewers and the post's viewers (the panel closes) | the DELETE route |

**Across `api-a` and `api-b`.** `broadcastToChannel` publishes every frame on
the cluster bus (`chat.broadcast`), and the receiving process calls
`deliverToChannel` for its own viewers, so a forum viewer on the sibling gets
every frame with no extra wiring. The activity frame crosses on
`chat.activity`. A summary is well under 1 KB, under the bus's 7,000-byte
inline limit (`server/src/lib/bus-postgres.ts`), so nothing spills. The list's
read cache is per process: the sibling's cached first page can be up to one
TTL (2 s) old, and the live frame is what closes that gap.

### 4.2 Unread, new and mentions

A post is a channel, so it already has a read cursor (`channel_reads`, written
by `POST /api/channels/:channelId/read` when the panel opens). The forum has
one too, written when the list opens. `markChannelRead` already returns
`previousLastReadAt`, which is what the list needs.

| State | Rule | Shown as |
|---|---|---|
| **Novo** | `created_at > forum cursor before this visit`, never opened by the viewer, not the viewer's own post | "Novo" badge (the planned `Badge` primitive in `ui/`, added by this work per `docs/DESIGN.md`) |
| **Unread** | opened before (`channel_reads` row exists) and `last_activity_at > last_read_at` | bold title + dot |
| **Mentions** (P2) | `message_mentions` for the viewer in that post after its cursor | count pill |
| **Forum dot in the sidebar** | a published post by someone else created after the forum cursor | the existing unread dot |
| **Forum mention badge** (P2) | any mention of the viewer in any of its posts after that post's cursor | the existing mention pill |

This is Discourse's split, and it is what keeps a forum readable: a reply in a
post you never opened does not make the forum shout at you.

**`listUnread` must change in P1, not P2.** It counts, per channel of the
server and with no type filter, every message after the viewer's cursor, and a
missing cursor means "everything". Threads are included under their own ids.
A forum of 2,000 posts would make every server open count every message in
every post the viewer never opened, and return 2,000 rows the sidebar ignores.
So in `server/src/services/users.ts`:

```sql
-- in listUnread's WHERE
AND NOT EXISTS (SELECT 1 FROM forum_posts fp WHERE fp.channel_id = c.id)
```

and the forum rows' count becomes the number of new posts (a second small
query over `idx_forum_posts_created`, capped at 99 in SQL). The live side
already matches: `channel-activity` for a reply carries the post's id, which
the sidebar never lists, so only the forum's own activity frame (new post)
lights the forum. P2 adds the optional `parentChannelId` to
`channelActivitySchema` so a mention inside a post can raise the forum's
mention pill live (an older client strips the unknown key and loses nothing).

### 4.3 Following and notifications

- **No follow button in v1.** "Following" is implied: the posts you opened
  carry a cursor and show as unread when they move; "Meus posts" is one tap.
  `thread_memberships` is not used for posts (it only governs the sidebar
  thread list, which posts are never in).
- **Push rules do not change in P1.** `shouldPush` (`server/src/services/push.ts`)
  already never pushes a plain server-channel message: only mentions, the
  reply target, `@everyone` / `@here`, and DMs. So a busy forum pings nobody,
  and a new post pings nobody unless it mentions them. That is the rule we
  want.
- **P2, the one addition (open question 1):** the post's author gets a push for
  replies to their post, treated as a reply-to (the same level as being
  replied to), respecting the channel and server notification level and DND,
  at most one push per post per 10 minutes. A support forum where the asker
  never hears the answer is a support forum nobody uses twice.
- **P2, a fix threads need too:** `resolvePushLevel` looks a thread up by its
  own id, then the server, so muting a forum (`none` on the forum id) does not
  mute mentions inside its posts. Fall back to the parent's level before the
  server's, for posts and chat threads alike.
- **Push links:** the server-channel push path is
  `/app/server/<sid>/channel/<channelId>`, which for a post is the post id. The
  web client cannot open that today (see §7.2), and P1 fixes the route.

---

## 5. Moderation and safety

### 5.1 Reports

- **A post is reported by reporting its opening message**, a reply by
  reporting the reply. Both are ordinary message reports (`POST /api/reports`,
  `createReport` and `resolveMessageSubject` in `server/src/services/reports.ts`):
  `server_id` comes from the post channel, so they land in **that server's
  queue**, for communities too. That is the rule `docs/CONTENT_SAFETY.md`
  states: only a report about the community **listing** (`subject_type
  'server'`) goes to the instance queue; content inside a community is
  moderated like any other server's. Nothing new.
- **P2:** when the reported message is a post's opening message,
  `content_snapshot` stores `title + "\n\n" + body`, so an abusive title
  survives the post being deleted (`reports.channel_id` is ON DELETE SET
  NULL, so the channel name alone does not).
- **P2:** the report's "remove message" action on an opening message offers
  "Excluir o post inteiro".

### 5.2 AutoMod

The body is checked on the normal send path. The title is checked by the post
route (§1.5 step 3) with the same `checkAutomod`. Renames go through it too.
**P2:** AutoMod's channel exemption compares the message's channel id, so
exempting a forum does not exempt its posts (true of chat threads today).
Check `[channelId, parentId]`.

### 5.3 Delete cascade

| Deleted | What goes with it |
|---|---|
| A post | `deleteChannel(postId)`: its messages (cascade), attachments (keys read first, then the hourly orphan sweep), `forum_posts`, `forum_post_tags`, `channel_reads`, `thread_memberships`. Reports keep their snapshot. |
| A forum | `deleteChannel(forumId)` deletes child threads first (it already does, by `parent_id`), then the forum; `forum_posts` and `forum_tags` cascade. Fix the per-thread key read first (§1.6). |
| A tag | `forum_post_tags` rows cascade; posts lose the chip. |
| An account | `forum_posts.author_id` goes NULL ("Conta excluída"), the posts stay, like messages. |
| An opening message | the post stays; the preview reads "A mensagem original foi apagada". |

### 5.4 Rate limits, slow mode, spam

- **Post creation** pays three times: the existing per-user send bucket
  (`takeMessageBudget`), a new cluster-wide bucket via `sharedRateLimit`
  (`server/src/lib/cluster-rate-limit.ts`, Postgres-backed, so the limit is
  the number on two containers, not twice it) of **5 posts per 10 minutes per
  user**, and the forum's slow mode if set.
- **Slow mode on a forum** is the interval between new posts per member
  (charged on the forum id). Replies inside a post read the post's own
  `slowmode_seconds`, which is 0; per-post slow mode is not in v1. The
  channel settings label changes to "Intervalo entre posts" for a forum.
- **Spam from drive-by accounts** (a community's public link lets anyone
  join): the bucket above, AutoMod's `invite_links` and `mention_spam` rules
  on title and body, the existing timeouts (a timed-out member's post request
  is refused by the same `findTimeoutForChannel`), and staff delete. No
  account-age gate in v1; if one is needed it belongs to AutoMod for every
  channel, not to forums.

---

## 6. Discord import (P3)

Today `mapChannelType` (`packages/shared/src/discord-import.ts`) maps Discord
type 15 to `{ type: "text", flattenedFrom: "forum" }`, records the
`flattenForum` mapped-away reason, and records `forumTags` whenever
`available_tags` is non-empty. (`flattenForum` is a reason key, not a function.)

**Change, behind the flag:**

- `mapGuildTemplate(raw, { forumChannels })` stays pure; the server passes
  `isEnabled("forum_channels")`. `MappedImportChannelType` gains `"forum"`.
  With the option off, today's output byte for byte (the existing test
  "flattens a forum to a text channel" keeps passing).
- With it on, type 15 maps to `{ type: "forum" }` and `available_tags` (today
  `z.array(z.unknown())`) is parsed leniently as
  `{ name, emoji_name?, emoji_id?, moderated? }` into
  `MappedImportChannel.tags`, first 20, names clamped to 20, duplicates by
  lower-case name dropped. `forumTags` is then recorded only for what was
  lost (a tag with a custom emoji keeps its name and loses the picture).
- The forum's Discord `topic` is its guidelines and already maps to `topic`,
  cut at 200 (`topicTruncated` already reports it).
- `createServerFromImport` (`server/src/services/discord-import.ts`) inserts
  `forum_tags` in the same transaction as the channels.
- `client/src/components/layout/discord-import-preview.tsx` shows the forum
  icon and the tag chips.

**The flag can only be global here.** An import creates a new server, so no
per-server override can exist yet; `isEnabled` is asked without a server id
and answers the global row, the variable, or the default. While forums are on
for a few servers only, imports keep flattening (open question 4).

**Still lost:** posts themselves (a template has no messages), custom-emoji tag
pictures, `default_reaction_emoji`, `default_sort_order`, `default_forum_layout`
(gallery), `default_thread_rate_limit_per_user`, the require-tag flag, and
media channels (type 16, still flattened to text). New reason
`forumSettings`, pt-BR "Algumas opções do fórum {name} (reação padrão, ordem,
layout) ficaram de fora". `docs/DISCORD_IMPORT.md`'s tables are updated in the
same PR.

---

## 7. Search and linking

### 7.1 Search

- **Title search in the forum (P1):** `q` on the list route,
  `unaccent(lower(c.name)) LIKE '%' || unaccent(lower($q)) || '%'`
  over the forum's posts. `unaccent` is installed; `pg_trgm` is not, and is not
  worth an extension for this: the scan is bounded by one forum's posts, and
  an accent-insensitive "notebook nao liga" finding "Notebook não liga" is the
  part that matters in Portuguese. Bypasses the read cache.
- **Full text inside posts:** already works. `searchMessages`
  (`server/src/services/search.ts`) uses `channelVisibleSql`, so posts are
  searched with their forum's visibility and results carry the post id. The
  results need §7.2 to open.
- **Not in v1:** search scoped to one forum's bodies (a `channelIds` filter on
  `searchMessages` is a small P2 if asked), ranking, "similar posts" by body.

### 7.2 Deep links

`client/src/lib/app-route.ts` knows `/app/server/<sid>/channel/<cid>` and
`/message/<mid>`. Add `/app/server/<sid>/channel/<forumId>/post/<postId>` and
build it in `channelRoutePath`'s neighbour. **Fix for chat threads too:**
`applyChannelRoute` (`client/src/App.tsx`) resolves a channel id against the
channel list, which excludes threads, so a permalink, a search hit or a push
into any thread lands on "That channel no longer exists or is private" today.
P1 makes an unknown id ask `GET /api/forum-posts/:id` (and, for a chat thread,
the thread lookup) and open the parent with the post or panel on top. "Copiar
link" in the post menu copies the `/post/` form. Electron's `pqp://` mapping
needs nothing.

### 7.3 Open Graph and SEO: none in v1

- `/app/*` is `noindex` at the edge (`client/functions/_middleware.ts`) and
  every post is members-only.
- The one public window a community has, `pqp.gg/c/<slug>`, is "a poster, not
  a window" by design (`docs/CONTENT_SAFETY.md`): no messages, no channels.
  Public, indexable posts would be the instance hosting public content, which
  is the category with the duty-of-care and presumed-liability regime the
  communities section explains, and it needs moderation capacity two people
  do not have.
- A pasted post link unfurls as the generic `/app` card. Revisit only after
  communities have run with the directory on for a while.

---

## 8. Flag, phasing, effort, tests, rollout

### 8.1 The flag

```ts
// server/src/lib/flags.ts, FEATURE_FLAGS
forum_channels: {
  description: "Canais fórum: posts com título, tags e respostas, em vez de um chat corrido.",
  env: "FORUM_CHANNELS",
  parseEnv: exactTrue,
  codeDefault: false,
  // Every reader knows the server: the forum routes start from a channel, the
  // create-channel route from a server, the config read is asked with one.
  // The Discord import is the exception and asks without one (global only).
  perServer: true,
  clientVia: "GET /api/forum/config?serverId= (enabled)",
},
```

Registered in: `FEATURE_FLAGS` (`server/src/lib/flags.ts`), the old-reader
table in `server/src/lib/flags.test.ts` (`forum_channels: (raw) => raw === "true"`),
`FLAG_RISK` in `tools/admin-dashboard/site/novo.js` ("Liga ou desliga criar
fórum e posts neste servidor. Desligado, os fóruns que existem ficam só pra
leitura; nada é apagado."), the "born as a flag" list in
`docs/FEATURE_FLAGS.md`, and the runtime flags row in `CLAUDE.md`. The client
asks `GET /api/forum/config?serverId=` when a server opens and again through
`client/src/lib/config-refresh.ts`, the same pattern as
`server/src/lib/share-config.ts`.

**Off means:** the server refuses creating a forum channel and creating posts
(403 `forum_channels_off`); reading, replying in existing posts and staff
actions keep working, so nothing anyone wrote is stranded; the client hides
"Fórum" in the create dialog and shows the paused line. It never hides or
deletes data.

### 8.2 Phases

Each phase ships alone, merged and deployed by itself.

| Phase | Scope | Days | Restarts API |
|---|---|---|---|
| **P1** | Schema, `forums.ts` (shared and server), routes, flag, send-path guards and bump, `listUnread` exclusion, `deleteChannel` key read, retention exemption, shell sweep, two WS frames. Web: create dialog option, list, post in the thread panel, composer with tags and attachments, filters, title search, Novo/unread, route fix, the hint, `Badge` primitive, i18n in three languages | **8** (server + shared 3, web 3.5, tests and QA 1.5) | yes, and it changes `schema.sql` (merge outside a party) |
| **P2** | Mention counts per post and on the forum (`parentChannelId`), author reply push (if yes to Q1), parent notification level fallback, AutoMod parent exemption, report snapshot with title and "excluir o post inteiro", "Posts parecidos" if it slipped, forum-scoped body search if asked | **4** | yes |
| **P3** | Discord import keeps forums and tags (§6), preview UI, `DISCORD_IMPORT.md` | **1** | yes (shared + server) |
| **P4** | iOS: forum row, list, post (reuses the thread chat in `ios/pqp/Sources/Chat/ThreadViews.swift`), composer with tags. Android: the same, plus a thread chat screen it does not have at all | **iOS 3, Android 5** | no |

About 21 engineering days in total. "Agent-assisted reality": the code in P1
is a day or two of agent typing; the days are the review, the two-user QA on
web and phone widths, and the cluster test, which is where the bugs in this
repo's pitfall list were actually found.

### 8.3 Tests per phase

**P1, server** (vitest on a real Postgres, `TEST_DATABASE_URL`):

- Create post: happy path with tags and an attachment; AutoMod on the title;
  AutoMod on the body deletes the shell and returns `automod`; slow mode on the
  forum; the cluster post bucket; nonce retry returns the same post; a
  timed-out member is refused; a member without `SEND_MESSAGES` on the forum
  is refused while one with an allow overwrite is not.
- Visibility follows the parent: a private forum's list, post summary, post
  messages and `thread-join` all fail closed for a non-member; a cargo
  overwrite on the forum governs replies in its posts.
- List: both sorts, keyset stability with equal timestamps, pinned first and
  only on page 1, tag / status / mine / `q` filters (accent-insensitive),
  shells never listed, the 2 s cache returns a new post after invalidation.
- Locked post refuses a member's reply with `locked` and accepts staff's.
- A message sent to a forum id is refused.
- `listUnread` returns no post rows and a forum row counting new posts; a
  forum with 500 posts and 10,000 messages does not change the query's cost
  for a viewer who never opened them (assert the row count, and EXPLAIN in the
  PR).
- Delete forum with 200 posts: one attachment-key query, every post and tag
  gone.
- Shell sweep deletes a 15-minute-old shell and leaves a published post.
- Retention keeps an opening message older than the window.
- Flag: off globally refuses create and keeps list and reply; a per-server
  override on wins over a global off; `flags.test.ts` old-reader row.
- `db-boot-schema.test.ts` passes; running `schema.sql` twice is a no-op.

**P1, cluster.** Production runs `CLUSTER_BUS=postgres` with two containers and
`READ_CACHE` on, so the tests run with both: a forum viewer on instance B
receives `forum-post-upsert` for a post created on A, a reply bump made on A,
and `forum-post-removed`; the activity frame for a new post reaches a sidebar
socket on B. Use the two-module-graph shape of `server/src/ws/cluster.test.ts`
for the frames, and one real two-process run on the Postgres bus in the shape
of `server/src/lib/flags-two-process.test.ts`, because the in-memory hub cannot
catch a payload that breaks on the real NOTIFY path.

**P1, client.** Unit: the list reducer applying upsert / removed frames to a
sorted, filtered, paginated list (a bump moves a post to the top only under
the activity sort and only if it passes the filters). Playwright with two dev
users (`pqp:dev-user-suffix` alice / bob) and the per-server override on:
alice posts with a tag, bob sees it live with the Novo badge and the sidebar
dot, bob replies, alice's list bumps and her post shows unread, a staff lock
swaps bob's composer for the closed line, delete closes bob's open panel, the
`/post/` deep link opens the post, and the phone viewport (390 px) flow from
list to post and back. `i18n:check` and `bench:tokens` green.

**P2:** mention roll-up to the forum live and after reload; author push sent
once per window and not when the author is online, muted or DND
(`shouldPush` unit tests); a mention in a post of a muted forum does not push;
report snapshot includes the title; AutoMod exemption by parent.

**P3:** `discord-import.test.ts` keeps the flatten test with the option off
and adds forum-with-tags with it on (20-tag cap, name clamp, duplicate names,
custom emoji reported); `createServerFromImport` writes `forum_tags`.

**P4:** decoding a forum channel and the two frames; the list, post and
composer against a staging server with the override on; and what an **old**
build does with a forum (below).

### 8.4 Old clients

| Client | Sees a forum as |
|---|---|
| Web bundle that predates forums | nothing at top level (`channel-list.tsx` filters loose channels on `type === "text"`), but **a row inside a category** (`childrenByCategory` has no type filter) that opens an empty chat whose sends are refused. Short-lived: open pages poll `/version.json` and reload onto the new bundle at a safe moment (pitfall 21), and `client_force_update` exists if it ever matters. |
| Android | nothing (`android/app/src/main/kotlin/gg/pqp/app/ui/screens/ChannelsScreen.kt` lists only text and voice). |
| iOS | **a `#` row inside a category** (`children(of:)` in `ios/pqp/Sources/Chat/ChannelListView.swift` keeps unknown types) that opens an empty chat whose sends are refused. Patch that filter to known types in the next TestFlight build during P1, well before P4. |

Turning the flag on for a server therefore costs its phone users nothing worse
than a missing channel until P4, and that is the reason P4 can wait.

### 8.5 Migration and rollback

- **Migration:** additive DDL only (§1.2), no backfill, no data move.
- **Feature rollback:** the flag, from the dashboard, per server or global, no
  deploy. Data stays.
- **Code rollback** (image back to before P1): the tables stay and nothing
  old reads them. If the old `schema.sql` runs (its hash differs), its type
  CHECK blocks fail on the forum rows and roll back, so the constraint keeps
  `'forum'`. Old code lists forum rows with `type: 'forum'` to clients that
  ignore them, and its send path would accept a crafted message into a forum
  id (harmless, invisible). No down-migration is needed or written.
- **Removing the feature for good:** drop the three tables and delete
  `type = 'forum'` channels through `deleteChannel` in a script; not planned.

---

## 9. Risks, and what is not in v1

### 9.1 Risks

| Risk | Mitigation |
|---|---|
| Posts are channels, so per-server queries that walk every channel grow with posts (`listUnread` is the one that matters) | Exclude posts from `listUnread` in P1 (§4.2) and test it at 500 posts. Audit `getChannelAudience`, export and metrics queries for the same shape in the P1 PR. |
| Deleting a big forum fires one query per post | One `ANY($1)` read in `deleteChannel` (§1.6). |
| The deploy that carries the schema runs the whole file once | `BOOT_SCHEMA_MODE=changed` plus `lock_timeout` already bound it; merge outside a party. |
| iOS and old web bundles show a dead row for a forum inside a category | iOS: one-line filter in the next TestFlight build. Web: the bundle self-updates (§8.4). |
| Drive-by spam in community servers | Cluster-wide post bucket, forum slow mode, AutoMod on title and body, timeouts (§5.4). |
| Retention sweeps leave title-only posts | Opening messages are exempt (§1.6). |
| A reader on the sibling container sees a 2 s old first page | The live frames correct it; the cache is per process by design. |
| A support forum where askers never hear back | Author reply push in P2 (open question 1). |

### 9.2 Not in v1

Gallery or media layout, custom-emoji tags, default reaction, required tag,
per-post slow mode, an explicit follow button, moving or merging posts, votes
and ranking, accepted answer beyond "resolvido", post templates, scheduled
posts, thumbnails in the list, per-post visibility, public or indexed post
pages, AI summaries or duplicate detection, posting into a forum from a
webhook or a character account, forum channels in DMs.

---

## 10. Open questions for Rafael

Each has a recommended answer; "sim pra tudo" is a valid reply.

1. **Should a post's author get a push when someone replies?** It would be the
   first non-mention push from a server channel. **Recommended: yes, in P2**,
   author only, at reply-to level, respecting mute and DND, at most one per
   post per 10 minutes.
2. **Who deletes a whole post?** **Recommended: staff only** (`MANAGE_MESSAGES`
   on the forum). The author deletes their opening message, and the answers
   other people wrote stay.
3. **Is "resolvido" a built-in state rather than a tag?** **Recommended:
   built-in** (`resolved_at`), so every forum gets the Abertos / Resolvidos
   filter and the check icon without the owner having to invent a tag; tags
   stay free for topic.
4. **Discord import with forums follows only the global flag.** **Recommended:
   yes**, keep flattening until the flag is global, because an import makes a
   new server that no per-server override can name yet.
5. **Ship web first and leave phones for P4?** **Recommended: yes**, turn the
   flag on for the requesting community and the QG after P1, with the iOS
   one-line filter in the next TestFlight; go global after P2 once the cluster
   counters and two weeks of real posts look sane.
