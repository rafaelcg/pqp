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
board off in one room without taking Speak. You have to be seated.

The rule matches Discord's: you may play while self-muted, and not while
deafened (you would play what you cannot hear) or moderator-muted. A clip
also needs an open microphone, so a channel that denies Speak, a watch
party floor closed to hosts only, and audience mode lock the board too.
For all of these the button stays, disabled, and its tooltip says why.
Only a missing permission or the flag being off hides it. The server
refuses the play either way.

Each person has two limits on plays.

1. At most three of your own clips may sound at once
   (`SOUNDBOARD_USER_CONCURRENCY` on the server). A built-in clip lasts 2.2
   to 4.6 seconds, so three quick clicks fill the limit and the fourth waits
   until the first clip ends.
2. A play budget: five plays, then one more every two seconds
   (`SOUNDBOARD_PLAY_BURST`, `SOUNDBOARD_PLAY_REFILL_MS`). A full budget
   banks no time. The two-second clock starts at the play that takes the
   budget below full. The caps alone let one person replay a short clip back
   to back forever.

With the built-in pack, the first limit stops you at three clips in a row.
Five in a row works only with custom clips short enough to end before the
fourth click. A click the server
refuses for the first limit does not spend budget.

The client keeps a copy of both limits (`takeSendToken` and the overlap
count in `client/src/lib/soundboard.ts`). A click over either limit is not
sent, and the panel says at once that it did not play. The overlap count
starts each clip's clock at the click and uses the clip's known length. It
can let through a click the server then refuses, never block one the server
would accept. Leaving the call resets it.

A click is only shown as played when the room echoes it back. The server
refuses in silence (the room's twelve, your own three, the budget, a
mute). The client cannot predict every one of these, so a click with no echo
in three seconds tells the person it did not play, or that the clip was
removed when the refreshed list no longer has it. Holding a key does not
repeat plays.

`MANAGE_SOUNDBOARD` adds, renames, and deletes clips. A member who holds only
this permission still gets "Community settings" in the server header menu, and
the dialog opens on the Soundboard tab. In server settings, the pencil on a row
renames it (Enter saves). Escape cancels the rename and nothing else, wherever
focus is, unless another dialog is open over it. Delete asks for confirmation
first. A clip that someone else already deleted counts as done: the list
refreshes and no error shows.

The counter shows the clips on the list. Uploads in flight sit on their own
line ("1 upload in progress"). The server still refuses at stored clips plus
uploads in flight, so Add is off only when that sum reaches the cap, and the
page says when uploads are the reason. While any are in flight it asks the
server again every 15 seconds, because an upload nobody claims is swept a few
minutes after it was signed. Each row says who added the clip; the list only
carries that for people who manage the board.

Closing the add dialog while it saves cancels the transfer. A save that ends
after the dialog closed cannot close or fill the next one. If the clip was
added anyway, the list refreshes.

Adding, editing and deleting a clip are written to the server's audit log
(`soundboard.create`, `soundboard.update`, `soundboard.delete`), with the
clip's name, because audio is not scanned. The log shows the name on every
row, and old to new on a rename or a volume change. Each row is written once:
only the claim that created a clip writes `create` (a retry or a parallel claim
of the same upload does not), only the delete that removed the row writes
`delete` (the others get 404), and an edit that changes nothing writes no
`update`. A delete removes the row first, which decides the winner, and then
the object. If storage fails, the row is put back and the delete answers 503.
It is on for manager and owner, off for `@everyone`. A server can hand it to a
role.

A clip name needs 2 to 24 characters and something people can see. Hangul
fillers, the Braille blank, control characters, tag characters, zero-width
characters and bidi controls are refused.

DMs have no library. Phones do not play the frame yet. Web and Electron do.

The room accepts twelve clips at once, including several from the same
person. Extra clicks past that are dropped. Muting the board is local.
It cuts what you are hearing, including a clip already playing. The
volume slider does the same. Your clicks still go out to the room.
Muting one person is in their audio menu (click them under the voice
channel or on the stage): "Soundboard" turns their clips off for you only,
sound and mark both. Discord has only the global slider.

The call bar button is the party popper icon. The waveform it used before
is the "speaking" mark elsewhere in the call. Watch party and onboarding use
the same icon, but only outside a call.

In the panel the arrow keys move between clips, Home and End jump to the
ends, and Tab moves on to the mute, the volume and Add. The arrows step by
the number of columns the grid draws, which is one number for both. A custom
clip's full name shows in a tooltip on hover and focus, since a long name is
cut to two lines on the tile. At 24 of 24 the Add button stays focusable and
its tooltip says the board is full. The count reads "21 of 24 sounds"; the
noun agrees with the maximum, so it is plural-aware on that number. The
footer wraps, so the volume slider keeps at least seven rem. When a lock
arrives (deafened, a moderator mute) while focus is in the panel, the panel
closes and focus returns to the call bar button. Muting the board shows a
small muted mark on that button, and its name says so.

A locked button is an outline with a small lock badge. It keeps the
secondary text colour, because a dimmed icon measured 3.0:1 in the light
theme. It stays focusable (`aria-disabled`). A tap or Enter on it shows the
reason in a small note above the button, with the same text the tooltip uses.
The note goes after four seconds, on a tap anywhere else, on Escape, or on a
second tap on the button. It never takes focus. A tooltip is inert on touch,
so this note is the only place a phone shows the reason.

On a phone the board is a sheet, not the 280px popover. The sheet is used when
the window is under 640px wide or under 520px tall. The height half is what
catches a phone on its side, which is wide but short. The sheet sits above the
call bar, not over it, so the mic and the other controls stay usable. It is up
to 640px wide, with as many columns as fit tiles at least 76px wide (up to
six), and has a close button. Tapping outside it also closes it. On a larger
window the board stays the popover, anchored to the button, with three
columns. Both measure their natural height each time the window changes, so a
panel placed in a short window grows back when the window gets taller.

On a coarse pointer, and always in the sheet, the mute button, the volume
slider's hit area and Add are at least 40px. The drawn slider track and thumb
do not change.

The "didn't play" notice is a soft warning fill with a small alert icon. Its
text uses the soft warning text token, which the design bench measures at 4.5:1
in every theme. It does not rely on colour alone.

A play lights that person's row under the voice channel, and the same
icon on their tile when the stage is up. It lasts a couple of seconds.
Another click swaps the icon. Muting the board does not hide it.
