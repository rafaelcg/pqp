# Share popout

A call's pictures in a popout inside the app window, instead of a stage that splits the pane with the chat. [Issue 1736](https://github.com/rafaelcg/pqp/issues/1736). Runtime flag `share_popout`, per server, default off (`docs/FEATURE_FLAGS.md`). Web and desktop only.

## What a person sees

With the flag on for the call's server (a DM call reads the global answer), a window at least `lg` wide (1024 px), and a room that is not a watch party:

- **The chat keeps the pane.** The call folds into the composer's dock, as a voice-only call always did.
- **A share waits for "Assistir".** Somebody starting a share, or a share already up when you join, shows as "{name} tá compartilhando a tela · Assistir" in the call's bar. Nothing is received for it until the click.
- **The popout.** "Assistir" puts that share in a popout over the conversation area, above the composer. It shows one picture, and that share is the one you hear. Drag it and it snaps to the nearest corner; resize it from its inner corner; move it between corners with the arrow keys. Corner and size are kept per device. With more than one picture, a switcher in its header picks which.
- **It follows you.** Walk to another channel, server or DM and the popout stays, same video, still playing. Its header names the call and takes you back to it.
- **The theater.** Maximize (the button, or a double click on the picture) and the call's stage takes the conversation area, with the chat put away. Every share you watch and every camera are in its grid, which is where several shares are watched at once; shares still waiting show there with their own "Assistir". From another channel, maximize takes you back to the call first. "Show the chat" brings the chat back beside the picture for this theater only. Minimize, collapsing the stage, or Escape returns to the popout.
- **Close** stops watching that share and sends it back to "Assistir".

With the flag off, or a narrow window, or a watch party, nothing here applies and the call behaves exactly as before.

## Which picture the popout shows

`popoutTarget` in `client/src/components/voice/popout-target.ts`, in this order:

1. what you picked in the switcher, or the share you just pressed "Assistir" on;
2. what it already shows, so it never jumps when the roster changes;
3. the focused share (`VoiceState.focusedScreenPeerId`): the one heard, and the newest, because the wire has no share start time and `nextScreenShareFocus` already works "newest" out by diffing rosters;
4. a share that arrived with sound;
5. the last share in roster order;
6. with no share watched, the camera of somebody speaking, then the camera it already showed.

Your own share and camera are never candidates (`OwnShareStrip` says you are sharing), and neither is a share you have not chosen to watch.

## How it is built

| Piece | File |
|---|---|
| Flag, client store fed by the share config | `client/src/lib/share-popout-flag.ts`, `server/src/lib/share-config.ts` |
| Whether a call uses the popout | `client/src/hooks/use-share-opt-in.ts`, `sharePopoutApplies` in `client/src/lib/share-view-mode.ts` |
| Opt-in watching | `setShareOptIn`, `VoiceState.shareInvitePeerIds` in `client/src/hooks/use-voice.ts`; `sharesArrivingUnwatched` in `client/src/lib/screen-share-roster.ts` |
| "Assistir" chips | `client/src/components/voice/share-invite-chips.tsx` |
| The popout | `client/src/components/voice/share-popout.tsx`, mounted once at the root of `App.tsx` |
| Position and size | `client/src/lib/popout-geometry.ts`, `client/src/lib/share-popout-pref.ts` |
| Popout / theater / closed | `client/src/lib/share-view-mode.ts` (transitions), `client/src/lib/share-view-store.ts` (shared by the popout and the shell) |
| Theater | `CallStage.picturesInPopout` and `CallStage.onMinimizeToPopout`; `App.tsx` hands `CallSplit` the chat collapsed without touching the stored preference |

Two rules the code depends on:

- **The popout never moves in the tree.** `lib/remote-video-delivery.ts` pauses an SFU publication when the last `<video>` bound to it goes away. Mounted once at the app root, the popout's video survives every navigation.
- **Opt-in remembers what it held.** Shares opt-in held are tracked apart from shares the person declined before opt-in applied. Turning opt-in off (flag off, window narrowed) gives back only what it held.

## Bandwidth

A share waiting for "Assistir" has no `<video>` bound, so on an SFU its video is not delivered. On a mesh call the bytes still arrive, as `dismissedSharePeerIds` already documents: declining them properly needs a renegotiation with that peer.

## Not done

- **iOS and Android.** Their stages still receive and draw every share on arrival. TODO comments in `ios/pqp/Sources/Voice/CallStageView.swift` and `android/.../ui/components/RemoteVideoView.kt`.
- **Your own camera** is not shown while the popout owns the pictures; the theater shows it.
- **Watch parties** keep their own stage.

## Rollout

Turn `share_popout` on for one server from controles → interruptores, use it in a real call with two or three shares, then globally. A call picks it up when its share config arrives at join; turning it off mid-call gives back every share it held.

## Tests

- Unit and jsdom: `share-view-mode`, `share-view-store`, `popout-target`, `popout-geometry`, `share-popout-pref`, `share-popout-flag`, `share-invite-chips`, `share-popout`, and the opt-in cases in `use-voice.test.ts`.
- End to end with two real clients in a DM call: `client/e2e/screen-share-popout.spec.ts` (chip, popout playing frames, above the composer, same `<video>` after walking to another DM, close, maximize from elsewhere into the theater, Escape back).
