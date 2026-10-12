# Stories: what's up, for 24 hours

> Design study, not code. Written 2026-10-11 against `origin/main` (`000fe9fb`).
> Nothing in the repo was edited. Mocks: `mocks.html` (one file, open it in a
> browser; the bottom-right toggle simulates reduced motion). Screenshots:
> `shots/` (headless Chrome, 1 px = 1 pt).

Rafael's ask: "a way for everyone in a channel/server to send a story and show
what's up". It is a separate feature from Baú. An earlier study rejected a
story strip *as the Baú preview* (M4 in `bau-preview/`), for two reasons:
stories imply a 24 h life, and Baú is "posts que ficam". That reasoning is
exactly why stories should exist **beside** Baú and not inside it. The same
study warned that a lime ring reads as "tu tá na call". The ring here is a
lime-to-amber gradient, never solid lime.

---

## 0. The short version

- **Two audiences, one story.** Every story goes to one or more servers you are in,
  to your friends, or to both. On phones the server strip sits at the top of
  the Lista viva server screen, and the friends strip at the top of the
  Conversas tab. On web it sits at the top of the channel sidebar and the
  Conversas list.
- **Anyone can post.** This is the opposite of Baú, which only `MANAGE_SERVER`
  can post to. A new permission bit, `POST_STORIES` (bit 25), is on for
  @everyone by default, so staff can take it away per role.
- **Four kinds.** Photo, video up to 30 s, a text card, and "chama pra call", a
  live sticker that joins a voice room in one tap. Polls, questions and an
  "on hoje às 22h" RSVP come in phase 2.
- **24 h, then the bytes are deleted.** The exception is a reported or flagged
  story. It is held for the moderators, and a CSAM match is held forever per
  `CONTENT_SAFETY.md`.
- **Replies are private.** Text becomes a message in the author's Conversas. A
  reaction (GG, 🔥, 😂, 😮, 💀, 👏) stays on the story, and only the author sees it.
- **No push per story, ever.** The ring is the notification.
- **Images are scanned before they are visible**, on the attachments claim path.
  Video is scanned on three sampled frames, which is better than Baú and chat
  video today (unscanned).
- **Runtime flag `stories`**, per server, default off. QG first.
- **Cost at today's scale is under US$1 a month.** R2 egress is free, and the
  bytes live for a day.
- **Build order:** PR 0 (contract + schema + bit + flag) first, then server, web,
  iOS and Android in parallel.

---

## 1. What the research says (and what pqp takes from it)

Sources are in the notes at the end. The four lessons below decided the design.

1. **Stories that are a "posting tool" die. Stories that are for friends live.**
   - Twitter Fleets (killed Aug 2021): "we haven't seen an increase in the number
     of new people joining the conversation". Fleets were "mainly used by those
     Tweeting the most". Fleets launched first **in Brazil** (Mar 2020), so
     Brazilian users have already seen a failed version.
   - LinkedIn Stories: people wanted lasting video, not ephemeral.
   - YouTube Stories: Community posts got "many times more" engagement.
   - Instagram, WhatsApp Status and Snapchat work because the audience is a
     known graph. Mosseri, 2025: stories are for friends, not discovery.

   → **pqp scopes stories to people you already share a server or a friendship
   with. There is no discovery and no public story.**
2. **Posters are a minority, so watching has to pay off by itself.**
   - Snapchat (2016): about a third of daily users created stories.
   - Instagram: daily Stories users were about a quarter of respondents.
   - WhatsApp Status reached 15% of users daily in 10 weeks.

   → Lower the cost of posting with things pqp already knows: who is in which
   voice room, the game you are playing (Steam connection), the clip in your
   gallery. Make the most useful story type, **"chama pra call"**, turn a
   viewer into a participant. That is the conversation Fleets never produced.
3. **Replies and reactions go private.**
   - Fleets: reactions by DM.
   - Telegram: replies and reactions arrive as a private message tied to the story.
   - WhatsApp (2023): 8 quick reactions.

   → Text replies open the Conversas thread, which the Conversas redesign is
   making first-class. Reactions do **not** create a message. A popular story in
   a 1,200-member server would otherwise spray dozens of one-emoji DMs.
4. **Notifications kill or make it.**
   - BeReal's single daily push drove both its rise and its fatigue.
   - Twitch Stories push-notify with tunable frequency.
   - Telegram notifies only for close-friends stories.

   → **No push per story.** The only pushes are ones a person asked for: a reply
   (an ordinary DM push), and in phase 2 an RSVP they tapped ("Tô dentro").

Smaller ones adopted:
- **Strip order:** unseen before seen, then closeness. Instagram ranks on
  closeness; unseen-first is an inference.
- **Viewer list for the author only**, as Telegram and Instagram do.
- **Report straight from the viewer, and hold the evidence.** Fleets' moderation
  critique was that evidence disappears.
- **Nobody pays to post.** Telegram opened posting to everyone within weeks.
- **Stay out of the chat flow.** Discord removed its Activity Feed in 2020 for
  "adding bulk".

---

## 2. Decisions (one line each)

| # | Decision | Why |
|---|---|---|
| 1 | Scope is **per server and friends**, not per channel | Stories are about people, not topics. Per channel splits an already tiny poster base and drags in channel overwrites |
| 2 | One story can target several audiences (servers you are in + Amigos) | Posting once and choosing where is what makes posting cheap. Rows in `story_audiences`, one viewer list |
| 3 | Composer pre-ticks the context you opened it from | Zero decisions in the common case |
| 4 | `POST_STORIES` permission bit, server level, on for @everyone by default | Baú is staff-only; stories are everyone's. Staff of a big community can still restrict it per role |
| 5 | Viewing a server story = being a member of the server (a timeout blocks posting, not viewing) | Matches Baú's "member" rule. No per-channel visibility to compute |
| 6 | Friends audience is evaluated at read time | Unfriending removes access instantly, with no fan-out to undo |
| 7 | Blocking hides stories **both ways** | Somebody you blocked must not watch your stories. This is stricter than Baú comments (one-way), on purpose |
| 8 | Kinds: photo, video ≤ 30 s, text card, call sticker | Covers clips, setups, rank-ups, memes and "bora". Polls, questions and RSVP are phase 2 |
| 9 | Video ≤ 30 s, ≤ 25 MiB, MP4 (H.264/AAC), 720p on phones | Clips from Medal or the phone gallery fit. One codec every client plays. 30 s keeps cost and scan time bounded |
| 10 | Images re-encoded on the client (≤ 1440 px long side, EXIF stripped) | Location data never leaves the phone. Bytes never pass the API, so the client is the only place to strip it |
| 11 | Text card is data, not an image (`text`, `background` key) | Zero storage, crisp on every screen, translatable later |
| 12 | 24 h from publish, fixed. No 6/12/48 h choices | One rule people can repeat. Telegram's choices are a power-user feature |
| 13 | No highlights or archive. The bridge to permanence is **Salvar no Baú** | Baú is the archive. A second archive would cannibalize it |
| 14 | Salvar no Baú: the author saves their own story if they hold `MANAGE_SERVER`; phase 2 lets staff *ask* the author | The story promised to disappear. Nobody else may make it permanent without the author saying yes |
| 15 | Viewer list visible to the author only, with each viewer's reaction | Feedback keeps posters posting. Showing it to others is a privacy cost with no upside |
| 16 | No "stealth mode", no hidden views | Honest symmetry: if you watch, the author sees it |
| 17 | Reactions: GG, 🔥, 😂, 😮, 💀, 👏. One per viewer per story, changeable | GG is the house reaction for a gaming crowd. One per viewer keeps the count honest |
| 18 | Text reply → a message in the 1:1 conversation, quoting the story | Starts conversations, which is what Fleets lacked. It rides the Conversas redesign |
| 19 | The quote shows thumbnail and caption **only while the story lives**. After that, a hatched "Story expirou" plate | Keeps the 24 h promise inside DMs too |
| 20 | Replies respect `dm_privacy` and blocks; the author can turn replies off per story | No new way to reach someone who closed their DMs |
| 21 | Zero push per story; the ring is the notification | BeReal fatigue, Fleets noise. A DM reply pushes because it is a DM |
| 22 | The strip appears only when at least one story is live. The empty state is a one-off dashed row (7 days after the server flag flips, or until the person posts or dismisses) | An empty "+" bubble would cost 90 pt of every server screen forever |
| 23 | Compose entry points: "Teu story" bubble, the server name menu, the chat "+" menu, the Conversas header | Always one tap away without a permanent slot |
| 24 | Ring: `conic-gradient(accent, warning, accent)`. Seen: `border-strong`, thinner | Both are real tokens. Solid lime already means "speaking" and "in call" |
| 25 | A call story shows a headphones badge on the ring | You can tell it is joinable before opening it |
| 26 | The call sticker is live: it reads the room roster and turns into "A call acabou" when the room empties or the author leaves it | A stale "join" button is worse than none |
| 27 | Moderation reuses chat. Reports go to the server queue; "minor in sexual content" goes to the instance queue. Staff with `MANAGE_MESSAGES` can remove a story **from their server only** | A story can also be in friends and other servers. One server's staff only owns their slice |
| 28 | A reported story does not expire until resolved; its bytes are held | Evidence must not evaporate under the moderator (the Fleets critique) |
| 29 | The author is told once, in-app, with the reason, when staff remove their story | No silent disappearance, and no push |
| 30 | Runtime flag `stories`, `perServer: true`. The friends audience follows the global value | Roll out on QG with no exposure of the friend graph, then widen |
| 31 | No AI residents or bots post stories | Stories are what *people* are up to. Character accounts stay in chat |
| 32 | Web viewer is a modal over the app, not a route change | Closing returns exactly where you were. A deep link `/app/stories/:id` exists only for the DM quote |

---

## 3. Surfaces

### 3.1 The strip (mocks A1, A2, E1)
- **Phone, server screen (Lista viva):** below the banner, above the watch
  party card and the Baú preview.
  - 64 pt rings, first name under each.
  - Horizontal scroll; the first ring is "Teu story" with a lime plus.
  - Scrolls away with the list. It never sticks.
- **Phone, Conversas tab:** under the title, above search, friends audience only.
  It collapses into the header after 40 pt of list scroll (Telegram pattern).
- **Web sidebar (248 px):** a "STORIES" eyebrow with "Ver todos", then 48 px rings
  (Tu + 3 fit). It sits above the Baú row in `channel-list.tsx`. The compact
  rail mode shows nothing.
- **Web Conversas list:** the same strip at the top of `dm-list.tsx`.
- **Order:**
  1. Teu story.
  2. Authors with an unseen story, by closeness:
     1. shared voice minutes in the last 14 days (this signal is phase 2),
     2. then friends,
     3. then DM recency,
     4. then most recent story.
  3. Fully seen authors, by most recent story.
- The order is computed on the server, once per strip fetch. The client never
  reorders while a finger or pointer is on the strip.
- **Cap:** 30 authors per strip. "Ver todos" in the viewer walks the rest.

### 3.2 The viewer (B1 to B3, E2)
- **Tap** right/left = next/previous story. **Hold** = pause (the chrome hides
  after 250 ms). **Swipe horizontally** = next/previous person. **Swipe down** =
  close. **Swipe up** on your own story = viewers.
- **Header:** avatar, name, age ("2 h"), and the audience you are seeing it
  through ("QG do pqp", "Amigos").
- **Video:** muted until first tap, as on Instagram. Captions come later
  (Baú captions use the same ffmpeg seam).
- **Footer:**
  - "Responder pra X…" (hidden when replies are off or blocked by DM privacy;
    the line then reads "X só recebe mensagem de amigos").
  - GG quick reaction and send.
  - Focusing the box pauses the story and raises the reaction row.
- **Web:** a 366×650 card centred; neighbours left and right at 55% opacity;
  arrows; keyboard ← → (story), Shift+← → (person), space, R, Esc.
- **Preload:** the next story's media and the next author's first story.
- **Mark as seen:** after 1 s on screen, batched (`POST /api/stories/views`).

### 3.3 The composer (C1 to C4, E3)
- **Phone:**
  - Opens on the camera: tap for a photo, hold for video (stops at 30 s).
  - The gallery opens on recent videos (where clips live).
  - Modes: TEXTO / CÂMERA / CALL.
  - Tools: Aa (caption, 200 chars) and Figurinhas:
    - Chama pra call
    - Hoje às… (phase 2)
    - Jogando agora (phase 2, from game connections)
    - Canal (a `#channel` chip that opens it)
    - Enquete and Pergunta (phase 2)
- **Web:** a modal with tabs Foto ou vídeo / Texto / Call.
  - Drop a file, paste a screenshot with Ctrl+V, or type.
  - Over-limit video is refused **before** upload, with the reason
    (`video.duration` read from a hidden element).
- **Audience sheet "Quem vê":**
  - Checkboxes for each server where you hold `POST_STORIES` and stories are on,
    plus Amigos.
  - Servers where you lack the bit show greyed with the reason.
  - "Deixar responderem" switch.
  - Footer: "Some em 24 h. A staff de cada servidor pode tirar."
- **Posting** shows an upload arc around "Teu story" (real PUT progress). On
  failure the ring turns red with "Tentar de novo".

### 3.4 Empty states
| Where | What |
|---|---|
| Server, nobody posted, first 7 days of the flag | Dashed row (A3): "Ninguém postou ainda" + Postar. Dismissible; dismissal stored in `lib/hints.ts` (per account, per server) |
| Server, nobody posted, after that | Nothing |
| Conversas, no friend has a story | Only the "Teu story" bubble when the person has friends; nothing when they have none |
| Viewer reaches the end | Closes back to the ring that opened it |
| Own story, 0 views | "Ninguém viu ainda" in the sheet |

### 3.5 Story and Baú (mock F)
- **Stories:** everyone, raw, 24 h, private replies, no pings.
- **Baú:** staff, curated, permanent, public likes and comments, optional push.
- **The only bridge is "Salvar no Baú":**
  - It runs from story to Baú, never the reverse.
  - It creates a Baú **draft** (the staff still edit and publish it) with the
    media copied server-side.
  - The copy goes through a new `copyObject` in `lib/s3.ts`. CopyObject is a
    signed request, so no bytes pass through the API.
  - Then `deleteObject` on the story key is no longer the end of those bytes,
    which is the point.

---

## 4. Motion

Uses the repo's tokens (`client/src/index.css`, `docs/DESIGN.md` §Motion):
- `--duration-fast` 150 ms, `--duration-base` 200 ms, `--duration-slow` 300 ms
- `--ease-standard` `cubic-bezier(0.2,0,0,1)`
- `--ease-emphasized` `cubic-bezier(0.16,1,0.3,1)`

Anything longer than 300 ms gets its own keyframes and joins the
`prefers-reduced-motion: reduce` block. The rule for the whole feature: **fast
where the person waits for an answer, linear where it is a clock, a spring
where the finger leads.** Demos with frozen frames: `mocks.html` §M.

| Motion | Normal | Reduced motion | Platform seam |
|---|---|---|---|
| **Ring appears** (new story arrives, strip loads) | Ring `scale .6→1` + fade, 300 ms emphasized. The gradient makes one sweep (rotate −200°→0, 900 ms emphasized). Neighbours shift with FLIP, 300 ms standard | 150 ms opacity, no sweep, no shift animation | web: `story-ring-in` keyframes in `index.css`; iOS `.transition(.scale(0.6).combined(with: .opacity))`; Compose `AnimatedVisibility(scaleIn(0.6f) + fadeIn())` |
| **Ring turns seen** | Crossfade of two layers (gradient → `border-strong`), ring 2.5→1.5 px, label to tertiary, 300 ms standard, starting **120 ms after the viewer has closed** so the change is seen | Same (colour only; opacity is not motion) | Never animate the `conic-gradient` itself; stack two layers and fade the top one |
| **Open from ring** | Shared element: the ring's circle grows into the card (position, size and radius together), 360 ms emphasized. Backdrop 0→100% in 200 ms. Media starts on the last frame | 200 ms fade of the viewer, no zoom | web: FLIP from the ring's `getBoundingClientRect`, `transform` + `border-radius` only; iOS 18 `.navigationTransition(.zoom(sourceID:in:))` + `.matchedTransitionSource`, iOS 17 `matchedGeometryEffect`; Compose `SharedTransitionLayout` + `Modifier.sharedBounds` |
| **Close** | Back into the ring, 280 ms `cubic-bezier(0.3,0,1,1)`. If the ring scrolled away, `scale .96` + fade, 200 ms | 150 ms fade | Same pair as open |
| **Drag to dismiss** | Card follows the finger, scales down to 0.85, radius up to 20; release past 120 pt or 800 pt/s closes into the ring, else springs back | Follows the finger without scaling; release fades | iOS `DragGesture`; Compose `draggable` + `Animatable`; web pointer events |
| **Progress bars** | `transform: scaleX` **linear**. Photo 5 s, text 5 s + 50 ms per character (cap 10 s), call sticker 8 s, video = the video's own `currentTime` | Same: a progress indicator is information, not decoration | One rAF loop on web; never animate `width` |
| **Tap-through** | Current bar completes in 150 ms standard; content cuts with a 100 ms crossfade. No slide | Hard cut | The next story is decoded before the tap |
| **Hold to pause** | After 250 ms, bars, header and footer fade out in 200 ms; they return in 150 ms on release | Chrome stays visible, story pauses | Light haptic on pause (phones) |
| **Person to person** | A "deck", not Instagram's cube. The next card slides over 1:1 with the finger; the current one recedes to `translateX(-28%) scale(.9)` and dims to 45%. Release past 35% or 600 pt/s completes with a spring: iOS `response 0.32, dampingFraction 0.86`; Compose `spring(dampingRatio = 0.86f, stiffness = 600f)`; web 320 ms emphasized. Auto-advance at the end of a person plays the same motion | 200 ms crossfade; the gesture still works | iOS: custom `DragGesture` + offset (paged `TabView` cannot do depth); Compose `HorizontalPager` + `graphicsLayer` per page |
| **Reply focus** | Story pauses; backdrop to 40% in 200 ms; the reaction row rises 12 pt + fades in (200 ms emphasized); emojis pop `scale .6→1` with a 30 ms stagger | Row fades, no stagger | Keyboard motion is the system's |
| **Reaction sent** | The emoji flies 150 pt up, grows to 1.8×, fades out in 600 ms emphasized; light haptic. The tapped chip keeps a lime outline | No flight; a "Reagiu 🔥" pill fades in for 1.2 s | `UIImpactFeedbackGenerator(style: .light)`; `HapticFeedbackType.TextHandleMove` |
| **Reply sent** | Input turns into "Mandado ✓" for 1.2 s, then the story resumes | Same, without the morph | |
| **Viewers sheet** | Follows the finger; the story shrinks to `scale .62` and moves up with 14 px corners; snaps in 300 ms emphasized (a spring on phones). Dragging the sheet down resumes the story where it paused | Sheet fades in 150 ms; the story does not shrink | iOS `.presentationDetents([.medium, .large])`; Compose `ModalBottomSheet`; web a panel inside the card |
| **Posting** | The composed card shrinks into the "Teu story" ring (400 ms emphasized). The ring becomes an upload arc driven by real PUT progress, then sweeps once into the gradient | "Postado" toast, fade | Arc = bytes sent / bytes total, never a timer |
| **Call sticker roster change** | A new face pops with the existing `badge-pop` (320 ms emphasized) | Appears | Reuses `index.css` `badge-pop` |

Performance rules:
- Animate only `transform` and `opacity`. The radius change during the zoom is
  applied to a clipping wrapper that scales, not by animating `border-radius`
  every frame on a large layer.
- The strip uses `content-visibility: auto` off-screen.
- Video decoding never starts during the open animation. The poster frame is
  shown until the zoom ends.

---

## 5. Data model (`server/src/schema.sql`, appended; idempotent DDL)

There is no migrations folder: schema is one file re-applied on boot, and data
changes register in `data_migrations`.

```sql
CREATE TABLE IF NOT EXISTS stories (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  author_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('image', 'video', 'text')),
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'processing', 'live', 'expired', 'deleted')),
  caption TEXT CHECK (char_length(caption) <= 200),
  text_body TEXT CHECK (char_length(text_body) <= 280),
  background TEXT,                       -- palette key, text kind only
  sticker JSONB,                         -- {type:'call', channelId} | phase 2 types
  replies_enabled BOOLEAN NOT NULL DEFAULT TRUE,
  media_storage_key TEXT UNIQUE,         -- stories/<authorId>/<storyId>/<uuid>.<ext>
  media_content_type TEXT,
  media_byte_size INTEGER,
  media_width INTEGER, media_height INTEGER, media_duration_ms INTEGER,
  poster_storage_key TEXT UNIQUE,        -- video: frame at 0.5 s, jpg
  scan_status TEXT NOT NULL DEFAULT 'unscanned'
    CHECK (scan_status IN ('unscanned', 'pass', 'flagged', 'rejected', 'error', 'skipped')),
  scan_provider TEXT, scan_score REAL, scan_labels JSONB, scanned_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  published_at TIMESTAMPTZ,
  expires_at TIMESTAMPTZ,                -- published_at + interval '24 hours'
  hold_until TIMESTAMPTZ,                -- report / flag hold; NULL = none
  hold_forever BOOLEAN NOT NULL DEFAULT FALSE,   -- illegal / csam_suspected
  media_deleted_at TIMESTAMPTZ,
  CHECK ((kind = 'text') = (media_storage_key IS NULL)),
  CHECK (status <> 'live' OR expires_at IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS idx_stories_author_live
  ON stories (author_id, expires_at DESC) WHERE status = 'live';
CREATE INDEX IF NOT EXISTS idx_stories_expiry
  ON stories (expires_at) WHERE status = 'live';
CREATE INDEX IF NOT EXISTS idx_stories_pending
  ON stories (created_at) WHERE status IN ('pending', 'processing');
CREATE INDEX IF NOT EXISTS idx_stories_media_sweep
  ON stories (expires_at) WHERE media_deleted_at IS NULL AND media_storage_key IS NOT NULL;

-- Where a story is visible. server_id NULL = the author's friends.
CREATE TABLE IF NOT EXISTS story_audiences (
  story_id UUID NOT NULL REFERENCES stories(id) ON DELETE CASCADE,
  server_id UUID REFERENCES servers(id) ON DELETE CASCADE,
  expires_at TIMESTAMPTZ NOT NULL,       -- denormalised from stories for the strip index
  removed_at TIMESTAMPTZ, removed_by UUID REFERENCES users(id) ON DELETE SET NULL,
  removed_reason TEXT CHECK (char_length(removed_reason) <= 200)
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_story_audience_server
  ON story_audiences (story_id, server_id) WHERE server_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_story_audience_friends
  ON story_audiences (story_id) WHERE server_id IS NULL;
CREATE INDEX IF NOT EXISTS idx_story_audience_strip
  ON story_audiences (server_id, expires_at DESC) WHERE removed_at IS NULL;

CREATE TABLE IF NOT EXISTS story_views (
  story_id UUID NOT NULL REFERENCES stories(id) ON DELETE CASCADE,
  viewer_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  viewed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  reaction TEXT CHECK (reaction IN ('gg', 'fire', 'joy', 'wow', 'skull', 'clap')),
  reacted_at TIMESTAMPTZ,
  replied_at TIMESTAMPTZ,
  PRIMARY KEY (story_id, viewer_id)
);
CREATE INDEX IF NOT EXISTS idx_story_views_viewer ON story_views (viewer_id, viewed_at DESC);

CREATE TABLE IF NOT EXISTS story_mutes (       -- "Silenciar stories do Caio"
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  muted_user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, muted_user_id)
);

-- A DM reply quotes the story. SET NULL when the row is finally deleted.
ALTER TABLE messages ADD COLUMN IF NOT EXISTS story_id UUID
  REFERENCES stories(id) ON DELETE SET NULL;

-- Reports: add 'story' to the subject CHECK (same swap as 'server', schema.sql ~2468)
-- and a reported_story_id column, with a content_snapshot of caption/text only.
```

**Strip query (server):** one statement.
1. Start from `story_audiences` for the server, with `expires_at > now()` and
   `removed_at IS NULL`, joined to live `stories`.
2. Exclude blocks in both directions (`services/blocks.ts`), the viewer's
   `story_mutes`, and authors no longer in the server.
3. Group by author with `bool_and(EXISTS view)` for "seen" and
   `max(published_at)` for recency.
4. Order as in §3.1 and cap at 30.

The friends query is the same over `areFriendsSql`. Index-only on
`idx_story_audience_strip` plus the `story_views` PK.

**Lifecycle and deletion:**
1. **Create:** the row is `pending` with a presigned PUT; text goes straight to
   `live`.
2. **Publish:** the claim `HEAD`s the object (size and type signed into the
   PUT, as attachments do).
   - Image: scan with `scanImage` and the `scanAllowsAttachment` policy (fail
     closed) *before* `live`, so the visibility window is zero.
   - Video: `processing`. A worker job reuses the ffmpeg seam of
     `community-home-captions.ts` (`downloadObjectToFile`):
     1. `ffprobe` checks ≤ 31 s and H.264,
     2. extract the poster plus frames at 25/50/75%,
     3. upload the poster, scan the three frames as images,
     4. go `live`.

     With a scanner configured and no ffmpeg on the worker, video is off
     (`videoEnabled: false` in config) rather than unscanned.
3. **Expire:** a sweep every 60 s in `server/src/jobs.ts`
   (`every(STORY_SWEEP_INTERVAL_MS, "stories", sweepStories)`, cold path, so it
   moves to the worker under `WORKER_MODE`).
   1. Set `status = 'expired'` where `expires_at < now()`.
   2. For expired rows with no hold, `deleteObject` media and poster, then stamp
      `media_deleted_at`.

   Reads filter on `expires_at` too, so a late sweep never shows an expired
   story.
4. **Holds:**
   - The sweep skips any story with an open report (a join on `reports`), so a
     reported story outlives its 24 h. On resolution, `hold_until = resolved_at
     + 30 days`.
   - A flagged scan stamps `hold_until = now() + CONTENT_SCAN_QUARANTINE_DAYS`.
   - `illegal` / `csam_suspected` sets `hold_forever`, never auto-deleted, and
     logs `[content-safety] ILLEGAL-CONTENT MATCH` as attachments do.
5. **Row deletion:** expired rows with media gone and no hold are deleted after
   **7 days**. That is long enough for the daily metrics rollup and for "who
   viewed" support questions. Views cascade. `messages.story_id` goes NULL; the
   quote already renders the hatched plate after expiry.
6. **Author deletes:** `status = 'deleted'`, media deleted immediately unless held.
7. **Orphans:** `pending` older than 1 h is deleted, with its object.

**Storage keys:**
- `stories/<authorId>/<storyId>/<uuid>.<jpg|webp|mp4>`
- `stories/<authorId>/<storyId>/poster.jpg`
- An `isStoryKey` guard sits beside `isCommunityHomeKey`, so a key from one
  feature can never be claimed by another.

**Read URLs:** presigned GET with TTL `min(1 h, expires_at − now())`, as
downloads are not needed (`inline`).

---

## 6. API and WS contract

New shared module **`packages/shared/src/stories.ts`**, exported from
`packages/shared/src/index.ts`. Zod schemas (names final):

```ts
export const STORY_TTL_HOURS = 24;
export const STORY_MAX_VIDEO_MS = 30_000;
export const STORY_MAX_BYTES = 25 * 1024 * 1024;
export const STORY_IMAGE_TYPES = ["image/jpeg", "image/webp", "image/png"] as const;
export const STORY_VIDEO_TYPES = ["video/mp4"] as const;
export const STORY_REACTIONS = ["gg", "fire", "joy", "wow", "skull", "clap"] as const;
export const STORY_BACKGROUNDS = ["lime", "night", "ember", "grape", "sand", "ink"] as const;

storiesConfigSchema        // { enabled, friendsEnabled, mediaEnabled, videoEnabled, maxVideoMs, maxBytes }
storyAuthorSchema          // { id, displayName, avatarUrl, handle? }
storyStickerSchema         // discriminated: { type:"call", channelId, serverId } (phase 2: time, poll, question, game)
storyCallLiveSchema        // { channelName, participants: [{id, avatarUrl, displayName}], count, joinable }
storySchema                // { id, author, kind, caption, text, background, media?: {url, posterUrl?, contentType,
                           //   width, height, durationMs?}, sticker?, call?: storyCallLiveSchema, publishedAt,
                           //   expiresAt, audiences: [{kind:"server", serverId, serverName} | {kind:"friends"}],
                           //   viewer: { seen, reaction|null, canReply, canModerate: string[] /* serverIds */ },
                           //   own?: { viewCount, reactionCount, repliesEnabled } }
storyStripItemSchema       // { author, storyIds: string[], latestAt, unseen: boolean, hasCall: boolean }
storyStripSchema           // { enabled, canPost, items: StoryStripItem[], firstRunHint: boolean }
createStorySchema          // { kind, caption?, text?, background?, sticker?, repliesEnabled,
                           //   audiences: { serverIds: string[] (max 10), friends: boolean },
                           //   media?: { contentType, byteSize, width, height, durationMs? } }
createStoryResponseSchema  // { story, upload?: { url, headers } }
storyViewsBatchSchema      // { storyIds: string[] (max 50) }
storyReactionSchema        // { reaction: StoryReaction | null }
storyReplySchema           // { text: string (1..2000) }
storyViewerRowSchema       // { user, viewedAt, reaction|null, replied: boolean }
storyModRemoveSchema       // { reason?: string (<=200) }
storyCardSchema            // { state: "live"|"expired"|"removed", kind?, posterUrl?, caption?, authorId }
storiesUpdateSchema        // WS: { type:"stories-update", scope:"server", serverId } | { type, scope:"friends" }
                           //   + optional removedStoryIds: string[]
```

**HTTP** (all behind auth; all 404 when the flag is off for that server, or
globally for friends routes; inline in `server/src/api/index.ts` next to the
`/home/*` block):

| Route | Who | Notes |
|---|---|---|
| `GET /api/stories/config` | any | always 200; `enabled` is the global value, `friendsEnabled` likewise |
| `GET /api/servers/:serverId/stories` | member | strip; 200 `{enabled:false}` when the server's flag is off, so clients hide without a 404 storm |
| `GET /api/stories/friends` | any | friends strip |
| `GET /api/stories?ids=a,b,c` | can see each | ≤ 20 ids; returns what the viewer may see, silently drops the rest |
| `POST /api/stories` | `POST_STORIES` in every target server; friends needs nothing | returns presigned PUT for media; limiter: 3 per minute, 20 per rolling 24 h per author |
| `POST /api/stories/:id/publish` | author | HEAD + scan (image), or enqueue processing (video); returns the story |
| `DELETE /api/stories/:id` | author | |
| `POST /api/stories/views` | viewer | batch, idempotent (`ON CONFLICT DO NOTHING`); never counts the author |
| `PUT /api/stories/:id/reaction` | viewer | upsert or clear |
| `POST /api/stories/:id/reply` | viewer, `canReply` | `openConversation(viewer, [author])`, then the ordinary DM send path with `story_id` set (DM limits, blocks, `isDmSendBlocked`, push); returns `{conversationId, messageId}` |
| `GET /api/stories/:id/viewers?cursor=` | author | 50 per page, newest first |
| `GET /api/stories/:id/card` | DM participant of a message quoting it | for the quote; never leaks media after expiry |
| `DELETE /api/servers/:serverId/stories/:id` | `MANAGE_MESSAGES` in that server | sets `removed_*` on that audience row, writes `audit_log` (`story.remove`), tells the author once |
| `PUT/DELETE /api/stories/mutes/:userId` | any | |
| `POST /api/stories/:id/save-to-bau` | author with `MANAGE_SERVER` in `serverId` | body `{serverId}`; creates a Baú draft via `copyObject` |
| `POST /api/reports` | viewer | `subjectType: "story"`, `storyId`, `serverId?` context; category `minor_sexual` routes to the instance queue |

**WS** (`packages/shared/src/chat.ts`, add `storiesUpdateSchema` to
`chatServerMessageSchema`; send in `server/src/ws/chat.ts` beside
`notifyCommunityHomeUpdate`):
- **Server audience:** `notifyStoriesUpdate({scope:"server", serverId})` to
  `listServerMemberIds`. It is **content-free**, coalesced to one frame per
  server per 5 s, and crosses instances on the cluster bus (topic
  `stories.update`).
- **Friends audience:** one frame per friend's sockets
  (`forEachSocketOfUser`), same coalescing.
- **Sent on:** publish going live, author delete, moderator removal. **Not** on
  view, reaction or expiry: clients drop expired rings locally from `expiresAt`.
- **The author's own sockets** get the same frame after a new view batch
  (throttled to one per 10 s), so the open viewers sheet refreshes.
- **Old clients:** they ignore the unknown frame type. The union is
  discriminated, so add it to every client's decoder in the same release.

---

## 7. Permission bit

`packages/shared/src/permissions.ts`:
- `POST_STORIES: 1n << 25n` (33554432).
- `PERMISSION_ALL = (1n << 26n) - 1n`.
- Add it to `PERMISSION_DEFAULT_EVERYONE`, and `{ bit, key: "POST_STORIES" }` to
  `PERMISSION_FLAGS`.

Server level only: hide it in `channel-permissions-section.tsx`, since an
overwrite would mean nothing.

Backfill, copying the `manage_music_bit_2026_09` block (schema.sql ~4353):
- A one-shot `DO $$` named `post_stories_bit_2026_10` ORs the bit onto every
  server's @everyone role and bumps `servers.permissions_version`.
- Listed communities (`is_community_listed`) get it too.
- Posting there additionally requires an account at least 72 h old (server
  check, not a bit) and no active timeout.

Labels:
- `roles.perm.POST_STORIES` "Postar stories"
- `roles.permHint.POST_STORIES` "Fotos, vídeos e textos que somem em 24 h."
- Mirror in `ios/pqp/Sources/Core/PermissionBits.swift` and
  `android/.../core/Permissions.kt`.

---

## 8. Runtime flag

One entry in `FEATURE_FLAGS` (`server/src/lib/flags.ts`), modelled on
`bau_post_push`:

```ts
stories: {
  description: "Stories: fotos, vídeos e textos que somem em 24 h, por servidor e pros amigos.",
  env: "STORIES",
  parseEnv: exactTrue,
  codeDefault: false,
  perServer: true,           // server routes pass serverId; friends routes read the global value
  clientVia: "GET /api/stories/config + GET /api/servers/:id/stories",
},
```

- Add a line to `flags.test.ts`, plus an entry in `flag-client-contract.test.ts`.
- Turn it on for QG with `PUT /api/admin/flag-overrides { key: "stories", serverId, enabled: true }`.
- **Friends stories need the global row on.** That is deliberate: the friends
  audience crosses servers, so it waits until the per-server test is judged.
- **Flag off** = every story route 404s (strip: `{enabled:false}`), the strip
  hides, and nothing is deleted. The expiry sweep **keeps running** so bytes
  never outlive the promise.
- **Tests run with the flag on and off** (pitfall 12).

---

## 9. Moderation and safety

**Scanning**
- Images use the attachments path (`scanImage` + `scanAllowsAttachment`) at
  publish, before `live`. Do not copy Baú: Baú media is never image-scanned.
- Video uses three sampled frames plus the poster. That is better than chat
  and Baú video today ("Video ... not scanned at all", `CONTENT_SAFETY.md`
  residual risk 4); add a line there.
- A text card goes through AutoMod text rules for each target server, using
  the same matcher as messages.

**Hit handling**
- **Rejected:** never visible. Report filed with `reporter_id NULL`,
  deduplicated per uploader per server.
- **Flagged:** visible, reported, held.
- **Illegal:** held forever, logged with the existing runbook line.

**Reports**
- New `subject_type 'story'` with `reported_story_id`.
- Routing:
  - Server context goes to that server's queue.
  - Friends context goes to the instance queue (no server owns it, exactly
    like a conversation).
  - `minor_sexual` always goes to the instance queue.
- `GET /api/reports/all` gains the story columns, so the operator sees scan
  evidence the same way.

**Moderator actions**
- **Tirar do servidor:** `MANAGE_MESSAGES`, this server's slice only, audited.
- **Castigo:** the existing timeout, which also blocks story posting.
- **Tirar permissão de story:** links to the role editor.
- **Operator:** `POST /api/reports/:id/remove-story` deletes the story
  everywhere and logs `[moderation] operator removed story`, mirroring
  `remove-message`.

**Author notice:** a one-time in-app card (D3) with the reason. Stored as a
`story_notices` row or a preference flag; no push.

**Legal note:** stories inside private servers and to friends stay "private
messaging". Stories in **listed communities** are content in a public directory,
which already moves the instance's category (`CONTENT_SAFETY.md` §Communities);
they inherit that regime, not a new one.

**Abuse limits**
- 20 stories per rolling 24 h per author.
- 72 h account age for communities.
- Replies ride DM limits.
- Views are batched and rate limited like reads.

**Screenshots:** not blocked, and not detected. Say so in the help text rather
than imply privacy we cannot enforce.

---

## 10. Notifications

| Event | Push | In-app |
|---|---|---|
| Someone posts | **No** | Ring appears (WS nudge) |
| Someone views / reacts to your story | No | Count in the viewers sheet |
| Text reply | Yes, as an ordinary DM push (respects mute, DND, `dmDetails`) | DM toast + unread |
| Staff remove your story | No | One-time card |
| Phase 2: "Tô dentro" RSVP to "Hoje às 22h" | Yes, once, at the time, **only** to people who tapped it | Sticker counts |

---

## 11. Metrics (how to judge it)

New `stories` block in `getAdminMetrics` (`server/src/services/metrics.ts`): a
cached SQL part plus a live `storiesMetrics()` counter object. It is shown on
the operator dashboard; remember the 3 manual Grafana steps for new counters.

| Metric | Meaning | Target after 4 weeks on QG |
|---|---|---|
| `posters24h`, `posters7d` (distinct) | Is posting spreading? | ≥ 5% of weekly actives post weekly |
| `posterConcentration` (share of stories by top 10 posters) | The Fleets failure mode | < 60% |
| `stories24h` by kind and audience | What people post | Call stickers ≥ 10% of stories |
| `viewersPerStory` p50 / p90 | Is watching worth it? | p50 ≥ 10% of the server's daily actives |
| `openers24h` / daily actives | Does the strip pull people in? | ≥ 25% |
| `reactions24h`, `replies24h` | Engagement | |
| `replyConversations` (replies that got ≥ 1 answer within 24 h) | Did it start conversations? | ≥ 30% of replies |
| `callStickerJoins` (voice joins with `source=story`) | The pqp-specific win | Any steady non-zero is a win |
| `posterRepeat7d` (D1 posters who post again within 7 d) | Habit | ≥ 40% |
| Moderation: reports, removals, scan rejects, held count, held bytes | Safety load | Removals < 1% of stories |
| Storage: live bytes, sweep lag (oldest expired-but-not-deleted), delete failures | Promise kept | Sweep lag < 5 min |

**Kill or fold criteria:**
- After 6 weeks, `posterConcentration` stays above 80% and `replyConversations`
  is near zero. That is Fleets: fold the call sticker into chat and stop.
- Posting must also not lower Baú publishing in that server (watch Baú
  posts/week before and after).

---

## 12. Cost at current scale

Assumptions, stated because no production data was queried for this study:
- 2,000 daily actives.
- 8% post on a given day, 1.5 stories each: 240 stories a day.
- Mix: 60% photo (~400 KB after client re-encode), 25% video (~15 s average at
  ~2.5 Mbit/s, about 4.7 MB plus a 60 KB poster), 15% text (0 bytes).
- 40 views per story.

| Item | Daily | Monthly | Price (R2) | Cost |
|---|---|---|---|---|
| Bytes written | 144 × 0.4 MB + 60 × 4.8 MB ≈ 345 MB | ≈ 10 GB written, but only ~0.4 GB resident (24 h life + sweep lag) | $0.015 / GB-month stored | ≈ $0.01 |
| Class A ops (PUT, DELETE free, HEAD is B) | ~300 | ~9 k | $4.50 / M | ≈ $0.04 |
| Class B ops (GET, HEAD) | ~10 k | ~300 k | $0.36 / M | ≈ $0.11 |
| Egress | ~1.3 GB | ~40 GB | R2 egress is free | $0 |
| Scan | ~144 images + 60 × 4 frames ≈ 380 calls | ~11 k | `openai` moderation is free; SightEngine would be ~$0.001 each | $0 (or ~$11) |
| Worker ffmpeg | 60 short jobs | | existing worker CPU | ≈ $0 |
| Postgres | ~250 story rows + ~10 k view rows a day, deleted after 7 days | < 100 k rows resident | | ≈ $0 |

**Total: under US$1 a month**, about US$12 with a paid scanner. Even at 10×
(a viral month) it stays under US$5 plus scanning.

The real costs are **moderation time** and **the fan-out**. The fan-out is
content-free frames coalesced per server; for a 5,000-member community that is
at most one small frame per member per 5 s while people post, cheaper than a
single chat message's broadcast.

---

## 13. Build plan

Every server or `packages/shared` PR is **`restarts-api`**. None is
`drops-voice`.
- **Clients** ship behind the flag and work with it off: the strip endpoint
  answers `{enabled:false}` and nothing renders.
- **Mobile:** cut `ios-v*` and `android-v*` after the mobile PRs merge.
- **Tests:** two accounts with `pqp:dev-user-suffix`. Run every test with the
  flag on **and** off.

### PR 0: contract + schema + bit + flag (merge first, everything else depends on it)
- **`packages/shared/src/stories.ts`** (new): every schema and constant in §6,
  plus `stories.test.ts`. Covers caps, reaction enum, audience validation, and
  the sticker discriminant.
- **`packages/shared/src/index.ts`:** export it.
- **`packages/shared/src/chat.ts`:** `storiesUpdateSchema` in `chatServerMessageSchema`.
- **`packages/shared/src/permissions.ts`:** `POST_STORIES`, `PERMISSION_ALL`,
  default everyone, `PERMISSION_FLAGS`. Plus its test.
- **`packages/shared/src/reports.ts`:** `subjectType: "story"`, `storyId`, and the
  `minor_sexual` category if not present.
- **`packages/shared/src/audit.ts`:** `story.remove`.
- **`server/src/schema.sql`:**
  - the tables in §5
  - the `messages.story_id` column
  - the reports CHECK swap plus `reported_story_id`
  - the `post_stories_bit_2026_10` backfill
- **`server/src/lib/flags.ts`:** `stories`. Plus `flags.test.ts` and
  `flag-client-contract.test.ts`.
- **`docs/FEATURE_FLAGS.md`:** one paragraph.

### PR 1a: server, core (after PR 0)
- **`server/src/services/stories.ts`** (new):
  - `createStory`, `publishStory`, `listServerStrip`, `listFriendsStrip`,
    `getStoriesForViewer`
  - `recordViews`, `setReaction`, `replyToStory` (calls `openConversation`
    from `services/dms.ts:267`, then the DM send path with `story_id`)
  - `listViewers`, `deleteStory`, mutes
  - `canSeeStory`: member or friend; blocks both ways via `services/blocks.ts`;
    friends via `areFriendsSql` in `services/friends.ts`.
- **`server/src/lib/s3.ts`:** `isStoryKey`; reuse `presignPut`, `headObject`,
  `presignGet`, `deleteObject`.
- **`server/src/api/index.ts`:** routes in §6, beside the `/home/*` block.
- **`server/src/ws/chat.ts`:** `notifyStoriesUpdate` / `deliverStoriesUpdate`
  with bus topic and coalescing.
- **`server/src/services/metrics.ts`:** the `stories` block.
- **Tests** on a real Postgres:
  - visibility matrix: member, non-member, banned, blocked both ways, unfriended
  - expired never returned
  - views idempotent, own view not counted
  - reply goes through DM privacy and blocks
  - flag off → 404 / `{enabled:false}`

### PR 1b: server, media pipeline + sweeps (parallel with 1a after PR 0)
- **Image scan at publish:** `services/content-scan.ts` (`scanImage`,
  `scanAllowsAttachment`), with automated reports via `createAutomatedReport`.
- **Video job:** a new `server/src/services/story-media.ts` using
  `downloadObjectToFile` and the ffmpeg runner from `community-home-captions.ts`
  (ffprobe duration and codec, poster, three frames, scan).
- **`server/src/jobs.ts`:** `sweepStories` (expire, delete media, delete rows,
  orphans), as a cold job.
- **`docs/plans/COLD_PATHS.md`:** add the row.
- **Tests:**
  - fail closed on scan error
  - held rows are not deleted
  - `hold_forever` is never deleted
  - the sweep is idempotent across two instances

### PR 1c: server, moderation (after 1a)
- **`server/src/services/reports.ts`:** story subject, routing to server vs
  instance queue, `remove-story` operator route.
- **Mod removal route:** writes `logAudit` (`services/audit.ts`) and the author
  notice.
- **`GET /api/reports/all`:** story columns.
- **`docs/CONTENT_SAFETY.md`:** a "Stories" section (scan path, holds, residual
  risk).

### PR 2: web (after PR 0; develop against 1a locally)
- **`client/src/lib/stories/`:**
  - `config.ts` (follows `config-refresh.ts`)
  - `api.ts`
  - `use-story-strip.ts` (refetch on the WS frame and on focus)
  - `upload.ts` (canvas re-encode + EXIF strip, duration check, PUT with progress)
  - `ordering.ts`
  - `seen-store.ts`
- **`client/src/components/stories/`:**
  - `story-ring.tsx`, `story-strip.tsx`
  - `story-viewer.tsx` (modal, keyboard, preload, FLIP open/close, deck swipe)
  - `story-viewers-sheet.tsx`
  - `story-composer.tsx` (tabs, drop zone via `ui/file-drop-zone.tsx`, paste)
  - `story-audience-picker.tsx`
  - `story-call-sticker.tsx` (reads the voice roster the client already holds)
  - `story-quote-card.tsx` (DM)
  - `story-report-dialog.tsx` (reuses the report dialog)
- **`client/src/components/layout/channel-list.tsx`:** strip above the Baú row.
- **`client/src/components/layout/dm-list.tsx`:** friends strip at the top. This
  coordinates with the Conversas PRs (#1043 / #1045 / #1046 and the unpushed
  W1 list branch).
- **`client/src/App.tsx`:** the `stories-update` case beside
  `community-home-update` (~5069); entry points in the server menu and the chat
  "+" menu.
- **`client/src/components/layout/roles-settings-section.tsx`:** bit label,
  hint, group.
- **`client/src/index.css`:** `story-ring-in`, `story-ring-sweep`,
  `story-react-pop`, `story-react-fly` keyframes, added to the reduced-motion
  block.
- **`client/src/locales/{pt-BR,en,es}/translation.json`:** §14. The
  no-em-dash test already guards these.
- **Tests:**
  - unit tests for ordering, the seen store and upload validation
  - component tests for the strip (empty, first-run, seen ordering) and the
    viewer (keyboard, pause)
  - an e2e `stories.spec.ts` with two accounts: post → ring on bob → open → seen
    → reply lands in Conversas → expire by clock fake

### PR 3: iOS (after PR 0)
- **`ios/pqp/Sources/Core/StoriesAPI.swift`, `StoriesModels.swift`** (new;
  pattern of `CommunityHomeAPI.swift`).
- **`ios/pqp/Sources/Stories/`** (new):
  - `StoryStripView.swift`, `StoryRing.swift`
  - `StoryViewer.swift` (zoom transition, deck `DragGesture`, hold, haptics)
  - `StoryViewersSheet.swift`
  - `StoryComposer.swift` (AVFoundation camera, PhotosPicker, export 720p MP4
    ≤ 30 s, JPEG re-encode without metadata)
  - `StoryAudienceSheet.swift`
- **`ios/pqp/Sources/Chat/ChannelListView.swift`:** strip in the Lista viva
  layout.
- **`ios/pqp/Sources/Home/HomeView.swift`:** friends strip at the top of
  Conversas.
- **`ios/pqp/Sources/Core/RealtimeClient.swift`:** the `stories-update` case
  (~1221).
- **`ios/pqp/Sources/Core/PermissionBits.swift`:** the new bit.
- **`ios/pqp/Sources/Home/ReportSheet.swift`:** story subject.
- **DM message view:** the quote card.
- **`ios/pqp/Resources/Localizable.xcstrings`:** the strings.
- **Reduced motion:** `@Environment(\.accessibilityReduceMotion)`.

### PR 4: Android (after PR 0)
- **`android/app/src/main/kotlin/gg/pqp/app/stories/`** (new):
  - `StoriesApi.kt`, `StoriesModels.kt`, `StoriesViewModel.kt`
  - `ui/StoryStrip.kt`
  - `ui/StoryViewer.kt` (`SharedTransitionLayout`, `HorizontalPager` +
    `graphicsLayer`)
  - `ui/StoryViewersSheet.kt`
  - `ui/StoryComposer.kt` (CameraX, photo picker, Media3 Transformer to 720p
    H.264 ≤ 30 s, EXIF dropped on re-encode)
  - `ui/StoryAudienceSheet.kt`
- **`ui/screens/ChannelsScreen.kt`:** strip.
- **`social/ui/ConversationsScreen.kt`:** friends strip.
- **`core/RealtimeClient.kt`:** the frame.
- **`core/Permissions.kt`:** the bit.
- **`reports/`:** story subject.
- **`res/values/strings.xml`, `res/values-pt-rBR/strings.xml`:** there is no
  `values-es` today; add it or fall back to English.
- **Reduced motion:** read `Settings.Global.ANIMATOR_DURATION_SCALE == 0f`.

### PR 5: docs + dashboard (any time after 1a)
- **`docs/STORIES.md`** (the reference doc, from this file).
- **CLAUDE.md:** a pointer line.
- **`tools/admin-dashboard`:** the `stories` metrics block.

### Phase 2 (separate PRs, each behind its own per-server flag)
- "Hoje às…" sticker with RSVP and its single push (`stories_rsvp`).
- Enquete and Pergunta stickers (`story_poll_votes`, answers go to the
  author's DM).
- "Jogando agora" from game connections.
- Staff "Pedir pro Baú" request flow.
- Closeness ranking from shared voice minutes.
- Video captions (reuse `community_home_video_captions`).

**Parallelism:**
1. PR 0 (about a day).
2. Then 1a, 1b, 2, 3 and 4 at once.
3. 1c after 1a.
4. QA when 1a + 1b + 2 are in.
5. Turn the flag on for QG only once a mobile build with stories is in review,
   so phones are not the odd ones out for long.

---

## 14. Strings (pt-BR uses tu; no em dashes)

| Key | pt-BR | en | es |
|---|---|---|---|
| `stories.strip.label` | Stories | Stories | Historias |
| `stories.strip.yours` | Teu story | Your story | Tu historia |
| `stories.strip.seeAll` | Ver todos | See all | Ver todas |
| `stories.empty.title` | Ninguém postou ainda | Nobody has posted yet | Nadie publicó todavía |
| `stories.empty.body` | Mostra o que tá rolando: um clipe, teu setup, que horas tu entra. Some em 24 h. | Show what's up: a clip, your setup, when you're getting on. Gone in 24 h. | Muestra qué está pasando: un clip, tu setup, a qué hora entras. Desaparece en 24 h. |
| `stories.empty.cta` | Postar | Post | Publicar |
| `stories.viewer.replyTo` | Responder pra {name}… | Reply to {name}… | Responder a {name}… |
| `stories.viewer.repliesOff` | {name} desligou as respostas | {name} turned replies off | {name} desactivó las respuestas |
| `stories.viewer.dmClosed` | {name} só recebe mensagem de amigos | {name} only gets messages from friends | {name} solo recibe mensajes de amigos |
| `stories.viewer.sent` | Mandado | Sent | Enviado |
| `stories.viewer.reacted` | Reagiu {emoji} | Reacted {emoji} | Reaccionaste {emoji} |
| `stories.viewer.ago` | {time} | {time} | {time} |
| `stories.viewer.through` | {server} | {server} | {server} |
| `stories.viewer.friends` | Amigos | Friends | Amigos |
| `stories.viewers.title_one` | Visto por {count} | Seen by {count} | Visto por {count} |
| `stories.viewers.title_other` | Visto por {count} | Seen by {count} | Visto por {count} |
| `stories.viewers.meta` | {reactions} reações · some em {left} | {reactions} reactions · gone in {left} | {reactions} reacciones · desaparece en {left} |
| `stories.viewers.none` | Ninguém viu ainda | Nobody has seen it yet | Nadie la vio todavía |
| `stories.viewers.replied` | respondeu | replied | respondió |
| `stories.own.saveToBau` | Salvar no Baú | Save to Baú | Guardar en el Baú |
| `stories.own.download` | Baixar | Download | Descargar |
| `stories.own.delete` | Apagar | Delete | Borrar |
| `stories.own.deleteConfirm` | Apagar esse story? Some pra todo mundo agora. | Delete this story? It disappears for everyone now. | ¿Borrar esta historia? Desaparece para todos ahora. |
| `stories.call.live` | Na call agora | In the call now | En la llamada ahora |
| `stories.call.join` | Entrar na call | Join the call | Unirse a la llamada |
| `stories.call.ended` | A call acabou | The call ended | La llamada terminó |
| `stories.call.full` | A sala lotou | The room is full | La sala está llena |
| `stories.compose.title` | Novo story | New story | Nueva historia |
| `stories.compose.modeText` | Texto | Text | Texto |
| `stories.compose.modeCamera` | Câmera | Camera | Cámara |
| `stories.compose.modeCall` | Call | Call | Llamada |
| `stories.compose.hint` | Toca pra foto, segura pra vídeo (até 30 s) | Tap for a photo, hold for video (up to 30 s) | Toca para foto, mantén para video (hasta 30 s) |
| `stories.compose.drop` | Arrasta uma imagem ou um vídeo de até 30 s, ou cola com Ctrl+V | Drop an image or a video up to 30 s, or paste with Ctrl+V | Arrastra una imagen o un video de hasta 30 s, o pega con Ctrl+V |
| `stories.compose.tooLong` | Esse vídeo tem {seconds} s. O limite é 30 s. | This video is {seconds} s. The limit is 30 s. | Este video dura {seconds} s. El límite es 30 s. |
| `stories.compose.tooBig` | Arquivo grande demais. Até 25 MB. | File too big. Up to 25 MB. | Archivo demasiado grande. Hasta 25 MB. |
| `stories.compose.wrongType` | Esse formato não rola. Manda JPG, PNG, WebP ou MP4. | That format won't work. Use JPG, PNG, WebP or MP4. | Ese formato no sirve. Usa JPG, PNG, WebP o MP4. |
| `stories.compose.stickers` | Figurinhas | Stickers | Stickers |
| `stories.sticker.call` | Chama pra call | Call people in | Llama a la llamada |
| `stories.sticker.time` | Hoje às… | Tonight at… | Hoy a las… |
| `stories.sticker.game` | Jogando agora | Playing now | Jugando ahora |
| `stories.sticker.channel` | Canal | Channel | Canal |
| `stories.sticker.poll` | Enquete | Poll | Encuesta |
| `stories.sticker.question` | Pergunta | Question | Pregunta |
| `stories.sticker.later` | Depois | Later | Después |
| `stories.callPicker.title` | Chama pra call | Call people in | Llama a la llamada |
| `stories.callPicker.body` | Quem tocar entra direto. O card mostra quem tá lá dentro na hora. | Whoever taps joins right away. The card shows who's in there live. | Quien toque entra directo. La tarjeta muestra quién está adentro en el momento. |
| `stories.callPicker.now` | Agora | Now | Ahora |
| `stories.callPicker.later` | Mais tarde | Later | Más tarde |
| `stories.callPicker.add` | Pôr no story | Add to story | Poner en la historia |
| `stories.audience.title` | Quem vê | Who sees it | Quién la ve |
| `stories.audience.body` | Pode marcar mais de um. Começa marcado onde tu tava. | You can pick more than one. It starts with where you were. | Puedes marcar más de uno. Empieza marcado donde estabas. |
| `stories.audience.friends` | Amigos | Friends | Amigos |
| `stories.audience.members_other` | {count} membros | {count} members | {count} miembros |
| `stories.audience.noPermission` | A staff só libera story pra quem tem cargo | Staff only allow stories for some roles | El staff solo permite historias a algunos roles |
| `stories.audience.replies` | Deixar responderem | Allow replies | Permitir respuestas |
| `stories.audience.repliesHint` | Resposta chega nas tuas Conversas | Replies land in your Conversations | Las respuestas llegan a tus Conversaciones |
| `stories.audience.post` | Postar story | Post story | Publicar historia |
| `stories.audience.footer` | Some em 24 h. A staff de cada servidor pode tirar. | Gone in 24 h. Each server's staff can remove it. | Desaparece en 24 h. El staff de cada servidor puede quitarla. |
| `stories.upload.failed` | Não subiu. Tentar de novo | Didn't upload. Try again | No se subió. Intentar de nuevo |
| `stories.upload.posted` | Postado | Posted | Publicada |
| `stories.menu.mute` | Silenciar stories de {name} | Mute {name}'s stories | Silenciar historias de {name} |
| `stories.menu.muteHint` | Some da tua faixa. {name} não fica sabendo. | They leave your strip. {name} won't know. | Desaparecen de tu fila. {name} no se entera. |
| `stories.menu.report` | Denunciar story | Report story | Denunciar historia |
| `stories.menu.modSection` | Moderação do {server} | {server} moderation | Moderación de {server} |
| `stories.menu.modRemove` | Tirar do {server} | Remove from {server} | Quitar de {server} |
| `stories.menu.modRemoveHint` | Some daqui na hora. Fica no registro da staff. | Gone from here right away. Logged for staff. | Desaparece de aquí al instante. Queda en el registro del staff. |
| `stories.menu.timeout` | Castigo pra {name} | Time out {name} | Aislar a {name} |
| `stories.menu.revoke` | Tirar permissão de story | Remove story permission | Quitar permiso de historias |
| `stories.report.title` | Denunciar story | Report story | Denunciar historia |
| `stories.report.body` | Enquanto alguém olha, o story não some, mesmo depois de 24 h. Só a moderação vê. | While someone reviews it, the story won't disappear, even after 24 h. Only moderators see it. | Mientras alguien la revisa, la historia no desaparece, ni después de 24 h. Solo la moderación la ve. |
| `stories.report.minor` | Menor de idade em conteúdo sexual | A minor in sexual content | Un menor en contenido sexual |
| `stories.report.minorHint` | Vai direto pra equipe do pqp, não pra staff do servidor | Goes straight to the pqp team, not the server staff | Va directo al equipo de pqp, no al staff del servidor |
| `stories.report.ncii` | Imagem íntima sem consentimento | Intimate image without consent | Imagen íntima sin consentimiento |
| `stories.report.harassment` | Assédio ou ódio | Harassment or hate | Acoso u odio |
| `stories.report.violence` | Violência ou ameaça | Violence or threat | Violencia o amenaza |
| `stories.report.spam` | Spam ou golpe | Spam or scam | Spam o estafa |
| `stories.report.other` | Outra coisa | Something else | Otra cosa |
| `stories.report.send` | Mandar denúncia | Send report | Enviar denuncia |
| `stories.removed.title` | A staff tirou teu story do {server} | Staff removed your story from {server} | El staff quitó tu historia de {server} |
| `stories.removed.body` | Motivo: {reason}. Ele continua pros teus Amigos até expirar. | Reason: {reason}. It stays up for your Friends until it expires. | Motivo: {reason}. Sigue para tus Amigos hasta que expire. |
| `stories.quote.replied` | Respondeu ao teu story | Replied to your story | Respondió a tu historia |
| `stories.quote.repliedTo` | Respondeu ao story de {name} | Replied to {name}'s story | Respondió a la historia de {name} |
| `stories.quote.expired` | Story expirou | Story expired | La historia expiró |
| `stories.quote.left` | some em {left} | gone in {left} | desaparece en {left} |
| `stories.reduced.reacted` | Reagiu {emoji} | Reacted {emoji} | Reaccionaste {emoji} |
| `roles.perm.POST_STORIES` | Postar stories | Post stories | Publicar historias |
| `roles.permHint.POST_STORIES` | Fotos, vídeos e textos que somem em 24 h. | Photos, videos and text that disappear in 24 h. | Fotos, videos y textos que desaparecen en 24 h. |

Notes:
- "Story" stays in English in pt-BR: that is the word Brazilians use
  (Instagram, WhatsApp say "Status", but "story" is the spoken word).
- Spanish uses "historia", as Instagram ES does.
- `{left}` is formatted as "21 h" / "40 min".

---

## 15. QA checklist

Setup:
- Dev bypass. Window A has no suffix; window B has
  `localStorage.setItem("pqp:dev-user-suffix","bob")`; window C is `carol`.
- Sandbox server; A and B are friends; C is a member, not a friend.
- MinIO profile up for media.
- Run with the flag **off** first: nothing renders and every route 404s or
  answers `{enabled:false}`.
- Then `PUT /api/admin/flag-overrides` on for Sandbox only.

**Posting**
- [ ] A posts a photo to Sandbox.
  - [ ] B's and C's strips show A's ring within 5 s, with no reload (WS frame).
  - [ ] The ring sweeps once.
- [ ] A posts a text card to Amigos only. B sees it in Conversas; C does not;
      Sandbox does not.
- [ ] A posts one story to Sandbox + Amigos. One viewer list counts views from
      both places.
- [ ] A 31 s video: web refuses before upload with the seconds in the message;
      phones stop recording at 30 s; the server rejects a hand-crafted 40 s
      MP4 at processing.
- [ ] A 30 MB file is refused with the size message. `.mov` and `.webm` on web
      get the format message.
- [ ] EXIF: a photo with GPS posted from each platform; download the object
      from MinIO and confirm no GPS tags.
- [ ] Call sticker in `broderagi` while A is in it.
  - [ ] B taps "Entrar na call" and is in the room.
  - [ ] When the room empties, the sticker reads "A call acabou" and the button
        is gone.
- [ ] C without `POST_STORIES` (remove the bit from @everyone, give it to a
      role A has): C's composer shows Sandbox greyed with the reason; the API
      refuses a forged request with 403.
- [ ] Rate limit: the 21st story in 24 h is refused with a clear message.

**Viewing**
- [ ] Tap right/left, hold to pause (chrome hides after 250 ms), swipe to the
      next person, swipe down to close.
- [ ] Web: ← → / Shift+← → / space / R / Esc.
- [ ] Seen: B watches A's stories, closes, and the ring turns grey **after** the
      close animation. A moves behind unseen authors on the next fetch, not
      while B's finger is on the strip.
- [ ] Views: A's sheet shows B and C with times, refreshing within 10 s while
      open. A's own views never count.
- [ ] Reactions: B reacts 🔥 then changes to GG; A sees GG once. **No DM is
      created** by a reaction.
- [ ] Reply: B replies "que isso".
  - [ ] A gets a Conversas message quoting the story, with a push if A is away.
  - [ ] After a forced expiry (move `expires_at` back), the quote shows the
        hatched "Story expirou" plate with no caption or image, on all three
        platforms.
- [ ] Replies off: the box is gone and the line says so.
- [ ] Replies with DM privacy friends-only: C sees "só recebe mensagem de amigos".
- [ ] Block: A blocks C. C no longer sees A's stories **and** A no longer sees
      C's.
- [ ] Unfriend: B unfriends A, and A's friends-only story leaves B's strip on
      the next fetch.
- [ ] Mute: B mutes A's stories and A leaves B's strips; A's view list is
      unaffected.

**Expiry and storage**
- [ ] Set `expires_at` to the past.
  - [ ] Within 60 s the story is gone from every strip and every read.
  - [ ] Media and poster objects are deleted from MinIO.
  - [ ] `media_deleted_at` is stamped.
  - [ ] After 7 days (moved clock) the row is gone and `messages.story_id` is NULL.
- [ ] An orphan (minted, never published) is deleted after 1 h with its object.
- [ ] Flag turned **off** with live stories: the strip hides, and the sweep
      still deletes bytes on time.

**Moderation and safety**
- [ ] Scanner configured (`webhook` stub returning reject) → a photo never goes
      live; an automated report is filed; `quarantined`-style hold is set; the
      author sees "Não subiu" with no reason leak.
- [ ] Scanner erroring → fail closed (story not live).
- [ ] Video with scanner on: a frame returning reject blocks it. With no ffmpeg
      on the worker, config says `videoEnabled:false` and phones hide the hold
      to record.
- [ ] B reports A's story as harassment.
  - [ ] It lands in Sandbox's queue.
  - [ ] It does **not** expire while open.
  - [ ] After resolution it is held 30 days, then deleted.
- [ ] Minor-in-sexual-content reason → instance queue, not Sandbox's.
- [ ] A friends-only story report → instance queue.
- [ ] Staff with `MANAGE_MESSAGES` removes A's story from Sandbox.
  - [ ] It stays for A's friends.
  - [ ] `audit_log` has `story.remove`.
  - [ ] A sees the one-time notice with the reason; there is no push.
- [ ] An instance moderator removes it everywhere via the operator route; the
      log line is written.
- [ ] A timeout on A blocks posting.

**Baú bridge**
- [ ] A (owner) uses Salvar no Baú.
  - [ ] A Baú **draft** appears with the media.
  - [ ] The story then expires and its own key is deleted.
  - [ ] The Baú copy remains.
- [ ] B (no `MANAGE_SERVER`) never sees the button.

**Motion and accessibility**
- [ ] With reduced motion (macOS setting, iOS Reduce Motion, Android animator
      scale 0):
  - [ ] no zoom, no deck, no flying emoji, no ring sweep
  - [ ] fades only
  - [ ] the progress bars still run
- [ ] 60 fps on a mid Android (Moto G class) when opening from the ring and
      swiping people. Check the Compose layout inspector for recomposition in
      the pager.
- [ ] VoiceOver / TalkBack read "Story de Bia, novo" / "visto", and "Teu story,
      postar".
- [ ] Viewer controls have labels: pause, next, previous, close, reply, react.
- [ ] Captions and text cards meet contrast on their backgrounds (the text
      backgrounds are chosen for ≥ 4.5:1 with white).

**Multi-instance**
- [ ] With `CLUSTER_BUS=postgres` and two API processes: a post on one reaches
      a socket on the other within 5 s.
- [ ] The sweep running on both (or on the worker) deletes each object once,
      with no errors.

**Metrics**
- [ ] `GET /api/admin/metrics` → `stories` shows the posts, views, reactions,
      replies and sweep lag the test just produced.

---

## 16. Open questions for Rafael (each has a default, so nothing blocks)

1. **Friends stories at launch, or servers first?** Default: servers first (QG
   override), friends when the global row flips.
2. **`POST_STORIES` on for @everyone in listed communities?** Default: yes, plus
   the 72 h account age. The alternative is staff-only by default in
   communities.
3. **30 s video, or 60 s like WhatsApp and Instagram?** Default: 30 s. Doubling
   it doubles scan frames and bytes for little gain in clip culture.
4. **Should the call sticker also work for DM group calls?** Default: yes for the
   Amigos audience, as a new group call (mock C3), phase 1.5.

---

## Research sources

- **Instagram:**
  - [CNBC on the 2016 launch](https://www.cnbc.com/2020/04/08/instagrams-kevin-systrom-ignored-suggestions-to-copy-snapchat-stories.html)
  - [500M daily users (TheWrap)](https://thewrap.com/instagram-stories-just-passed-500-million-daily-users)
  - [Close Friends (VentureBeat)](https://venturebeat.com/technology/instagram-now-lets-you-send-stories-only-to-close-friends)
  - [ranking (Social Media Today)](https://www.socialmediatoday.com/news/instagram-explainer-feed-reels-and-stories-algorithm/651705/)
  - [Mosseri 2025](https://www.socialmediatoday.com/news/instagram-stories-ranking-factors-2025/738541/)
  - [60 s stories (PetaPixel)](https://petapixel.com/2022/09/26/instagram-users-can-now-post-60-second-uninterrupted-stories)
- **WhatsApp Status:**
  - [175M daily in 10 weeks (TechCrunch)](https://techcrunch.com/2017/05/03/whatsapp-status-million-users)
  - [2023 reactions (MobileSyrup)](https://mobilesyrup.com/2023/02/07/several-new-features-for-status-on-whatsapp-rolling-out-now/)
- **Snapchat:** [Bloomberg 2016](https://www.bloomberg.com/news/articles/2016-04-28/snapchat-user-content-fuels-jump-to-10-billion-daily-video-views), [MarketingCharts / YouGov](https://www.marketingcharts.com/digital-70575)
- **Telegram:** [Telegram blog](https://telegram.org/blog/stories), [Premium FAQ](https://telegram.org/faq_premium), [opened to all (Droid Life)](https://www.droid-life.com/2023/08/14/telegram-stories-launch-for-all-no-premium-subscription-required/)
- **Fleets:**
  - [shut down (PetaPixel)](https://petapixel.com/2021/07/14/twitter-is-shutting-down-fleets-after-just-8-months-citing-low-usage/)
  - [Bloomberg](https://www.bloomberg.com/news/articles/2021-07-14/twitter-shuts-down-fleets-its-stories-clone)
  - [test in Brazil (Silicon UK)](https://silicon.co.uk/e-marketing/socialmedia/twitter-tests-disappearing-fleets-334675)
  - [moderation case study (Techdirt)](https://archive.techdirt.com/articles/20211006/15054247715/content-moderation-case-study-twitters-self-deleting-tweets-feature-creates-new-moderation-problems.shtml)
- **LinkedIn Stories:** [Wordtracker](https://wordtracker.com/blog/social-media/linkedin-shutting-down-stories-at-the-end-of-september)
- **YouTube Stories:** [Search Engine Journal](https://www.searchenginejournal.com/youtube-stories-to-be-discontinued)
- **BeReal:** [Sprout Social](https://sproutsocial.com/glossary/bereal/), [PetaPixel on the decline](https://petapixel.com/2023/02/22/bereal-may-be-on-the-out-users-have-nearly-halved-since-peak), [TechCrunch on BeReal's rebuttal](https://techcrunch.com/2023/09/29/bereal-pushes-back-at-report-that-its-losing-steam-says-it-now-has-25m-daily-users)
- **Twitch Stories:** [Tubefilter](https://tubefilter.com/2023/10/17/twitch-hopes-its-new-story-feature-will-help-creators-audience-build-on-platform/)
- **Discord:**
  - [Activity Feed removal (PCGamesN)](https://www.pcgamesn.com/discord-library-activity-feed)
  - [Discord blog](https://discord.com/blog/tidying-up-discord)
  - [Clips privacy (PC Gamer)](https://pcgamer.com/discord-clips-feature-privacy)
  - No official Discord stories test was found; only user requests exist.
- **Gaming clips:** [Medal (TechCrunch)](https://techcrunch.com/?p=1785362). No data was found on what gamers post in stories. The categories in this study (clips, setups, rank-ups, "on hoje", memes) are inference from pqp's own `#clipes` and chat culture.
