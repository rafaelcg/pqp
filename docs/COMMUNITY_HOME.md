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
| `COMMUNITY_HOME_ENABLED` | off | The surface exists. Off: every `/home/*` route 404s, the schedule sweep idles, the client hides the row. |
| `COMMUNITY_HOME_VIP_ENABLED` | off | The VIP half. Off: `visibility: members` is refused on write, existing members-only posts leave the feed (staff still see them in Drafts), and the client shows no lock, no VIP chip, no tier picker and no "view as" inspector. Needs the first flag. |

Do **not** reuse `COMMUNITIES_ENABLED`. That one changes the instance's legal
category (STF, Art. 19, see `docs/CONTENT_SAFETY.md`); this one only adds a
feed. There is no `VITE_` flag: the client asks `GET /api/community-home/config`
(`{ enabled, vipEnabled, mediaEnabled }`, always 200) and follows it, the way
it follows the attachments and communities configs. `mediaEnabled` is the
`S3_*` probe folded in, so a deployment without storage still gets the feed
with YouTube links and text.

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
| Everyone else | Free posts in full. Members-only posts as title + teaser + lock, with body, media **and comment words** stripped on the API (the count survives). |

Visibility is enforced in `server/src/services/community-home.ts` (`toPost`);
the client never reconstructs a locked post from what it has. The staff-only
"view as member without VIP" switch (`?homeViewer=members`, `pqp:community-home-viewer`)
only changes how a manager's own screen renders `post.locked`; it exists so
staff can check the teaser without a second account.

The unlock CTA is disabled and reads "VIP, coming soon". There is no checkout.
See [`BAU_VIP_STRATEGY.md`](./BAU_VIP_STRATEGY.md) for what would replace it.

## What is in the pane

- **Row** in the channel list above TEXT on every server while the flag is on.
  Landing on Baú is community-only: `isCommunity` servers open on the feed,
  private halls still open on the first text channel
  (`client/src/lib/community-home/landing.ts`).
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
  `mediaEnabled`, else YouTube only), comments on/off, VIP toggle + teaser
  when `vipEnabled`. **Preview** renders the card as members will see it, and
  the locked version too for a VIP post. **Publish**, **Save draft**, or
  **Schedule** (a `datetime-local` in the browser's timezone; the API stores
  the instant plus the IANA name).
- **Drafts tab**: drafts and scheduled posts with Publish now / Unschedule /
  Edit / Delete.
- **Cards**: no "free" chip ever; a VIP chip only on a members-only post
  while the VIP flag is on. Heart with a count. The two newest comments under
  the card, "See all N" fetches the rest. Delete is a two-step button, not a
  browser dialog.

## Media

Image, native video (`mp4`/`webm`), PDF, up to 100 MiB each (`COMMUNITY_HOME_MAX_BYTES`; attachments stay at 10 MiB), through the same
mint / PUT / claim dance as attachments (`client/src/lib/community-home/media.ts`,
`POST …/home/media`, `POST …/home/media/claim`). Bytes never pass through the
Node process. YouTube is URL only (`watch`, `youtu.be`, `shorts`, `embed`,
`live`), embedded from `youtube-nocookie.com`. Over-limit video is refused
with "upload it to YouTube". Files are signed as downloads, never inline.

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
then push to `staging`. Staging has no `S3_*`, so `mediaEnabled` is false
there: the composer offers YouTube and text only. That is the expected shape
of a self-host without storage, not a bug.

## Tests

- `server/src/services/community-home.test.ts`: flag off 404s, config answers
  200, member vs staff vs VIP visibility (including comment words), VIP flag
  off refuses and hides, drafts never reach members, schedule sweep, teaser
  survives an edit, comments and likes.
- `client/src/components/community-home/community-home-feed.test.tsx`: the
  card's contract (no free chip, locked leaks nothing, two comments max).
- `client/src/lib/community-home/*.test.ts`: flag resolution, landing,
  visibility helpers, media helpers.
- `client/e2e/community-home.spec.ts`: forced-off chrome, owner write →
  preview → publish → like, member intro + lock + comments, private-hall
  landing.

## Not here yet (see the strategy doc)

Checkout, plans and prices, polls as a post type, pagination of the feed,
push or email on publish, Electron / Android / iOS surfaces (web only for now;
the native apps show nothing and lose nothing).
