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

`MANAGE_SOUNDBOARD` adds, renames, and deletes clips. In server settings,
the pencil on a row renames it (Enter saves, Escape cancels). Delete asks
for confirmation first. The count and the Add button follow the number the
server refuses at: stored clips plus uploads in flight. Each row says who
added the clip; the list only carries that for people who manage the board.
Adding, editing and deleting a clip are written to the server's audit log
(`soundboard.create`, `soundboard.update`, `soundboard.delete`), with the
clip's name, because audio is not scanned. It is on for manager and owner,
off for `@everyone`. A server can hand it to a role.

DMs have no library. Phones do not play the frame yet. Web and Electron do.

The room accepts twelve clips at once, including several from the same
person. Extra clicks past that are dropped.

## What a listener controls

Everything here is local. It changes what you hear and see, and tells the
room nothing. Your own clicks still go out.

1. Muting the board cuts what you are hearing, including a clip already
   playing. The volume slider does the same.
2. Deafening cuts every clip already playing. Before, it only stopped the next
   one. Self-muting does not cut anything, as on Discord. The server still
   counts those clips toward the player's own three.
3. Muting one person stops their clips, sound and mark both, even a clip
   already playing or still loading.
4. A muted person shows a small muted speaker on their row under the voice
   channel, on their chip in the listener row, and in their menu header. It
   has an accessible name. The row's name says it too.
5. Two tabs of one account share the board mute, the volume and the person
   mutes. A change in one tab reaches the other at once, and a person muted in
   the other tab is cut here too.
6. The muted list keeps the newest 500 people.

### Where the person mute is

It is the "Soundboard" switch in a person's audio menu. On means their clips
play. The switch is named "{name}'s soundboard sounds". The name contains the
row's visible word "Soundboard", so the visible word and the name agree. The
menu opens from:

- their row under the voice channel (click, Enter or Space; Escape returns the
  focus to the row),
- their chip in the listener row under the stage,
- their face on the collapsed call bar,
- the "+N" after the three faces on that bar, which lists the rest and opens
  the picked person's menu,
- the room view, and the overlay of their camera or screen tile.

The row is there for any other person in a server call whose board is on,
even when their voice track failed or has not started: their clips arrive
over the voice socket, not over the voice track. It is never there for
yourself, and never in a DM.

The call bar's menu is drawn outside the bar, fixed beside the face. It opens
upward and flips when there is no room, so the bar's hidden overflow cannot
clip it.

### The mark

A play lights that person's row under the voice channel, and a small badge
on their face when the stage is up. On the collapsed bar and the listener row
the badge is a corner badge inside the small avatar, so it never hides the
face. On the large room-view face it is a disc over the top.

The mark lasts as long as the clip: a built-in's length, or a custom
clip's length from the catalog, never under 1.2 seconds and never over the
5.2 second cap. A custom clip this machine has not heard of yet is assumed
to be 2.2 seconds, and corrected when the list arrives. Another click from
the same person swaps the icon. Muting the board does not hide it.

A custom clip's name is read when the mark is drawn. When somebody plays a
custom clip, this machine asks the server for the list again in the
background, at most every 15 seconds, so a rename shows up in the mark and
the float without reopening the panel. An open panel also polls every 20
seconds and listens to the same store, so uploads, renames and deletes appear
in it.

In the panel the arrow keys move between clips, Home and End jump to the
ends, and Tab moves on to the mute, the volume and Add. A custom clip's
full name shows in a tooltip on hover and focus, since a long name is cut
to two lines on the tile. At 24 of 24 the Add button stays focusable and
its tooltip says the board is full. When a lock arrives (deafened, a
moderator mute) while focus is in the panel, the panel closes and focus
returns to the call bar button. Muting the board shows a small muted mark
on that button, and its name says so.
