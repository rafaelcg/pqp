# Channel list: categories only, mixed types, drag to reorder

Design + plan, read against `origin/main` at `56dc3e1b2` (2026-10-12). No repo edits made.
Mocks: `mocks.html` in this folder, screenshots `01..05-*.png` and `mocks-full.png`.

## 1. How it works today

**Data model.** A category is a `channels` row with `type = 'category'`; a channel inside it has `parent_id` pointing at it (`server/src/schema.sql` ~1170, `ON DELETE SET NULL`). Categories cannot nest and cannot be private (`createChannelSchema` refuses a private category; overwrite inheritance from a category does not exist, gap #22). `parent_id` is otherwise only used by threads (`type = 'thread'`), and every privacy/push/search reader that touches it is thread-only, so moving a channel between categories changes no permission.

**TEXT / VOICE are not data.** They are pseudo-sections the clients draw for `parent_id IS NULL` channels, split by type. The server mirrors that split in its numbering: `position` is a contiguous `0..n-1` per *sibling group*, and at the top level the group key includes the type (`positionGroupTypes` in `server/src/services/servers.ts`: text+forum share one group, voice is one, watch_party is one, categories are one). Inside a category the group is the whole category, types mixed. `createChannel` appends to the end of its type's top-level group and has no `parentId`. `moveChannel(serverId, channelId, parentId, index)` splices one channel into its destination group and renumbers the group it left; `deleteChannel` of a category re-appends its children to the top-level group of their type.

**What each client draws.**

| Client | Order | Inside a category |
|---|---|---|
| Web `channel-list.tsx` | TEXTO (text+forum), VOZ (voice, watch_party when that flag is off), then a CATEGORIAS label with a folder-plus button, then each category | mixed, by position |
| iOS `ChannelListView.swift` (1.0.21 has Lista viva #1055) | Text (hidden when empty), categories, Voice (hidden when empty) | mixed, by position |
| Android `ChannelListRules.kt` `sectionsOf` (0.4.14 has Lista viva #1052) | Text, categories, Voice | **split: text half then voice half** |

So the three clients already disagree: on a phone, loose voice rooms sit below every category; on the web they sit above. Android's comment claims it matches the web; it does not.

**Reorder today.** Web: native HTML5 drag on every row (managers reorder; anyone can drag to Pinados), drop on a row = take its slot (no before/after, a ring highlight), drop on a category header or the empty placeholder = append, drop on TEXTO/VOZ = only unpins. Category headers drag too. Keyboard/touch: the row menu has Mover para cima / Mover para baixo (within the sibling group only, never across a border), Mover pra {categoria}, Tirar da categoria. No optimistic update: `handleMoveChannel` waits for `PATCH /api/channels/:id/move` and replaces the list with the response. iOS: menu only, Move to category / Top level (index 0). Android: no reorder at all. Alt+arrow navigation (`navigableChannelIds` in `client/src/lib/keyboard-shortcuts.ts`) and the icons-only rail (`channelRailGroups`) re-derive the same TEXT, VOICE, categories split separately.

**Discord import.** `packages/shared/src/discord-import.ts` maps categories, text and voice in Discord's sidebar order, then renumbers into pqp's groups (`renumberGroup`): three top-level sequences plus one mixed sequence per category (`docs/DISCORD_IMPORT.md` §Positions). Forums flatten to text. Category overwrites flatten onto children.

**New server.** `createServer` inserts `general` (text, 0) and `Lobby` (voice, 1), both top-level.

**Who sees what.** `listChannels` is per viewer: only the owner and Administrator see every private channel. A MANAGE_CHANNELS holder can be missing some channels from their own list, which the reorder design must respect.

## 2. The new model

Decisions, one line of why each:

1. **Categories are the only headers.** The TEXTO/VOZ split is the confusion Rafael names, and Discord users read a header as "a group someone made".
2. **Any type mixes inside a category, in the order the manager chose.** Voice next to its text channel is the common real layout (a game's #lfg beside its room).
3. **Uncategorized channels still exist and render above the first category with no header.** Deleting a category, a Discord import with loose channels, and old clients all produce them; Discord draws them the same way.
4. **Top level becomes one mixed sequence for non-category channels; categories keep their own sequence.** One order per parent is the whole model; loose channels always sit above categories, so the two never interleave.
5. **A new server gets one category, "Canais", holding #general and Lobby.** Rafael wants a default title; "Geral" would read "Geral > #general" (the seeded text channel is literally `general`), and "Canais" says what is under it without implying a topic. en "Channels", es "Canales", chosen from the creator's locale.
6. **The CATEGORIAS header becomes the last row, "Criar categoria"** (managers only). A header over a create button is the thing that looked like an empty category.
7. **Each category header gets its own "+" on hover** (menu: Canal de texto, Canal de voz, Fórum when on, Canal privado). It replaces the per-section "+" and the lock button, and creates inside that category.
8. **Empty categories are hidden from people without MANAGE_CHANNELS; managers see them with the drop placeholder.** Discord does this, and it covers a migrated "Canais" whose only channels are private to someone else.
9. **A collapsed category keeps the selected channel and the voice room you are in visible**, plus a count and an unread dot. Folding should never hide where you are.
10. **Watch parties stay the block at the top, never a row** (unchanged `LivePartyBlock` rule). Baú button and Pinados stay above everything, unchanged.
11. **Permissions: reorder, create category, move = MANAGE_CHANNELS server-wide**, same as `PATCH /move` today. Non-managers can still drag a row, but only onto Pinados (personal).

### Rows in a mixed list (no change in look, only in place)
- Text: `#`, bold + left pip when unread, red mention badge (web) / lime `@N` pill (phones), dim when muted.
- Forum: `MessagesSquare` icon, BETA tag while `forum_channels` is per server.
- Voice: speaker icon, quiet when empty, occupants nested under the row wherever it sits, speaking ring, connected row in accent. Occupant drag (move someone to another room) keeps working and never reorders channels; a row drag never moves people.
- Threads stay nested under their parent row.
- Watch party channel: never listed while the watch party flag is on; with it off it is a voice row in its slot.

### Drag and drop, web
- **Keep native HTML5 drag**, add a real insertion indicator. Why: the list already shares one drag state between channel rows, Pinados and voice occupants; porting all three to a library (dnd-kit) is a rewrite of the riskiest part of the file for no gain on desktop. Touch-web goes through the edit mode below.
- Pointer over a row: upper half = insert before, lower half = after; draw a 2px accent line with a ring at its start between the two rows (mock 04, panel 1). The dragged row's origin stays as a dashed gap so nothing jumps.
- Pointer over a category header: the header fills `accent-soft` and reads "Soltar em {name}"; drop appends to the end of that category, open or folded (panel 2). Hovering a folded header for 600 ms opens it.
- Pointer over a category header *while dragging a category*: line above or below that category (categories only reorder among categories).
- Esc cancels. Status line while dragging: "Solta pra mover. Esc cancela."
- Optimistic: apply locally, send, on failure revert and show "Não deu pra mover. A lista mudou, tenta de novo." On 409 adopt the server's list.

### Keyboard (web)
- Row menu (right click, Shift+F10, menu key): Mover para cima / Mover para baixo **cross category borders** (first row of a category moving up lands at the end of the previous one, or in the loose area), so the menu reaches every slot a drag can. Mover pra {categoria}, Tirar da categoria stay.
- Category menu gains Mover para cima / Mover para baixo (among categories), Renomear, Excluir.
- Focus stays on the moved row; an `aria-live` line says "{canal} foi pra {categoria}, posição {n} de {total}."

### Phones (iOS + Android), "Organizar canais"
- **An explicit edit mode**, not long-press drag: long press already opens the channel's context menu on both platforms, and a list people mostly tap should not rearrange by accident.
- Entry: server menu (⋯) "Organizar canais", and "Organizar canais" in a category's long-press menu. Managers only.
- Mode: nav bar Cancelar / Organizar canais / Concluir; every row and header gets a ≡ handle; the list closes behind the lifted row and opens a slot where it will land (mock 05, last phone). Dropping on a header appends. A header drags with its channels. Pencil on a header renames. "Criar categoria" at the bottom. Empty category shows "Vazia. Arrasta um canal pra cá."
- Changes are staged locally; Concluir sends one `PUT` with the full order; Cancelar discards. One request means one 409 to handle, not twenty.
- Accessibility: each row also exposes "Mover para cima" / "Mover para baixo" as accessibility actions (iOS `accessibilityAction(named:)`, Compose `semantics { customActions }`), because a drag is not reachable by VoiceOver/TalkBack.
- iOS: a flattened `List` (headers and rows as items in one `ForEach`) with `.onMove` in `EditMode`, then normalize (a moved header carries its children, a row above the first header becomes loose). Android: `LazyColumn` with a handle-scoped drag (`detectDragGesturesAfterLongPress` on the handle, or the Apache-licensed `sh.calvin.reorderable`; pick in the PR, no paid anything).

### Copy (pt-BR first, tu, no em dashes)
| Key (new unless noted) | pt-BR | en |
|---|---|---|
| `chrome.createCategory` | Criar categoria | Create category |
| `chrome.defaultCategory` (server side too) | Canais | Channels |
| `chrome.organizeChannels` | Organizar canais | Organize channels |
| `chrome.organizeDone` / `organizeCancel` | Concluir / Cancelar | Done / Cancel |
| `chrome.dropOnCategory` | Soltar em {name} | Drop in {name} |
| `chrome.dragStatus` | Solta pra mover. Esc cancela. | Drop to move. Esc cancels. |
| `chrome.movedTo` | {channel} foi pra {category}, posição {n} de {total}. | {channel} moved to {category}, position {n} of {total}. |
| `chrome.reorderStale` | Não deu pra mover. A lista mudou, tenta de novo. | Couldn't move it. The list changed, try again. |
| `chrome.emptyCategory` (existing, fix gender) | Vazia. Arrasta um canal pra cá. | Empty. Drag a channel here. |
| `chrome.organizeTip` | Segura o ≡ e arrasta. Solta em cima de uma categoria pra mandar o canal pro fim dela. | Hold ≡ and drag. Drop on a category to send the channel to its end. |
| Category "+" menu | Canal de texto, Canal de voz, Fórum, Canal privado | Text channel, Voice channel, Forum, Private channel |

`chrome.text`, `chrome.voice`, `chrome.categories` stay for the flag-off path and are deleted with it. `members-panel.tsx` uses `chrome.voice` for something else; leave it.

## 3. Migration of existing servers

### Options
- **(a) One default category, today's web order kept.** Loose text/forum channels, then loose voice rooms, go into a new "Canais" at category position 0. On the web nothing moves: TEXTO + VOZ become one CANAIS header, CATEGORIAS becomes the Criar categoria row (mock 01 vs 02). Every server ends up in the same shape as a new one.
- **(b) "Texto" and "Voz" categories.** Literally nothing moves anywhere, but it bakes the confusing split into every existing server as real data, which is Discord's own default and the thing Rafael is removing. Most owners will never clean it up.
- **(c) Leave loose channels at the top, no header.** No category rows created; very safe; but existing servers would look headerless while new ones get "Canais", and Rafael asked for a default title.

### Recommendation: (a), behind a per-server flag, QG first
Why (a): it is the only option where the web looks identical in order, the result matches new servers, and the rollback is mechanical. (c) remains the natural state after an owner deletes "Canais", so we get it for free anyway.

Details that decide edge cases:
- Watch party and forum channels move with the rest (all loose non-category, non-thread rows). Nothing reads `parent_id` for them.
- A server with zero loose channels gets no category; the migration records a no-op.
- If a category named "canais" (any case) already exists, the new one is named "Geral" instead, so two CANAIS headers never appear.
- Name by owner's `user_preferences.settings->>'locale'`: `en` gives "Channels", anything else "Canais".
- Discord-imported servers are migrated like any other; a fresh import made while the flag is on keeps Discord's loose channels loose (that is what Discord shows), recorded as a no-op.

### Step 0 (PR 1, boot one-shot, old-client safe): unify the top-level sequence
Old clients filter by type then sort by position, so renumbering text first, then voice, then watch_party into one sequence leaves every old client's order identical. It is the precondition for every later write.

```sql
-- server/src/schema.sql, after data_migrations exists
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM data_migrations WHERE name = 'channel_top_level_unify_2026_10') THEN
    WITH ranked AS (
      SELECT id,
             ROW_NUMBER() OVER (
               PARTITION BY server_id
               ORDER BY CASE WHEN type IN ('text','forum') THEN 0
                             WHEN type = 'voice' THEN 1 ELSE 2 END,
                        position, created_at, id
             ) - 1 AS pos
        FROM channels
       WHERE kind = 'server' AND parent_id IS NULL
         AND type NOT IN ('category','thread')
    )
    UPDATE channels c SET position = r.pos
      FROM ranked r
     WHERE c.id = r.id AND c.position IS DISTINCT FROM r.pos;
    INSERT INTO data_migrations (name) VALUES ('channel_top_level_unify_2026_10');
  END IF;
END $$;

ALTER TABLE servers ADD COLUMN IF NOT EXISTS channel_layout_version INTEGER NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS channel_layout_migrations (
  server_id   UUID PRIMARY KEY REFERENCES servers(id) ON DELETE CASCADE,
  category_id UUID REFERENCES channels(id) ON DELETE SET NULL, -- NULL = no-op
  snapshot    JSONB NOT NULL,          -- [{id, parent_id, position}] before the move
  migrated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  reverted_at TIMESTAMPTZ
);
```

From PR 1 on, `positionGroupTypes` returns one group for every non-category top-level type, so new writes keep the single sequence. The legacy `PATCH /move` translates old clients' type-scoped index (below).

### Step 1 (per server): `migrateChannelLayout(serverId, { dryRun })`
One transaction, in `server/src/services/channel-layout.ts`:

```sql
BEGIN;
SELECT pg_advisory_xact_lock(hashtextextended('channel-layout:' || $1, 0));
-- idempotent: a row means done (or deliberately reverted); return early
SELECT 1 FROM channel_layout_migrations WHERE server_id = $1;

-- snapshot every sidebar row before touching anything
INSERT INTO channel_layout_migrations (server_id, snapshot)
SELECT $1, COALESCE(jsonb_agg(jsonb_build_object('id', id, 'parent_id', parent_id, 'position', position)), '[]')
  FROM channels WHERE server_id = $1 AND kind = 'server' AND type <> 'thread';

-- nothing loose: record the no-op and stop
SELECT count(*) FROM channels
 WHERE server_id = $1 AND parent_id IS NULL AND type NOT IN ('category','thread');

UPDATE channels SET position = position + 1 WHERE server_id = $1 AND type = 'category';

INSERT INTO channels (server_id, name, type, position, is_private)
VALUES ($1, $name, 'category', 0, FALSE) RETURNING id;   -- $name: Canais / Channels / Geral

WITH ordered AS (
  SELECT id, ROW_NUMBER() OVER (
           ORDER BY CASE WHEN type IN ('text','forum') THEN 0
                         WHEN type = 'voice' THEN 1 ELSE 2 END,
                    position, created_at, id) - 1 AS pos
    FROM channels
   WHERE server_id = $1 AND parent_id IS NULL AND type NOT IN ('category','thread')
)
UPDATE channels c SET parent_id = $cat, position = o.pos FROM ordered o WHERE c.id = o.id;

UPDATE channel_layout_migrations SET category_id = $cat WHERE server_id = $1;
UPDATE servers SET channel_layout_version = channel_layout_version + 1 WHERE id = $1;
COMMIT;
```
After commit: `invalidateServerChannelList`, `pingChannels(serverId, { carriesChildren: true })` so open clients refetch, counter `channelLayout.migrated`. No voice state is touched: not `drops-voice`.

Dry run returns `{ loose, categories, collision, privateOnlyLoose }` and writes nothing.

**Idempotency:** the primary key on `channel_layout_migrations` plus the advisory lock; a second call, a concurrent call, or a replay after a crash mid-way (the transaction rolled back, no row) all converge. The ORDER BY ends in `id`, so the result is deterministic.

### Rollback, in two layers
- **Rendering (instant, no deploy):** flag off for that server or globally. Clients go back to TEXTO / VOZ / CATEGORIAS; migrated data reads fine there (empty TEXTO/VOZ headers, Canais under CATEGORIAS, same order).
- **Data (rare):** `revertChannelLayout(serverId)`: for each snapshot row whose channel still exists *and* still sits in the migration category, restore `parent_id`/`position`; channels created since are appended after them in their group; delete the migration category only if it is now empty (otherwise leave it, the owner has used it); category positions minus one; set `reverted_at` (kept so the job never re-migrates it); bump version; ping. Exposed as an operator route.

### The flag and how the switch happens
- Runtime flag `mixed_channel_list` in `server/src/lib/flags.ts`: env `MIXED_CHANNEL_LIST`, code default off, `perServer: true`, `clientVia: "GET /api/servers/:id/channel-layout"`. Self-hosts keep the env var.
- **Data follows the flag automatically:** a batch job (`jobs.ts`, so it lands on `pqp-worker` when `WORKER_MODE` splits) every 60 s migrates up to 200 servers that resolve `isEnabled('mixed_channel_list', { serverId })` and have no `channel_layout_migrations` row. Per-server overrides are read from `feature_flag_overrides`; global on walks `servers` by id. No deploy, no restart.
- **Clients switch only when the data is ready:** `GET /api/servers/:id/channel-layout` answers `{ mixed: flagOn && migrated, version }`. So QG never shows a half state. Clients ask on server open and after each `channels-update`.
- Operator routes added to `ADMIN_MACHINE_ROUTES`: `POST /api/admin/servers/:id/channel-layout` with `{ action: "migrate" | "revert", dryRun }`, for "do QG now" and for undo.
- `createServer` with the flag on globally creates Canais with general and Lobby inside and records a migration row (category_id set, empty snapshot) so the job skips it. Takes optional `locale` (`pt-BR` | `en` | `es`) in `createServerSchema` to name it.
- Rollout: QG override on (dry run first, then migrate via the route) → watch a day on web + old phones → a handful of volunteer servers → global on (job drains in batches) → after new phone builds have cycled, delete the flag-off path.

### Old clients after migration (must not break)
| Client | What it shows on a migrated server | Verdict |
|---|---|---|
| Old web tab (pre-reload) | Empty TEXTO and VOZ (headers with + for managers), CATEGORIAS, then Canais with the same channels in the same order | works; BuildWatcher reloads it |
| iOS 1.0.21 and older | Text/Voice sections hidden (empty), Canais first with every channel in position order, then other categories. Loose voice rooms move from the bottom up into Canais | works, and now matches the web |
| Android 0.4.14 and older | Canais drawn as text half then voice half; equals the real order right after migration. If a manager later interleaves voice between text, Android still shows text first then voice in that category | order degraded, nothing hidden |
| Old iOS "Create text/voice" (no `parentId` sent) | Lands at the end of the first category, not in an invisible loose area | via legacy-create rule |
| Old iOS "Move to Top level / category" (`index: 0`) | Works unchanged | ok |
| Old web "Mover para cima" on a voice row (type-scoped index) | Translated server-side to the same visual result | via legacy-move rule |

Legacy rules (server, PR 1), both counted on `/api/admin/metrics`:
- **legacy create:** `createChannelSchema.parentId` is optional; when the key is *absent* and the server is migrated, append to the first category by position (if any). New clients always send the key (`null` = loose).
- **legacy move:** `PATCH /move` with `parentId: null` on a top-level target is interpreted as an index among siblings *of the same type group*, then converted to a slot in the unified sequence (insert after the (index-1)th same-group sibling). Inside a category the index is already the unified one.

## 4. Reorder endpoint (atomic, full list)

`PUT /api/servers/:serverId/channel-layout`, MANAGE_CHANNELS server-wide.

```ts
// packages/shared/src/api.ts
export const channelLayoutSchema = z.object({
  baseVersion: z.number().int().min(0),
  categoryIds: z.array(z.string().uuid()).max(100),          // category order
  groups: z.array(z.object({
    parentId: z.string().uuid().nullable(),                   // null = loose
    channelIds: z.array(z.string().uuid()).max(500),
  })).max(101),
});
// 200 { channels, version } | 409 { error: "channel_layout_stale", channels, version }
```

Server, one transaction:
1. `SELECT channel_layout_version FROM servers WHERE id = $1 FOR UPDATE`; mismatch gives 409 with the actor's fresh list.
2. Validate: every id belongs to the server; no thread; `categoryIds` are all categories and every category of the server appears exactly once (categories are never private, so the actor sees them all); channel ids appear at most once and are never categories; every `parentId` is in `categoryIds`. Any violation: 400 naming the rule.
3. **Channels the actor did not send keep their place** (private ones they cannot see, a watch_party room the web never lists): each is re-anchored right after its nearest previous sibling from the old order that is still in the same parent, or first if none. This is what stops a manager without VIEW on #staff from silently shoving it to the end.
4. One write: `UPDATE channels c SET parent_id = v.parent_id, position = v.position FROM unnest($2::uuid[], $3::uuid[], $4::int[]) AS v(id, parent_id, position) WHERE c.id = v.id AND c.server_id = $1`; bump version; commit.
5. After commit: invalidate list cache, `pingChannels({ carriesChildren: true })`, audit `channel.reorder` (moved count, not the whole list), counter `channelLayout.reorders` / `channelLayout.staleRejected`.

`createChannel`, `deleteChannel`, `moveChannel`, rename of a category, and `migrateChannelLayout` all bump `channel_layout_version` so a stale drag is always caught. Category names get their own schema (1 to 32 chars, spaces and accents allowed, trimmed): a category is a label, not a slug, and today "Salas de voz" is refused by the `^[a-z0-9-_]+$` channel rule.

## 5. PR plan

Each PR is one feature on its own branch, run locally, Farol then CI, `restarts-api` said when it applies.

**PR 1, server + shared (`restarts-api`).**
- `packages/shared/src/channel-layout.ts` (new): `buildSidebarLayout(channels, { mixed, hideWatchParty })` → `{ loose, categories: [{ category, children }] }`; `moveInLayout(layout, id, { parentId, index })`; `stepInLayout(layout, id, -1 | 1)` (crosses borders); `layoutToPayload`; `navigableIds(layout)`. Plus `packages/shared/fixtures/channel-layout-cases.json`, consumed by vitest, XCTest and JUnit (same idea as the flag client contract test).
- `api.ts`: `channelLayoutSchema`, optional `parentId` on `createChannelSchema`, `categoryNameSchema`, optional `locale` on `createServerSchema`, `ChannelLayoutConfig`.
- `server/src/schema.sql`: step 0 block, `channel_layout_version`, `channel_layout_migrations`; rewrite the `position` comment block (it documents the old type-scoped rule).
- `server/src/services/channel-layout.ts` (new): `migrateChannelLayout`, `revertChannelLayout`, `applyChannelLayout`, job body.
- `server/src/services/servers.ts`: `positionGroupTypes` unified, `createChannel(parentId?)` + legacy rule, `moveChannel` legacy index translation, `deleteChannel` re-append into the unified loose group, `createServer` default category when flag on, version bumps.
- `server/src/api/index.ts`: `PUT /api/servers/:id/channel-layout`, `GET /api/servers/:id/channel-layout`, admin route + `ADMIN_MACHINE_ROUTES` entry, metrics block `channelLayout.*`.
- `server/src/lib/flags.ts`: `mixed_channel_list`; `server/src/jobs.ts`: the migrate job.
- `packages/shared/src/discord-import.ts` + `server/src/services/discord-import.ts`: one unified loose sequence (Discord order); `docs/DISCORD_IMPORT.md` §Positions.
- Docs: `docs/FEATURE_FLAGS.md` row, `CLAUDE.md` env table (`MIXED_CHANNEL_LIST`).

**PR 2, web (client only).**
- `client/src/components/layout/channel-list.tsx`: render from `buildSidebarLayout`; when `mixed`: no `ChannelSection`s, `CategoryHeader` gains "+" menu and up/down items, loose area above the first category, Criar categoria row, empty categories hidden for non-managers, folded category keeps selected/connected rows; drop indicator (before/after), header-target state, Esc, optimistic apply with revert; menu up/down via `stepInLayout`; `aria-live` announcement. Flag-off path untouched.
- `channelRailGroups` and `client/src/lib/keyboard-shortcuts.ts` `navigableChannelIds`: from the shared layout.
- `client/src/App.tsx`: `handleApplyLayout` (PUT, optimistic, 409 adopt), fetch channel-layout config on server open and on `channels-update`; `createServer` sends `locale`; create-in-category passes `parentId`.
- Phone web (drawer): the same Organizar canais mode with up/down buttons per row (no touch drag on the web drawer; HTML5 drag does not exist on touch).
- `discord-import-preview.tsx`: preview by category, loose on top.
- `client/src/lib/api.ts`, locales `pt-BR` / `en` / `es`.

**PR 3, iOS (cut `ios-v*` after merge).** `ChannelListView.swift` sections from the shared rules port (`ChannelListRules.swift` + fixture test), mixed mode when the config says so, old layout otherwise; Organizar canais edit mode; category "+" and Criar categoria; `APIClient.swift` `applyChannelLayout`, `channelLayoutConfig`, `createChannel(parentId:)`; `CollapsedSections` keeps keys (category ids), drops `text`/`voice` in mixed mode.

**PR 4, Android (bump + cut `android-v*`).** `ChannelListRules.kt` `sectionsOf`: stop splitting categories into halves, loose on top without a heading in mixed mode; `ChannelsScreen.kt` edit mode with handles and custom accessibility actions; `SocialApi`/channel API calls; fixture test.

## 6. Tests

Server (vitest on a real Postgres via `TEST_DATABASE_URL`, **with the flag on**, pitfall 12):
- step 0: every fixture's per-type order before equals after (old-client view); collisions and gaps normalised; second boot is a no-op.
- migrate: flattened web order before equals after; no loose channels writes no category; collision names it "Geral"; private-only loose channels; two concurrent calls create one category; re-run no-op; dry run writes nothing; revert restores the snapshot exactly; revert after a channel was added keeps it; reverted server is never re-migrated by the job.
- PUT layout: mixed reorder, cross-category, category reorder, append to empty category; actor without VIEW on a private channel leaves its slot unchanged; unknown id, thread id, category as channel, missing category, duplicate, nested parent → 400; stale version → 409 with fresh list; non-manager → 403; one failing row leaves nothing written; audit row; `channels-update` reaches only viewers who can see.
- legacy: old web voice "move up" translation; old iOS move index 0; create with `parentId` absent goes to the first category, `null` stays loose.
- createServer flag on / off shapes; version bumps on create/delete/move/rename.
- flag registry + client contract test entry; metrics keys present.

Shared: `channel-layout` pure functions against the JSON fixtures (same file the phones run).

Web (vitest + RTL): no TEXTO/VOZ/CATEGORIAS when mixed; Criar categoria and header "+" only for managers; drop before/after by pointer half; drop on header and on the empty placeholder; up/down crossing borders with the announcement; occupant drag still moves people and never reorders; Pinados drag for a non-manager still works; empty category hidden for members; folded category keeps the selected and connected rows; 409 adopts server list; flag off renders exactly as today (existing `channel-list-*.test.tsx` pass untouched). E2E (Playwright, `pqp:dev-user-suffix` second user): manager drags in window A, window B updates; two managers drag at once, the second gets the stale message.

iOS / Android: fixture tests for sections; edit-mode reducer (move row, move header with children, drop on header, cancel); old layout when the config endpoint is missing (older server).

## 7. QA checklist

- [ ] Dry run on a prod-shaped copy: counts of servers with loose channels, collisions, private-only loose.
- [ ] QG: flag override on, migrate via the operator route, web shows CANAIS with the same order as yesterday's screenshot.
- [ ] QG on iOS 1.0.21 and Android 0.4.14 from the stores: every channel visible, nothing hidden, voice rooms now inside Canais.
- [ ] Old web tab (do not reload): still navigable; reload picks up the new list.
- [ ] Member without MANAGE_CHANNELS: no Criar categoria, no "+", no empty categories, can still pin by drag.
- [ ] Manager without VIEW on a private channel reorders around it; owner sees the private channel exactly where it was.
- [ ] Drag: within a category, across categories, onto a folded header (opens after 600 ms), onto an empty category, a category among categories, Esc cancels, drop outside does nothing.
- [ ] Keyboard only: reach every slot with the menu; screen reader (VoiceOver on Safari) hears the announcement.
- [ ] Phones: Organizar canais, move a row across categories, move a category, rename, create, Cancelar restores, Concluir persists, VoiceOver/TalkBack move actions.
- [ ] Voice: someone in Lobby while it moves categories stays in the call; occupants render under it in the new place; dragging an occupant still moves them.
- [ ] Live watch party during a reorder: block stays at top, no row appears.
- [ ] New server (pt-BR, en, es UI): Canais / Channels / Canales with general and Lobby inside.
- [ ] Discord import with loose channels: loose on top, categories after, Discord order.
- [ ] Delete "Canais": its channels become loose and render on top, no header.
- [ ] Two managers drag at the same time: second sees "Não deu pra mover. A lista mudou, tenta de novo." and the fresh list.
- [ ] Revert QG via the operator route, then flag off: old layout, same order.
- [ ] `channelLayout.*` counters move on `/api/admin/metrics` (migrated, reorders, staleRejected, legacyMoveTranslated, legacyCreateRedirected).

## 8. Out of scope, noted
- Category permission overwrites (gap #22): moving into a category still changes nothing about who sees a channel. Worth saying in the Criar categoria flow later, not now.
- Per-channel MANAGE_CHANNELS overwrites for reorder (Discord checks the channel); we stay server-wide like `PATCH /move`.
