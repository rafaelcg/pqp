# Getting the host into the stream: options, costs, recommendation

**Status: option 1 is built (2026-09-10, `client/src/lib/screen-mix.ts`).** The
rest of this document is the reasoning that chose it. What IS built is
everything in "The floor", below: the host is now told what the stream is
carrying, and the microphone bug that made an invited speaker inaudible to the
*room* is fixed. Read `docs/WATCH_PARTY.md`, "What the stream carries", first;
this file is only about changing it.

## The problem, stated once

A watch party has two audiences on two different paths.

| | seated in the room | watching the HLS |
|---|---|---|
| the presenter's screen | yes, WebRTC | yes, transcoded |
| the screen's own audio | yes | **only if the capture had it** |
| every microphone | yes | **no** |
| every camera | yes | **no** |
| delay | sub-second | about ten seconds |

`server/src/voice/hls-egress.ts` starts a **Track Composite** egress, and
`TrackCompositeEgressRequest` carries one video track sid and one audio track
sid, singular, not repeated. So the choice of two tracks IS the whole of what
the seatless audience receives, and `pickScreenTracks` makes it: the screen
share, and that share's own audio.

A host talking over a film is therefore not heard by the streaming audience at
all, and cannot tell, because they hear the film out of their own speakers and
the room they are talking to hears them perfectly.

## The floor, which is done and needs none of the below

- The transcode states whether it has any audio at all (`LiveHlsStream.hasAudio`).
- The host's transmission panel says it while they are live, collapsed as well
  as expanded, with what to do about it.
- `voice.hlsStarted` carries `audio: "screen" | "none"` and
  `GET /api/admin/metrics` carries `liveHls.silentSessions`, so it is a number
  during a party and a `grep` after one.
- The panel states what the stream carries and what it does not, whether or not
  anything is wrong, plus the ten second gap.

That is the difference between a silent film for a full audience and a host who
notices in ten seconds. **It is not the same thing as the host being heard**,
and nothing below is needed for it.

## The options, ranked

### 1. Client-side mix into the screen-share audio track. RECOMMENDED, after Saturday

The host's browser builds one audio track out of (display audio, if the capture
had any) plus (their own microphone) with an `AudioContext`, and publishes THAT
as `SCREEN_SHARE_AUDIO`. The egress binds to it exactly as it does today and
never learns anything changed.

**Cost on the media box: zero.** No egress change, no second rung, no Chrome,
the same one audio track it already transcodes. This is the entire reason it
ranks first.

**Client-only**, so it deploys through Pages, does not restart `pqp-api`, and
rolls back with another Pages deploy.

What it needs, in full, because none of it is free:

- `livekit-session.ts` `publishScreen` builds and publishes the mix, and
  `unpublishScreen` tears the `AudioContext` down. A capture with no audio of
  its own is the mic alone, which is strictly better than the silence it
  produces today.
- **The separately published microphone is muted while the mix is live**, or
  seated listeners hear the host twice out of two jitter buffers, which is
  flanging and sounds worse than either copy. Muting the publication rather
  than unpublishing it keeps the sid stable, which matters because
  `muteSfuUser` and `setSfuUserCanPublish` both walk `type === AUDIO` and would
  still reach the mix as well: **moderation keeps working**, which was the first
  thing checked and the answer that made this option viable.
- The host's own mute button has to gate the mic branch's `GainNode`, not just
  the publication it is no longer using.
- A microphone device change (`replaceTrack`) has to rebuild the mix.
- Scope it to `watch_party` channels. An ordinary screen share must not start
  routing somebody's voice into a track other people's volume sliders control.

What it costs the product, stated rather than discovered later:

- A viewer turning the film down turns the host down with it, because they are
  now one track. For a watch party that is arguably correct and it is still a
  change.
- Speaking rings: no change, because a participant sharing screen audio already
  registers as speaking continuously. Pre-existing, not introduced here.
- Mesh rooms: a `watch_party` channel is pinned to LiveKit only while live HLS
  is on for that server, so a party on a non-allowlisted server can be mesh.
  Either gate the mix on the transport or handle both.

**Why not before Saturday.** The half that matters cannot be verified locally:
there is no LiveKit and no egress on a dev stack, so "the HLS audience hears the
host" is only observable on staging or in production. It wants a real dry run
with a second account and a seatless viewer, and a host-visible switch to turn
it off mid-party. Build it, dry-run it, then ship it. Shipping it untested three
days before a large event risks the seated room, which currently works.

### 2. Room Composite egress. CORRECT, AND IT DOES NOT FIT ON THIS BOX

`startRoomCompositeEgress` composites the room through a layout template and
mixes every participant's audio, so cameras and every microphone arrive without
any client change at all. It is the complete answer and it is the expensive one.

**LiveKit's own numbers**, from
[the egress self-hosting docs](https://docs.livekit.io/transport/self-hosting/egress/):
"We recommend giving each Egress instance at least 4 CPUs and 4 GB of memory",
and "RoomComposite egress can use anywhere between 2-6 CPUs", against a
TrackEgress that "consumes minimal resources because it doesn't need to
transcode".

**Our measured Track Composite**, `docs/CAPACITY.md` section 2: 0.51 core at
`720p30`, 0.88 core at `1080p30`, on the same images production runs.

So one Room Composite rendition is somewhere between two and seven times a
Track Composite one, on a **4 vCPU box that also carries the SFU, the TURN
relay and Redis**, and the default ladder is two renditions. `docs/CAPACITY.md`
section 1 is explicit about what happens past the point where that box's CPU
pins: egress *falls* rather than levelling off and a large share of packets
reach nobody. That is a cliff, during a live event, for the seated room as well
as the stream.

It also needs a layout decision. The built-in templates put a film in a frame
with camera tiles around it, and a film night wants the film full-bleed with the
host small or absent. That is a custom template page, hosted somewhere, which is
new surface with its own failure mode.

**What would make it viable**: a separate egress box, which `docs/CAPACITY.md`
already names as the clean split once HLS parties become routine. That is a
provisioning decision with a monthly cost, and it is Rafael's to make. Until it
exists, this option is not on the table.

### 3. A server-side mixing agent. NOT WORTH IT

A process using `@livekit/rtc-node` joins the room, subscribes to every audio
track, mixes, and publishes one mixed track; the egress binds to that instead.
Opus decode plus a mix plus an encode is well under a tenth of a core, so the
box cost is fine.

It fails on the same doubling problem as option 1 and has no cheap answer to
it: the mixed track is published into the room, every client auto-subscribes,
and everybody hears everybody twice. Filtering it out client-side means shipping
that filter on web, iOS and Android before it is safe to run at all, and a phone
that has not updated hears the doubling. Plus a new process to deploy, watch and
pay for. Option 1 gets the same result with none of that because the mixing
happens where the microphone already is.

### 4. Pick the presenter's microphone when the share has no audio. REJECTED, AND WORTH RECORDING

Tempting and nearly free: the egress takes one audio sid, so when there is no
`SCREEN_SHARE_AUDIO` at all, bind the presenter's microphone instead. A silent
stream becomes an audible one for the cost of one different string.

Rejected for two reasons, the second of which is the real one.

- It solves the wrong half. A film shared with its audio still leaves the host
  inaudible, and that is the Saturday shape.
- **The microphone would have to be found, and there is no reliable way to find
  it that an old client cannot break.** The web client published microphones
  with no source at all until this PR (see below), so a picker written against
  `TrackSource.MICROPHONE` finds nothing from any tab that has not reloaded, and
  one written against "any audio that is not screen-share audio" will happily
  bind a track it does not understand. Either version passes every test written
  against a well-formed mock and does nothing, or the wrong thing, in
  production. That is CLAUDE.md pitfalls 9 and 12 with a new hat on.

`pickScreenTracks` therefore refuses on purpose, and
`server/src/voice/hls-egress.test.ts` has a case named for it
("leaves the audience silent rather than reaching for the microphone") so the
refusal is a decision rather than an omission.

## The microphone source bug, which was found on the way

Sampling a live production party on 2026-09-09 showed the host's microphone
published with `source = 0`, `SOURCE_UNKNOWN`, beside a screen share correctly
tagged `3`. `new LocalAudioTrack(raw)` starts at `Track.Source.Unknown` and
`publishTrack` only overwrites that when a `source` is passed, and the web
client passed one for the camera and the screen share and not for the mic.
Android passed one; its comment says "both halves of what the web client
publishes", about the two halves it did copy.

That was not cosmetic. `liveKitPublishGrant` sends
`canPublishSources: ["microphone"]` to anybody holding SPEAK and not STREAM, and
LiveKit treats a non-empty list as an allowlist that UNKNOWN is not in
(`VideoGrant.GetCanPublishSource`, livekit/protocol). In a `watch_party` channel
the stream bit is `START_WATCH_PARTY`, which no ordinary member holds, so
**exactly that grant is what an invited speaker gets**: the media server refused
their microphone while their own app showed them live and unmuted.

Fixed in `client/src/lib/livekit-session.ts`, pinned by
`client/src/lib/livekit-session-sources.test.ts`. It is a client-only change, so
tabs that have not reloaded keep the old behaviour until they do.

## The recommendation, in one line

**Ship the floor now. Build option 1 next, dry-run it on production with a real
seatless viewer, and ship it after Saturday.** Revisit option 2 only alongside a
separate egress box.
