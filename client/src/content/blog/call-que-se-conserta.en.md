A week of repairs. Most of what shipped is not a new thing to click. It is a thing that used to break and now sorts itself out, or at least tells you what to do about it.

## The stubborn microphone

Somebody could not get into a voice channel. They changed the microphone in settings and it worked. The problem is that they had to work that out alone.

Now pqp walks the microphones in order: the one you picked, the system default, then every other one the browser lists. The first that opens wins, and the call tells you which it landed on. If none of them open, the message stops being "Could not start audio source" in English and starts saying what it usually is: another app holding the mic, or a bluetooth headset that went to sleep. A button next to it goes straight to voice settings.

One thing it no longer does: ask for permission again after you said no. Asking twice in a row is the fastest way for a site to get blocked for good.

## The "connecting" that never finished

Someone was stuck on "connecting" in the desktop app and on their phone, on two different networks. The API was up for everyone else.

From the client, four very different things look like that same spinner: a refused session, a token that never comes back (a DNS filter or an ad blocker sitting on the sign-in service), HTTPS allowed but WebSockets blocked, and a network with no route to a relay. The banner said "reconnecting" to all four, forever.

Now there is **Check connection**: five tests, each result landing as it arrives, ending in one sentence that names the problem. There is a button to copy the report and paste it in the QG. If the session was refused twice in a row, you get **Sign in again** instead of an infinite retry.

## Screen sharing with sound

Two problems, one on each side.

On Windows, turning sound on sent the call back into itself and everybody heard their own echo. That one is fixed by the new app (v0.1.4), because the fix lives in the shell rather than the page. Existing installs pick it up on their own.

The other: tick the sound box and the share simply never starts. Audio and video are one request, so a screen with no sound to give takes the whole capture down, picture included. Now the app only asks for sound where it can be delivered, and when it still fails there is a **share without sound** button right there instead of nothing happening.

## Your name in a call

If you have a nickname on a server, the voice channel list showed your real name while the rest of the screen showed the nickname. It is the nickname in both places now, and renaming yourself mid-call updates for everyone already in the room.

## A DM you cannot miss

A direct message arriving while you read a channel was easy to miss: a red dot, and that was it. Now there is a card under the channel header with who sent it and a button to open, its own sound (with its own switch in settings), a count in the tab title, and dates on conversations: today shows the time, yesterday says "Yesterday", older shows the day. A message from last week stopped looking like it just arrived.

## The rest

**Favorites.** Star a channel and it moves to the top of the list. It moves, it does not become a copy.

**VIP cargo.** Lilac, listed on its own, with no extra powers. It is there to mark whoever you want to mark.

**Camera on the call.** A voice-only call stays a slim bar. Turn on a camera or a screen and it grows into the full stage, with fullscreen and collapse.

**One click joins.** Clicking a voice channel row joins it. The phone icon that used to sit there is gone.

**New GIFs.** GIF search changed provider and got faster.

**Support page.** `/support` with GitHub Sponsors and Pix. Donating unlocks nothing, and it is not going to.

**First run.** It was six kinds of window with six kinds of animation. It is one system now.

**Phones.** Android and iOS caught up, and a new TestFlight build went out.

## And the privacy policy

It said there were no trackers at all. That stopped being true when analytics and the Google Ads conversion tag shipped, and the text was left behind. Corrected: hosted pqp.gg uses cookie-less analytics and a tag that counts sign-ups, nothing else. No remarketing, no audience lists. Anyone running pqp on their own server inherits none of it.
