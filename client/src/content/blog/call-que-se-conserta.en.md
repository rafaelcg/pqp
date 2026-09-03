A week of repairs. Most of what shipped is not a new thing to click. It is a thing that used to break and now sorts itself out, or at least tells you what to do about it. The full list is at the end.

## The stubborn microphone

Somebody could not get into a voice channel. They changed the microphone in settings and it worked. The problem is that they had to work that out alone.

Now pqp tries the microphones in order: the one you picked, the computer's default, then whatever else is there. The first that opens wins, and the call tells you which one it landed on. If none of them open, the message stops being an error in English and starts saying what it usually is: another program holding the mic, or a bluetooth headset that went to sleep. Next to it is a button straight to voice settings.

One thing it no longer does: ask for permission again after you said no. Asking twice in a row is the fastest way for a site to end up blocked for good.

## The "connecting" that never finished

Someone was stuck on "connecting" on their computer and their phone, on two different networks. The server was up for everyone else.

Very different problems freeze in the same way, behind the same spinner: your session expired, an ad blocker ate the sign-in, your network allows websites but blocks voice calls, or there is no route to the sound relay. Before, all of them said "reconnecting", forever.

Now there is a **Check connection** button. It runs five tests, shows each result as it lands, and finishes with one sentence naming what is stuck. There is a button to copy the result and paste it in the QG, and if your session is genuinely gone you get **Sign in again** instead of an endless retry.

## Screen sharing with sound

Two problems, one on each side.

On Windows, turning sound on sent the call back into itself and everybody heard their own echo. That is fixed in the new desktop app (v0.1.4). If you already have pqp installed it updates itself.

The other one: you ticked the sound box, picked a screen, and nothing happened at all. Sound and picture travel in the same request, so a screen with no sound to give took the whole share down, picture included. Now pqp only asks for sound where sound exists, and when it still fails there is a **share without sound** button right there.

## Our privacy policy was wrong

It said there were no trackers at all. That stopped being true when our visit counter and the Google Ads tag shipped, and the text was left behind. Corrected: pqp.gg uses a cookie-less visit counter and a tag that only counts sign-ups. We do not do remarketing and we do not build audience lists. Anyone running pqp on their own server inherits none of it.

## Everything that changed

### New

- **Favorite a channel.** Click the star and it moves to the top of your list, so you stop hunting for it.
- **VIP cargo.** A ready-made lilac cargo for marking whoever you want. It shows separately in the member list and grants no extra powers.
- **Who is who.** Owner, admin, manager, moderator and VIP now show a mark next to the name.
- **Camera on a call.** A voice-only call stays a thin bar. Turn on a camera or a screen and it becomes a full stage, with fullscreen and collapse.
- **One click to join.** Click a voice channel and you are in.
- **Formatted text in chat.** Bold, lists and code blocks, the same as Discord. Shift+Enter breaks a line without sending.
- **Bringing a Discord server across.** The copy now also brings each cargo's permissions and the server icon.
- **Unread counts on the server bar.** A badge with new messages and mentions.
- **Faster GIFs.** We changed who provides GIF search.
- **Knowing a DM arrived.** A card appears with who sent it and a button to open, with its own sound you can switch off and a count in the tab title.
- **Finding out why you cannot connect.** The Check connection button runs five tests and says what is stuck.
- **Support page.** `/support`, with GitHub Sponsors and Pix. Donating gets you nothing in the app, and it never will.
- **Shorter welcome.** The several first-run windows became one.
- **iPhone app updated.** A new TestFlight version went out.

### Fixed

- You could not join a voice channel when your microphone would not open. pqp now tries the others itself and tells you which one it used.
- When no microphone opens, the message now explains what it usually is instead of showing an error in English.
- pqp no longer asks for microphone permission again right after you denied it.
- The "connecting" that never finished now has a way out: retry now, check the connection, or sign in again.
- Sharing a screen with sound on Windows sent the call back as echo. Fixed in the new desktop app, which updates itself.
- Ticking "share sound" and the screen never appearing for anyone.
- The voice channel list showed your real name instead of your nickname on that server.
- Changing your nickname did not reach people already in a call with you.
- A direct message from another day looked like it had just arrived.
- Our privacy policy said there were no trackers at all, which was no longer true.
