Screen sharing now carries **sound**. And the picture stopped stuttering.

## The sound

Until today, sharing your screen sent the picture only. A film with no audio, a game with no audio, a clip with no audio. Everyone on the other side watched mouths move and heard nothing.

Now the audio goes too. One thing matters: the browser only hands over the sound if you **share a Chrome tab and tick "Also share tab audio"**. pqp says so at the moment you press share, because that box is easy to miss.

Where it works today:

| Situation | Sound |
|---|---|
| Chrome or Edge, sharing a **tab**, box ticked | yes |
| Chrome or Edge on Windows, whole screen | yes |
| Chrome on macOS, whole screen or a window | no |
| Safari and Firefox | no |

Without the box, anywhere, it stays video only. That is not a fault, it is a browser limit, and pqp says so on screen rather than letting you find out from the silence on the other side.

## The picture

This was the annoying one, and the cause was embarrassing: we had never told the browser what we were sending. With no hint, the encoder assumes a shared screen is a spreadsheet, and spreadsheets are optimised for sharpness: it holds resolution and spends the motion. Perfect for still text, terrible for anything that moves.

We flipped the priority to motion, capped the capture at 1080p30, and started splitting the upload across the people in the room instead of sending the same amount to each of them. Films, games and matches now look live rather than like a series of stills.

## One question after a call

When a call ends, if it lasted more than a minute and somebody else was there, a small question appears: 1 to 5, how was it. A low score opens an optional box for what broke.

It asks at most once every six hours, and closing it without answering counts the same as answering. We are not interested in training anybody to ignore prompts.

What we keep: the score, how long it lasted, how many people were there, whether a screen was shared, and which path the call took. What we do not keep: who was there, what was said, none of it.

## Not yet

- Sending your iPhone screen. You can watch, you cannot broadcast.
- Sound when sharing a whole screen on macOS. Browser limit, not ours.
- Fullscreening a shared video in Safari on iPhone: the picture goes black and the sound keeps playing. Already queued.
