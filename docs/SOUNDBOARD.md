# Soundboard

A call can play a short clip for everyone in the room. The button sits on
the call bar, next to the music queue. Click sends it.

## Not a second microphone

The file never enters the call. Mesh and LiveKit already share the voice
socket, and that socket carries one small frame: who played which sound.
Each client plays a clip it cached. A second audio track would renegotiate
every mesh peer and fight the LiveKit publish allowlist.

The same choice as the music queue in `docs/MUSIC.md`. A watch-party
recording does not contain the clip. People in the call hear it. A VOD
does not.

Built-in clips ship with the client (`client/public/sounds/soundboard/`).
They are recorded reactions, trimmed under 5.2 seconds, encoded as 128 kbps
mp3 (about 320 KB for all six) because every browser decodes mp3. A call
join downloads them once. CC0 and the
public-domain sting do not require credit. The list is here so the
license stays with the files.

| File | Source |
|---|---|
| `palmas.mp3` | Breviceps, Freesound 462362, CC0. About 30 people clapping. |
| `risada.mp3` | Joseph Sardin, BigSoundBank 490, CC0. The first laugh. |
| `buzina.mp3` | guitarguy1985, Freesound 68999, CC0. The horn hit. |
| `grilo.mp3` | Joseph Sardin, BigSoundBank 1020, CC0. Two seconds of a field cricket. |
| `ba-dum-tss.mp3` | Bart Nagel, public domain. Wikimedia Commons `Sting.ogg`. |
| `trombone.mp3` | kirbydx, Freesound 175409, CC0. Trailing silence removed. |

The pictures on the tiles are separate from the clips. Clap, laugh, airhorn,
and the speaker mark are Material Design Icons by Pictogrammers, Apache 2.0.
Cricket is by Delapouite, and the drum kit and trombone are by Caro Asercion, from [game-icons.net](https://game-icons.net),
CC BY 3.0.

Custom clips live in the same bucket as attachments, capped at 24 per
server, 512 KB, and 5.2 seconds, mp3 or ogg. A new upload is refused when
the board is already full, counting uploads that were signed and not
claimed yet. An unclaimed file is deleted when that signature expires,
and only when no saved clip still points at it.
Play clicks are not stored.

## Turning it on

The runtime flag `soundboard` gates everything (env `SOUNDBOARD`, default
off, per server). Off, the call has no button, the settings tab is hidden,
uploads and edits answer 403 `soundboard_disabled`, and the server drops
every play. Listing and deleting clips still work, so a moderator can take
a clip down after the flag goes off. The play gate reads the flag on every
click, so turning it off silences a call that is already running.

Turn it on for one server first:

1. Open controles → interruptores on the dashboard.
2. Add a server override for `soundboard` with the server's id.
3. Check it in a call with two accounts.
4. Turn it on globally once it holds.

The client reads it as `soundboard` on `GET /api/voice/config?serverId=`.
It asks again on focus and on a slow timer, so the button follows a flip
without a rejoin.

## Who can do what

`USE_SOUNDBOARD` is on for `@everyone`. A channel overwrite can turn the
board off in one room without taking Speak. You have to be seated. A
moderator mute blocks it. Muting yourself does not. Deafening yourself
only stops you hearing it.

A clip needs an open microphone. Whoever may not speak may not play one.
That covers a channel that denies Speak, a watch party floor closed to
hosts only, audience mode, and a moderator mute. The button is hidden for
those seats and the server refuses their plays.

A click is only shown as played when the room echoes it back. The server
refuses in silence (the room's twelve, your own three, a mute), so a click
with no echo in three seconds tells the person it did not play, or that
the clip was removed when the refreshed list no longer has it. The client
also sends at most a short burst: holding a key does not repeat plays.

`MANAGE_SOUNDBOARD` adds, renames, and deletes clips. In server settings,
the pencil on a row renames it (Enter saves, Escape cancels). Delete asks
for confirmation first. The count and the Add button follow the number the
server refuses at: stored clips plus uploads in flight. It is on for manager
and owner, off for `@everyone`. A server can hand it to a role. Audio is
not scanned.

DMs have no library. Phones do not play the frame yet. Web and Electron do.

The room accepts twelve clips at once, including several from the same
person. Extra clicks past that are dropped. Muting the board is local.
It cuts what you are hearing, including a clip already playing. The
volume slider does the same. Your clicks still go out to the room.

A play lights that person's row under the voice channel, and the same
icon on their tile when the stage is up. It lasts a couple of seconds.
Another click swaps the icon. Muting the board does not hide it.
