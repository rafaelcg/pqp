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
| ordinary mic publication | muted (doubling — pitfall in `screen-mix.ts`'s own header) | **unmuted** — this is what the ROOM hears the host from |
| `voice-track` publication | does not exist | published — this is what the SERVER's camera/voice egress reads |
| camera/voice rung (`cameraHlsUrl`) | video only, silent (unchanged) | video (if a camera is on) **+ the mic** |
| no camera, "separada" | rung does not exist | **audio-only rung**, mic alone, tiny bitrate |

The room-mute rule (`publicationShouldBeMuted` in `use-voice.ts`) already
existed to stop the seated room hearing the host twice — once from the mix
(published as the share's audio), once from the raw mic publication. That
rule is what "separada" turns off: with the mic out of the mix, there is only
one copy left for the room, so it has to be the one that is not muted.

**THE SIGNAL THE SERVER TRUSTS IS NOT THE ORDINARY MICROPHONE — A FIRST
VERSION OF THIS FEATURE GOT THAT WRONG, AND A FAROL REVIEW CAUGHT IT.** The
first cut had `reconcileCameraEgress` attach whichever non-`mic-archive`,
`Microphone`-sourced track it found on the sharer, gated only on
`LIVE_HLS_VOICE_TRACK`. That publication exists for every presenter with a
microphone, "separada" chosen or not, and its LiveKit mute state is not a
safe proxy either — mute flips for push-to-talk, deafen and SPEAK being
revoked, none of which are this decision. So with the flag on, every host
with a mic got a camera+voice or voice-only egress regardless of which mode
they had actually picked: a "junto" host's voice reached the audience twice,
once in the film's mix and once on the rung.

The fix is the same shape `LIVE_HLS_MIC_ARCHIVE` already uses for exactly
this problem: a SECOND, distinctly-named publication (`voice-track`,
`VOICE_TRACK_NAME` in both `livekit-session.ts` and `hls-egress.ts`),
published under source `Microphone` (pitfall 14 — a grant is an allowlist of
sources) but told apart by name. The client publishes it — a plain clone of
`pipeline.processedStream`, tapped independently of the screen mix's own
graph, since "separada" means the mic is deliberately NOT in that graph —
only when `syncVoiceTrackPublication` finds ALL three true: `voiceTrackMode`
is "separada", the mic is meant to reach the audience at all (`isSharingMic`),
and the deployment actually answered `voiceTrack: true`
(`effectiveVoiceSeparated()`, see below). Every OTHER client drops and
unsubscribes from a `voice-track`-named publication on sight, exactly like
`mic-archive` — filing it would overwrite the presenter's real voice with a
duplicate of the same person, for the *room* now, not just the stream.
`pickScreenTracks` picks it by name into `voiceTrackId`; the server never
again infers the mode from the ordinary microphone's mere presence.

**A PERSISTED PREFERENCE IS NOT A LIVE CAPABILITY — Farol's second finding.**
`voiceTrackMode` is a standing, per-browser choice (`localStorage`), and
nothing stopped a host who once picked "separada" from sharing again on a
deployment (or a moment) where the flag is off: `micForScreenMix()` would
still pull the mic OUT of the film with nothing left to carry it, and the
audience would hear nothing from the host at all. Every read of the mode now
goes through `effectiveVoiceSeparated()` — `voiceTrackMode === "separada" &&
voiceTrackAvailable` — never `state.voiceTrackMode` directly.
`voiceTrackAvailable` is refreshed from `GET /api/live-hls/config`
(deployment-wide, the same scope `micArchive` already checks at) before every
decision point that matters: starting a watch-party share, flipping "meu mic
vai no stream", flipping the mode itself. Its default is `false` — the safe
side, "junto" — until a check has actually run.

**Camera egress, generalized.** `server/src/voice/hls-egress.ts`'s
`reconcileCameraEgress` used to take one input (the sharer's camera sid, or
null) and run a video-only Track Composite. It now takes two — camera sid and
the sharer's `voice-track` sid, both picked in the same `listParticipants`
pass `pickScreenTracks` already made — and starts whichever of three shapes
is wanted:

- camera, no voice-track (flag off, or "junto", or the mic is not shared into
  the party at all): `CAMERA_RUNG`, unchanged from #535.
- camera + voice-track (flag on, "separada", both present): `CAMERA_RUNG_WITH_VOICE`
  — same 360p30 video, plus a 64 kbit/s AAC audio track.
- voice-track alone, no camera ("separada", no webcam): `VOICE_RUNG` — audio
  only, no video track requested at all, ~32 kbit/s.

All three share `CAMERA_RUNG_NAME` on purpose: same object prefix, same
playlist path, same viewer token. A presenter turning their camera on and off
mid-party, or flipping "separada" on and off, never mints a new session —
nobody watching rebuffers. `cameraHlsUrl` stays the single field it always
was; two new booleans on the frame, `cameraHasVideo` and `cameraHasVoiceAudio`
(both default to the pre-flag shape when absent — an older client parses the
frame and ignores them, same convention `cameraHlsUrl` itself already uses),
say which of the three shapes is live. `cameraStillWanted`, the post-start
sanity check, now judges each half against its OWN flag — `LIVE_HLS_CAMERA`
for video, `LIVE_HLS_VOICE_TRACK` for audio — rather than always requiring
the camera flag; the first version of that check would start a voice-only
egress and immediately stop it again on any deployment with the camera off,
which is exactly the deployment shape a presenter with no webcam is in.

Box-budget accounting follows the shape: the video+audio combo still costs
`HLS_CAMERA_MBPS` (audio is negligible next to a 360p encode); the audio-only
rung costs a new, much smaller `HLS_VOICE_ONLY_MBPS` — there is no frame to
encode, so a box too tight for a full camera slot can still carry a
voice-only one.

**Adoption restores the exact shape, not a guess.** `hls_sessions` gained
`audio_track_id`, alongside the existing `video_track_id`: the camera/voice
slot's two sids now live in their own columns instead of being collapsed
into one, so a boot reconcile after a restart or a deploy adopts a
camera+voice or voice-only egress in the shape it actually was, with
`cameraHasVideo`/`cameraHasVoiceAudio` correct from the first frame a
resumed viewer gets. Before that column existed, a voice-only egress had
nowhere to keep its mic sid but `video_track_id`, so it came back mislabelled
as a silent camera and cost one extra restart on the very next reconcile
tick to self-correct — client-invisible (the slot's URL never moved) but a
real, avoidable interruption of the voice rung specifically.

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
both get it for free. Unmuted autoplay can be refused with no prior gesture
on the document at all (a link opened straight into cinema fullscreen, say);
a `NotAllowedError` now drives a small "tap to hear" affordance rather than
leaving the viewer permanently and silently muted with no way back in.

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
presenter picks "separada" on a client that has confirmed the deployment can
carry it.

**A cherry-picked, unrelated race also lived on this branch.** #490's
360p camera cap (see the PR body) shares `refreshHlsSource` with this
feature, and a Farol review on ITS wiring caught a real overlap: two calls
— one entering the capped state, one right behind it leaving it — could
interleave so the slower one resumed after the faster one had already
finished, reapplying a stale quality on top of a correct one.
`applyWatchPartyCameraCap` now carries a generation counter and backs off
after every await if a later call has already superseded it; pinned in
`use-voice-watch-party-camera.test.ts`.

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
- **`voiceTrackAvailable` is checked deployment-wide, not per-server.**
  `GET /api/live-hls/config` with no `serverId` is the same scope
  `publishMicArchiveIfRecording` already checks `micArchive` at, and
  `LIVE_HLS_VOICE_TRACK` itself has no per-server override to begin with —
  only whether HLS is on AT ALL varies per server. So the one gap left is a
  server whose *own* `live_hls_enabled` allowlist row differs from the
  deployment's default while the presenter is mid-share; a real edge case,
  and the same one `micArchive` has carried since it shipped. Worth
  threading a `serverId` into the voice controller if it ever bites.
