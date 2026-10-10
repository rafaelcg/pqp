# Retrospectiva (year in review)

A personal recap of the year, shown as stories in December, with a card to
share. Design mockups: the "Retrospectiva pqp 2026" canvas in Claude Design.

## Status

1. **Tracking: this branch.** The counts below start the day it ships.
2. **Recap job and screens: not started.** Target release about 4 December,
   open until about 15 January.

## Why tracking comes first

The database did not keep most of what a voice app's recap needs:

- A voice seat (`voice_peers`) is deleted when its person leaves.
- The music queue lives on the room and is replaced on every write.
- Watch party viewer rows (`hls_session_viewers`) are pruned a day after the
  last sighting.

Nothing can rebuild those days later. Every day without tracking is a day
missing from the recap.

## What is already in the database

| Stat | Source | Limit |
|---|---|---|
| Messages, top channel, top server | `messages` | Servers with `message_retention_days` lose old rows. |
| People you talked to most | DMs in `messages` | Only for the person viewing. |
| Reactions, favourite emoji | `message_reactions` | Gone with the message. |
| Peak hour | `messages.created_at` | Posters only. |
| Friends added, servers joined | `friendships`, `server_members` | A server you left is gone. |
| Days active | `user_activity_days` | Since 27 September 2026. |
| Watch parties hosted | `channel_sessions.host_user_id` | |
| Baú posts and likes | `community_home_*` | |
| Badges | `user_badges` | |

## What this branch records

`server/src/services/user-stats.ts`. All of it is counts per person per São
Paulo day, or which parties a person watched. Nothing records who was in a
call with whom.

| Table | Column | How |
|---|---|---|
| `user_daily_stats` | `voice_seconds` | One-minute sampler over live seats in rooms of two or more real people. |
| `user_daily_stats` | `share_seconds` | Same sampler, seats with `sharing_screen`. |
| `user_daily_stats` | `music_queued` | Noted where a music write is accepted, flushed once a minute. |
| `user_watch_parties` | one row per party | Copied from `hls_session_viewers` every 15 minutes. |

The rules:

1. The sampler reads the same sources as the voice occupancy sampler. A worker
   that cannot see seats writes nothing and counts `blindTicks`.
2. Each minute is added once. The row stores the last minute bucket it added.
3. A seat held for resume, a room of one, a bot and a second tab add nothing.
4. A queue adopted from another machine adds no tracks.
5. Runtime flag `user_stats` (default on) stops every write.
6. Everything is deleted with the account.

Known gap: a seat in a live party that never loaded the stream (host,
co-host, speaker) has no viewer row. Hosting is counted from
`channel_sessions`.

## Privacy

The privacy policy names this data in both languages ("Retrospectiva" /
"Year in review"). Before release, add:

1. An opt-out in Privacidade that hides the recap.
2. The new tables to the data export.

## Open decisions

1. Store the track id of queued songs, so the recap can show a top song?
   Today only the count is kept.
2. Export the last 14 days of `voice.join` and `voice.leave` logs from
   Grafana to backfill call time from about 26 September? The window
   shrinks by one day each day.
