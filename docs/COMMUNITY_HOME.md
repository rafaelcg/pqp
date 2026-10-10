# Baú (Community Home)

The Patreon-like media feed inside a server. In code it is `communityHome`
(routes under `/api/servers/:id/home/*`, tables `community_home_*`); in the
product it is **Baú**: the chest where the staff keeps what should not scroll
away. Posts are durable, newest first, with likes and a flat comment list.
Only `MANAGE_SERVER` publishes. It is not a channel type and it is not
`#avisos`: nothing here pings anybody.

Staging is the proving ground. Production has the flags unset.

## Flags (server env, read per request)

| Name | Default | What it does |
|---|---|---|
| `COMMUNITY_HOME_ENABLED` | off | The feed exists. Off: every `/home/*` route 404s, the schedule sweep idles, the client hides the row on a private hall. A community still lands on Overview (identity poster, empty feed). |
| `COMMUNITY_HOME_VIP_ENABLED` | off | The VIP half. Off: `visibility: members` is refused on write, existing members-only posts leave the feed (staff still see them in Drafts), and the client shows no lock, no VIP chip, no tier picker and no "view as" inspector. Needs the first flag. |

A third switch, `community_home_translation`, is a **runtime flag** (per
server, default off) and is described in "Translation" below. A fourth,
`community_home_video_captions` (per server, default off), puts automatic
subtitles on uploaded videos; see "Video subtitles".

**Plus one per-server switch.** With the instance flag on, each server still
starts with Baú off. An owner turns it on in **Server settings**, the same
panel as name, icon and roles (`PATCH /api/servers/:id/home/config`, column
`servers.community_home_enabled`). That panel is the discovery surface: a
NEW sticker sits on the toggle while the bit is still false. Do **not** put
the toggle in channel settings, the `/c/<slug>` community listing editor, or
user settings. When the instance flag/latch is off
(`isCommunityHomeEnabled` false), the settings row is omitted entirely (fail
closed). Flag/latch on + `MANAGE_SERVER`: show the toggle. The row, the
landing and the feed need both on a private hall. A community always lands
on Overview (identity), even with Baú still off; the feed stays empty until
staff turn it on, and only if the instance flag is on. Flipping the switch
bumps `servers.community_home_version` in the same UPDATE and sends a
`community-home-update` frame to every member with `enabled` and `version`. The
web client writes the value onto its copy of the server only when the version
is higher than the one it holds, so an open app follows the owner with no
reload, and a late or duplicated frame cannot undo a newer flip. A failed
member lookup or a cluster bus that was down is retried in the background
(`notifyCommunityHomeSwitch`, `server/src/ws/chat.ts`). A frame missed while the
socket was down is caught on reconnect: the client re-reads
`GET /api/servers/:id/home/config` (`{ enabled, version }`) for the server on
screen, and for any other server when it is next opened. Until the row is
opened once on a server it carries a small "New" chip (`localStorage`, per
server, `client/src/lib/community-home/new-badges.ts`). The toggle in Server
settings has its own sticker (`pqp:community-home-settings-seen`) that stays
while the server bit is off: opening the panel does not clear it, flipping the
switch does.

Do **not** reuse `COMMUNITIES_ENABLED`. That one changes the instance's legal
category (STF, Art. 19, see `docs/CONTENT_SAFETY.md`); this one only adds a
feed. There is no `VITE_` flag: the client asks `GET /api/community-home/config`
(`{ enabled, vipEnabled, mediaEnabled }`, always 200) and follows it, the way
it follows the attachments and communities configs. `mediaEnabled` is the
`S3_*` probe folded in, so a deployment without storage still gets the feed
with YouTube / Twitch / TikTok / Instagram links and text.

**Local override, dev bypass only.** With `DEV_AUTH_BYPASS=true`,
`?communityHome=1|0` on `/app` forces the answer for that tab and latches it
in `localStorage` (`pqp:community-home`). Outside the bypass the query is
ignored. This is what lets one Playwright run prove both chromes against a
single API process.

```bash
# .env (local) or fly secrets (staging)
COMMUNITY_HOME_ENABLED=true
COMMUNITY_HOME_VIP_ENABLED=true
```

## Who publishes, who sees

| Role | Behaviour |
|---|---|
| `MANAGE_SERVER` | Write, edit, delete, publish, schedule, drafts; turn comments off per post; delete any comment. Always sees members-only posts in full. |
| VIP cargo (`system_key=vip`) | Cannot publish. Sees members-only posts in full. |
| Everyone else | Free posts in full. Members-only posts as title + teaser + lock plate (when the post has media), with body, media **and comment words** stripped on the API. Like count and comment count survive. |

Visibility is enforced in `server/src/services/community-home.ts` (`toPost`);
the client never reconstructs a locked post from what it has. The staff-only
"view as member without VIP" switch (`?homeViewer=members`, `pqp:community-home-viewer`)
only changes how a manager's own screen renders `post.locked`; it exists so
staff can check the teaser without a second account.

Staff CMS opens from **Novo post** on the cover (`MANAGE_SERVER`), next to
**Edit page** and overflow. Inspector and drafts live in that overflow —
never Feed|Compose|Drafts tabs, never a second viewer row, never a FAB.
A community Overview has no Discord channel header: the cover is the top
of the pane. Dirty close of compose saves a draft into overflow; drafts
never mix into the member feed.

Card chrome is Patreon-shaped, not Discord-shaped: flush media (or a 16:9
hatched lock plate, or the public YouTube poster when `posterUrl` is set) at
the top, a display title, a quiet relative date, the
body or a public teaser, then likes and the comment count. There is no
member-facing author row. The page is the creator. Locked cards still show
counts; they never expand comment words. Dummy CSS blur lines stand in for
the hidden body. They are not the real text. The plate is only for posts
with `hasMedia` (true when `media_kind` is set, even if `media` is null for
this viewer). A text-only VIP post does not grow a fake video. A locked
YouTube post may show the public `i.ytimg.com` poster (`posterUrl`). That
image is already on YouTube. Uploaded files stay hatched: those pixels are
the secret. The poster names the video id, so do not put an unlisted clip
behind VIP if the id must stay private.

Staff lock a post with **VIP** in compose, or **Trancar (VIP)** / **Liberar**
in the card overflow. Pin, edit and delete live there too. Members never
see the overflow.

Card footers are like + comment count only. Join-call chrome stays off Baú
cards. Comment teasers on the card are 0–2 (owner reply else oldest, 2-line
clamp); the rest opens on detail tap. Locked cards do not expand comments.

The unlock CTA is disabled and reads "VIP, coming soon". There is no
checkout, Gift, Buy post, or price. See [`BAU_VIP_STRATEGY.md`](./BAU_VIP_STRATEGY.md)
for what would replace it.

## What is in the pane

- **Row** in the channel list above TEXT, still called Baú. It is a page
  tile (community icon or hue initials; chest on a private hall), not a
  two-line channel with a teaching subtitle. A community always gets the
  row. A private hall gets it when it opted in and the
  instance flag is on. The unread count is published posts this person has
  not seen (`GET …/home/unread`; own posts never count, and the VIP filter
  matches the feed so the badge cannot promise a post the feed will not
  show). Opening the live feed stamps `community_home_reads` and clears it.
  The count outranks the "New" chip: a number says more.
  Landing (`client/src/lib/community-home/landing.ts`): a **community**
  always lands on this pane (identity header, then the feed). A private hall
  still needs the server's own Baú opt-in. If the instance flag or the
  server opt-in is off, a community still opens Overview: the header shows
  and the feed is empty until staff turn Baú on. A URL that already names a
  channel still opens that channel. The unread stamp and the "New" chip are
  unchanged: opening the live feed still writes `community_home_reads` and
  still clears the discovery chip.
- **Identity header** on that same scroll, only for `isCommunity`. Cover
  is full-bleed on the pane (Patreon creator page). With no cover uploaded,
  the band is a tiled pqp.gg mosaic over the hashed hue wash, the same
  default `/c/` uses. With no posts the about stays in the header. With
  posts the header compresses (name, tagline), about plus official links
  move to a sticky rail beside the feed, and cards lead with media. Staff
  with Manage Server get **Edit page** on the cover: in-place cover, icon,
  tagline, about and official
  links. The editor keeps the poster as a live preview, with cover/icon
  controls on the pictures and a labeled form under them (crop size, file
  type, cap). Pictures apply as soon as they are picked. The rest waits for
  Save. Directory, slug and featured stay in Server settings. No featured
  16:9 here (pin a Baú post instead). Private halls that turned Baú on
  keep today's feed with no identity header. One channel-list row, still
  called Baú.
- **Server rail** (web): an unread Baú post lights the white pip on that
  server's icon, the same one an unread channel lights, and never a number: the
  red count on an icon is for mentions, and a staff post is news, not a message
  addressed to you. A muted server stays silent, as for channels. One read
  (`GET /api/community-home/unread`, `{ servers: { [id]: count } }`, only
  servers whose owner turned Baú on) feeds every icon; it is re-asked on any
  `community-home-update` frame and when you move between servers. The open
  server's own number still comes from `…/home/unread` and drives the row and
  the corner card (`client/src/lib/community-home/rail-unread.ts`).
- **Push** on a new post, behind the runtime flag `bau_post_push` (default off,
  per server, see below).
- **Live corner card** when a post is published while you are in that
  server, looking at another channel (`community-home-update` plus unread
  going up). Not the author: own posts never count as unread. Not if you
  are already on the feed (the feed is the notice). Not if you are in DMs
  or another server — the badge is waiting when you open this one, and
  opening it lands on Baú. Same `CornerCard` shell as the other corner
  hints, after the update notice in `CORNER_HINT_ORDER`. Click **Abrir o
  Baú**, or wait 8 s / hit Escape. See
  [`ONBOARDING.md`](./ONBOARDING.md).
- **Intro card** for members, once per account
  (`preferences.communityHomeIntroDismissedAt`, not `localStorage`, so a new
  browser does not re-offer it). Says what the Baú is, that likes and comments
  are the only verbs, and, with VIP on, what a locked post is.
- **Staff guide** instead of an empty feed for managers: a headline that
  sells the idea, a 14 s recording of a filled Baú (member view: posts with
  an image, a PDF, a like, comments expanding, the VIP lock), and four or
  five big-icon rows (clip, file, likes and comments, schedule, VIP when the
  flag is on). The reel is `client/src/assets/bau/bau-demo.<lang>.{webm,mp4,jpg}`,
  one per language, muted and looping, still under `prefers-reduced-motion`.
  Re-record it with `client/e2e/bau-demo-record.spec.ts` (instructions in
  the file) whenever the card design changes. The compose tab repeats the
  rows, small, until the first post exists.
- **Composer** (staff tab "Write"): title, body, one media (file when
  `mediaEnabled`, else YouTube / Twitch / TikTok / Instagram only), comments on/off, VIP toggle + teaser
  when `vipEnabled`. Paste a supported link and the same player the feed uses
  unfurls in the compose card (300 ms debounce, 16:9 skeleton, muted hint
  after idle if it is not a supported URL — no red error while typing).
  **Prévia** still renders the whole card as members will see it, and
  the locked version too for a VIP post. **Publish**, **Save draft**, or
  **Schedule** (a `datetime-local` in the browser's timezone; the API stores
  the instant plus the IANA name).
- **Channel links**: `#geral` in a post is a link to that channel. The composer
  helps write it: type `#` and the server's channels open as a dropdown
  (filtered as you type, arrows + Enter/Tab or a click to pick; the chat
  composer's `AutocompleteMenu`). The textarea holds a readable `#name`; on
  save it is stored as **`<#channelId>`** (the channel's uuid, grammar in
  `packages/shared/src/community-home-channel-refs.ts`), so a rename never
  breaks the link and the body never carries a name. Readers resolve the id
  against the channels **they** can see (the same list the sidebar shows), so
  a private or deleted channel is a muted `#unavailable-channel` with no name
  and no link: the server does not resolve names and leaks nothing. A plain
  `#name` in an older post (or one typed without the picker) links too when
  exactly one visible channel has that name; two with the same name are never
  guessed. Automatic translation swaps the ids for numbered placeholders
  (`<#1>`) before the model sees the text and puts them back; a field whose
  placeholders did not all come back keeps the author's words
  (`communityHomeTranslation.channelRefsKept`). iOS and Android draw the same
  links (tap opens the channel in the app) and offer the picker as a row of
  chips while the draft ends in `#query`. Stored limit: the 4000 characters are
  counted on the stored form, where a link is 40.
- **Drafts tab**: drafts and scheduled posts with Publish now / Unschedule /
  Edit / Delete.
- **Pinned post**: one per server, enforced by a partial unique index rather
  than by hope. Staff pin from the card; pinning replaces whatever was pinned
  before, and only a published post can be pinned. A pinned post leads the
  feed whatever its date, carries a "Pinned" chip, and is the intended home
  for the welcome video an owner wants every new member to meet.
- **Emoji and GIFs**: the comment box carries the same two pickers the chat
  composer does (`EmojiPickerPanel`, `GifPickerPanel`, Klipy), and the post
  composer carries the emoji one. A picked GIF is posted as a comment whose
  body is only the GIF URL, and a body that is nothing but an allowlisted GIF
  URL renders as the GIF instead of the text, in posts and comments alike:
  the same rule and the same `GifAttachment` renderer chat uses, so an
  arbitrary host stays plain text. The GIF panel opens below the box when
  there is room and above when there is not, because a comment box can sit
  anywhere in a scrolling feed.
- **Cards**: flush media (or a 16:9 lock plate, YouTube poster when we have
  one) at the top, a big title, a quiet date, body or teaser, then likes +
  comment count on every published card including locked. No author row. No
  "free" chip. Locked badge on the plate (or by the date on a text-only VIP
  post). Dummy CSS blur lines, never the real body. Staff overflow can lock
  or unlock (VIP visibility). Delete is a two-step in that overflow, not a
  browser dialog. Heart with a count. The two newest comments under an
  unlocked card, "See all N" fetches the rest.

## Push on a new post (`bau_post_push`)

Runtime flag, **default off, per server** (`docs/FEATURE_FLAGS.md`): turn it on
for one server with `PUT /api/admin/flag-overrides { key: "bau_post_push",
serverId, enabled: true }`, then globally. It needs `community_home`, the
server's own Baú switch and a configured push transport (web push, FCM, APNs;
the same pipeline as mentions and DMs).

- **When.** A post going live: published from the composer, "Publish now", or a
  scheduled time arriving. Exactly once: `community_home_posts.push_claimed_at`
  is stamped by one `UPDATE ... RETURNING` (`services/community-home-push.ts`),
  by the publish route and by the 30 s sweep alike, so two API machines, a
  feed read's catch-up and an unpublish followed by a publish cannot announce a
  post twice. The stamp is taken **even with the flag off**, so turning it on
  never announces what was published while it was off. A post unannounced for
  more than 30 minutes is stamped and dropped (in one statement, never loaded),
  and a claim is at most 200 fresh posts per call. If the fan-out fails before
  anything was sent the claim is handed back and the next tick retries; once a
  page of pushes has gone out the posts stay claimed, because finishing could
  tell some people twice and a missed push is the lesser harm. The walk is
  capped at 50 000 members (`capped` on the `push.bauPost` line).
- **Who.** Every member except: the author; anybody who blocked the author; for
  a members-only post, anybody who could not open it in full (only
  `MANAGE_SERVER` and the VIP cargo can; with the VIP flag off a members-only
  post is not announced). Then the push-only rules, each counted under
  `product.pushSkipped.bau.*` on `GET /api/admin/metrics`: a socket in front of
  the person (`live_socket`, or `attentive_socket` with `push_attention_gate`;
  the live corner card is that notice), stored do-not-disturb (`dnd`), the
  server muted (`muted`: an explicit `none` for the server or a `none` default)
  or explicitly set to mentions only for this server (`level`). The account-wide
  "mentions" default for servers does **not** silence it: a staff post is not
  chat noise. No device (`no_subscription`) and no configured transport
  (`transport_off`) are counted the same way. Sends land in
  `product.pushDelivery` by platform like every other push, and one
  `push.bauPost` log line per server per claim.
- **Quiet.** Posts claimed together are one push per person that says how many
  ("3 posts novos no Baú do X"). The notification `tag` is per server
  (`bau:<serverId>`), so on the device (and as the APNs collapse id) a later
  post replaces an earlier one. TTL is a day.
- **Copy.** Title `Baú`; body `Post novo no Baú do {server}: {title}` (en, es,
  pt-BR by the recipient's `settings.locale`). Never the body of the post.
- **Tap.** `path` is `/app/server/<id>/home`. The web client lands on the Baú
  for any server URL with no channel; iOS (`DeepLinkTarget.bau`) and Android
  (`DeepLinkTarget.Bau`) open their Baú screen.

## Limits

What a member can do, and how much of it. The global per-user write budget
(`writeLimiter`, 30 burst / 2 per second) still applies underneath all of it.

| Thing | Limit | Why |
|---|---|---|
| Title | 200 chars | `safeText`, rejected not truncated |
| Body | 4000 chars | same |
| Teaser | 500 chars | same |
| Comment | 1000 chars | the outer schema accepts twice that so a paste gets a 400 rather than a silent cut |
| Comments | 6 burst, 1 per 5 s | a person replying twice is fine; a script is not |
| Likes | 20 burst, 1 per second | one tap each; the cap stops a script, not a person |
| Publishing | 10 burst, 1 per 20 s | staff-only and rare; the fan-out is the expensive part |
| Media upload | shared `uploadLimiter` | 10 burst, 1 per 10 s |
| Feed read | 50 posts | `COMMUNITY_HOME_FEED_LIMIT`; the pinned post always rides along |
| Drafts read | 50 | same constant |
| Comments read | newest 200 | read oldest-first inside the page |

**Blocked people are gone, not greyed.** A comment by somebody the viewer has
blocked is excluded in SQL from the count, the two-comment teaser and the
full list, so a card can never say "3 comments" and show two. One direction
only, as everywhere else: blocking hides them from you, not you from them.

**A comment does not fan out.** Publishing, pinning and deleting do (the feed
changed shape for everyone); a comment does not, because the WS frame carries
no payload and every member would refetch the whole feed for one comment on
one card. The commenter sees their own immediately; everyone else on their
next load.

## Media

Image, native video (`mp4`/`webm`), PDF, up to 100 MiB each (`COMMUNITY_HOME_MAX_BYTES`; attachments stay at 10 MiB), through the same
mint / PUT / claim dance as attachments (`client/src/lib/community-home/media.ts`,
`POST …/home/media`, `POST …/home/media/claim`). Bytes never pass through the
Node process. YouTube is URL only (`watch`, `youtu.be`, `shorts`, `embed`,
`live`), embedded from `youtube-nocookie.com`. TikTok is the same paste box
(`tiktok.com/@user/video/{id}`, `m.tiktok.com/v/{id}`; short `vm.` / `vt.` /
`/t/` links are refused because they only resolve after a redirect),
embedded from `tiktok.com/player/v1/{id}` (TikTok's current Embed Player URL;
`embed/v2` 504s from some edges). Instagram is `/p/{shortcode}`, `/reel/`,
`/reels/`, embedded from `instagram.com/p/{shortcode}/embed/` (reels use
`/reel/…/embed/`). That embed path answers with no `X-Frame-Options`, unlike
the watch page which sends `DENY`. Profiles, tags, discover, stories and
explore are refused. The original URL for all four providers still lives in
`media_youtube_url`; the server classifies `kind` from the paste. Twitch is
the same paste box
(`twitch.tv/<channel>`, `/videos/<id>`, `/clip/<slug>`, `clips.twitch.tv`),
embedded from `player.twitch.tv` / `clips.twitch.tv` with `parent` set to the
viewing hostname and autoplay off. The API returns the stored URL in
`youtubeUrl` for YouTube, TikTok and Instagram, and in `twitchUrl` for Twitch.
Over-limit video is refused with "upload it to YouTube". Files are signed as
downloads, never inline.

Orphans (minted, never claimed onto a post) are swept after an hour; deleting
or replacing a post's media deletes the object and the upload row.

### A phone cut of a video

An uploaded video can carry a second, vertical (9:16) edit beside the main,
landscape one: an owner posting a launch video with both cuts. Phones play the
vertical one, everything else the main one. Runtime flag
`bau_mobile_rendition` (**per server**, default off, env default
`BAU_MOBILE_RENDITION`), served to the composer as `mobileRenditionEnabled` on
`GET .../home/posts` and `.../home/drafts`.

- **Storage.** Four nullable columns on the post row
  (`mobile_media_name`, `_content_type`, `_byte_size`, `_storage_key`), not a
  child table: there is exactly one alternate, it lives and dies with the main
  video, and a CHECK refuses one on a post whose `media_kind` is not `video`.
  The bytes take the same mint / PUT / claim as any Baú media (same 100 MiB
  cap, same type allowlist, same HEAD), so the upload row is an ordinary one
  and the orphan sweep needs nothing new.
- **Writes.** `mobileMediaUploadId` on create and on PATCH. Refused unless the
  flag is on, the main media is an uploaded video, the cut is a video, and it
  is not the main file twice. On PATCH, omitted keeps the cut while the main
  file stays the same; replacing or clearing the main media drops it (it was an
  edit of the old video); `null` removes it. A removed or replaced cut, and
  both files of a deleted post (main media included), are handed to the
  orphan sweep inside the same transaction (upload row unclaimed and
  unverified), then deleted right after COMMIT without the answer waiting on
  it. Whatever that quick cleanup does not finish, the sweep does.
- **Reads.** `media.mobile` = `{ name, contentType, byteSize, url }`, inside
  `media`, so a locked viewer (who gets no media) never gets it. Flag off: the
  field is null and every client plays the main video; stored cuts are kept,
  so turning it back on brings them back. A client that ignores the field
  plays the main video.
- **Who plays which.** Web: `communityHomeVideoUrl` in
  `client/src/lib/community-home/rendition.ts`. The vertical cut when the
  viewport is at most 640 CSS px wide, or the pointer is coarse and the screen
  is portrait; decided when the player mounts, never on rotate (a phone turned
  sideways mid-video keeps playing). iOS and Android always prefer it
  (`CommunityHomeMedia.inlineVideoURL`, `BauMedia.videoUrl`). The composers on
  the phones do not offer it yet; staff attach it from the web.

## Schedule

`status = scheduled` rows flip to `published` in `publishDueCommunityHomePosts`,
called every 30 s and on boot from `server/src/index.ts`, single process, no
worker. A missed tick is caught by the next one. Each flip fans out a
`community-home-update` frame (server-scoped, per member, never a channel
relay) and clients refetch. Likes deliberately do **not** fan out.

**The feed does not wait for that tick.** The 30 s sweep is only how a publish
is _pushed_ to a member already sitting on another channel. The feed and unread
reads themselves flip this server's due rows first (`flushDueScheduledPosts`,
the same UPDATE scoped to one `server_id`), so a post whose scheduled time has
passed is live the instant anyone loads the Baú, and stays hidden only while the
clock says it is still in the future. Before this, a due post was invisible
until the sweep happened to run, and on any deployment where the sweep never
ran it never appeared at all — a community owner reported exactly that ("posted
it, refreshed, it was gone, members never saw it"). The read-time flip is a
0-row UPDATE once the sweep or an earlier reader has caught it, and idempotent
with both. It never fans out (the reader is already reading); the sweep stays
the only thing that nudges everyone else.

## Translation

Posts written in one language are read in another: a Portuguese post about
pqp shows up in English for an English reader, in Spanish for a Spanish one,
with one quiet line that says it was translated and a way back to the
original. The site stays readable in the language of whoever is reading.

**Off by default, two switches, both needed.**

| Switch | What | Unset or off means |
|---|---|---|
| `community_home_translation` | Runtime flag, **per server** (`FEATURE_FLAGS.md`). Flip it from the operator dashboard (controles, interruptores, search the server inside the row) with no deploy and no restart. Env default: `COMMUNITY_HOME_TRANSLATION`. Needs the Baú itself on. | Nothing is produced for that server and readers get the original, even for translations that already exist (they are kept, not deleted). |
| `OPENROUTER_API_KEY` | A secret on the API box. Never in git. | The feature is cleanly off: no calls, no errors, one log line per publish saying why (`communityHome.translation.skipped reason=no_key`), the staff note hidden. |

Tuning, all optional: `COMMUNITY_HOME_TRANSLATION_MODEL` (default
`google/gemini-3.1-flash-lite`, the one the STT/translation bench picked;
`openai/gpt-4o-mini` is the cheaper fallback),
`COMMUNITY_HOME_TRANSLATION_DAILY_CHARS` (default 200000),
`COMMUNITY_HOME_TRANSLATION_MAX_CHARS` (default 6000 per post and language) and
`COMMUNITY_HOME_TRANSLATION_BASE_URL` (another OpenAI-compatible endpoint; env
only because the key is sent to it).

**How it decides.**

- *Languages*: the three UI locales, `en`, `pt` (pt-BR) and `es`. The reader
  asks with `?lang=` on `GET .../home/posts` and `.../home/posts/:id` (the
  client sends its UI locale); anything else gets the original.
- *Source language* is guessed offline from the post's words
  (`server/src/services/lang-detect.ts`, a stopword count over English,
  Portuguese and Spanish; French and German turn into "unknown"). A post
  already in the target language is not translated: a `same_language` row is
  stored so the sweep does not ask again. Unknown is sent as "whatever language
  this is", and the model works it out.
- *When*: after a post is published (now or by the schedule), after an edit of
  a published post, and by a sweep every minute (`jobs.ts`, so it runs in the
  worker when there is one) for any published post with no current translation:
  a crash, a missed call, the key or the flag arriving after the post. All of
  it is background and best effort. **Nothing between BEGIN and COMMIT touches
  the network, a publish never waits for it and never fails because of it.**
- *Which text*: title, teaser and body in one call to the shared
  `Translator` (`server/src/speech/translators/openrouter-chat.ts`, the same
  system prompt that keeps pqp, Baú, QG, MoonKase, LiveKit and watch party
  untouched). A field with no words (a GIF URL, only links or emoji) is carried
  over as is.
- *Edits*: a translation row holds the md5 of the title, teaser and body it was
  made from. The read compares it with the post as it is now and serves the
  original on a mismatch, so a stale translation is never shown for new text;
  the edit starts a new one. Nothing is deleted on edit.
- *Two API machines*: the claim is a row (`community_home_translation_jobs`,
  one atomic `INSERT ... ON CONFLICT DO UPDATE ... WHERE` with a 4 minute lease
  and a backoff), not an in-process map. A crashed machine's claim expires.
- *Bounds*: at most `COMMUNITY_HOME_TRANSLATION_MAX_CHARS` source characters per
  post and language (the cut gets a ` […]`), a daily character budget reserved
  atomically in `community_home_translation_usage` so it means the deployment
  and not one process, quick retries on 429 and 5xx with the provider's
  `Retry-After`, then a job-level backoff (2, 6, 18 minutes) and a quiet give
  up after four tries for that version of the post (an edit is a new version
  and starts fresh). A failure known not to have reached the provider gives its
  budget back; one after a billed call keeps it. Work waiting for one of the two
  slots is deduplicated per post and language and capped, and after a scan that
  found nothing missing the sweep rescans only every 10 minutes (or at once when
  the flag's servers change); a publish or an edit never waits for it.

- *Brand and names never reach the model.* Both the post translator and the
  subtitle translator go through `communityHomeTranslatorFor` ->
  `server/src/services/translation-brand-guard.ts`. "pqp" (standalone word,
  any case), "pqp.gg", "QG do pqp", "Baú", "QG", URLs, @handles, `#channel`
  tokens and the server's own name are swapped for placeholders (`<k1>`) before
  the call and put back after it, so the product name cannot be "helpfully"
  translated (it once came back as "WTF", because "pqp" is also a pt-BR swear).
  A string whose placeholders did not all come back keeps the author's words
  (`communityHomeTranslation.brandNamesKept`). The system prompt says the same
  as a second line of defence. Translations stored before this change keep
  their old text; to make them again for one post (the sweep redoes the post
  text within about ten minutes, the subtitles on the next read):

  ```sql
  BEGIN;
  DELETE FROM community_home_post_translations     WHERE post_id = '<post id>' AND NOT same_language;
  DELETE FROM community_home_translation_jobs      WHERE post_id = '<post id>';
  DELETE FROM community_home_post_captions         WHERE post_id = '<post id>' AND NOT is_source;
  DELETE FROM community_home_caption_translation_jobs WHERE post_id = '<post id>';
  COMMIT;
  ```

**What is never translated.** Comments (a follow-up), the author's name,
the cover, media, anything in a draft or scheduled post (it is translated when
it goes live). A members-only post is translated like any other, but the lock
is applied to the translated fields by the same expression as to the original
(`toPost`): a reader who cannot open the post gets the translated title and
teaser (public by design) and never a body, in either version, and a
translation row never changes what `locked` means.

**What the reader sees.** The card carries a line, "Automatically translated ·
See original", that flips that one post to the author's words and back; the
choice is remembered for the session (`sessionStorage`). `post.translation`
is `{ lang, auto, sourceLang, original: { title, body, teaser } }` and the
`title` / `body` / `teaser` beside it are the translated ones. Staff who edit a
post always edit the original.

**What staff see.** A quiet note in the composer, only when the flag is on for
the server and a key is set ("Readers in other languages will see an automatic
translation of this post"), and, when editing a published post, "See
translations": each language's text, read only, with "Out of date" when the post
changed since (`GET .../home/posts/:id/translations`, `MANAGE_SERVER`). There is
no editing of a translation; saving the post makes new ones.

**Cost.** (A rejected answer from the provider still counts: it was billed.) About 0.003 USD per 1,000 words per language with flash-lite, so a
600-word post into two languages is about a cent.

**Counters and logs.** `communityHomeTranslation` on `GET /api/admin/metrics`:
`done`, `sameLanguage`, `failed`, `gaveUp`, `skippedOverBudget`,
`skippedClaimed`, `skippedFlagOff`, `skippedNoKey`, `skippedNotPublished`,
`discardedStale`, `truncated`, `providerRetries`, `charsSent`, `costUsd`,
`lastError` (per machine, since boot) and `today` (`chars`, `requests`,
`capChars`, from the database, the whole deployment). Every path that does not
translate logs why: `communityHome.translation.skipped` (`reason=flag_off |
no_key | claimed | over_budget | not_published | post_gone | source_changed`),
`.failed` (with the attempt and whether it gave up), `.overBudget`, `.discarded`,
`.sameLanguage`, `.done`, `.retry`, and `.sweep` (only when its state changes).

**Turning it on.** Set `OPENROUTER_API_KEY` on the API box and restart it, then
flip `community_home_translation` for the server in the dashboard. (With a
separate `pqp-worker`, the key belongs on the worker too: the API translates
right after a publish, the worker runs the minute sweep.) The sweep
translates what is already published within a minute (newest first, bounded by
the daily budget). Turning the flag off is instant and keeps the stored rows.

## Video subtitles

A video uploaded to the Baú gets automatic subtitles in the language it was
spoken in, and a translation of them into the reader's language, so the owner's
launch video in Portuguese can be followed in English or Spanish. Uploaded
videos only: YouTube, Twitch, TikTok and Instagram bring their own.

**Switches.** `community_home_video_captions`, a runtime flag, **per server**,
default off (env default `COMMUNITY_HOME_VIDEO_CAPTIONS`). It sends the video's
sound to the speech provider (Cloudflare Workers AI, outside Brazil), so it goes
on one server first. Off is a kill switch: no new jobs, a queued job is dropped
before any call, and stored subtitles are hidden on every read. The translated
track also needs `community_home_translation` on for that server (same
provider, same consent as the post text). Producing anything needs
`VOICE_STT_PROVIDER` and its key on the worker, and ffmpeg (the worker image
has it; a process without ffmpeg never claims the job).

**Pipeline** (`server/src/services/community-home-captions*.ts`,
`server/src/speech/captions.ts`):

1. Publishing a video post (now, scheduled, or editing in a new video) queues
   a `speech_jobs` row of kind `community_home_captions`, keyed by `post_id`.
   The minute sweep (`jobs.ts`) queues any published video on a flagged server
   that has no job, which is also the backfill.
2. The worker runs one captions job at a time, in a lane of its own so voice
   notes never wait behind a long video: it streams the video to a temporary
   file, ffmpeg takes the first audio stream as 16 kHz mono PCM (at most
   `COMMUNITY_HOME_CAPTIONS_MAX_SECONDS`, default 1800), reserves the length
   (overlaps included) from the shared daily speech budget
   (`VOICE_STT_DAILY_SECONDS`, `speech_usage_daily`), and sends 30 s windows
   with 1 s of overlap, one at a time, as WAV. The language Whisper hears in
   the first window with words is held for the rest. The flag is asked again
   before every call.
3. The windows are stitched (`stitchWindows`), Whisper's silence and loops are
   dropped, long lines are cut into two-line cues, and the result is stored as
   the source track in `community_home_post_captions` (cues as JSONB, the
   storage key of the video they came from, md5 of the cues).
4. Each other UI language (`en`, `pt`, `es`) gets a translation of the cue
   **text only**, in batches, through the post translator
   (`communityHomeTranslator`, same model, same daily character budget, same
   claim and backoff shape in `community_home_caption_translation_jobs`). The
   timings are never sent and never change. The worker does it right after the
   transcription; the minute sweep and a reader's request (on whichever process
   has `OPENROUTER_API_KEY`) catch anything missed.

**Reading.** `post.captions` is `{ sourceLang, langs }` when there is a current
source track (null for a locked viewer, for anything but an uploaded video, and
with the flag off). The words come from
`GET /api/servers/:id/home/posts/:postId/captions?lang=<reader locale>`, which
answers `{ tracks: [{ lang, source, auto, vtt }] }` (the source and, when
current, the reader's language). It goes through the same read as the feed, so
a draft, another server's post or a members-only video the viewer cannot open
has no subtitles. The web player fetches them when the reader first comes near
the player, gives them to `<track kind="subtitles">` as `blob:` URLs (a track
cannot send the Authorization header), and draws the current cue above its own
bar. Subtitles start **on** when the video's language differs from the
reader's and **off** otherwise; the CC button flips them, and that choice is
remembered in this browser (`pqp:community-home-captions`). In the iPhone's
native fullscreen the browser draws them itself.

**A replaced video** loses its job and its tracks in the edit's transaction,
and a read only serves tracks whose storage key is still the post's, so new
pictures never get old words. A worker that was mid-job on the old file loses
its fence and writes nothing.

**Backfill.** Turning the flag on for a server is the backfill: the minute
sweep queues every published video there, newest first, five per minute. A
job that settled as `no-provider` or `over-budget` is offered again after an
hour. To make one post again by hand (a better provider, a gave-up job):
`DELETE FROM speech_jobs WHERE kind = 'community_home_captions' AND post_id = '<id>'`
and the next sweep queues it.

**Cost.** Workers AI Whisper is 0.000513 USD per audio minute, so a 3 minute
video is about 0.0016 USD (3.1 minutes billed with the overlaps) and 186 s of
the 36,000 s daily budget. Translating its cues (roughly 2,500 characters) into
two languages is about a third of a cent with flash-lite.

**Counters.** `communityHomeCaptions` on `GET /api/admin/metrics`: jobs done,
skipped and failed in the last 24 h and what is queued or running (from the
database, so it covers the worker), how many videos have a track and how many
translations exist, and this process's own counters. Logs say why at every
step: `communityHome.captions.enqueued`, `.skipped` (`flag-off`,
`no-provider`, `over-budget`), `.noSpeech`, `.done`, `.failed`, and
`communityHome.captions.translation.done | skipped | failed`.

**Native apps** do not show subtitles yet. AVPlayer only takes external
WebVTT through an HLS wrapper or an `AVMutableComposition`, and ExoPlayer
through a `SubtitleConfiguration`; the endpoint above is what they will read.
**The phone cut** (`bau_mobile_rendition`, the vertical second file of a
post) is transcribed once, through the main video: the tracks are keyed to the
post and the main video's storage key. The web player shows them on the cut
too, but only while the cut's length is within 1.5 s of what was transcribed
(`post.captions.durationMs`), so a cut that was edited differently shows no
subtitles rather than lines at the wrong moment. Transcribing the cut on its
own would be the follow-up if authors start posting different edits.

## Staging

`fly secrets set COMMUNITY_HOME_ENABLED=true COMMUNITY_HOME_VIP_ENABLED=true -a pqp-api-staging`
then push to `staging`. Media needs the staging R2 credentials on the app
(see `docs/STAGING.md`); without them `mediaEnabled` is false and the
composer offers YouTube / Twitch / TikTok / Instagram and text only, which is
the expected shape of a self-host without storage, not a bug.

## Tests

- `server/src/services/community-home.test.ts`: pinning leads the feed and
  replaces the previous pin, a draft cannot be pinned, a member cannot pin,
  unread counts and clears on read and never counts your own; flag off 404s,
  config answers 200, member vs staff vs VIP visibility (including comment words), VIP flag
  off refuses and hides, drafts never reach members, schedule sweep, a due
  scheduled post surfaces in the feed and unread without the sweep while a
  future one stays out, teaser survives an edit, comments and likes.
- `packages/shared/src/community-home.test.ts`: YouTube / Twitch / TikTok /
  Instagram URL classifiers (profiles, stories and short links refused).
- `client/src/components/community-home/community-home-feed.test.tsx`: the
  card's contract (no free chip, no author row, locked leaks nothing, likes
  and comment count stay on locked cards, two comments max, Twitch / TikTok /
  Instagram iframes).
- `packages/shared/src/community-home-channel-refs.test.ts`,
  `client/src/lib/community-home/channel-refs.test.ts`,
  `client/src/components/community-home/community-home-channel-refs.test.tsx`,
  Android `BauChannelRefsTest`, iOS `BauChannelRefsTests`: the `<#id>` grammar,
  rendering and the privacy fallback, the `#` picker (filter, keyboard,
  mouse), the `#name` to `<#id>` round trip, the translation guard.
- `client/src/lib/community-home/embed-preview.test.ts` and
  `community-home-compose-embed.test.tsx`: composer live unfurl (player after
  debounce, skeleton while settling, muted hint after idle).
- `server/src/services/community-home-mobile-rendition.test.ts`: the phone
  cut. Flag off refuses and hides, only beside an uploaded video and only a
  video, add / replace / remove on edit, a new main video drops the old cut,
  delete removes both objects, the lock covers it, the CHECK backstop.
- `client/src/lib/community-home/rendition.test.ts`: which cut a viewport
  plays.
- `client/src/lib/community-home/*.test.ts`: flag resolution, landing,
  visibility helpers, media helpers, live-post toast gating.
- `client/src/components/layout/channel-list-community-home.test.tsx`: the
  row, the unread number, the New chip yielding to it.
- `server/src/services/community-home-translation.test.ts` and `lang-detect.test.ts`:
  off means off (flag off, key unset), a Portuguese post gets English and
  Spanish and a same-language marker, a members-only post's translated body
  never reaches a reader who cannot open it, two machines racing for one
  claim, edit invalidation, the daily budget, per-post truncation, backoff and
  give up, the sweep and the per-server flag, the staff list.
- `server/src/services/community-home-captions.test.ts` (real Postgres) and
  `server/src/speech/captions.test.ts`: flag off means no job and no words,
  publish to source track to translations with the same timings to WebVTT,
  the lock, the flag asked again before the provider, the budget, a replaced
  video, the sweep as backfill, and the worker tick through the real ffmpeg
  when the machine has it.
- `client/src/components/community-home/community-home-media-captions.test.tsx`
  and `client/src/lib/community-home/captions.test.ts`: when the player asks,
  the `<track>` elements, which track is live, on by default only for another
  language, the CC button and what it remembers.
- `client/e2e/community-home-translation.spec.ts`: the real pipeline against a
  stub chat endpoint, the reader's toggle (and that it sticks), a phone, the
  staff note and per-language list.
- `client/e2e/community-home.spec.ts`: forced-off chrome, owner write →
  preview → publish → like, member intro + lock + comments, unread badge +
  live corner card, private-hall landing.
- `server/src/services/community-home-push.test.ts`: the push audience (author,
  mute, mentions level, DND, live socket, VIP, blocks), once-only claim, flag
  off stamps without sending, scheduled posts, the aggregate unread read.
- `client/src/lib/community-home/rail-unread.test.ts` and
  `client/src/components/layout/server-rail-bau.test.tsx`: the rail's pip.

## Not here yet (see the strategy doc)

**Translating comments**, and a reader-chosen language other than the UI one.

**Reporting a Baú post or comment.** `createReportSchema` covers `message`,
`user` and `server` only, so the in-product path for bad content in a Baú is
to report the *person*. Worth closing before this is on by default for
strangers; the queue and the moderation surfaces already exist.

Checkout, plans and prices, polls as a post type, older pages of the feed,
email on publish, a permalink route to one post (a push opens the Baú, not the
post), the Electron surface.
