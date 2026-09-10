# Now playing, and the rest of the recado roadmap

Design note, not a shipped feature. Phase 1 (the recado, a free-text line under
a name) is on `main`. This is what phase 2 would cost.

Read [`docs/CONNECTIONS.md`](./CONNECTIONS.md) first. Everything below is
proposed as an extension of that machinery, not as a new one.

## Where phase 1 got to

`users.custom_status`, 80 characters, plain text, whitespace collapsed, no
control or bidi characters. It reaches other clients on the `profile-update`
frame, the same global fan-out a rename and a new avatar already use. It is
drawn under the name in the member sidebar and on the profile card, and it is
edited in the account's own popover next to the online / dnd / invisible picker.

Two things were deliberately left out, and both belong to this document.

### Expiry

"Clear after 30 minutes / 1 hour / 4 hours / today / never" is not a column and
a dropdown. It is a column, a guard on every read path, and a way to tell the
other clients when the hour is up, and that last part is the expensive one.

The read guard is easy: `CASE WHEN expires_at IS NULL OR expires_at > NOW()`,
in three queries. The push is not. Nothing wakes up at a timestamp to send a
`profile-update`, so a lazily expired status stays on everyone else's screen
until something unrelated makes them refetch. In a room where nobody has
reloaded for six hours, "volto em 30 min" is still on screen at midnight, which
is worse than not offering expiry at all: the person set it precisely so that it
would stop being true out loud.

Doing it properly is a job in `startColdJobs`, running about once a minute,
selecting the rows that have just expired, clearing them and broadcasting one
`profile-update` per row. That is small (`every(60_000, "recado-expiry", ...)`),
but it is a scheduled writer with its own idempotence story, and it is a second
feature rather than a flag on the first one. It is also the natural place to put
the now-playing sweeper below, which is why the two are in one document.

**Recommendation: build expiry together with now-playing, not before it.** They
want the same job.

### The public profile page

`pqp.gg/@rafa` does not show the recado, and that is a decision rather than an
omission. The page is unauthenticated, crawled and unfurled, and the recado is
free text nobody approved. This instance has no text moderation path of any
kind: the only text safety machinery that exists is `safeTextSchema` (control
characters) and the handle blocklist, and `docs/CONTENT_SAFETY.md` is entirely
about images. A depoimento reaches that page because two people consented to it
being there; a recado has consented to nothing except being read by the people
in the room. Putting it on an indexable page is a different decision and needs
the moderation story first.

## Spotify

The one provider where this genuinely works.

### The API

Two endpoints, and they take different scopes:

| Endpoint | Scope | Gives |
|---|---|---|
| `GET /v1/me/player/currently-playing` | `user-read-currently-playing` | The track, the progress, whether it is playing |
| `GET /v1/me/player` | `user-read-playback-state` | The above plus the device and Spotify Connect state |

Sources:
<https://developer.spotify.com/documentation/web-api/reference/get-the-users-currently-playing-track>
and
<https://developer.spotify.com/documentation/web-api/reference/get-information-about-the-users-current-playback>.

**Ask for `user-read-currently-playing` and nothing else.** The device list is
not a status line, and the narrower scope is the one a person can read on the
consent screen and understand.

### It has to be polled

There is no webhook, no push, no event stream for "what is this person playing".
The Web Playback SDK gives real-time state only for a player your own page owns,
which is not what this feature is about: the whole point is the track playing on
their phone or their desktop app. I could not find a Spotify document that says
"there is no push" in those words, so treat this as a well-supported negative
rather than a cited one.

So: a poller. The cost, honestly stated.

- One request per linked, currently-online account per tick.
- At a 60-second tick and 200 linked accounts online, that is 200 requests a
  minute, 288,000 a day.
- Spotify publishes no fixed rate-limit number. It documents a rolling 30-second
  window whose size depends on whether the app has extended quota, and answers
  429 with `Retry-After` when it is exceeded
  (<https://developer.spotify.com/documentation/web-api/concepts/rate-limits>).
  That means the ceiling is discovered in production, which argues for starting
  the tick slow (120s) and a per-account backoff on 429.

The cheap correction that matters more than the tick length: **only poll
accounts with a live socket.** `isPresentForHere` in `server/src/ws/status.ts`
already answers that in memory. Nobody needs to know what an offline person is
listening to, and this removes most of the account base from the loop.

### Tokens, which is the real change

The current connections design has one line that this feature breaks:

> Access tokens are used once to learn who the person is, then discarded. There
> is no token vault. Refreshing a nick is Connect again.

A poller cannot work that way. It needs a stored refresh token, used forever,
and that is a materially different security posture from the one
`docs/CONNECTIONS.md` argues for today. It has to be decided explicitly, not
slid in.

The mechanics, if it is decided yes:

- Access token lives 1 hour; refresh tokens issued through the developer
  dashboard last 6 months and Spotify warns against assuming longer
  (<https://developer.spotify.com/documentation/web-api/tutorials/refreshing-tokens>).
  So the poller must handle "the refresh token is gone" as an ordinary outcome:
  drop the now-playing state, keep the connection row, and ask the person to
  reconnect.
- pqp's API is a confidential client and already holds `TWITCH_CLIENT_SECRET`
  and `BATTLENET_CLIENT_SECRET`, so plain authorization code is the fit. PKCE is
  Spotify's guidance for public clients (a SPA or a mobile app) and is optional
  hardening here rather than the recommended path
  (<https://developer.spotify.com/documentation/web-api/tutorials/code-pkce-flow>).
- Storage: a new nullable `refresh_token` column on `user_connections`, or a
  sibling table if it should be possible to grant the poller a narrower database
  role. Encrypted at rest with a key from a Fly secret, not in plaintext: this
  is the one credential in the product that would let a database leak read
  somebody's listening history.
- The `connection_oauth_states` table, the `/start` and `/complete` routes and
  the SPA callback at `/app/connections/callback/:provider` all work unchanged.
  Spotify is a fourth entry in the provider enum plus a `SPOTIFY_CLIENT_ID` /
  `SPOTIFY_CLIENT_SECRET` pair in `connectionsConfig()`.

### Where the result goes

**Not into `users.custom_status`.** A person's own words and a machine's report
must not share a column, or clearing one clears the other and the poller
overwrites what somebody typed.

A separate `users.now_playing` (or a small `user_now_playing` table with a
`fetched_at`), rendered under the recado, on the same `profile-update` frame,
with its own field. Two lines is one line too many for a member row at 240px,
so the rule at draw time is: the recado wins the second line when there is one,
and now-playing takes it when there is not. The profile card, which has room,
shows both.

Off by default per account. A listening feed is a different disclosure from a
BattleTag, and the existing `visibility` column on `user_connections`
(`hidden` / `shared` / `public`) is the right control, defaulting to `hidden`.

## Apple Music

**No.** Not a scheduling question, an availability one.

- The Apple Music API has `GET /v1/me/recent-played-tracks`
  (<https://developer.apple.com/documentation/applemusicapi/get-v1-me-recent-played-tracks>),
  which is history and not now-playing. There is no currently-playing endpoint,
  and Apple's own developer forums have carried that as an open gap for years
  (<https://developer.apple.com/forums/thread/114660>).
- MusicKit, native and JS, reports playback state only for a player instance
  your own app owns. It cannot read what the system Music app is doing.

So the only route to "Ana is listening to X on Apple Music" is reading the OS
media session on her own machine, which is the desktop option below and not an
API integration at all. Anything that promises Apple Music parity with Spotify
is promising something that does not exist.

## YouTube and YouTube Music

**No**, and more firmly.

- YouTube Music has no official API at all. Google's own support forum carries
  that answer (<https://support.google.com/youtubemusic/thread/80759936>).
- The YouTube Data API v3 exposes no listening presence or currently-playing
  signal.
- What exists is reverse-engineered: `ytmusicapi`, which says in its own README
  that it is not supported or endorsed by Google
  (<https://github.com/sigma67/ytmusicapi>), and browser extensions like PreMiD
  that scrape the DOM of an open tab.

Building on either would mean a terms-of-service exposure and a dependency that
breaks whenever Google reshuffles a page. Not worth it for a status line.

## The desktop shell

Electron could read the operating system's own now-playing, which is the only
route that covers Apple Music, YouTube in a browser tab, local files, and
everything else at once, because it reads what the OS is showing rather than
what a vendor's API admits to.

**Windows** is the good half. `Windows.Media.Control`'s
`GlobalSystemMediaTransportControlsSessionManager` is a public, documented WinRT
API, present since Windows 10 1809
(<https://learn.microsoft.com/en-us/uwp/api/windows.media.control.globalsystemmediatransportcontrolssessionmanager.getcurrentsession>).
It is not callable from plain Node, so it needs either a native addon (which has
to be rebuilt against every Electron ABI bump, a recurring release chore) or a
bundled helper executable that Node spawns and reads JSON from. Packages exist
for both shapes; their maintenance status was not verified and should be checked
against npm before anything depends on one.

**macOS is the bad half, and it got worse.** The private
`MRMediaRemoteGetNowPlayingInfo` stopped answering for unentitled processes in
macOS 15.4, and it is still blocked
(<https://github.com/kirtan-shah/nowplaying-cli/issues/28>). What works now is a
trick: shell out to a system binary Apple already ships with the entitlement
(`/usr/bin/perl`) and load a helper alongside it, which is what
`mediaremote-adapter` does (<https://github.com/ungive/mediaremote-adapter>).
That is an exploit of an Apple oversight, not a platform capability, and it can
break in any OS update, on a client that ships as a signed binary to real
people.

Cost, stated plainly: a native module or a bundled helper per platform, a
release chore on every Electron bump, and a macOS path that is one Apple patch
from being dead. It also only ever works for the desktop app, which is the
smallest of the four clients.

## What to do first

**Spotify, and only Spotify.**

It is the only one of the three that has a real API, it slots into the
connections machinery that already exists (the same `/start` and `/complete`
routes, the same `visibility` control, the same config endpoint), it works for
every client rather than only the desktop one, and it is what the audience
actually uses. Its one genuinely new cost, storing refresh tokens, is a decision
worth making once and reusing later, and it is the only new thing in the whole
design.

Apple Music and YouTube should be answered with "not possible" rather than left
as a backlog item that implies they are coming. The desktop reader is worth
revisiting only if macOS ever gets a supported API, and until then it would be a
Windows-only feature with a maintenance tail.

Order:

1. Spotify connection, identity only, no poller. Reuses everything; ships in a
   day and gives people a Spotify chip on their profile alongside Steam.
2. The expiry job. Small, self-contained, and it is the scheduled writer the
   poller will live next to.
3. Refresh-token storage, encrypted, with the security decision made explicitly
   and `docs/CONNECTIONS.md` updated so its "no token vault" claim stops being
   false.
4. The poller, online accounts only, 120-second tick, per-account backoff on
   429, and a counter that proves it is running. Read that counter. This
   repository has shipped a mechanism that never ran more than once
   (`CLAUDE.md` pitfalls 9 and 12), and a poller that silently stops is exactly
   that shape: everybody's now-playing simply goes quiet, which looks identical
   to nobody listening to anything.
