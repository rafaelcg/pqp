# The presenter's camera in a watch party

**Status:** implemented (this plan shipped with the PR that added it).
**Reading order:** `docs/WATCH_PARTY.md` first, then this. `docs/CAPACITY.md`
§2 is where every number below comes from.

## The ask

Rafael, 2026-09-12: in a watch party the presenter's webcam should be on too.
The stream is the big picture and the webcam is a small floating container in a
corner. Fullscreen hides the camera. A viewer can click the camera to make it
the main stage and click again to swap back. Extra server capacity is a later
conversation, so **the design has to be cheap for the media box and must not
put the audience on the SFU**.

## What is in the way

**The HLS audience is seatless.** A watch party's viewers never join the
LiveKit room: they hold no seat, they publish nothing, they are counted by
`watch-live` and they receive one playlist. So a camera track published into
the room reaches the seated participants over WebRTC and reaches **nobody in
the audience**. That is not a bug to fix by subscribing them; it is the whole
reason watch parties are affordable. Five hundred people on the SFU is the
thing this feature exists to avoid.

**The transcode carries exactly two tracks.** `TrackCompositeEgressRequest`
has a singular `video_track_id` and a singular `audio_track_id`, not repeated
ones, so the running egress cannot be asked to also carry a camera.
`pickScreenTracks` says this out loud already.

**A Room Composite egress is ruled out on this box.** It runs headless Chrome
to lay the room out before GStreamer encodes, which LiveKit's own docs price at
2 to 6 CPUs per rendition (`docs/CAPACITY.md` §2). The production media box is
4 vCPU and already carries the SFU, the TURN relay and Redis. It would compose
the camera over the film beautifully and it is not available to us.

## The design

**One extra Track Composite egress, video only, 360p30, beside the ladder.**

- It transcodes the presenter's **camera** track and nothing else: no audio
  track id at all, which is the same request shape a share picked without its
  own audio already produces (`hasAudio: false`), so it is a path that is
  already exercised in production.
- It writes its own `SegmentedFileOutput` under the **same session prefix**,
  `live/<channelId>/<startedAt>-cam360p30`. Same retention sweep, same
  `sessionPrefixPattern`, same `hls_sessions` row shape.
- It is served by the playlist proxy the ladder already uses:
  `GET /api/voice/hls-playlist/:channelId/:startedAt/cam360p30`, cached per
  rung like every other rendition, authorised by the same viewer token.
- `LiveHlsStream` gains an optional `cameraHlsUrl`, stamped with the **same**
  `?t=` token as `hlsUrl` by `stampViewerStream`.

### It is additive, and that is the load-bearing property

**The camera must never change `startedAt`.** A new `startedAt` is a new
session: a new playlist path, a new token, a new master, and every viewer's
player re-attaches and rebuffers. Doing that to five hundred people because the
host turned their webcam on is worse than not shipping the feature.

So the camera egress starts and stops **inside** the running session. The
ladder rungs are untouched, the main playlist URL does not change, and the only
thing a viewer sees is `cameraHlsUrl` appearing or disappearing on a
`voice-stream` / `channel-live` frame they were already being sent.

### Why it is NOT a rung

`cam360p30` is deliberately absent from `LADDER_RUNGS`. Three things follow for
free, and each of them would be a bug if it did not:

- `sessionRungs` filters the master playlist's variants through
  `LADDER_RUNGS[rung]`, so the camera never appears as a variant a viewer's ABR
  could switch **to**. A player that fell onto the camera rendition would show
  a webcam instead of the film.
- `decideLadder` prices renditions of the share. The camera is not one.
- `adoptLiveHlsSession` looks a rung up in the same table, so a camera egress
  adopted across a deploy is routed to the room's camera slot rather than
  quietly becoming a 720p30 ladder rung.

### Lifecycle, and where each half hooks in

| Event | What happens |
|---|---|
| Presenter turns the camera on | `set-camera` now calls `pushLiveHls`; the reconcile sees a camera track and starts the egress |
| Presenter turns it off | same path, no camera track, egress stopped, `cameraHlsUrl` gone |
| Camera republished (device switch) | sid changed, old egress stopped, new one started; the ladder is untouched |
| Session restarts (track replaced, presenter changed, egress died) | `stopRoom` stops the camera with the rungs; the new session reconciles its own |
| API deploy | `adoptLiveHlsSession` adopts it like a rung, into `room.camera` |
| Camera egress dies on its own | the health monitor treats it exactly like a **secondary** rung: dropped, stopped if still running, the room told. The film never dies with it |
| `reapForeignEgresses` | the camera's egress id is in `ours`, so the reaper does not kill it every ten seconds |

That last row is the one that would have been silent and total. The reaper
stops every ACTIVE egress in a room we are presenting that is not one of ours;
a camera egress missing from that set would be killed on the first monitor tick
and restarted on the next reconcile, forever.

### One LiveKit round trip, not two

`pickScreenTracks` already walks the presenter's track list to find the share
and the share's audio. It now picks the presenter's `CAMERA` sid in the same
pass, so the reconcile costs exactly the `listParticipants` call it already
made. A separate probe would have doubled the RPC on a path that runs on every
roster event.

## What it costs

`docs/CAPACITY.md` §2, measured 2026-09-09 on the staging media box (same
images as production): a Track Composite egress costs **0.51 core** at
`720p30` (1800 kbit/s out) and **0.88 core** at `1080p30` (4500 kbit/s out).
Those are full-frame synthetic motion, an upper bound.

A `360p30` rendition at 400 kbit/s is roughly a fifth of the 720p30 pixel rate,
so **0.2 to 0.3 of a core** is the honest estimate. It is an estimate, not a
measurement, and it is stated as one: `HLS_CAMERA_MBPS` in `hls-ladder.ts` is
`HLS_RUNG_MBPS * 0.3`, i.e. it is priced at 30 % of a full rendition in the
same Mbit/s currency `promotion.ts` and `decideLadder` already share, so the
camera cannot claim a core the WebRTC side has already spent.

Against the default two-rung ladder at about 1.4 cores, a party with the host's
camera on costs about **1.65 cores of four**. The guard:

- `decideCameraEgress` refuses the camera when the ladder plus the camera plus
  the WebRTC load already on the box would pass the promotion budget. A refused
  camera is logged and the film is untouched; the ladder is never traded for it.
- `LIVE_HLS_CAMERA=false` is the one-command rollback, no deploy, the same
  shape as `TURN_PREFER_STATIC` and `LIVE_HLS_REAP_ORPHANS`.
- It only ever runs while the presenter has deliberately turned their camera
  on, which is not the common case for a film night.

**The presenter's uplink cost is capped separately.** The camera going up at
720p beside a 3.5 Mbit/s share is what collapsed a staging share to 640x360 at
17 fps on 2026-09-12; that is fixed on the client by
`effectiveCameraQuality`, which holds a presenting host's camera at the 360p
profile (`docs/WATCH_PARTY.md`, "The presenter's camera is held at 360p while
the party is on air"). This plan assumes that cap: the egress transcodes from
the published track, so a 360p publish is exactly what a 360p30 rendition
wants and nothing is upscaled.

**Bandwidth to the audience** is one more 400 kbit/s rendition per viewer who
is showing the PiP, out of the same R2 bucket the film already comes from. A
viewer on 3.2 Mbit/s of film pays about 12 % more.

## Sync, and why we are not chasing it

The two playlists are two independent egresses started seconds apart, each with
its own 2 s segments and its own encoder latency. **They will drift**, and the
honest number is **one to three seconds**, bounded below by the segment
duration and above by the difference in when the two transcodes started.

Both playlists carry `EXT-X-PROGRAM-DATE-TIME` (LiveKit writes it), so a
best-effort alignment on start is possible and is what is implemented: when the
camera player attaches, it seeks to the film's current live position if both
sides report a program date and the gap is more than a segment. After that the
two run free.

**Frame-accurate sync is not attempted and should not be.** It would mean
either one egress composing both pictures (Room Composite, ruled out above) or
holding one playlist back to match the other, which costs the audience latency
on the thing they actually came to watch. A webcam a second or two off the film
is a webcam; a film held back to match a webcam is a worse film.

## The viewer's side

`HlsWatchPlayer` owns the PiP, because the two videos have to share one stage,
one chrome overlay and one fullscreen element.

- A **second, muted** hls.js instance on its own `<video>`. Audio stays on the
  main stream only, always: `muted` is set on the element and never read from
  the volume preference, so there is no path by which the camera can make
  noise.
- The stage and the corner are **boxes, not players.** Swapping does not
  re-attach either instance; it swaps which `<video>` gets the full-bleed class
  and which gets the corner class. Nobody rebuffers to look at a webcam, and
  the control bar (volume, quality, fit, fullscreen) stays where it is, because
  it belongs to the stage rather than to a picture.
- The corner is one of four, remembered per browser in `localStorage`
  (`pqp:watch-camera-pip`), alongside whether the camera is currently on the
  stage. A corner picker rather than dragging: dragging on a surface that also
  toggles the chrome on tap is a gesture conflict, and four corners is the
  whole of what the ask needs.
- **Fullscreen hides it.** That is the product instruction as given. It is one
  boolean (`cameraPipVisible`) and trivially reversible if the owner changes
  their mind after seeing it.
- A camera that never produces a frame draws nothing at all. There is no
  spinner, no placeholder and no error: a broken webcam must cost the film
  nothing, not even a rectangle.

## Out of scope

- **iOS and Android.** `cameraHlsUrl` is optional on the shared schema, so an
  older client parses the frame and ignores the field. Nothing about the
  existing playback path changes for them.
- Anybody's camera but the presenter's. A watch party with several cameras is
  several more transcodes, and that is the capacity conversation this plan is
  explicitly deferring.
- The camera in the recording / replay. It is under the session prefix so it is
  swept on the same terms, and nothing reads it back.

## Open question for the owner

**Fullscreen hiding the camera** is implemented exactly as asked, and it is the
one decision worth a second look: fullscreen is where a viewer is most
committed to the party, and it is also where a 22 % corner box is least in the
way. It is one boolean either way.
