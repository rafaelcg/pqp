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

**Plus one per-server switch.** With the instance flag on, each server still
starts with Baú off. An owner turns it on in Server settings (the Baú section,
`PATCH /api/servers/:id/home/config`, column `servers.community_home_enabled`).
The row, the landing and the feed need both on a private hall. A community
always lands on Overview (identity), even with Baú still off; the feed stays
empty until staff turn it on, and only if the instance flag is on. Until the row is
opened once on a server it carries a small "New" chip (`localStorage`, per
server, `client/src/lib/community-home/new-badges.ts`).

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

## Schedule

`status = scheduled` rows flip to `published` in `publishDueCommunityHomePosts`,
called every 30 s and on boot from `server/src/index.ts`, single process, no
worker. A missed tick is caught by the next one. Each flip fans out a
`community-home-update` frame (server-scoped, per member, never a channel
relay) and clients refetch. Likes deliberately do **not** fan out.

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
  off refuses and hides, drafts never reach members, schedule sweep, teaser
  survives an edit, comments and likes.
- `packages/shared/src/community-home.test.ts`: YouTube / Twitch / TikTok /
  Instagram URL classifiers (profiles, stories and short links refused).
- `client/src/components/community-home/community-home-feed.test.tsx`: the
  card's contract (no free chip, no author row, locked leaks nothing, likes
  and comment count stay on locked cards, two comments max, Twitch / TikTok /
  Instagram iframes).
- `client/src/lib/community-home/embed-preview.test.ts` and
  `community-home-compose-embed.test.tsx`: composer live unfurl (player after
  debounce, skeleton while settling, muted hint after idle).
- `client/src/lib/community-home/*.test.ts`: flag resolution, landing,
  visibility helpers, media helpers, live-post toast gating.
- `client/src/components/layout/channel-list-community-home.test.tsx`: the
  row, the unread number, the New chip yielding to it.
- `client/e2e/community-home.spec.ts`: forced-off chrome, owner write →
  preview → publish → like, member intro + lock + comments, unread badge +
  live corner card, private-hall landing.

## Not here yet (see the strategy doc)

**Reporting a Baú post or comment.** `createReportSchema` covers `message`,
`user` and `server` only, so the in-product path for bad content in a Baú is
to report the *person*. Worth closing before this is on by default for
strangers; the queue and the moderation surfaces already exist.

Checkout, plans and prices, polls as a post type, older pages of the feed,
push or email on publish, Electron / Android / iOS surfaces (web only for now;
the native apps show nothing and lose nothing).
