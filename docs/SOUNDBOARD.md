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
They are recorded reactions, trimmed under 5.2 seconds. CC0 and the
public-domain sting do not require credit. The list is here so the
license stays with the files.

| File | Source |
|---|---|
| `palmas.wav` | Breviceps, Freesound 462362, CC0. About 30 people clapping. |
| `risada.wav` | Joseph Sardin, BigSoundBank 490, CC0. The first laugh. |
| `buzina.wav` | guitarguy1985, Freesound 68999, CC0. The horn hit. |
| `grilo.wav` | Joseph Sardin, BigSoundBank 1020, CC0. Two seconds of a field cricket. |
| `ba-dum-tss.wav` | Bart Nagel, public domain. Wikimedia Commons `Sting.ogg`. |
| `trombone.wav` | kirbydx, Freesound 175409, CC0. Trailing silence removed. |

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

## Who can do what

`USE_SOUNDBOARD` is on for `@everyone`. A channel overwrite can turn the
board off in one room without taking Speak. You have to be seated. A
moderator mute blocks it. Muting yourself does not. Deafening yourself
only stops you hearing it.

`MANAGE_SOUNDBOARD` adds, renames, and deletes clips. It is on for manager
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
