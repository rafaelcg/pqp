Your camera now sends 720p, and you pick the quality.

## The selector

In Settings, Voice and video:

| Option | What it asks for |
|---|---|
| **Auto** (default) | 720p, handing resolution back when the connection needs it |
| 1080p | 1920x1080 |
| 720p | 1280x720 |
| 480p | 854x480 |
| 360p | 640x360 |

**Auto does not mean "no opinion".** It asks for 720p and lets the connection take resolution back when it cannot carry it, in both directions: it drops when things tighten and climbs when they clear.

The fixed options are for when you know something the browser does not. Hotel wifi, a metered connection, an old laptop running hot: pin it to 480p and forget about it.

Changing it mid-call **does not turn the camera off**. The light does not blink and nobody disappears, because the change is applied to the track already in the air rather than capturing everything again.

Next to the selector there is a number: what you are actually sending, right now, in size, frames and kbps. If the connection is holding you back, it says so. Better to show it than to let you guess why the picture looks bad.

## Why 720p is news

When pqp turned the camera on, it asked the browser for this:

```
getUserMedia({ video: true })
```

That is the whole request. No size, no frame rate, nothing. When you do not ask for a size, the browser picks, and Chrome picks **640x480**. Firefox and Safari land in the same place.

So your 1080p webcam was sending 480p because nobody ever asked it for more. There was no cap, no plan limit, no bandwidth saving. There was a request we never made.

The worse part comes after. From 480p, the first step down when the connection tightens is 320x240. So the network only had to dip slightly for the picture to turn into that blurry little square, because it started the call one step above the floor.

Screen sharing never had this problem, because there we asked for 1080p properly. The camera needed the same treatment, and now it has it: 720p at 30 frames, with a bandwidth ceiling of its own instead of wrestling the screen share for whatever is left.

## Fullscreen with two screens

Since last week two people can share a screen at once. The fullscreen button, though, was older than that, and did what it had always done: it put **both** of them fullscreen together, side by side, each at half the space.

Now each screen has its own button, and it only appears when there is more than one. Switching from one to the other does not exit and re-enter fullscreen, it just switches. Escape exits, as always.

On the way we found a worse bug than that one, in the server voice panel: with two screens open on an iPhone, one covered the other's exit control. A fullscreen you could not leave. That is fixed too.

## Fixed since the last post

Fullscreening a shared video in Safari on iPhone went black. It was queued in the last post. It shipped, and it works.

## Not yet

- Sending your iPhone screen. You can watch, you cannot broadcast.
- Sound when sharing a whole screen on macOS. Browser limit, not ours.
- 1080p is not a guarantee. It is a request. A webcam that cannot do 1080p gives what it has, and a bad connection drops the resolution even with the option pinned. The number next to the selector exists precisely so that stays visible.

Just want to share a screen with friends and see what works today? There is an honest comparison at [sharing a screen in the browser](/tela).
