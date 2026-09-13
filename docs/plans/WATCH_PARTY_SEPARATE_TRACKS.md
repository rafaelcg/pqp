# Webcam and voice as separate tracks: `LIVE_HLS_VOICE_TRACK`

**Status: built, dark by default.** Server and client both ship behind
`LIVE_HLS_VOICE_TRACK` (unset/off). With the flag off this is a no-op: every
byte on the wire is identical to what shipped before it. Read
`docs/WATCH_PARTY.md`, "What the stream carries", and
`docs/plans/WATCH_PARTY_STREAM_AUDIO.md` first — this document only changes
what that one settled.

## The ask, and why the floor was not enough

Rafael, verbatim: "webcam + audio being different tracks. This is a must for
streamers." Since 2026-09-10 the presenter's microphone reaches the HLS
audience by being mixed INTO the film's own audio track
(`client/src/lib/screen-mix.ts`, "junto" — the only mode that existed before
this). That solved "can the audience hear the host at all" at zero cost to
the media box, and it is still the right default. It also means the film
rung's audio is *permanently* one bus: a viewer, or a clip cut from the
recording, can turn the film's volume up or down, but never the host's voice
independently of it, never mute one and keep the other, and never record them
as two files that a streamer's editor can actually use. #535 (this morning)
put the presenter's camera on its own Track Composite egress beside the
ladder — proof the "second egress beside the film" seam works — but that
rung is video-only; #518 records the host's voice to a file, but the HLS
audience never hears it separately, only in the mix. Neither gets a
streamer two independent tracks *live*, which is the actual ask.

## The design

**Presenter's microphone: always its own LiveKit track.** This does not
change. The host's browser has published a standing microphone publication
(source `Microphone`) since before this feature existed —
`publishMicWhenAllowed` in `client/src/hooks/use-voice.ts` — and #528/#536
made it a real, isolated publication (a clone) so LiveKit's own mute can
control it without touching the shared capture track other consumers read.
What changes is *when* it is muted.

**The flag adds a second axis, `voiceTrackMode`: "junto" or "separada".**
Orthogonal to "meu mic vai no stream" (`micInStream` — whether the audience
hears the host's voice AT ALL): "junto" is exactly today's behaviour, and
"separada" keeps the mic OUT of the screen mix so it can ride its own rung.

| | junto (default, and the only mode before this flag) | separada |
|---|---|---|
| film's own audio (`hlsUrl`) | film + mixed voice | film alone |
| ordinary mic publication | muted (doubling — pitfall in `screen-mix.ts`'s own header) | **unmuted** — the only place the room or the voice rung hears it |
| camera/voice rung (`cameraHlsUrl`) | video only, silent (unchanged) | video (if a camera is on) **+ the mic** |
| no camera, "separada" | rung does not exist | **audio-only rung**, mic alone, tiny bitrate |

The room-mute rule (`publicationShouldBeMuted` in `use-voice.ts`) already
existed to stop the seated room hearing the host twice — once from the mix
(published as the share's audio), once from the raw mic publication. That
rule is what "separada" turns off: with the mic out of the mix, there is only
one copy left, so it has to be the one that is not muted, for the *room* as
much as for the HLS audience. This is the load-bearing insight the whole
feature rests on — nothing about "separada" is really about the stream at
all; it is about which of two already-existing publications gets to carry the
voice, changed by NOT feeding one of them into a WebAudio graph.

**Camera egress, generalized.** `server/src/voice/hls-egress.ts`'s
`reconcileCameraEgress` used to take one input (the sharer's camera sid, or
null) and run a video-only Track Composite. It now takes two — camera sid and
the sharer's *ordinary* (non-`mic-archive`) microphone sid, both picked in the
same `listParticipants` pass `pickScreenTracks` already made (`micTrackId` is
the new field) — and starts whichever of three shapes is wanted:

- camera, no mic (flag off, or mic not shared into the stream): `CAMERA_RUNG`,
  unchanged from #535.
- camera + mic (flag on, both present): `CAMERA_RUNG_WITH_VOICE` — same
  360p30 video, plus a 64 kbit/s AAC audio track.
- mic alone, no camera (flag on, "separada", no webcam): `VOICE_RUNG` — audio
  only, no video track requested at all, ~32 kbit/s.

All three share `CAMERA_RUNG_NAME` on purpose: same object prefix, same
playlist path, same viewer token. A presenter turning their camera on and off
mid-party, or flipping "separada" on and off, never mints a new session —
nobody watching rebuffers. `cameraHlsUrl` stays the single field it always
was; two new booleans on the frame, `cameraHasVideo` and `cameraHasVoiceAudio`
(both default to the pre-flag shape when absent — an older client parses the
frame and ignores them, same convention `cameraHlsUrl` itself already uses),
say which of the three shapes is live.

Box-budget accounting follows the shape: the video+audio combo still costs
`HLS_CAMERA_MBPS` (audio is negligible next to a 360p encode); the audio-only
rung costs a new, much smaller `HLS_VOICE_ONLY_MBPS` — there is no frame to
encode, so a box too tight for a full camera slot can still carry a
voice-only one.

**Client: the PiP unmutes for "separada."** `WatchCameraPip` was hardcoded
`muted` — correct when the rung could never carry anything worth hearing.
It now takes `hasVoiceAudio` (unmutes, restores a per-browser volume
preference, draws a slider) and `hasVideo` (false draws a small "voice"
indicator instead of a video frame, for the no-camera shape — the same
`<video>` element keeps running underneath, since hls.js needs a media
element to play audio through regardless of whether there is a picture).
Both flow from the stream frame through `WatchStage` → `CinemaStage` →
`HlsWatchPlayer` → `WatchCameraPip`, the same path `cameraHlsUrl` already
took, so a seated viewer's cinema stage and a seatless viewer's watch stage
both get it for free.

**Host control: a new component, not a rewrite.** `VoiceTrackModeToggle`
(`client/src/components/watch-party/voice-track-mode-toggle.tsx`) is a plain
two-option radio group, "junto"/"separada", mounted with one conditional line
inside `watch-party-panel.tsx` — right beside the existing "meu mic vai no
stream" switch, which is the same decision's other half. It is never rendered
unless the server's own answer says so
(`GET /api/live-hls/config` → `voiceTrack: boolean`, the exact rule
`micArchive` already follows: a build must never publish a track, or offer a
choice, against a deployment that cannot carry it). `watch-party-panel.tsx`
and `watch-party-transmission.tsx` were touched only for that one mount point
and the props it needs — PR 538 rewrites both files soon, and this feature's
logic living in its own component means that rewrite has nothing of this to
carry through a merge.

**Fallback, stated plainly: flag off is exactly today.** No second track
requested, no unmuted publication, no toggle rendered, no new booleans on the
frame (they are simply absent, which every consumer already treats as "the
pre-flag shape"). Every code path this document describes is additive; none
of it runs unless `LIVE_HLS_VOICE_TRACK=true` on the server AND the
presenter picks "separada" on the client.

## What a test party has to verify

- **Flag off, both PRs before it untouched.** A party with a camera on still
  gets a silent `cameraHlsUrl`; a party with none gets none. `voiceTrack` is
  absent from `GET /api/live-hls/config`, so the toggle never renders.
- **Flag on, "junto" (the default even with the flag on).** Identical to
  today: mixed voice in the film, silent camera rung, raw mic muted for the
  room. The toggle renders and reads "junto."
- **Flag on, "separada," camera on.** Film plays with no voice in it. The
  camera PiP is unmuted with the host's voice on it, roughly a rung's worth of
  delay off the film (two independent egresses, same as the camera PiP always
  was — drift is expected, not chased, same as `docs/WATCH_PARTY.md` already
  says for the picture). The seated room hears the host once, not twice, not
  zero times.
- **Flag on, "separada," no camera.** No PiP video frame; the corner shows
  the "voice" indicator and is genuinely audio-only. Same single-hearing rule
  in the room.
- **Flipping the toggle mid-party, both directions**, with a viewer already
  watching: no rebuffer, no new session, no dropped connection. Watch the
  camera PiP specifically — it must not tear down and reattach hls.js on a
  mode flip (only the file's own token-refresh cadence should touch the
  player).
- **Two-device echo**, the existing warning
  (`lib/dual-device-watch.ts`) — unaffected by this flag, still fires when
  the signed-in account is seated on another device or tab; worth a manual
  check that "separada" does not somehow double the voice on top of that
  existing case.
- **Box budget under load**: with `LIVE_HLS_MAX_LADDER_MBPS`/
  `VOICE_PROMOTION_MAX_SFU_MBPS` tight, confirm a voice-only rung starts where
  a full camera slot would have been refused (`voice.hlsCameraRefused` should
  not fire for the audio-only case on a box that has room for it).
- **Recording**: `LIVE_HLS_MIC_ARCHIVE` still writes its own file regardless
  of `voiceTrackMode` — the two features are independent, and a streamer
  running both ends up with three assets (film, camera+voice or voice-alone,
  and the archived mic), never fewer.

## Open questions for Rafael

- **Naming, in the product's own words.** This document uses "junto"/
  "separada" throughout because that is what ships in the UI copy today, but
  it is a first pass — worth a look before it is load-bearing in translation
  memory.
- **Is 64 kbit/s the right voice bitrate for the combined rung, or should it
  match `LIVE_HLS_MIC_ARCHIVE`'s own Opus figure for consistency between the
  two recordings a streamer might compare?**
- **Should "separada" become the DEFAULT once the flag is on**, rather than
  an opt-in a host has to find? Shipped as opt-in here specifically so
  turning the flag on for the first time changes nothing until a host
  deliberately asks for it — the same caution `LIVE_HLS_CAMERA` and
  `LIVE_HLS_MIC_ARCHIVE` both shipped with.
- **Adoption across an API restart is intentionally imperfect for the
  audio-only shape** (see the comment on `adoptCameraEgress` in
  `hls-egress.ts`): a voice-only rung adopted after a deploy gets
  mislabelled internally as a camera-shaped row until the next reconcile
  tick corrects it with one extra restart of that rung. Camera and
  camera+voice adoption are both exact. Worth a proper `audio_track_id`
  column on `hls_sessions` if this rung sees real use — not done here to
  keep the migration surface small for a flag nobody has turned on yet.
