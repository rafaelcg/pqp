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
| `vidro.wav` | Joseph Sardin, BigSoundBank 148, CC0. A glass bursting on the floor. |
| `ba-dum-tss.wav` | Bart Nagel, public domain. Wikimedia Commons `Sting.ogg`. |
| `trombone.wav` | kirbydx, Freesound 175409, CC0. Trailing silence removed. |

Custom clips live in the same bucket as attachments, capped at 24 per
server, 512 KB, and 5.2 seconds, mp3 or ogg. Play clicks are not stored.

## Who can do what

`USE_SOUNDBOARD` is on for `@everyone`. A channel overwrite can turn the
board off in one room without taking Speak. You have to be seated. A
moderator mute blocks it. Muting yourself does not. Deafening yourself
only stops you hearing it.

`MANAGE_SOUNDBOARD` adds, renames, and deletes clips. It is on for manager
and owner, off for `@everyone`. A server can hand it to a role. Audio is
not scanned.

DMs have no library. Phones do not play the frame yet. Web and Electron do.

The room accepts three clips at once. You cannot stack your own. Extra
clicks are dropped in silence.
