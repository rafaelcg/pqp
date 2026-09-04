# Feature gaps vs Discord

> Produced 2026-08-01 against `main` at the post-merge state. Every entry was checked
> against the code rather than against the docs, so "exists today" is what actually ships.

28 gaps, ranked. The ordering is what to build first, judged on how badly a small-community
user misses it, how much of the work is already done, and what it unblocks.

Companion: [`THEMING.md`](./THEMING.md) scopes the theming entry in full.

## Three things ship broken today

These are not gaps. They are features that exist, are reachable in the UI, and do not work.
They cost days, not weeks.

1. **"Copy message link" produces a dead URL.** `message-list.tsx` writes
   `/app/channel/<channelId>/message/<messageId>`, but `app-route.ts` only parses `server`
   and `invite` sections — the link resolves to nothing for the person you send it to.
2. **Drafts leak between channels.** `MessageComposer` is mounted without a `key`, so
   switching channels keeps the half-typed text, one Enter away from posting to the wrong
   audience. The fix is a single prop.
3. **`@mentions` cannot be typed.** The whole pipeline exists — shared regex, server-side
   `message_mentions`, mention counts in unread, client highlighting — but the composer has
   no `@` autocomplete, so the only way to mention someone is to click them in the member
   list. Users type `@name` and reasonably conclude mentions are broken.

## Ranked list

✅ marks a gap that has since shipped.

| # | Feature | Category | Pain | Effort |
|---|---|---|---|---|
| 1 | ✅ Jump to message and working permalinks | navigation | high | medium |
| 2 | ✅ Composer fixes: @mention autocomplete and per-channel drafts | composer | high | small |
| 3 | ✅ Replies (quote-and-respond) | conversation-structure | critical | small |
| 4 | ✅ File and image attachments | attachments | critical | large |
| 5 | Push-to-talk, input mode, and mic processing controls | voice-input | high | medium |
| 6 | Voice state visibility and voice moderation | voice-presence | high | medium |
| 7 | ✅ Desktop notifications with a cross-server unread badge | notifications | critical | medium |
| 8 | ✅ Per-server and per-channel notification levels | notifications | high | medium |
| 9 | Installable PWA (manifest, icons, service worker) | platform | high | small |
| 10 | ✅ Message search | discovery | high | medium |
| 11 | Screen share with audio | screen-share | critical | large |
| 12 | Call quality indicators and a TURN-relay badge | diagnostics | medium | small |
| 13 | ✅ Theming: light mode, a token layer, and synced user preferences | theming | medium | medium |
| 14 | ✅ Channel categories and drag-to-reorder | server-structure | high | medium |
| 15 | ✅ Camera video in voice channels | video | medium | medium |
| 16 | Keyboard access to message actions and a screen-reader-visible message log | accessibility | medium | small |
| 17 | ✅ Find people by handle, and stop re-rolling their tag | identity | high | small |
| 18 | ✅ Direct messages (1:1 and group) | messaging | critical | large |
| 19 | ✅ Blocking and DM privacy controls | safety | high | medium |
| 20 | Timeouts, slow mode, and a real message-rejected path | moderation | medium | medium |
| 21 | ✅ Audit log | moderation | medium | medium |
| 22 | ✅ Real permission system: roles with bitfields and per-channel overwrites | permissions | high | large |
| 23 | Incoming webhooks, Discord wire-compatible | integrations | high | large |
| 24 | ✅ Pinned messages | conversation-structure | medium | small |
| 25 | ✅ Link and image embeds (unfurling) | content-rendering | medium | medium |
| 26 | Custom server emoji | expression | medium | medium |
| 27 | Persisted send queue and honest offline state | offline | medium | medium |
| 28 | Electron shell hardening: auto-update, tray, global push-to-talk | platform | medium | medium |

## Detail

### Tier 0 — finish what is already half-built

Small changes that fix features which ship today but do not work. Cheapest credibility we can buy, and two of them are user-visible bugs rather than gaps.

#### 1. Jump to message and working permalinks

*high pain · medium · navigation*

**Why it matters.** A user copies a message link, sends it to a friend, and the friend lands nowhere — the feature already ships and is already broken.

**Today.** Half-built and currently broken. client/src/components/chat/message-list.tsx:468 writes `${origin}/app/channel/<channelId>/message/<messageId>` to the clipboard, but client/src/lib/app-route.ts:17-38 parses only `section === "server"` and `section === "invite"` — the `/app/channel/…` form falls through and returns null. History loading is backwards-only: `listMessages` (server/src/services/messages.ts:22) supports `before` only, and `loadOlder` in client/src/hooks/use-chat.ts walks up from the oldest loaded message, so there is no way to land mid-history at all.

**Sketch.**

Route: change the emitted link to `/app/server/<serverId>/channel/<channelId>/message/<messageId>`, extend `parseAppRoute` to return `{ kind: "channel", serverId, channelId, messageId }` (the existing shape already carries `channelId`, so App.tsx's deep-link effect needs one extra field), and add `messageRoutePath()` next to `channelRoutePath` in app-route.ts.

API: add `?around=<messageId>` to `GET /api/channels/:channelId/messages` (server/src/api/index.ts:440). In messages.ts run two keyset queries around the anchor — `(created_at, id) <= anchor ORDER BY DESC LIMIT n/2` and `> anchor ORDER BY ASC LIMIT n/2` — union and re-sort, returning `{messages, hasMore, hasNewer}`. Reuse the existing `UnknownCursorError` path for a deleted anchor (404 → "this message no longer exists").

Client: use-chat.ts gains `hasNewer`, `loadNewer()` mirroring `loadOlder()`, and `jumpTo(messageId)` that scrolls to an already-loaded row or refetches with `around`. message-list.tsx already owns scroll anchoring via `restoreRef`/`prependedRef`; add a `highlightMessageId` prop that scrolls the row into view and flashes it ~2s, and gate the bottom-pinning effect while `hasNewer` is true so a jump into history isn't yanked to the present. Wire the existing "jump to present" button to reset to the tail.

Build this first: replies, search, and pins are all dead ends without it.

#### 2. Composer fixes: @mention autocomplete and per-channel drafts

*high pain · small · composer*

**Why it matters.** Users type `@Rafael`, nothing happens, and they conclude mentions are broken — and half-typed text follows them into the wrong channel, one Enter away from being posted to the wrong audience.

**Today.** Mention plumbing is complete and unreachable: `MENTION_PATTERN`/`extractMentionUsernames` (packages/shared/src/api.ts:213-224), `recordMentions` (server/src/services/messages.ts:103), `remarkMentions` (client/src/lib/remark-mentions.ts), mention counts in `listUnread`. The only insert affordance is clicking a member (App.tsx:1295 → `insertText` prop). There is no `@` handling in the composer's keydown logic (client/src/components/chat/message-composer.tsx:167-233). Drafts: `const [body, setBody] = useState("")` at message-composer.tsx:49, and the component is mounted at client/src/App.tsx:950 with no `key`, so switching channels does not remount it and the text carries over. Nothing persists to storage.

**Sketch.**

Draft leak, do this line first: add `key={selectedChannel.id}` to `<MessageComposer>` at App.tsx:950. That alone closes the cross-channel privacy footgun.

Mentions: the interaction already exists — `SlashCommandMenu` (client/src/components/chat/slash-command-menu.tsx) plus the ArrowUp/Down/Tab/Enter/Escape handling at message-composer.tsx:194-232. Generalise it into a shared `<AutocompleteMenu>`. Detect an active `@token` at the caret (scan back from `selectionStart` to whitespace, require word-start) rather than the whole-value regex `isSlashMenuOpen` uses — mentions occur mid-message, slash commands only at position 0. Match on both `displayName` and `username` against members the app already fetches (`fetchServerMembers`, rendered by client/src/components/layout/members-panel.tsx); App.tsx passes them down as a `mentionCandidates` prop. Selection replaces the token with `@username ` preserving the caret, mirroring `insertEmoji` (message-composer.tsx:98-115). Ship user mentions only — `@everyone`/`@here` needs server-side fan-out and a role gate, which belongs with the permission work.

Drafts proper: a `useDrafts()` hook in client/src/hooks/ keyed by channel id, backed by localStorage under `pqp:draft:<channelId>` with a ~500ms debounced write and an LRU cap (~50 channels). MessageComposer takes `value`/`onChange` from the hook instead of owning `body`; clear on successful send; store the reply target alongside once replies exist. Show a dot next to channels with a draft in client/src/components/layout/channel-list.tsx, copying the unread-badge rendering. Cross-device draft sync is deliberately out of scope.

#### 17. Find people by handle, and stop re-rolling their tag

*high pain · small · identity*

**Why it matters.** There is no way to reach a specific person short of sending them a whole server invite, and the handle you would give them silently changes out from under you whenever you edit your username.

**Today.** No endpoint returns a user you are not already a co-member with: `GET /api/servers/:serverId/members` (server/src/api/index.ts:517) is the only user listing and it requires membership; client/src/lib/api.ts has no search call. Uniqueness is only on the pair (`idx_users_username_discrim`, schema.sql:16-18), never on `username` alone.

✅ **The tag-stability half of this entry is already done** (verified 2026-08-01 against `updateProfile` in server/src/services/users.ts). It used to re-roll the discriminator on every username change, so `rafael#0042` silently became `rafael#7781`; it now keeps the number and only reallocates when that exact `(username, discriminator)` pair is taken. What remains here is discovery — the two endpoints and the picker below.

**Sketch.**

~~Fix the tag first~~ — done, see above. Longer term add `UNIQUE (lower(username))` and demote the discriminator to legacy display, which is where Discord landed in 2023 for exactly the "what's your number again" friction.

Endpoints: `GET /api/users/lookup?tag=name%231234` (exact match) and `GET /api/users/search?q=` (prefix on username, min 2 chars, capped at 20 rows, on a strict limiter bucket like `writeLimiter` at api/index.ts:105 to blunt enumeration). Return only id/displayName/username/tag/avatarUrl — never `clerkId`, which `toPublicUser` (users.ts:29) currently includes and which must not travel to third parties.

Client: one `components/user/user-search.tsx` combobox, reused by the new-DM dialog and any later member picker.

### Tier 1 — table stakes for group chat

What people notice missing in the first session. Replies is the single highest value-per-day-of-work item in the whole list.

#### 3. Replies (quote-and-respond)

*critical pain · small · conversation-structure*
  
Depends on: Jump to message and working permalinks

**Why it matters.** With three or more people talking at once nobody can tell which question an answer belongs to, and the person being answered never finds out they were answered.

**Today.** Nothing. `messages` has no parent column (server/src/schema.sql:92-99). The message context menu (client/src/components/chat/message-list.tsx:453-499) offers copy text / copy ID / copy link / edit / delete / react — no Reply. The only adjacency signal is 5-minute author grouping (`GROUP_WINDOW_MS`, message-list.tsx:42).

**Sketch.**

Schema: `ALTER TABLE messages ADD COLUMN reply_to_id UUID REFERENCES messages(id) ON DELETE SET NULL;` — SET NULL, not CASCADE, so deleting a parent does not delete its replies — plus `CREATE INDEX ON messages (reply_to_id) WHERE reply_to_id IS NOT NULL`.

Protocol (packages/shared/src/chat.ts): `messageCreateMessageSchema` gains `replyToId: z.string().uuid().optional()`; the shared `broadcastMessageSchema` (chat.ts:40) gains `replyTo: z.object({ id, authorId, authorName, excerpt: z.string().max(120), deleted: z.boolean() }).nullable().default(null)` — a denormalised snippet, so rendering a reply never costs a second fetch.

Server: the `message-create` branch of server/src/ws/chat.ts validates the parent is in the same channel (reject cross-channel parents); `listMessages`/`mapMessage` in server/src/services/messages.ts LEFT JOIN `messages parent` + `users pu` for the snippet. Critically, `recordMentions` (messages.ts:103) also inserts the parent author into `message_mentions` unless they are the replier — that is what makes a reply a notification rather than decoration, and it reuses the mention-badge path in `listUnread` unchanged.

Client: a Reply entry in the message-list.tsx context menu and hover toolbar calling `onReplyTo(message)`; App.tsx holds `replyTarget` and passes it to MessageComposer, which renders a dismissable "Replying to X" bar above the textarea (Escape clears, mirroring the slash-menu Escape handling). MessageRow renders a one-line quote header; clicking it calls `jumpTo()`, falling back to a disabled "original message was deleted" state when `replyTo.deleted`.

#### 7. Desktop notifications with a cross-server unread badge

*critical pain · medium · notifications*

**Why it matters.** Someone @-mentions you, the window is in the background, and you find out an hour later — which is the single behaviour deciding whether pqp can be left running as your comms channel or has to be checked manually.

**Today.** The wire event exists but is content-free: `channelActivitySchema` (packages/shared/src/chat.ts:82-87, verified) carries only `{serverId, channelId, mention}`, fanned out by `notifyChannelActivity` (server/src/ws/chat.ts:174-205). App.tsx:400-422 turns it into an in-app badge and nothing else. Electron *grants* the `notifications` permission (electron/main.js:264,276) but never constructs one — a repo-wide grep for `new Notification`, `setBadgeCount`, `setOverlayIcon`, `flashFrame` returns nothing (verified). And there is no number to badge with: `GET /api/servers/:serverId/unread` exists (api/index.ts:325) but App.tsx only ever calls it for the selected server, and client/src/components/layout/server-rail.tsx:40-54 says so in its own comment — other server icons stay indicator-free because `channels` holds only the selected server's channels.

**Sketch.**

Merged from two analyst entries; the badge and the toast are the same feature.

CROSS-SERVER UNREAD FIRST (small): add `GET /api/unread` returning `[{serverId, channelId, count, mentions}]` for every server the caller is in — the same query already behind the per-server route in server/src/services/servers.ts with the `server_id = $2` predicate dropped and `server_id` added to the projection, respecting the private-channel clause in `getChannelAudience`. Fetch once at bootstrap (App.tsx:333-392) instead of `loadUnread(first.id)`. Keep a `channelId → serverId` map in App state, seeded from that response and updated from each `channel-activity` frame (which already carries `serverId`), and pass per-server totals into `ServerRail`. Expose a derived `totalMentions` for the OS badge and the document title prefix (`(3) pqp`).

PROTOCOL: extend `channelActivitySchema` with `messageId`, `authorName`, `channelName`, `serverName`, `preview` (~120 chars, markdown stripped). `getChannelAudience` (server/src/services/servers.ts:206) already joins channels → server_members; adding `c.name`, `s.name` to that query costs nothing.

CLIENT: new `client/src/lib/notifications.ts` — `ensurePermission()` called on first mention, never on load; `notify({title, body, tag: channelId, renotify:false})`; suppressed when `document.visibilityState === 'visible'` AND that channel is open; `onclick` → `window.focus()` + navigate via `channelRoutePath()`. Wire it into the `channel-activity` branch at App.tsx:400.

ELECTRON: add `setBadgeCount(n)`, `notify(payload)`, `onNotificationClick(cb)` to electron/preload.js with matching `ipcMain.handle`s → `app.setBadgeCount` (mac/Linux), `mainWindow.setOverlayIcon` + `flashFrame(true)` (Windows), `show()+focus()` on click. Mirror the types in client/src/lib/desktop.ts:1-9.

#### 4. File and image attachments

*critical pain · large · attachments*

**Why it matters.** "Can you screenshot it" is a daily action in every small group, and pqp cannot do it at all — not even by pasting an image URL, which renders as a bare link.

**Today.** Nothing. `messages` is `(channel_id, author_id, body TEXT, created_at, edited_at)` (server/src/schema.sql:92-99) and `messageBodySchema` (packages/shared/src/api.ts:85) caps a 4000-char string — that is the entire content model. No storage bucket, no multipart handling in server/src/lib/http.ts (only `readJsonBody`), no paste/drop handlers in client/src/components/chat/message-composer.tsx, and `img` is deliberately absent from `MARKDOWN_ELEMENTS` (client/src/components/chat/message-list.tsx:379-393, verified). Avatars are plain URLs typed into a text field (settings-modal.tsx:365).

**Sketch.**

Storage: S3-compatible (Cloudflare R2 — the SPA already lives on Pages) with presigned PUT so the Railway node process never proxies bytes. Env: `S3_ENDPOINT`, `S3_BUCKET`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`, `S3_PUBLIC_BASE_URL`, `MAX_ATTACHMENT_BYTES`.

Schema (server/src/schema.sql, appended in the existing idempotent style): `CREATE TABLE IF NOT EXISTS message_attachments (id UUID PK, message_id UUID NULL REFERENCES messages(id) ON DELETE CASCADE, channel_id UUID NOT NULL REFERENCES channels(id) ON DELETE CASCADE, uploader_id UUID NOT NULL REFERENCES users(id), storage_key TEXT NOT NULL, filename TEXT NOT NULL, content_type TEXT NOT NULL, byte_size BIGINT NOT NULL, width INT, height INT, created_at TIMESTAMPTZ DEFAULT NOW())` + index on `message_id` + a partial index on `message_id IS NULL` for the orphan sweeper.

API: `POST /api/channels/:channelId/attachments` → `requireChannelAccess`, validate `{filename, contentType, byteSize}` against a MIME allowlist (image/png|jpeg|gif|webp, application/pdf, text/plain, video/mp4) and a 10 MB default cap, insert with `message_id NULL`, return `{attachmentId, uploadUrl, publicUrl}`. Rate-limit via the existing `writeLimiter`. An interval sweeper deletes rows + objects where `message_id IS NULL AND created_at < now() - interval '1 hour'`.

Protocol: `messageCreateMessageSchema` gains `attachmentIds: z.array(z.string().uuid()).max(10).optional()`; relax `messageBodySchema` to allow an empty body when attachments are present; `broadcastMessageSchema` (chat.ts:40) gains `attachments: z.array(attachmentSchema).default([])`.

Server: the `message-create` branch of server/src/ws/chat.ts claims the rows in the same transaction as the insert, verifying `uploader_id = user.id AND channel_id = payload.channelId AND message_id IS NULL`. `listMessages`/`mapMessage` batch-join attachments the way `listReactionsForMessages` already batches reactions. `deleteMessage` needs an explicit object delete (the FK cascade only removes rows).

Client: message-composer.tsx gets `onPaste`/`onDrop`/hidden file input → upload with progress → pending-attachment chips above the textarea; use-chat.ts `sendMessage` carries `attachmentIds` and keeps the optimistic bubble on local object URLs; message-list.tsx renders an `<AttachmentGrid>` below the body (images inline with intrinsic width/height to avoid layout shift, everything else a download chip with `Content-Disposition: attachment`). Keep `img` out of the markdown allowlist — render from structured data, never from user markdown.

This is the storage subsystem the product does not have; custom emoji, server icons, and real avatars all hang off it.

#### 10. Message search

*high pain · medium · discovery*
  
Depends on: Jump to message and working permalinks

**Why it matters.** Anything said more than a day ago is effectively gone, so a group that uses chat as its shared memory keeps re-asking questions it already answered.

**Today.** Nothing. server/src/api/index.ts has no search route (verified against the full route list); the only read path is `GET /api/channels/:channelId/messages` with a `before` cursor (index.ts:440). There is no full-text index — `idx_messages_channel_created` (server/src/schema.sql:105) is the only index on `messages`.

**Sketch.**

Schema: `ALTER TABLE messages ADD COLUMN search_tsv tsvector GENERATED ALWAYS AS (to_tsvector('simple', body)) STORED;` + `CREATE INDEX idx_messages_search ON messages USING GIN (search_tsv);`. Use `'simple'`, not `'english'` — servers are multilingual and English stemming over Portuguese chat produces junk. The generated column backfills automatically; on a large table create the index CONCURRENTLY out of band.

API: `GET /api/servers/:serverId/search?q=&channelId=&authorId=&before=&limit=`. The ACL is the load-bearing part: reuse the exact predicate from `isChannelMember` (server/src/services/users.ts:178-197, verified — `c.is_private = FALSE OR sm.role IN ('owner','admin') OR EXISTS (SELECT 1 FROM channel_members …)`) so private channels never leak. Rank with `ts_rank_cd` but default the sort to newest-first — in chat, recency beats relevance. Keyset-paginate on `(created_at, id)`, never OFFSET. Return `{results: [{message, channelId, channelName}], hasMore}` with `ts_headline` snippets.

Shared: `messageSearchQuerySchema` in packages/shared/src/api.ts (2-200 chars) built with `websearch_to_tsquery` so a stray `&` is not a syntax error.

Client: a `SearchPanel` in client/src/components/chat/ opening as a right-hand rail (client/src/components/layout/channel-members-panel.tsx is the layout precedent), a search input in the channel header in App.tsx, and each result calling `jumpTo(messageId)`.

### Tier 2 — voice parity

pqp's differentiator is voice, and this is where it is furthest from Discord in day-to-day feel rather than in feature count.

#### 5. Push-to-talk, input mode, and mic processing controls

*high pain · medium · voice-input*

**Why it matters.** pqp transmits every sound in your room from the moment you join, so anyone on a laptop mic, a mechanical keyboard, or with family in the background can only participate by staying muted and clicking before each sentence.

**Today.** Voice activity is detected but never gates the mic: `createSpeakingTracker` (client/src/lib/voice-audio.ts:48) with a hardcoded 0.045 threshold only drives the speaking ring in `startSpeakingLoop` (client/src/hooks/use-voice.ts:319). The only gate is manual mute (`applyMuteToPipeline`, use-voice.ts:261). Electron has a Cmd/Ctrl+Shift+M menu *accelerator* (electron/main.js:243) — a toggle that only fires when focused, not push-to-talk. Separately `buildAudioConstraints(deviceId)` (client/src/lib/audio-devices.ts:60) returns a bare `true` when no device is picked, so echo cancellation / noise suppression / AGC are only requested on the explicit-device branch and are unsettable from the UI (settings-modal.tsx:442-527 has device pickers, volumes and a mic meter, no processing toggles).

**Sketch.**

SETTINGS: add `inputMode: "voice" | "ptt"`, `pttKey`, `pttReleaseMs`, `vadThreshold`, `echoCancellation`, `noiseSuppression`, `autoGainControl` to `LocalSettings` (client/src/components/layout/settings-modal.tsx:14) with an input-mode radio, a keybind capture field, and a sensitivity slider drawn over the existing `MicLevelMeter` (settings-modal.tsx:98) so the threshold is visible against the user's own level.

GATE: in use-voice.ts add `setTransmitting(on)` that ramps `pipeline.gainNode.gain.setTargetAtTime(on ? volume : 0, ctx.currentTime, 0.02)` then flips `track.enabled` after `pttReleaseMs` — the gain ramp avoids clicks, `enabled=false` saves the uplink. Drive it from the existing speaking loop when `inputMode === "voice"` (using the user threshold instead of the constant) and from key events when `"ptt"`. Purely local: no protocol change, identical on mesh and LiveKit.

CONSTRAINTS: change the signature to `buildAudioConstraints(deviceId, { echoCancellation, noiseSuppression, autoGainControl })` and always emit the flags explicitly, including the default-device path. Apply live on an active call via `pipeline.rawStream.getAudioTracks()[0].applyConstraints({...})` — no renegotiation.

HOTKEY: new `client/src/hooks/use-push-to-talk.ts` with window keydown/keyup, guarded against typing in the composer. Be honest in the UI that browser PTT only works while the tab is focused; the global version needs main-process capture and belongs with the Electron hardening item.

Defer the ML suppressor (RNNoise AudioWorklet inserted between `source` and `gainNode` at use-voice.ts:109, ~150KB wasm lazy-loaded like `livekit-client` already is) — that is its own week and the explicit constraints get most of the value.

#### 6. Voice state visibility and voice moderation

*high pain · medium · voice-presence*

**Why it matters.** You cannot tell whether the person you are talking to can hear you, and when someone joins with a screaming hot mic the only lever a moderator has is banning them from the whole server.

**Today.** Mute/deafen are local-only: `isMuted`/`isDeafened` live in `VoiceState` (client/src/hooks/use-voice.ts:43-46) and render only on the `self` row (client/src/components/voice/voice-panel.tsx:298-310); `PeerRow` (voice-panel.tsx:28) shows connection state and local volume only. `voiceParticipantSchema` (packages/shared/src/signaling.ts:10) carries peerId/userId/displayName/avatarUrl and nothing else, so the server never learns mute state. Moderation: `actionsFor` (client/src/components/layout/members-panel.tsx:215) offers mention/promote/demote/kick/ban only. The primitives already exist unused — `evictVoiceUser`/`evictVoiceUsersExcept` (server/src/ws/voice.ts:156-186) fire only on kick/ban and channel deletion.

**Sketch.**

Two analysts filed these separately; they share one protocol addition and one server-side peer record, so build them together.

SHARED (packages/shared/src/signaling.ts): add `muted`/`deafened` to `voiceParticipantSchema`; add `voiceStateMessageSchema { type: "voice-state", muted, deafened }` and `voiceModerateMessageSchema { type: "voice-moderate", targetPeerId, action: 'mute'|'unmute'|'deafen'|'undeafen'|'disconnect'|'move', toChannelId? }` to `voiceClientMessageSchema`; add `peerStateMessageSchema { type: "peer-state", peerId, muted, deafened, serverMuted, serverDeafened }` and `forceJoinMessageSchema { type: "force-join", voiceChannelId }` to `voiceSignalingMessageSchema`.

SERVER (server/src/ws/voice.ts): store `muted`/`deafened`/`serverMuted`/`serverDeafened` on `VoicePeer` (:21) and include them in `toParticipant` (:49) so `welcome`, `peer-joined` and every roster carry them. Handle `voice-state` by updating the peer and calling the existing `broadcastToRoom` + `broadcastRoster`, throttled with `createRateLimiter` (server/src/lib/rate-limit.ts). Handle `voice-moderate` after an owner/admin check (`canManageServer`) plus the outrank check kick/ban already uses: `disconnect` calls the existing `removePeer`/`evictVoiceUser`; `move` is disconnect plus a `force-join` push the client acts on by calling `voice.join(toChannelId)`.

PERSISTENCE: start in-memory on the peer record. Add `voice_member_states (channel_id, user_id, server_muted, server_deafened, set_by, PRIMARY KEY (channel_id, user_id))` only once you want a mute to survive a rejoin — which is what people expect within the first week.

ENFORCEMENT, honestly: on mesh there is no server in the media path, so server-mute is advisory — a patched client keeps transmitting and disconnect is the only hard action. Under LiveKit it is real via `RoomServiceClient.mutePublishedTrack` plus re-minting the token with `canPublish: false` (server/src/voice/backends.ts:58). Say so in the UI. This is a concrete, honest argument for the SFU path documented in docs/voice-backends.md.

CLIENT: send from `applyMute`/`toggleDeafen` in use-voice.ts; merge `peer-state` into `remotePeers`; render mic-slash / headphone-slash icons in `PeerRow` and on sidebar occupant avatars (client/src/components/layout/channel-list.tsx:201, voice-avatar.tsx); moderation entries via the existing `ContextMenu` primitive (client/src/components/ui/context-menu.tsx) on voice occupants and in members-panel.tsx.

#### 12. Call quality indicators and a TURN-relay badge

*medium pain · small · diagnostics*

**Why it matters.** When audio breaks up nobody can tell whose fault it is, so the whole channel stops to debug it by voice — and a self-hoster has no way to see whether their own TURN config is even being used.

**Today.** Only a coarse ICE state. `mapPeerState` (client/src/lib/peer-connection-manager.ts:60) collapses RTCPeerConnection state into connecting/connected/failed and `PeerRow` renders it as a text chip with a Retry button (client/src/components/voice/voice-panel.tsx:64-85). `pc.getStats()` is never called anywhere in the repo, so there is no RTT, loss, jitter, bitrate, or candidate-type data at all.

**Sketch.**

MESH: add a 2s stats poll in peer-connection-manager.ts. From `getStats()` read the nominated `candidate-pair` (`currentRoundTripTime`, and `remoteCandidateId` → `candidateType === "relay"` to detect TURN), `inbound-rtp` (`packetsLost`, `jitter`, delta over the previous sample) and `outbound-rtp` bitrate. Extend `RemotePeer` with `quality: { rttMs, lossPct, transport: "host" | "srflx" | "relay" }` and emit through the existing `onPeerStateChange` path.

SFU: subscribe to `RoomEvent.ConnectionQualityChanged` and read `participant.connectionQuality` in client/src/lib/livekit-session.ts; map Excellent/Good/Poor onto the same three-bar scale so the UI has one shape.

UI: a small bars component in `PeerRow` and an aggregate in voice-status-bar.tsx (which already has a slot for the SFU chip, :68). Show "Relayed" when the pair is TURN, and surface the existing Retry button automatically when loss stays above ~5% rather than only on hard failure.

This is a disproportionate win for a self-hostable product: CLAUDE.md pitfall 1 records a whole debugging cycle on cross-NAT failure that a relay badge would have made obvious in one glance, and every operator who wires their own `TURN_*` vars will hit the same question.

#### 11. Screen share with audio

*critical pain · large · screen-share*

**Why it matters.** Watching someone's screen while talking is why most groups open a voice channel at all, so the moment anyone says "let me show you" the whole group leaves for Discord or Meet.

**Today.** Nothing. `createMicPipeline` (client/src/hooks/use-voice.ts:95) calls getUserMedia with `video: false`, and there is no `getDisplayMedia` call anywhere in client/src. The LiveKit path explicitly drops non-audio tracks (client/src/lib/livekit-session.ts:82-95, `if (track.kind !== Track.Kind.Audio) return`). Electron allows the `display-capture` permission (electron/main.js:260-281) but registers no handler, so getDisplayMedia would reject there.

**Sketch.**

HARD BLOCKER FIRST (mesh): client/src/lib/peer-connection-manager.ts never sets `pc.onnegotiationneeded` — offers are only created in `connectToPeer` (:449), `retryPeer` (:513) and `restartIce` (:164), so adding a track to a live PC never renegotiates. Add an `onnegotiationneeded` handler feeding the existing perfect-negotiation logic (`isImpolite`/`applyRemoteDescription`); the offer/answer/ice-candidate protocol in packages/shared/src/signaling.ts supports it unchanged.

TRACK ROUTING: `ontrack` (peer-connection-manager.ts:257) overwrites `managed.stream` with `event.streams[0]`, so a second track from the same peer clobbers the audio stream. Split `RemotePeer` into `audioStream`/`videoStream` (or key by `track.kind` + transceiver mid) and publish the screen with `addTrack(track, screenStream)` under a distinct stream id.

PROTOCOL: extend `voiceParticipantSchema` with `publishing: { camera: boolean, screen: boolean }` and add `{ type: "voice-publish", kind, active }` client → `peer-publish` broadcast in packages/shared/src/signaling.ts and server/src/ws/voice.ts, so the sidebar shows a LIVE badge before media arrives and peers know a renegotiation is coming.

SFU: server/src/voice/backends.ts:58 sets `canPublishData:false` and no `canPublishSources` — allow `microphone`/`screen_share`/`screen_share_audio`. In livekit-session.ts use `room.localParticipant.setScreenShareEnabled(true, { audio: true })`, stop filtering video in TrackSubscribed, flip `adaptiveStream` to true (currently false, :56), enable simulcast.

CLIENT UI: new `client/src/components/voice/screen-stage.tsx` (focused video + thumbnail strip), a `<video>` sink alongside client/src/components/voice/voice-audio-sinks.tsx, share/stop controls in voice-panel.tsx and voice-status-bar.tsx.

ELECTRON: register `session.setDisplayMediaRequestHandler` with `desktopCapturer.getSources` in electron/main.js plus an in-app source picker over the `pqpDesktop` bridge. macOS system audio needs a loopback device — degrade to video-only with a clear message.

MESH VS SFU: one sharer to N viewers on mesh is N independent encodes — cap mesh sharing at ~2-3 viewers / 720p15 and require the SFU above that, refusing with the existing `voice-room-full`-style server gate in server/src/ws/voice.ts.

#### 15. ✅ Camera video in voice channels

*medium pain · medium · video*
  
Depends on: Screen share with audio — same renegotiation fix, same multi-track RemotePeer split, same video sink

**Why it matters.** pqp advertises "Voice & Video" in its own settings UI and then offers no video, so anyone expecting a face-to-face standup gets a phone call.

**Done.** The camera is on the voice panel's control bar, and a participant whose camera is on has their tile *become* the picture: mirrored for yourself, a window for everybody else (client/src/components/voice/voice-panel.tsx). Camera and screen share are independent, exactly as in Discord, so presenting keeps your face on your own tile while the share fills the stage beside it.

Nothing new was needed below the UI. `toggleCamera` in client/src/hooks/use-voice.ts already worked for both transports, the roster's `cameraStreamId` already told the mesh which incoming video was a face, and `set-camera` on the server was never conversation-specific. The video quality control moved onto the same bar with it, so a bad uplink is answerable from inside the call rather than from Settings.

Pinned by `client/e2e/video-quality.spec.ts`, which measures **decoded frames** at the watching member (not `videoWidth`, which cannot fail here; see CONTRIBUTING) with a camera and a screen share running at once, and reads the encoder ceilings back off `RTCRtpSender.getParameters()`.

**The quality control is one-directional, and now says so.** Everything `setVideoQuality` reaches ends at `RTCRtpSender.setParameters` on this machine's own senders (client/src/lib/peer-connection-manager.ts). `maxBitrate` and `scaleResolutionDownBy` are encoder parameters; `RTCRtpReceiver` has no counterpart to either, so in a full mesh what a viewer receives is whatever the presenter encoded and there is no knob on the watching side at all. It shipped labelled "Camera and screen quality" on both sides of that asymmetry, which is how a viewer watching a soft iOS screen share moved the selector from 360p to 1080p, twice, and saw nothing change. The sizes are now "Video you send" and appear only while this machine is sending; a viewer gets "Video you receive", which names the size actually arriving (off `inbound-rtp`, via `client/src/lib/voice-stats-probe.ts`) and says whose choice it is. Pinned by `client/e2e/viewer-video-quality.spec.ts`, which measures at the receiver and asserts the watcher's own rung moves nothing. **A viewer-initiated request to the sender is still open**: it needs a new signalling frame, so it needs `packages/shared` and `server/`, and that is a redeploy that drops every live call.

**Leftovers, now shipped.** Settings → Voice lists cameras (`listAudioDevices` returns `cameras`; the choice is `cameraDeviceId` in local settings). The channel-list occupant row badges a camera from the roster's `cameraStreamId`. Concurrent cameras are capped per transport (`CAMERA_LIMIT`: mesh 3, LiveKit 8), refused with `camera-denied`, matching screen share.

### Tier 3 — structure, safety, and scale

What a server needs once it outgrows a handful of friends. The permission system is the deepest item in the document and gates several others.

#### 14. ✅ Channel categories and drag-to-reorder

*high pain · medium · server-structure — shipped 2026-08*

**What shipped, and where it differs from the original sketch.** A category is a channel row (`type='category'`), as sketched — `channels.parent_id` (server/src/schema.sql) points at one, `ON DELETE SET NULL` so deleting a category uncategorizes its children rather than taking them with it.

The one design point the sketch didn't anticipate: **`position` is scoped by `(parent_id, type)` at the top level, not by `parent_id` alone.** The sidebar renders top-level text, top-level voice and categories as three separate lists, never one interleaved one — so a naive "position among all top-level channels" would let reordering the text list silently renumber voice channels that share no visible list with it at all. Inside a real category the group is *not* type-scoped; text and voice channels mix together there, matching how the sidebar nests them under one heading. See the comment on `moveChannel` (server/src/services/servers.ts) for the full reasoning — a dedicated test (`scopes top-level position by type`) pins it, and reverting the scoping is what it's there to catch.

No `@dnd-kit` or any new dependency: native HTML5 drag-and-drop handles desktop pointer dragging with zero library weight, and every row's context menu carries "Move up"/"Move down"/"Move to \<category\>" as a keyboard- and touch-reachable equivalent — which doubles as the accessible path gap #16 wants, not just a fallback. No new WS broadcast either: channel create/rename/delete were never broadcast live to begin with, so a reorder joining that same silence is consistent rather than a new gap — the actor's own client updates from its own response, matching how the other three channel mutations already behave.

`PATCH /api/channels/:channelId/move` takes `{parentId, index}` and renumbers both the sibling group a channel joins and the one it leaves as contiguous 0..n-1 sequences in one transaction, guarded by `requireManager`. Rejects nesting a category under a category, and a channel naming itself as its own parent.

One real bug surfaced by testing with a pre-existing top-level channel already at position 0 (not by design — a browser check happened to have one): deleting a category renumbers its now-uncategorized former children to append after whatever top-level channels of the same type already existed, rather than keeping their old category-scoped position values, which collided. Caught by a test, mutation-checked (revert the fix, exactly that test fails).

#### 22. ✅ Real permission system: roles with bitfields and per-channel overwrites

*high pain · large · permissions*

**Shipped 2026-08-24.** Discord 8-step overwrites, 20 bits, seeded `@everyone` + Admin, nicknames, `@everyone`/`@here`. Channel overwrite editor, hoist UI, role colours, live `permissions-update` WS frame. Unenforced bits (`ATTACH_FILES`, `READ_MESSAGE_HISTORY`, `SPEAK`, `MANAGE_SERVER`) stay hidden in both editors.

**Why it matters.** You cannot make someone a channel moderator without also handing them kick, ban and server settings, you cannot make a read-only announcement channel, and you cannot keep an admin out of a founders-only channel because the admin bypass is hardcoded.

**Today.** `server_members.role TEXT CHECK (role IN ('owner','admin','member'))` (server/src/schema.sql:30, verified). All authorization is four helpers in server/src/api/index.ts:141-202 (`requireServerMember`, `requireManager`, `requireOwner`, `requireOutranked`) plus `canManageServer` and `isChannelMember` in server/src/services/users.ts:170-197 — and `isChannelMember` literally contains `OR sm.role IN ('owner', 'admin')` as an unconditional private-channel bypass (verified). Private channels are a boolean plus a `channel_members` allowlist (schema.sql:52,60-65). Critically the same ACL predicate is copy-pasted in four places — `isChannelMember` (users.ts:182-193), `listChannels` (servers.ts:63-70), `getChannelAudience` (servers.ts:214-221), `listUnread` (users.ts:395-402) — so any permission model must replace all four or they drift. Client gating is one boolean, `canManage` at client/src/App.tsx:874.

**Sketch.**

SCHEMA: `roles(id UUID PK, server_id FK CASCADE, name, color INTEGER NULL, hoist BOOL, mentionable BOOL, permissions BIGINT NOT NULL DEFAULT 0, position INTEGER NOT NULL, is_everyone BOOL DEFAULT FALSE)` with a partial unique index on `(server_id) WHERE is_everyone`; `member_roles(server_id, user_id, role_id, PK all three)`; `channel_overwrites(channel_id, target_type CHECK IN ('role','member'), target_id UUID, allow BIGINT DEFAULT 0, deny BIGINT DEFAULT 0, PK(channel_id,target_type,target_id))`. Use BIGINT / TS `bigint`, not `number` — JS integers die at 2^53 and a real permission set passes 53 bits.

BACKFILL (one migration, not a rewrite): create @everyone per server with VIEW_CHANNEL|SEND_MESSAGES|ADD_REACTIONS|READ_HISTORY|CONNECT|SPEAK|CREATE_INVITE; create an 'Admin' role with ADMINISTRATOR assigned to every current `role='admin'` row; keep `servers.owner_id` as the implicit-everything check. Convert each `is_private=TRUE` channel into `@everyone deny=VIEW_CHANNEL` plus a member overwrite `allow=VIEW_CHANNEL` per `channel_members` row — that makes `is_private` derived. Keep `is_private` and `server_members.role` as computed read-only API fields for one release or every client surface breaks at once.

BITS in a new packages/shared/src/permissions.ts: ADMINISTRATOR, VIEW_CHANNEL, SEND_MESSAGES, READ_HISTORY, ADD_REACTIONS, MENTION_EVERYONE, MANAGE_MESSAGES, MANAGE_CHANNELS, MANAGE_ROLES, MANAGE_SERVER, CREATE_INVITE, KICK_MEMBERS, BAN_MEMBERS, MODERATE_MEMBERS, CONNECT, SPEAK, MUTE_MEMBERS, MOVE_MEMBERS, MANAGE_WEBHOOKS.

RESOLVER (server/src/services/permissions.ts): `computePermissions(serverId, channelId|null, userId): bigint` — owner ⇒ ALL; base = OR of @everyone + member roles; ADMINISTRATOR ⇒ ALL; then overwrites in Discord order (@everyone deny→allow, union of role denies→allows, member overwrite last). PERFORMANCE IS THE TRAP: `isChannelMember` runs on every `message-create`, `reaction-toggle` and `join-channel` in server/src/ws/chat.ts. Fetch the member's roles + the channel's overwrites in one query and memoize per socket behind a per-server version counter bumped by any role/overwrite write, or you add two round-trips to the hottest path in the app.

QUERIES: replace the four duplicated predicates with one SQL function or CTE `visible_channels(server_id, user_id)` evaluating `(resolved & VIEW_CHANNEL) <> 0`.

HIERARCHY: an actor may only edit/assign roles strictly below their highest `position`, and only kick/ban/timeout a target below them — replaces `requireOutranked`.

API: `GET|POST /api/servers/:id/roles`, `PATCH|DELETE /api/roles/:roleId`, `PATCH /api/servers/:id/roles/order` (bulk, one txn), `PUT|DELETE /api/servers/:id/members/:userId/roles/:roleId`, `PUT|DELETE /api/channels/:channelId/overwrites/:targetType/:targetId` (replacing the channel-member routes at api/index.ts:395-430), and `GET /api/servers/:id/permissions` returning the caller's resolved server bits plus a `{channelId: bits}` map so the client never re-derives the algorithm. WS `permissions-update` pushed on any change; revocation reuses `evictChannelViewers` (ws/chat.ts:138) and `evictVoiceUsersExcept` (ws/voice.ts:163) verbatim — both are already called from the is_private toggle.

CLIENT: `canManage` (App.tsx:874) becomes a `usePermissions()` hook exposing `can(bit, channelId?)`, migrated across App.tsx, channel-list.tsx, members-panel.tsx:84,148-151,226, server-settings-dialog.tsx:61; channel-members-panel.tsx becomes an overwrite editor. New screens: role list with drag-reorder and a permission toggle grid, plus a per-channel overwrite editor — the largest new UI in the product.

ROLE COSMETICS RIDE ALONG: `roles.color`/`hoist`/`mentionable` are in the schema above, so colour-by-highest-position-role in members-panel.tsx and message author names, hoisted sections, and `@role` mentions (extend `extractMentionUsernames` to return `{users, roles}` and fan roles out into `message_mentions` so unread badges keep working unchanged) are presentation work on top, not a second project. Gate `@everyone` on MENTION_EVERYONE and arbitrary role pings on `roles.mentionable` or it becomes the most-abused feature in the product on day one. Ship a per-server role dictionary via `GET /api/servers/:id/roles` and put only `roleIds` on member payloads — never grow the message payload.

EFFORT, honestly: ~1 week schema + resolver + backfill, ~1 week API/WS/query rewrite, 1-2 weeks client, and server/test/acl.integration.test.ts roughly triples — it is currently the only real authorization test and must cover overwrite precedence and hierarchy before this ships.

#### 18. Direct messages (1:1)

*critical pain · large · messaging*
  
Depends on: Find people by handle, and stop re-rolling their tag

**Why it matters.** You cannot say one thing privately to one person — you meet someone in a server and there is nowhere to put a private word.

**Today.** Nothing. Every conversation must be a channel inside a server: `channels.server_id UUID NOT NULL REFERENCES servers(id)` (server/src/schema.sql:48, verified). Every read path joins through server_members — `isChannelMember` (server/src/services/users.ts:178), `getChannelAudience` (servers.ts:206), `listUnread` (users.ts:375), `listChannels` (servers.ts:54), `recordMentions` (messages.ts:112). The closest workaround is a private channel (`channels.is_private` + `channel_members`), which requires a server both people already share AND owner/admin rights to create.

**Sketch.**

Do NOT just make `server_id` nullable — each of the ~8 predicates shaped `JOIN server_members sm ON sm.server_id = c.server_id` silently returns zero rows for a DM, so every one grows an OR branch and one missed predicate is a privacy leak.

Instead promote the conversation to a first-class kind and keep `messages.channel_id` pointing at it:
```sql
ALTER TABLE channels ALTER COLUMN server_id DROP NOT NULL;
ALTER TABLE channels ADD COLUMN kind TEXT NOT NULL DEFAULT 'server'
  CHECK (kind IN ('server','dm','group'));
ALTER TABLE channels ADD CONSTRAINT channels_server_kind
  CHECK ((kind = 'server') = (server_id IS NOT NULL));
-- participants for kind <> 'server' reuse channel_members, which already has
-- idx_channel_members_user_channel (schema.sql:144).
CREATE TABLE dm_pairs (
  low_user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  high_user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  channel_id UUID NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  PRIMARY KEY (low_user_id, high_user_id));
```
low/high = sorted uuid pair, so `POST /api/dms` is idempotent under two concurrent taps.

ACCESS CONTROL: add ONE `canAccessChannel(channelId, userId)` in server/src/services/users.ts branching on `kind` — `'server'` keeps today's query verbatim, `'dm'|'group'` is `EXISTS (SELECT 1 FROM channel_members …)`. Repoint every call site above plus `join-channel`/`message-create` in ws/chat.ts and ws/voice.ts. `recordMentions` breaks outright on a NULL server_id (its `JOIN channels c ON c.server_id = sm.server_id`) — for DMs resolve mentions against the participant set. This one-function consolidation is worth doing even for its own sake, since the predicate is currently copy-pasted in four places that can drift.

ENDPOINTS: `GET /api/dms` (list + last-message preview + unread), `POST /api/dms {userId}` → 200 existing / 201 created, `DELETE /api/dms/:channelId` (hide, don't delete). Messages, edit/delete, reactions, typing and read cursors all reuse `/api/channels/:id/…` unchanged once the access check branches.

PROTOCOL: no new client→server types — `join-channel`, `message-create`, `typing` are already channel-scoped. But `channelActivitySchema` (packages/shared/src/chat.ts:82, verified) requires `serverId: z.string().uuid()`; make it nullable and add `kind`, or DM unreads have nowhere to land in the `unread` map App.tsx keys by channel.

CLIENT (the largest refactor here): app-route.ts gains `/app/dm/:channelId`; server-rail.tsx gains a Home button above the server list; a new `dm-list.tsx` stands in for channel-list.tsx in the home view; and `selectedServerId` must become `selection: {kind:'server'|'dm', id}` — `syncRoute` early-returns on a null serverId (App.tsx:522) and `loadChannels`/`applyChannelRoute` both assume a server.

DM voice calls come nearly free: `getChannel(...).type !== 'voice'` (ws/voice.ts:270) rejects a DM channel today — gate on `kind` instead.

#### 19. Blocking and DM privacy controls

*high pain · medium · safety*
  
Depends on: Direct messages (1:1)

**Why it matters.** Shipping DMs without blocking ships a harassment vector, and a user needs a proportionate option today: not to leave the server, just to get one person out of their feed without asking a moderator to act for them.

**Today.** Only server-scoped moderation exercised by moderators on behalf of a server: `server_bans` (server/src/schema.sql:79-86), kick/ban in server/src/services/moderation.ts, UI in client/src/components/layout/members-panel.tsx:215. There is nothing a user can do on their own behalf — no block, no mute, no ignore, and no setting controlling who may contact them.

**Sketch.**

Deliberately skip the friends graph. For a self-hosted community the server IS the relationship, so express DM privacy in terms the product already has rather than building a friend list to gate it:
```sql
CREATE TABLE user_blocks (
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  blocked_user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, blocked_user_id),
  CHECK (user_id <> blocked_user_id));
ALTER TABLE users ADD COLUMN dm_privacy TEXT NOT NULL DEFAULT 'server_members'
  CHECK (dm_privacy IN ('everyone','server_members','nobody'));
```
One direction only (blocker → blocked). `'server_members'` = we share a server, which is a single EXISTS against `server_members` and needs no new social graph.

Enforcement must be server-side at every point — a client-side hide is not a block:
- `POST /api/dms` and `message-create` into a DM channel → 403 when either party blocks the other or `dm_privacy` is not satisfied.
- `notifyChannelActivity` (server/src/ws/chat.ts:174) and `recordMentions` (server/src/services/messages.ts:103) skip blocked-by users, so a blocked person cannot ping you.
- Server-channel messages: do NOT filter server-side — that corrupts the keyset pagination counts in `listMessages`. Add `blocked: boolean` to the message payload and have message-list.tsx collapse it behind a "Blocked message — show" affordance, matching Discord's reveal-on-tap curtain.

Endpoints: `POST /api/blocks {userId}`, `DELETE /api/blocks/:userId`, `GET /api/blocks`; `dm_privacy` rides on the existing `PATCH /api/me` via `updateProfileSchema` (packages/shared/src/api.ts:163).

Client: block/unblock in the members-panel.tsx context menu and any profile popover; the collapsed-message renderer in message-list.tsx; a Privacy section in settings-modal.tsx.

#### 20. Timeouts, slow mode, and a real message-rejected path

*medium pain · medium · moderation*

**Why it matters.** A moderator dealing with someone heated has to choose between doing nothing and removing them from the community, and a message the server silently drops currently retries forever with no explanation to the sender.

**Today.** Sanctions are kick and ban only: `DELETE /api/servers/:serverId/members/:userId` with a `ban` flag (server/src/api/index.ts:532) and `POST /api/servers/:serverId/bans` (:568), backed by server/src/services/moderation.ts. Rate limiting exists but is anti-abuse infrastructure, not moderation: global per-identity token buckets in server/src/lib/rate-limit.ts instantiated as `messageLimiter`/`reactionLimiter`/`typingLimiter` (server/src/ws/chat.ts:30-32) — not per-channel, not per-member, not configurable, and it silently drops the message.

**Sketch.**

TIMEOUT: `ALTER TABLE server_members ADD COLUMN timeout_until TIMESTAMPTZ, ADD COLUMN timeout_reason TEXT`. Enforce in server/src/ws/chat.ts before `message-create`, `reaction-toggle` and `typing`, and in ws/voice.ts on `join-voice-room` — read-yes, send/react/speak-no. `PATCH /api/servers/:id/members/:userId/timeout {untilMs|null, reason}` gated on `requireManager` + `requireOutranked`, capped at 28 days. Push `member-timeout {serverId, userId, until, reason}` over WS.

SLOW MODE: `ALTER TABLE channels ADD COLUMN slowmode_seconds INTEGER NOT NULL DEFAULT 0 CHECK (slowmode_seconds BETWEEN 0 AND 21600)`. Add to `updateChannelSchema` (packages/shared/src/api.ts:132) and `updateChannel` (server/src/services/servers.ts:98). Enforce in `message-create` with a per-(channelId,userId) bucket — the existing `createRateLimiter` works directly with capacity 1 and refill 1/slowmodeSeconds. Bypass for managers.

THE REAL COST IS THE CLIENT FAILURE PATH. Today a dropped send is only detected by a client-side timer: `SEND_TIMEOUT_MS` (client/src/hooks/use-chat.ts:34) marks it failed and `retryMessage` (:347) re-sends the identical body — which under slow mode or a timeout loops forever with no explanation. So build a real rejection channel: new WS server message `message-rejected {channelId, nonce, reason: 'slowmode'|'timeout'|'ratelimit'|'blocked', retryAfterMs}` added to `chatServerMessageSchema` and `CHAT_SERVER_MESSAGE_TYPES` (packages/shared/src/chat.ts:116,136), handled in use-chat.ts to mark the bubble failed with a reason and suppress auto-retry, with message-composer.tsx showing a countdown or "timed out until X" and disabling send.

That rejection channel is worth building for its own sake — it fixes an existing infinite-retry bug against the plain rate limiter that already ships.

#### 21. Audit log

*medium pain · medium · moderation*

**Why it matters.** When a channel disappears or someone is demoted, nobody in the community can find out who did it — moderator disputes are unresolvable and a compromised admin account leaves no trace.

**Today.** Only `server_bans.banned_by` and `server_bans.reason` (server/src/schema.sql:82-84, written in server/src/services/moderation.ts:26-60). Kicks (moderation.ts:19), role changes (server/src/services/users.ts:228), channel create/update/delete (servers.ts:77,98,128), moderator message deletion (api/index.ts:491-513), ownership transfer (servers.ts:161) and server rename/delete leave nothing behind. Structured logging exists (server/src/lib/log.ts) but it is operational — not queryable per server and not exposed to owners.

**Sketch.**

SCHEMA: `audit_log (id BIGSERIAL PK, server_id UUID REFERENCES servers(id) ON DELETE CASCADE, actor_id UUID NULL REFERENCES users(id) ON DELETE SET NULL, action TEXT NOT NULL, target_type TEXT, target_id UUID NULL, reason TEXT NULL, changes JSONB NULL, created_at TIMESTAMPTZ DEFAULT NOW())` with `INDEX (server_id, created_at DESC, id DESC)` — the same shape as `idx_messages_channel_created` (schema.sql:105) so keyset pagination works identically. `changes` holds `[{key, old, new}]`.

WRITE FROM THE SERVICE LAYER, NOT THE ROUTES. Several mutations are transactional (`banMember` moderation.ts:32-59, `transferOwnership` servers.ts:161-200) and some happen over WS rather than HTTP, so route middleware would both miss actions and log ones that later rolled back. Add `logAudit(client, {...})` taking an optional pg client and call it inside the existing transactions. Actions: `member.kick|ban|unban|timeout|role_update`, `channel.create|update|delete|reorder`, `message.delete`, `server.update|ownership_transfer`, `invite.create|delete`.

API: `GET /api/servers/:serverId/audit-log?before=&limit=&action=&actorId=` gated on `requireManager`, returning `{entries, hasMore}` with the same cursor contract as `listMessages` so the client's existing infinite-scroll pattern is reusable. Accept an optional `reason` on destructive bodies — `removeMemberSchema` (packages/shared/src/api.ts:203) already takes a body.

RETENTION: periodic `DELETE FROM audit_log WHERE created_at < NOW() - INTERVAL '90 days'`, or a busy self-hosted instance grows unbounded.

CLIENT: a new tab in client/src/components/layout/server-settings-dialog.tsx (already a tabbed shell) plus `fetchAuditLog` in client/src/lib/api.ts.

Effort is breadth, not depth: ~15 call sites, one query, one screen. It is a trust feature for a product whose whole pitch is that the operator is accountable to their own community.

**What shipped, and where it differs from the sketch.** Written from the route layer, not the service layer as sketched: every mutation here already hands its route both the old and new state for free (a channel row read for its own authorization check, a role fetched to gate the change) or needs neither, so threading a pg client through `servers.ts`/`moderation.ts` transactions would have bought correctness this app does not need for a v1 audit trail — the same best-effort-follow-up-write tolerance this codebase already accepts elsewhere (`notifyChannelActivity` runs after `createMessage` commits, not inside it). The cursor is a bare `audit_log.id` (a `BIGSERIAL` is already a strict total order matching insertion order) rather than the sketch's `(created_at, id)` pair — simpler, and without the "cursor row was deleted" fragility keyset message pagination has to guard against, since retention can purge an old row without ever breaking a page built on ids alone. No `server.delete` action: that row would cascade away with the server it describes the instant it was written, and nobody can open the audit-log route for a server that no longer exists to read it back anyway. `message.delete` only logs a moderator acting on someone else's message — an author deleting their own is not a moderation action — and never records the deleted body itself, which is already gone and would otherwise become a second, longer-retained copy of content someone chose to remove. Client: a plain "Audit log" section at the bottom of `server-settings-dialog.tsx` (that dialog was not, in fact, already a tabbed shell) rather than a new tab, visible to admins as well as the owner — a moderator with the power to kick, ban, or delete needs to be accountable to the community for having used it, not just answerable to the owner. Retention ships as a daily sweep (`pruneAuditLog`, 90-day default) alongside the existing hourly attachment sweep in `index.ts`.

### Tier 4 — platform, expression, and reach

Individually optional, collectively the difference between a project and a product.

#### 9. Installable PWA (manifest, icons, service worker)

*high pain · small · platform*

**Why it matters.** There is no mobile story at all — a phone user gets a browser tab that dies on every app switch, with no home-screen icon and no way to be reached in the background.

**Today.** The responsive shell is genuinely there — mobile nav drawer and `md:` breakpoints throughout client/src/App.tsx (`mobileNavOpen`, lines 988-995, 1018-1076). But client/index.html has no `<link rel="manifest">`, no favicon, no `apple-touch-icon` (verified: only a `theme-color` meta at line 28), and client/public/ contains only `_redirects`, `images/`, `robots.txt`, `sitemap.xml`. No service worker file and no `serviceWorker.register` anywhere.

**Sketch.**

Add `client/public/manifest.webmanifest`: `name`/`short_name: "pqp"`, `start_url: "/app"`, `scope: "/"`, `display: "standalone"`, `background_color`/`theme_color: "#1a1c22"` (matching the existing meta), icons at 192/512 plus a `maskable` 512 in `client/public/icons/`. Link it from index.html alongside `apple-touch-icon` and `apple-mobile-web-app-status-bar-style`.

Add `vite-plugin-pwa` to client/vite.config.ts with `registerType: 'prompt'`, precaching the app shell only — never cache `/api/*`, and keep the Cloudflare Pages `_redirects` SPA fallback intact.

Two things to verify on install: Clerk's `mode="modal"` sign-in inside a standalone iOS window (App.tsx:112-118), and that `VITE_API_URL`/`VITE_WS_URL` are absolute so a standalone window does not hit same-origin Pages — already pitfall 3 in CLAUDE.md.

Reuse the same icon set for the missing Electron app icon (PLAN_STATUS.md open item 4). The service worker file is also where web push lands later — iOS only delivers push to home-screen-installed PWAs, so this is that feature's hard prerequisite.

#### 8. Per-server and per-channel notification levels

*high pain · medium · notifications*
  
Depends on: Desktop notifications with a cross-server unread badge

**Why it matters.** One chatty #general makes notifications intolerable and users switch the whole feature off, which is worse than never having had it.

**Today.** Nothing at any layer. `LocalSettings` (client/src/components/layout/settings-modal.tsx:14-21) is localStorage-only and covers audio devices, `muteOnJoin`, `compactPeers` — no notification keys. `notifyChannelActivity` (server/src/ws/chat.ts:187-205, verified) filters only on "not the author", "in the audience", "not currently viewing" — there is no per-user preference in the loop and no table to hold one.

**Sketch.**

Schema (appended to server/src/schema.sql in the existing `CREATE TABLE IF NOT EXISTS` style): `notification_settings (user_id UUID REFERENCES users(id) ON DELETE CASCADE, server_id UUID REFERENCES servers(id) ON DELETE CASCADE, channel_id UUID NULL REFERENCES channels(id) ON DELETE CASCADE, level TEXT NOT NULL DEFAULT 'all' CHECK (level IN ('all','mentions','none')), muted_until TIMESTAMPTZ, updated_at TIMESTAMPTZ)` with `UNIQUE NULLS NOT DISTINCT (user_id, server_id, channel_id)` — `channel_id NULL` is the server-level default.

Endpoints: `GET /api/notification-settings` (all rows for the user, one round-trip at bootstrap), `PUT /api/notification-settings {serverId, channelId?, level?, mutedUntil?}`.

Server: resolve the effective level (channel row → server row → 'all') inside `notifyChannelActivity` and skip the WS frame for users at 'none', or at 'mentions' when `mention === false`. This is the hot path, so cache the per-user map in a `Map` invalidated on PUT — same in-process caveat as the rate limiters.

Client: add "Notifications ▸ All / Only @mentions / Nothing" and "Mute ▸ 15m / 1h / 8h / 24h / Until I turn it back on" to the existing context-menu `items` arrays in client/src/components/layout/channel-list.tsx:358-391 and server-rail.tsx:83. Muted channels render dimmed and are excluded from the `unread` totals in App.tsx.

#### 13. Theming: light mode, a token layer, and synced user preferences

*medium pain · medium · theming*

**Why it matters.** pqp is dark-only with no escape hatch — it does not even honour the OS setting — and the same assumption already ships two visible bugs: Clerk's sign-in modal renders light-on-dark, and every native select, slider and scrollbar draws light OS chrome inside the dark shell.

**Today.** One dark theme, defined once. client/src/index.css:3-29 is the whole system (verified): an `@theme` block with 11 raw OKLCH values (`ink`/`ink-2`/`ink-3`/`ink-4`, `paper`/`paper-muted`, `signal`/`signal-dim`, `danger`/`warning`/`success`) plus 9 semantic aliases and 3 fonts. Components consume the RAW names, not the aliases: `text-paper-muted` ×113, `text-paper` ×47, `border-ink-4` ×33, `bg-ink-3` ×32, `text-danger` ×31 vs `text-muted` ×4. Zero `dark:` variants, zero `prefers-color-scheme`, zero `color-scheme` anywhere in client/. `<ClerkProvider>` (client/src/main.tsx:69-76) has no `appearance` and `@clerk/themes` is not in client/package.json (verified). Eight things bypass tokens entirely: the body gradients (index.css:44-47, using the `background:` shorthand), `::selection` (:66), `.legal-prose` (:247), the emoji-mart rgb-triplet bridge (:269-278), a popover shadow repeated verbatim in 4 files (context-menu.tsx:34, slash-command-menu.tsx:23,33, emoji-picker-panel.tsx:48), the speaking-ring glow (voice-avatar.tsx:23), `theme="dark"` hardcoded at emoji-picker-panel.tsx:57, and `backgroundColor: "#1a1f2a"` on the Electron BrowserWindow (electron/main.js:321). Preferences: `LocalSettings` is localStorage-only under `pqp-local-settings` (settings-modal.tsx:14-79) with no theme field, and `PATCH /api/me` (api/index.ts:210) syncs only displayName/username/avatarUrl — so muteOnJoin, volumes and compactPeers never leave the browser either.

**Sketch.**

Scope to the analyst's own recommended cut line — stages 1-3, ~1.5-2 weeks. Stages 4-6 (accent picker, custom themes, per-server branding) are upside; free-form CSS themes should stay off the roadmap permanently, since they are an exfiltration and UI-redress surface that turns every bug report into "disable your theme and retry".

STAGE 1 — role tokens (1-2 days, no visible feature). Three verified Tailwind v4 facts make this cheap: `@theme` emits `:root, :host` inside `@layer theme`, so an *unlayered* `:root[data-theme="light"]` block anywhere in index.css beats it without specificity tricks; alias indirection (`--color-accent: var(--color-signal)`) survives to runtime rather than being resolved at build; and `@theme` tree-shakes unused variables, so the block must become `@theme static` (one-word change, index.css:3) because role tokens are consumed at runtime, not by utility scanning. Never use `@theme inline` — it inlines values and structurally kills runtime overriding; leave a comment saying so.

Rename to elevation/role names — `surface-0..3`, `border`/`border-strong`, `text`/`text-muted`, `indicator`, `accent`/`accent-hover`/`on-accent`, `danger`/`warning`/`success`, `code-bg`/`code-text`, `overlay`, `selection`, `focus-ring`, `ring-offset` — and keep the old names as deprecated aliases pointing at them (`--color-ink-3: var(--color-surface-2)`), so all 200+ existing class names keep working and **no component file changes**. Codemod the class names later; do not block light mode on it. Four renames are load-bearing rather than cosmetic: the ink ramp runs darkest→lightest and must invert, `ink-4` is a border token wearing a surface name (33 `border-ink-4` uses vs 3 `bg-ink-4`), `bg-signal text-ink` appears 5× and needs a real `on-accent`, and code background must be a role not an alias (in dark, `--color-ink` is *below* the message list; in light it is the page itself, so code blocks would vanish). Put `--shadow-popover`/`--shadow-speaking`/`--gradient-app-*` in a plain unlayered `:root` (not `@theme`, which would try to make utilities of them) and replace the 8 inline literals. Convert index.css:44-47 from the `background:` shorthand to `background-color` + `background-image` longhands. Set `color-scheme: dark` — that alone fixes the native-control bug today.

STAGE 2 — Light + System (3-4 days). `:root[data-theme="light"]` override block (light needs a darkened accent — the 0.88 chartreuse fails on white — glows replaced with solid rings, `--color-overlay` deliberately NOT overridden since a modal scrim must darken in both themes, and skeletons' `surface-3` darker than the panel or every loading state disappears). New `client/src/lib/theme.ts` + `use-theme.ts` with a `matchMedia` listener; theme radio in settings-modal.tsx writing its own `pqp-theme` key (not inside the audio-device blob — the boot script must not parse it). Anti-flash needs all three: an inline blocking script in `client/index.html` `<head>` (Vite injects main.tsx at the end of `<body>`, so a head script paints first; there is no CSP in the repo today, but note that adding one later needs a hash for this script), never gating render on `/api/me`, and reading a persisted theme in electron/main.js before `new BrowserWindow` to set `backgroundColor` and `nativeTheme.themeSource`. Add `@clerk/themes` and a `<ClerkThemeBridge>` passing `baseTheme` + `variables` read from the resolved custom properties in a `useLayoutEffect`. `theme={resolved}` for emoji-mart plus hand-written `--rgb-*` triplets per theme. Force `data-theme="dark"` on the four marketing routes (main.tsx:33-38) — those are compositions over a hero photograph, not app chrome, and light-moding them is scope creep.

STAGE 3 — server-side preferences (~2 days). This absorbs the separate "settings don't follow the user" gap: `CREATE TABLE IF NOT EXISTS user_preferences (user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE, settings JSONB NOT NULL DEFAULT '{}'::jsonb, updated_at TIMESTAMPTZ)` validated by a `userPreferencesSchema` in packages/shared/src/api.ts (theme, muteOnJoin, compactPeers, inputVolume, outputVolume, notification prefs) — a column per preference means a migration per preference and this set will churn. `inputDeviceId`/`outputDeviceId` MUST stay local: a deviceId from another machine is meaningless and `getUserMedia({audio:{deviceId:{exact}}})` (settings-modal.tsx:151) throws on it. Fold reads into `toPublicUser` (server/src/services/users.ts:29) so `GET /api/me` carries them at zero extra round-trips; add `PATCH /api/me/preferences` (upsert, shallow merge, last-write-wins) near api/index.ts:210, debounced ~500ms since `patchLocal` fires on every slider tick. Server wins on read, user action wins on write — never reconcile-and-write on boot or a stale tab clobbers the phone.

High contrast shipped as a third axis (`data-contrast="more"`, preference `default | more | system`). It is not a fourth appearance and not a Teams clone. See [`THEMING.md`](./THEMING.md).

#### 16. Keyboard access to message actions and a screen-reader-visible message log

*medium pain · small · accessibility*

**Why it matters.** A keyboard-only or screen-reader user cannot react to, edit, or delete any message — the actions exist but are physically unreachable — and is never told that new messages arrived.

**Today.** Verified defect: the hover toolbar at client/src/components/chat/message-list.tsx:628 is `"absolute -top-3 right-2 hidden items-center … group-hover:flex group-focus-within:flex"` — because the container is `display:none`, its buttons cannot receive focus, so `group-focus-within` can never fire. The `<article>` (:514) has no `tabIndex`, so the Radix `ContextMenu` trigger wrapping it can't be opened with Shift+F10 either, and `ReactionBar`'s add-reaction button only renders when reactions already exist (:752). The scroll container (:224) has no `role="log"`/`aria-live` — the only `aria-live` in the file is the typing indicator at :334. Dialogs are the good case: focus trap, Escape, focus restore and scroll lock in client/src/components/ui/dialog.tsx.

**Sketch.**

In message-list.tsx: give each `<article>` `tabIndex={0}` with roving focus (arrows move between rows, Home/End jump). Replace `hidden … group-hover:flex group-focus-within:flex` with `opacity-0 pointer-events-none group-hover:opacity-100 group-hover:pointer-events-auto focus-within:opacity-100 focus-within:pointer-events-auto` so the buttons stay in the tab order. Add row-level keys (`e` edit own message, `Delete`, `+` open the emoji picker) mapped to the same handlers the toolbar already calls, and always render the add-reaction button.

Add `role="log" aria-live="polite" aria-relevant="additions"` to the scroll container at :224 with a per-row `aria-label` of "{author} at {time}: {body}" so announcements are intelligible, and suppress the live region while `isLoadingOlder` so prepending history doesn't spam the reader.

Replace the `window.confirm` delete (:448) with the existing `PromptDialog`/`Dialog` primitive. In channel-list.tsx add `aria-current="true"` to the selected channel and express unread counts as `aria-label` text rather than colour alone; add a skip-to-composer link in App.tsx.

This is a defect, not polish: three shipped features are unreachable by an entire input modality, and it is the class of issue an open-source project gets filed against publicly.

#### 24. ✅ Pinned messages

*medium pain · small · conversation-structure — shipped 2026-08*

**What shipped, and where it differs from the original sketch.** Pin state lives on `messages.pinned_at`/`pinned_by` (server/src/schema.sql) rather than a join table — a message is pinned in at most one place, so a join table would let two rows reference the same pin for nothing, and every existing read path already has the message row in hand. Capped at `MAX_PINS_PER_CHANNEL = 50` (packages/shared/src/api.ts), checked only on the path that adds a new pin — re-pinning an already-pinned message never counts against it.

Permission is manage-only in a server channel (`canManageServer`, matching Discord's own "Manage Messages" gate) rather than "any member" — pinning something you did not write and were not asked to keep is a moderation action, not personal annotation. A conversation has no moderators, so any participant may pin or unpin there, the same split `requirePinAccess` uses everywhere else in the codebase.

`POST/DELETE /api/messages/:messageId/pin` and `GET /api/channels/:channelId/pins`. No new broadcast type: pinning is a mutation of the message row like an edit, so it reuses the existing `message-update` broadcast — `pinnedAt`/`pinnedBy` ride on `messageSchema` and `broadcastMessageSchema` for free. Client: "Pin message"/"Unpin message" in the context menu (client/src/components/chat/message-list.tsx), a pin badge next to the timestamp, and a "Pins" button in the channel header opening client/src/components/chat/pinned-messages-panel.tsx. No "X pinned a message" system line — the badge and the panel are the visible record.

#### 25. Link and image embeds (unfurling)

*medium pain · medium · content-rendering*

**Why it matters.** A pasted YouTube, GitHub or news link renders as bare blue text, so the reader has to leave the app to find out what it even is.

**Today.** Links render as plain anchors: `MARKDOWN_COMPONENTS.a` (client/src/components/chat/message-list.tsx:395-403, correctly hardened with `noopener noreferrer nofollow ugc`). `img` is excluded from `MARKDOWN_ELEMENTS` (message-list.tsx:379-393, verified), so even explicit markdown images are stripped. No server-side fetching of any kind — this would be the first place the server follows a user-supplied URL.

**Sketch.**

Schema: `CREATE TABLE link_embeds (url_hash TEXT PRIMARY KEY, url TEXT NOT NULL, kind TEXT NOT NULL, title TEXT, description TEXT, site_name TEXT, image_url TEXT, width INT, height INT, fetched_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), failed BOOLEAN NOT NULL DEFAULT FALSE)` — cached by URL, not per message, so a link posted in ten channels is fetched once. TTL ~7 days.

Server: a new server/src/services/embeds.ts extracts the first 1-2 URLs after insert (in the `message-create` branch of server/src/ws/chat.ts), enqueues an out-of-band fetch, and broadcasts `{type: "message-embed", channelId, messageId, embeds}` when it resolves — never block the send on a network fetch. SSRF defence is the real work: resolve DNS first and reject private/link-local/loopback ranges, refuse redirects into them, 5s timeout, 512 KB body cap, `Accept: text/html` only, and a small tolerant OG/Twitter meta parser (no headless browser). Image URLs (content-type sniff on HEAD) become `kind: 'image'` directly.

Protocol: `embeds: z.array(embedSchema).default([])` on the shared `broadcastMessageSchema`; new server type added to both `chatServerMessageSchema` and `CHAT_SERVER_MESSAGE_TYPES`.

Client: an `<EmbedCard>` under the body in message-list.tsx — left accent border, site name, title, description, thumbnail — plus inline rendering for `kind: 'image'`. Proxy embed images through the API or R2 rather than hotlinking so a malicious host cannot harvest viewer IPs, and offer a per-message "remove embed" plus a "don't unfurl my links" preference in the synced settings store.

**What shipped, and where it differs from the sketch.** SSRF defence (`server/src/lib/safe-fetch.ts`) is DNS-resolve-then-pin, not resolve-then-reconnect: the socket connects to the exact address a one-time lookup returned via a custom `lookup` option, never re-resolving, which closes the DNS-rebinding TOCTOU window a naive "check the IP, then let Node re-resolve for the real request" approach leaves open. Blocks the full private/loopback/link-local/CGNAT/multicast range on both IPv4 and IPv6, including unwrapped `::ffff:`-mapped addresses. 5s timeout, 512 KB body cap enforced by counting bytes received rather than trusting `Content-Length`, 3 redirects, `text/html,application/xhtml+xml,image/*` accept.

No new broadcast type, matching pins: an embed is a mutation of the message row, so it rides the existing `message-update` broadcast rather than the sketch's proposed `message-embed`. The cache-hit path is synchronous — a link someone already shared rides the very first `message-broadcast` — and only a genuine cache miss (including a fresh `failed` row, which must not be re-fetched on every repeat of a dead link within its 1-hour TTL) triggers a background fetch followed by a `message-update` once it resolves; the same trigger fires from the edit route for a link added or changed by an edit. `GET /api/embeds/:urlHash/image` is deliberately the one unauthenticated `/api/` route in the app — it only ever re-serves a hash already present in the cache, refetched through the same SSRF-guarded path, so gating it behind Clerk would buy no confidentiality while breaking the plain `<img src>` tag that renders it. Client toggle shipped as `showLinkEmbeds` in the synced preferences store (Settings → Chat → "Show link previews"); no per-message "remove embed" yet.

#### 26. Custom server emoji

*medium pain · medium · expression*
  
Depends on: File and image attachments

**Why it matters.** Custom emoji are how a small server sounds like itself — in-jokes, member faces, reaction culture — and they are the thing communities cite when they say they cannot leave Discord.

**Today.** Unicode only. client/src/lib/emoji-shortcodes.ts is a hardcoded 38-entry `SHORTCODES` map expanded at send time by `expandEmojiShortcodes` (message-composer.tsx:134,162), so `:fire:` becomes a literal 🔥 in the stored body. Reactions are validated by `reactionEmojiSchema` (packages/shared/src/api.ts:57) — max 32 chars, no whitespace — so a `<:name:uuid>` token would technically pass but nothing renders it. `EmojiPickerPanel` (client/src/components/chat/emoji-picker.tsx) is a static Unicode grid, and `message_reactions.emoji` is already `TEXT` (schema.sql:131), so reactions need no migration.

**Sketch.**

Schema: `CREATE TABLE server_emoji (id UUID PK, server_id UUID NOT NULL REFERENCES servers(id) ON DELETE CASCADE, name TEXT NOT NULL, storage_key TEXT NOT NULL, animated BOOLEAN NOT NULL DEFAULT FALSE, created_by UUID REFERENCES users(id) ON DELETE SET NULL, created_at TIMESTAMPTZ DEFAULT NOW(), UNIQUE (server_id, name));` with a per-server cap (50) and `name` constrained to `^[a-z0-9_]{2,32}$`.

API: `GET/POST /api/servers/:serverId/emoji`, `DELETE /api/servers/:serverId/emoji/:emojiId`, gated by `requireManager`. Upload reuses the attachment presign path; enforce 256 KB and 128×128 server-side, or reject oversize rather than add a native image dep.

Wire format: store `<:name:emojiId>` in the message body — a stable token that survives a rename, unlike a bare `:name:`. Add a remark plugin next to client/src/lib/remark-mentions.ts turning the token into an `<img class="emoji">` node and extend `MARKDOWN_ELEMENTS` for that one controlled case (the URL comes from the emoji table, never from user text). Tighten `reactionEmojiSchema` to validate the two shapes explicitly instead of accepting any 32-char blob, and have `listReactionsForMessages` resolve custom ids to URLs.

Client: emoji-picker.tsx gains a server-emoji tab fed by a `useServerEmoji(serverId)` hook, and the `:` autocomplete reuses the shared `<AutocompleteMenu>` built for mentions. Stickers are the same subsystem at larger dimensions with no inline-text form — skip them.

#### 27. Persisted send queue and honest offline state

*medium pain · medium · offline*

**Why it matters.** You type a message on a flaky connection, reload, and it is gone — but the UI showed it as sent, so you believe it was delivered.

**Today.** Partial and in-memory. client/src/lib/realtime.ts queues outbound chat while offline (`chatQueue`, `MAX_CHAT_QUEUE = 200`, :30) and flushes on `ready` (:308) — that part is well done — but `disconnect()` clears both queues (:359-360) and nothing is written to storage, so a reload or quit drops them. client/src/hooks/use-chat.ts:128-138 deliberately only starts the 10s failure timer when `transport.isConnected()`, so an offline message stays `pending` forever with no explanation. Bootstrap calls `fetchMe`/`fetchServers` first (App.tsx:333-368) and renders `AppBootstrapError` on any failure — there is no cached data to fall back on.

**Sketch.**

Persistence: write the pending queue and optimistic messages to IndexedDB (`idb-keyval`) keyed by channelId on every enqueue; rehydrate in `createChatController` and re-transmit after `transport.onReady`.

Idempotency is the part that must land with it: make the nonce a stable UUID stored with the row (today `createNonce()` at use-chat.ts:81 is `Date.now()`-based and resets per session), add a nullable `nonce` column to `messages` with `UNIQUE (channel_id, author_id, nonce)`, and use `ON CONFLICT DO NOTHING … RETURNING` in `createMessage` (server/src/services/messages.ts), re-broadcasting the existing row on conflict. Without this a double flush duplicates messages.

Cold start: cache the last `/api/servers` and `/api/channels` payloads plus the newest page per channel in IndexedDB after each successful fetch; in App.tsx's `init()` render from cache when the network call fails instead of `AppBootstrapError`, with a persistent "Offline — showing cached messages" strip next to the existing reconnecting banner (App.tsx:1085).

UI honesty: in message-list.tsx render pending bubbles as "Will send when reconnected" whenever transport status is not online, rather than an indefinitely dimmed bubble.

This matters more once the PWA ships, since a phone-installed app spends much of its life on a bad connection.

#### 23. Incoming webhooks, Discord wire-compatible

*high pain · large · integrations*
  
Depends on: Permission system for MANAGE_WEBHOOKS (can ship gated on admin first)

**Why it matters.** Nothing can get into pqp except a signed-in human typing, so a technical community loses every CI result, deploy notice, and alert the moment it moves off Discord.

**Today.** Nothing. Every message originates from an authenticated WS session: `handleChatMessage` → `createMessage(channelId, user, body)` (server/src/ws/chat.ts:278, server/src/services/messages.ts). The blocker is structural, not routing: `messages.author_id UUID NOT NULL REFERENCES users(id)` (server/src/schema.sql:95, verified) means the schema has no representation of a non-human author. And every API request passes through `resolveAuthUser` before routing (server/src/api/index.ts:674-684), so there is no unauthenticated write path anywhere in the app.

**Sketch.**

SCHEMA: `webhooks(id UUID PK, channel_id UUID FK CASCADE, name TEXT, avatar_url TEXT, token_hash TEXT NOT NULL, bot_user_id UUID REFERENCES users(id), created_by UUID, created_at)`. For authorship, create a synthetic user row per webhook (`ALTER TABLE users ADD COLUMN is_bot BOOLEAN NOT NULL DEFAULT FALSE`) rather than relaxing `author_id` to NULL — every existing join in `listMessages`/`mapMessage` and in `message_mentions` then keeps working untouched, which is worth more than schema purity. Add `messages.webhook_id`, `messages.override_name`, `messages.override_avatar_url` for per-post identity.

API: `POST|GET /api/channels/:channelId/webhooks` and `DELETE /api/webhooks/:id` gated on manage rights, returning the token exactly once (store `token_hash` only, constant-time compare on use). The execute route `POST /api/webhooks/:id/:token` is the one route that must bypass the auth gate — restructure `handleApi` (api/index.ts:656) to match that path *before* `resolveAuthUser`, and give it its own rate-limit bucket keyed by webhook id via `createRateLimiter`, since the per-user bucket does not apply.

BODY: accept Discord's shape `{content, username, avatar_url}` and 204 on success. That wire compatibility is the whole product argument — every existing GitHub/Sentry/Grafana integration works with a URL swap. Explicitly scope v1 to `content` only: `embeds` needs a structured render model message-list.tsx does not have, and is a separate project rather than a stretch goal.

DELIVERY: after insert reuse `broadcastToChannel` and `notifyChannelActivity` (server/src/ws/chat.ts:105,174) so webhook posts light unread badges like any other message.

CLIENT: webhook management in server-settings-dialog.tsx or channel-meta-dialog.tsx; message-list.tsx renders a BOT tag and honours the overrides.

Large because of the unauthenticated write path, the authorship model change and token handling — not because of line count.

#### 28. Electron shell hardening: auto-update, tray, global push-to-talk

*medium pain · medium · platform*
  
Depends on: Push-to-talk, input mode, and mic processing controls; Desktop notifications with a cross-server unread badge

**Why it matters.** Anyone who downloads a build is frozen on it forever, closing the window quits the app so voice drops and no notification can arrive, and the mute hotkey only works when the app is focused — which is useless while gaming, the actual reason people install a voice client.

**Today.** electron/main.js does window state (lib/window-state.js), `pqp://` deep links (:81-143, 410-419), an app menu, and hardened navigation with a permission allowlist (:256-306) — all solid. What is missing, verified by grep across electron/: no `Tray`, no `globalShortcut`, no `autoUpdater`, no `new Notification`; `app.on('window-all-closed')` quits on non-macOS (:449); electron/package.json has no `publish` block. PLAN_STATUS.md open item 4 confirms there are no icons in electron/build, so packaged apps ship the default Electron icon.

**Sketch.**

AUTO-UPDATE: add `electron-updater` and `"publish": [{"provider": "github", "owner": "rafaelcg", "repo": "pqp"}]` to the `build` block in electron/package.json; call `autoUpdater.checkForUpdatesAndNotify()` in `app.whenReady()` (main.js:421) and push an `update-ready` IPC for an in-app "Restart to update" banner. This is shipping hygiene for a project that distributes binaries publicly.

BACKGROUND: create a `Tray` with a context menu (Open pqp / Toggle mute / Quit), set its tooltip from the unread count pushed over IPC, and on Windows/Linux intercept `close` → `hide()` unless a real quit is in progress (an `app.isQuitting` flag set in `before-quit`, main.js:455).

GLOBAL PTT: Electron's `globalShortcut` has no key-up event, so a true hold-to-talk needs `uiohook-napi` (or a `before-input-event` fallback that only works focused). Expose `pqp:ptt-down` / `pqp:ptt-up` on the existing allowlisted `pqpDesktop` bridge in electron/preload.js, consumed by the `use-push-to-talk` hook. Persist the binding through the existing lib/window-state.js JSON store, editable in settings-modal.tsx.

Mirror all preload additions into client/src/lib/desktop.ts:1-9 and client/src/components/desktop-bridge.tsx, and ship `electron/build/icon.icns|.ico|.png` from the same icon set as the PWA.

## Deliberately not on this list

- **Free-form CSS themes.** An exfiltration and UI-redress surface that turns every bug
  report into "disable your theme and retry". See `THEMING.md`.
- **A bot API and app directory.** Incoming webhooks cover the realistic 90% (CI, alerts,
  RSS) at a fraction of the cost. A full bot platform is a product in itself.
- **Stage channels, soundboard, activities, Nitro-style cosmetics.** These serve Discord's
  scale and monetisation, not a self-hostable app for small communities.
- **Server discovery.** Meaningless when every deployment is its own island; it only makes
  sense on a hosted pqp.gg with real network effects.

## What this says strategically

The list is long, but the shape is encouraging: most Tier 0 and Tier 1 items are small
because the hard parts already exist. Mentions need a menu, not a pipeline. Replies need a
nullable column and a snippet, because the unread and notification machinery is already
there. Search needs an index on a table that already has the right shape.

The genuinely large items cluster in two places: **anything that stores bytes**
(attachments, custom emoji, embeds) and **anything that changes who can do what**
(permissions, DMs, webhooks). Those are the two decisions worth making deliberately and
early, because everything downstream inherits them.

Attachments is the one large item that cannot be deferred forever — "can you screenshot
it" is a daily action, and pqp cannot do it at all.
