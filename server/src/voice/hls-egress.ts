import {
  DirectFileOutput,
  EgressClient,
  EgressStatus,
  type EncodingOptions,
  RoomServiceClient,
  S3Upload,
  SegmentedFileOutput,
  TrackSource,
} from "livekit-server-sdk";
import { playlistLooksLive, type LiveHlsStream } from "@pqp/shared";
import { isLiveKitConfigured } from "./backends.js";
import { promotionBudgetMbps } from "./promotion.js";
import {
  CAMERA_RUNG,
  CAMERA_RUNG_NAME,
  CAMERA_RUNG_WITH_VOICE,
  VOICE_RUNG,
  decideCameraEgress,
  decideLadder,
  hlsRungVideoKbps,
  HLS_CAMERA_MBPS,
  HLS_VOICE_ONLY_MBPS,
  LADDER_RUNGS,
  ladderBudgetMbps,
  parseLadder,
  rungEncodingOptions,
  type LadderRung,
} from "./hls-ladder.js";
import { logEvent } from "../lib/log.js";
import { getPool } from "../db.js";
import {
  claimHlsSessionRow,
  claimHlsSessionRows,
  egressIdsOwnedElsewhere,
  ensureHlsOwnerHeartbeat,
  hlsOwnerInstanceId,
  hlsSkippedOwnedElsewhereCount,
  forgetPendingHlsSessionClaims,
  liveOtherInstances,
  noteHlsSkippedOwnedElsewhere,
  ownedByLiveOtherInstance,
  resetHlsOwnershipForTests,
  retryPendingHlsSessionClaims,
  sessionIdsOwnedElsewhere,
} from "./hls-ownership.js";
import {
  buildStorageConfig,
  signRequest,
  type StorageConfig,
} from "../lib/s3.js";
import {
  liveHlsLLAvailable,
  llDelaySeconds,
  llHasRoom,
  llPlaylistFrontConfigured,
  llPlaylistUrl,
  forgetLlResumeDecisions,
  llAdoptedAt,
  llStreamFor,
  reconcileLlHlsNow,
  releaseLlRoom,
  resetHlsRemuxForTests,
  resolveHlsModeForChannel,
  runBounded,
  stopLlSession,
  sweepLlDemotions,
} from "./hls-remux.js";

/**
 * Live HLS for a watch-party screen share: LiveKit Track Composite egress
 * writes 2 s segments to a dedicated R2 bucket, and the playlist URL rides
 * the existing `/ws` as `voice-stream`.
 *
 * Off unless `LIVE_HLS_ENABLED=true` and a *separate* S3 set
 * (`LIVE_HLS_S3_*`) is present. Attachment `S3_*` is deliberately not
 * reused: that bucket is private. `LIVE_HLS_PUBLIC_BASE_URL` is only needed
 * when `LIVE_HLS_SIGNED_URLS=false`: in signed mode (the default, and what
 * production runs) the bucket stays private and everything a viewer or this
 * process reads goes through presigned URLs, so there is no public base.
 */

/**
 * THE HOST'S VOICE AS ITS OWN FILE.
 *
 * `mic-archive` is the LiveKit track NAME the presenter's browser publishes a
 * second copy of its processed microphone under, when the server advertises
 * `micArchive` on `GET /api/live-hls/config`. Nothing plays it: every client
 * unsubscribes from a publication with this name on sight, and the HLS
 * audience keeps hearing the mix exactly as before. It exists so a Track
 * Egress can write the voice to its own Opus file beside the segments, and a
 * clip can be cut later with the film and the voice on separate tracks.
 *
 * THE NAME IS THE CONTRACT, and pitfall 14 is why it is a name and not a
 * source. `liveKitPublishGrant` sends `canPublishSources: ["microphone"]` to
 * anybody holding SPEAK and not STREAM, and LiveKit treats a non-empty list as
 * an allowlist that `SOURCE_UNKNOWN` is not in: a track published under an
 * invented source would be refused by the media server while the host's own
 * app showed it live. So this publication is a MICROPHONE like any other and
 * is told apart by `TrackInfo.name`, which no grant reads.
 */
export const MIC_ARCHIVE_TRACK_NAME = "mic-archive";

/**
 * `LIVE_HLS_VOICE_TRACK`'s "separada" mode: a SECOND publication of the
 * presenter's processed mic, under this name, told apart from their
 * ordinary one for exactly `MIC_ARCHIVE_TRACK_NAME`'s reasons above (same
 * source, same pitfall 14, the name is the only thing that distinguishes
 * them).
 *
 * WHY THE PICKER USES THIS AND NOT THE ORDINARY MICROPHONE. An earlier
 * version of this feature attached whichever non-archive, `Microphone`-
 * sourced track it found on the sharer, gated only on the deployment flag.
 * A Farol review caught what that misses: the ordinary publication exists
 * for every presenter with a microphone, "separada" chosen or not, and its
 * LiveKit mute state is not a safe proxy either — mute flips for
 * push-to-talk, deafen and SPEAK being revoked, none of which are this
 * decision. So with the flag on, every host with a mic got a camera+voice
 * or voice-only egress regardless of which mode they had actually picked,
 * which is the doubling bug this rename fixes: a "junto" host's voice was
 * reaching the audience twice, once in the film's mix and once on the rung.
 *
 * A track under THIS name is unambiguous the same way the archive is: the
 * client only ever publishes it while `voiceTrackMode` is "separada" AND
 * the mic is meant to reach the audience at all (`isSharingMic`) AND the
 * client's own answer from `GET /api/live-hls/config` says the deployment
 * can carry it — see `syncVoiceTrackPublication` in `use-voice.ts`. Its
 * presence is therefore a fact the server can trust, not an inference from
 * a track that exists regardless of any of that.
 */
export const VOICE_TRACK_NAME = "voice-track";

/**
 * CONVIDADOS (`docs/plans/WATCH_PARTY_GUESTS.md` §5.2): the presenter's
 * browser is the mixer, and this is its output — the presenter's own
 * microphone plus every accepted guest's, summed client-side
 * (`client/src/lib/stage-mix.ts`) and published under this name, exactly the
 * shape `VOICE_TRACK_NAME` already is and for the same pitfall-14 reason (a
 * grant is an allowlist of SOURCES, so a second publication has to be told
 * apart by NAME).
 *
 * PREFERRED OVER `VOICE_TRACK_NAME`, NEVER BOTH. A party with guests on
 * publishes `stage-mix` instead of the plain `voice-track` copy of the mic
 * (see `syncVoiceTrackPublication`'s guest branch): the stage rung's audio
 * is always exactly one of "nothing", "the presenter alone" (`voice-track`,
 * #544's shape, guests off) or "the presenter plus every guest"
 * (`stage-mix`), never a choice between two live inputs. `pickScreenTracks`
 * below is the one place that ordering is written down — prefer a
 * `stage-mix` publication when one exists, fall back to `voice-track`
 * otherwise — so everything downstream (`reconcileCameraEgress`, the row,
 * the adoption path) keeps reading the single `voiceTrackId` field it
 * already understands and needs no idea guests exist at all.
 */
export const STAGE_MIX_TRACK_NAME = "stage-mix";

/**
 * How long after a session starts the monitor keeps looking for the archive
 * track. The browser publishes it AFTER the share is up and the mix is
 * running, so it is normally absent on the first look and present a second or
 * two later; a host whose browser never publishes one (an old bundle, the mic
 * switch off, no WebAudio) must not cost a `listParticipants` every ten
 * seconds for the length of a film.
 */
const MIC_ARCHIVE_WAIT_MS = 60_000;

const TRACK_FIND_ATTEMPTS = 16;
const TRACK_FIND_GAP_MS = 400;
const DEFAULT_DELAY_SECONDS = 30;
/**
 * How long a fresh egress gets to produce its first live playlist.
 *
 * WAS 20 SECONDS, AND THAT WAS TOO IMPATIENT. `docs/CAPACITY.md` section 2
 * measured time-to-first-playlist at 10.8 s for a `720p30`-first ladder on an
 * idle box and **43.7 s** for `1080p30` on a saturated core, so the old
 * ceiling sat between the good case and the bad one. Production on 2026-09-09
 * logged `voice.hlsStarted playlistReady=false` immediately followed by
 * `voice.hlsStopped reason=playlist-not-ready` on a box that was carrying
 * leftover transcodes at the time: the session was torn down, one of the three
 * restarts in the window was spent, and the audience got nothing, when waiting
 * a little longer would have served them.
 *
 * The cost of waiting is the host staring at "preparing" for longer. The cost
 * of not waiting is that plus a wasted session plus another wait. Forty-five
 * seconds covers the measured worst case; `voice.hlsStarted` now reports how
 * long it actually took, so the next revision of this number is measured
 * rather than argued.
 */
const PLAYLIST_WAIT_ATTEMPTS = 45;
const PLAYLIST_WAIT_GAP_MS = 1000;

/** How often the monitor asks LiveKit whether each egress is still alive. */
export const HLS_HEALTH_CHECK_INTERVAL_MS = 10_000;
/** A fresh egress gets this long before its status is held against it. */
const HEALTH_GRACE_MS = 15_000;
/**
 * How long an LL companion (`llCompanions`) may wait for the LL session it
 * belongs to before the monitor decides that session is not coming back. Past
 * the boot sequence, which adopts the companion's egresses before it adopts
 * the LL session (`server/src/index.ts`).
 */
const LL_COMPANION_BOOT_GRACE_MS = 60_000;
/**
 * The live playlist not moving for this long is a dead egress, whatever
 * LiveKit's bookkeeping says. Verified on the local stack 2026-09-08: a
 * `docker stop lk-egress` mid-share leaves `ListEgress` answering ACTIVE
 * for that id indefinitely (v1.13.6, egress v1.14.1: the killed node never
 * writes a final status and nothing expires it), so the status alone
 * would never notice. Ten segments of 2 s: long enough for a presenter
 * pause, short enough that the client's own 15 s watchdog and this one
 * land in the same minute.
 */
const PLAYLIST_STUCK_MS = 20_000;
/** Restarts allowed per channel inside `RESTART_WINDOW_MS` before giving up. */
export const HLS_MAX_RESTARTS = 3;
export const HLS_RESTART_WINDOW_MS = 5 * 60 * 1000;
/** After the cap: no new egress for this channel until the share is stopped or this passes. */
const FAILED_COOLDOWN_MS = 5 * 60 * 1000;
const RESTART_BACKOFF_BASE_MS = 2_000;
const RESTART_BACKOFF_MAX_MS = 15_000;
/**
 * First wait after a leftover `StopEgress` fails. Staging 2026-09-12: one
 * dead handler (`no response from servers`) was retried every monitor tick
 * for seven hours, each attempt a 3 s LiveKit timeout, in front of the
 * playlist check. The leftover never came back; the live encode paid for
 * the RPC. After this, 2 min, 5 min, then 15 min.
 */
export const ORPHAN_STOP_BACKOFF_FIRST_MS = 60_000;
const ORPHAN_STOP_BACKOFF_STEPS_MS = [
  ORPHAN_STOP_BACKOFF_FIRST_MS,
  2 * 60_000,
  5 * 60_000,
  15 * 60_000,
] as const;

/**
 * Real incident, 2026-09-12: nine ACTIVE egress records sat in LiveKit's own
 * state (Redis on the media box) with nothing writing to them, and a 720p
 * rung was refused twice with `box-budget` while the box was otherwise idle.
 * The fix pinned here is the `hls_sessions` row, not the record's age: age
 * alone is not proof of anything (a real watch party's egress runs for
 * hours), but a record whose channel has no live session row is one LiveKit
 * is holding for a room nobody is presenting to. See `noLiveSession` in
 * `activeBoxEgressCount`.
 *
 * How long a fresh record is exempt from that check regardless: the
 * `startTrackCompositeEgress` call and the `hls_sessions` insert that backs
 * it are two round trips, not one, so a record can legitimately have no
 * matching row for a moment right after it starts. Two minutes is generous
 * for that gap to close.
 */
const GHOST_EGRESS_GRACE_PERIOD_MS = 2 * 60_000;

/**
 * What LiveKit says about one egress, reduced to the three answers the
 * monitor acts on. `unknown` is "could not ask" and never triggers a restart.
 */
export type EgressHealth = "alive" | "ended" | "unknown";

export interface EgressListing {
  egressId: string;
  status: EgressStatus | number;
  error?: string;
  /** The LiveKit room, which for us is the voice channel id. */
  roomName?: string;
  /**
   * Wall-clock ms this egress started, when LiveKit stated it. Undefined for
   * an older fake in a test that has no reason to care — every caller that
   * uses it (the ghost filter below) already treats "unknown" as "cannot be
   * aged out", never as "definitely fresh".
   */
  startedAt?: number;
}

export interface LiveHlsScreenTracks {
  videoTrackId: string;
  audioTrackId?: string;
  /** Published capture height, when LiveKit stated it. */
  sourceHeight?: number;
  /**
   * The sharer's separate `mic-archive` audio publication, when they have one.
   * NOT part of the transcode: the Track Composite takes one audio sid and
   * that is still the share's own audio (which already carries the mixed
   * voice). This one is written to its own file. See `MIC_ARCHIVE_TRACK_NAME`.
   */
  micArchiveTrackId?: string;
  /**
   * The SAME participant's camera, when they have one published.
   *
   * Picked in the same pass as the share on purpose. The reconcile already
   * calls `listParticipants` on every roster event; asking a second time for
   * the camera would double an RPC on a hot path to learn something the first
   * answer already contained. Absent means no camera, which is the ordinary
   * case for a film night.
   */
  cameraTrackId?: string;
  /**
   * The sharer's `voice-track` publication (`VOICE_TRACK_NAME`), when they
   * have one. `LIVE_HLS_VOICE_TRACK`'s "separada" signal: the CLIENT only
   * ever publishes this while it has chosen "separada", is sharing its mic
   * into the party at all, and the deployment says it can carry it — see
   * `VOICE_TRACK_NAME`'s own doc for why this is named-picked rather than
   * inferred from the sharer's ORDINARY microphone (an earlier version did
   * that and doubled a "junto" host's voice). Picked in the same
   * `listParticipants` pass as everything else here, by name for the same
   * pitfall-14 reason `micArchiveTrackId` is, and never confused with that
   * one: same source, different name, different purpose (this one an
   * egress input, that one a Track Egress that never reaches the audience).
   */
  voiceTrackId?: string;
}

export interface LiveHlsEgressApi {
  startTrackCompositeEgress: (
    roomName: string,
    output: SegmentedFileOutput,
    opts: {
      audioTrackId?: string;
      /**
       * Optional so an audio-only Track Composite (`VOICE_RUNG`, no camera
       * published) can be requested at all: the protocol's own fields are
       * both optional, and the real binding below passes `undefined` straight
       * through. Every caller before `LIVE_HLS_VOICE_TRACK` always had one.
       */
      videoTrackId?: string;
      encodingOptions?: EncodingOptions;
    },
  ) => Promise<{ egressId: string }>;
  /**
   * `TrackEgress`: one track, no transcode, straight to a file. Optional so
   * every existing fake still compiles; without it the mic archive simply
   * never starts, which is the pre-feature behaviour rather than a crash.
   */
  startTrackEgress?: (
    roomName: string,
    output: DirectFileOutput,
    trackId: string,
  ) => Promise<{ egressId: string }>;
  stopEgress: (egressId: string) => Promise<void>;
  /**
   * `ListEgress`, by room or by id. Optional so the older fakes still
   * compile; without it the monitor has nothing to ask and does nothing,
   * which is the pre-monitor behaviour, not a crash.
   */
  listEgress?: (opts: {
    roomName?: string;
    egressId?: string;
    active?: boolean;
  }) => Promise<EgressListing[]>;
}

/**
 * Who hears that a channel's stream changed underneath the room. `ws/voice.ts`
 * registers its reconcile-and-rebroadcast here; the monitor calls it after
 * an egress died (so a new one is started and the new playlist URL goes out)
 * and after the cap is hit (so viewers are told the stream is gone).
 */
export type LiveHlsChangeListener = (
  channelId: string,
  reason: string,
) => void;

export type LiveHlsTrackFinder = (
  roomName: string,
) => Promise<LiveHlsScreenTracks | null>;

/**
 * What the WebRTC side of the media box already costs, in the Mbit/s
 * `promotion.ts` prices rooms in. `ws/voice.ts` registers the real reader
 * (the same `readRoomLoads()` the promotion guard uses); without one the
 * ladder guard treats the box as unmeasured and refuses only on its own
 * budget, the same way `decidePromotion` treats an unprobed SFU as
 * promotable rather than as a failure.
 */
export type LiveHlsSfuLoadReader = () => Promise<number>;

/**
 * IS THIS PRESENTER STILL PRESENTING, ASKED AT THE MOMENT IT MATTERS.
 *
 * Every decision that reaches this file was made somewhere else and some time
 * ago. `pushLiveHls` reads `watchPartyKnownOver` and `pickHlsSharer` at the
 * top of a function that then awaits a server-id lookup, a mode resolve and
 * the whole of this channel's reconcile queue before a rung is ever asked
 * for. On 2026-09-17 two pushes for channel `d5559e70` raced across exactly
 * that gap: the first saw the party end and tore the session down, the second
 * still held "over: false, sharing: peer f408cf6a" from before the end, waited
 * its turn in the queue, and started a fresh two-rung ladder 200 ms before
 * that presenter's `voice.leave`. Its egresses died 34 s later on `track ...
 * not found`, which scheduled a restart, which produced a `voice.hlsStarted`
 * with `playlistReady=false` for a room nobody was in.
 *
 * So the answer is asked again HERE, where the core is about to be spent,
 * rather than trusted from there. `ws/voice.ts` registers the check
 * (`watchPartyKnownOver` plus `pickHlsSharer`, the same two authorities the
 * push uses) and this file calls it at each point a start would otherwise
 * commit.
 *
 * FAILS OPEN, exactly like `watchPartyKnownOver` itself: with no check
 * registered (every test that does not care, and any embedding that never
 * wires one) the answer is "yes", so behaviour is what it always was. The
 * failure it must never have is refusing to transcode a real party; the
 * failure it accepts is missing one of these races and stopping it on the
 * next push.
 */
export type LiveHlsPresenterCheck = (
  channelId: string,
  presenterPeerId: string,
) => boolean;

/** One rendition of a live session: its own egress, its own playlist. */
interface RunningRung {
  rung: LadderRung;
  egressId: string;
  /** Wall clock when this egress was requested, for the health grace period. */
  startedAtMs: number;
  /** Last playlist shape the monitor saw (`sequence:segments`) and when it changed. */
  progress: { key: string; at: number } | null;
  /**
   * The `hls_sessions.id` this rendition's row was written under
   * (BROADCAST_PIPELINE B0.4), so the `voice.hls*` lines about it name the
   * same id the playlist's own `#EXT-X-PQP-SESSION` tag carries. Null for a
   * row adopted back after a restart (the boot reconcile has the egress and
   * the track, not the row's id) or when the insert itself failed; nothing
   * downstream treats null as an error, only as "not known yet".
   */
  sessionId: string | null;
}

interface RoomHls {
  /**
   * When THIS process took the session over instead of starting it: the boot
   * adoption, a resume adoption, a handover from the other machine. Absent on
   * a session this process started. Read by `pushLiveHls` through
   * `liveHlsAdoptedAt`: right after an adoption, "no presenter here" usually
   * means their socket has not reconnected yet, not that they stopped.
   */
  adoptedAtMs?: number;
  /**
   * Every rendition running for this session, LOWEST BITRATE FIRST. The
   * first entry is the primary: it is what the readiness probe waited for,
   * and the session lives and dies with it. A secondary rung that dies is
   * dropped from the master playlist and the rest keeps playing.
   */
  rungs: RunningRung[];
  stream: LiveHlsStream;
  /**
   * The screen track sid the egress was started on. A Track Composite egress
   * is bound to one sid; when the presenter republishes (a quality pick that
   * changes the top layer, the room crossing the large-room line, a
   * reconnect), the old sid goes away, the egress keeps running on audio
   * alone and the playlist stops growing. Verified on staging 2026-09-07:
   * "writer finished" for the video track, then no segment for 21 s until
   * stop. So a same-presenter reconcile compares this to what the SFU has.
   */
  videoTrackId: string;
  /**
   * The screen's OWN audio sid the ladder was started on ("música" in the
   * product's language: the tab or system audio the presenter is sharing,
   * not their microphone), or null when the share had none at that moment.
   *
   * A Track Composite egress is bound to this sid exactly the way it is
   * bound to `videoTrackId`, and until 2026-09-20 only the video half was
   * ever compared on a same-presenter reconcile: ticking "share audio" on
   * after the ladder was already running, losing it, or the browser handing
   * out a new audio sid while the video sid stayed put all went unnoticed
   * forever, because nothing recorded what the running egress actually had.
   * The seated room kept hearing the presenter's live track regardless (a
   * direct LiveKit subscription, untouched by any of this); only the
   * seatless HLS audience was stuck on whatever audio the egress happened to
   * start with — silence if it started muted, or a dead sid if the original
   * track was later replaced. Compared here exactly like `videoTrackId` is.
   */
  audioTrackId: string | null;
  /**
   * The presenter's camera and/or voice rung, transcoded beside the ladder,
   * or null. One slot for both, because they are the same egress: a Track
   * Composite with a video sid, an audio sid, or one of each.
   *
   * ADDITIVE TO THE SESSION, NEVER A NEW ONE. It starts and stops inside the
   * running `startedAt`: a new one is a new playlist path, a new viewer token
   * and a new master, so every viewer re-attaches and rebuffers. Turning a
   * webcam on must not do that to an audience. See
   * `docs/WATCH_PARTY.md`, "The presenter's camera, floating over the film".
   *
   * A `RunningRung` rather than its own shape, because the health monitor,
   * `stopRungs` and `reapForeignEgresses` all want to treat it exactly like a
   * secondary rendition. It carries `CAMERA_RUNG`, `CAMERA_RUNG_WITH_VOICE` or
   * `VOICE_RUNG` (`LIVE_HLS_VOICE_TRACK`), none of which are in `LADDER_RUNGS`
   * and all three of which share `CAMERA_RUNG_NAME` so the slot, its object
   * prefix and its playlist URL never move underneath a viewer as the two
   * booleans below change mid-party.
   *
   * `cameraTrackId` null means no camera video (a `VOICE_RUNG` audio-only
   * egress, or the flag off — the only shape this ever was before
   * 2026-09-13). `audioTrackId` null means no microphone attached (the
   * pre-2026-09-13 `CAMERA_RUNG` shape, or a presenter not sharing their
   * voice at all). Both null never happens — `reconcileCameraEgress` tears
   * the slot down the moment neither is wanted, same as it always did for the
   * camera alone.
   */
  camera:
    | (RunningRung & { cameraTrackId: string | null; audioTrackId: string | null })
    | null;
  /** Wall clock when the session was requested. */
  startedAtMs: number;
  /**
   * HAS THIS SESSION EVER PRODUCED A LIVE PLAYLIST? Until it has, nobody is
   * told about it.
   *
   * `startRoom` publishes the room into `rooms` BEFORE the readiness probe,
   * deliberately: the monitor, the reap and the restart path all have to be
   * able to find a session that is still warming up, and putting a network
   * wait in front of `rooms.set` would make a start unreachable for as long
   * as it takes. The cost of that, until now, was that the room's `stream`
   * was readable by everything else the moment the rungs were asked for --
   * `liveHlsStreamFor`, `getChannelLiveState`, and the same-presenter branch
   * of `reconcileLiveHlsNow` -- so a concurrent push could hand every viewer a
   * playlist URL for a session whose playlist did not exist and, on 2026-09-17,
   * never would (`playlistReady=false playlistWaitMs=52752`). A viewer who
   * takes that URL polls a 404 behind the holding screen's "reconnecting"
   * for as long as they are willing to look at it.
   *
   * So the room is VISIBLE to this file and INVISIBLE to the audience until
   * the primary rung's live playlist has actually been read once. Adoption
   * sets it true: an adopted session was live on the media box before this
   * process ever heard of it.
   */
  announced: boolean;
  /**
   * The host's voice, recorded to its own file beside the segments. Null
   * until the presenter's `mic-archive` publication shows up (or forever,
   * when the feature is off or their browser never publishes one).
   */
  micArchive: { egressId: string; trackId: string; sessionId: string | null } | null;
  /**
   * Stop looking for that publication after this instant. Zero means never
   * look, which is what an ADOPTED session gets: its archive either came back
   * with it or is gone, and starting a second one mid-film would write a
   * second file nobody asked for.
   */
  micArchiveUntil: number;
}

const rooms = new Map<string, RoomHls>();
/**
 * THE CAMERA AND THE MIC ARCHIVE OF A LOW-LATENCY BROADCAST, which has no
 * `rooms` entry of its own.
 *
 * An LL party's picture is pqp-remux's (`hls-remux.ts`), but the presenter's
 * camera rung and the host's voice archive are still LiveKit egresses, and
 * the recording is "webcam + mic + stream" whichever way the film was made.
 * So an LL session gets a `RoomHls` here with NO rungs, carrying only the two
 * slots, and every function that already runs those slots for the ladder
 * (`reconcileCameraEgress`, `startMicArchive`, `tendMicArchive`, the camera's
 * health check) runs them for this one too, found through `companionHost`.
 * Same `startedAt` as the LL row, so `hls-history.ts` groups all three into
 * one broadcast and offers the camera and the voice as downloads.
 *
 * Never in `rooms`, deliberately: everything that iterates `rooms` means "a
 * ladder this process is transcoding" (the restart path, the reap, the
 * session cap, the primary-rung health check), and an entry with no rungs
 * would be torn down by all of them. A channel is in at most one of the two
 * maps: the LL branch of `reconcileLiveHlsNow` stops a conventional room
 * before it builds one of these, and the conventional branch stops this.
 */
const llCompanions = new Map<string, RoomHls>();

/** The room whose camera and mic archive slots this channel is using. */
function companionHost(channelId: string): RoomHls | undefined {
  return rooms.get(channelId) ?? llCompanions.get(channelId);
}

/** Every room holding a camera or archive slot, ladder or LL. */
function companionHosts(): RoomHls[] {
  return [...rooms.values(), ...llCompanions.values()];
}
/** Restart timestamps per channel, pruned to `HLS_RESTART_WINDOW_MS`. */
const restartHistory = new Map<string, number[]>();
/** Channels that hit the cap: no egress until this instant, or the share stops. */
const failedUntil = new Map<string, number>();
const pendingRestarts = new Map<string, ReturnType<typeof setTimeout>>();
/** Per-channel serialisation of `reconcileLiveHls`: the monitor and the room can race. */
const reconcileQueue = new Map<string, Promise<unknown>>();
/** Leftover ids whose last `StopEgress` failed: do not ask again before `until`. */
const orphanStopBackoff = new Map<
  string,
  { failures: number; until: number }
>();
/**
 * Leftover transcodes this process has stopped since it started, from
 * `reapForeignEgresses`. Belongs at zero. Anything else is a session that
 * leaked handlers onto the media box, and the number is the only evidence a
 * leak ever happened, because the leak itself is silent.
 */
let orphansStopped = 0;
/**
 * Watch-party transcode lifecycle counts, cumulative since this process
 * started (reset only by `resetLiveHlsForTests`), for `liveHls.*` on
 * `GET /api/admin/metrics`. Per instance, like `orphansStopped`: they belong
 * to whichever machine answered. `starts`/`stops` are the `voice.hlsStarted` /
 * `voice.hlsStopped` log lines as a level a "flapping" alert can evaluate;
 * `restartsScheduled` is a rung that died and is being brought back, and
 * `restartsExhausted` is `scheduleRestart` giving up (`voice.hlsFailed`) —
 * the pair is the shape of a stream that will not stay up, which pitfall 15
 * was, and which no gauge on this endpoint could show before.
 */
let hlsStartsTotal = 0;
let hlsStopsTotal = 0;
let restartsScheduledTotal = 0;
let restartsExhaustedTotal = 0;
/**
 * Egress ids the box-budget count has already logged as a ghost, so a
 * record that lives on for hours (exactly what makes it a ghost) does not
 * re-log every monitor tick. Cleared only by `resetLiveHlsForTests`; nothing
 * in production ever needs to forget one, since a stopped id simply stops
 * appearing in `listEgress({active:true})`.
 */
const loggedGhostEgressIds = new Set<string>();
/**
 * Egresses this process wanted to stop and could not prove were its own,
 * because the ownership lookup itself failed. Retried on every monitor tick
 * (`retryDeferredStops`) rather than stopped blind, which would let a database
 * blip hang up the other machine's stream, or dropped, which would leak a
 * transcode onto the media box exactly as pitfall 15 did.
 */
const deferredStops = new Map<
  string,
  { channelId: string; sessionId: string; rung: string; queuedAt: number; attempts: number }
>();
/**
 * A deferred stop is a repair, not a debt without end. `StopEgress` is not
 * idempotent from here: a request that actually landed and lost its response
 * looks exactly like one that failed, so an entry that will not clear has to
 * be given up on rather than retried forever. Both bounds are generous enough
 * that an ordinary database or control-plane blip resolves long before either.
 */
const DEFERRED_STOP_MAX_ATTEMPTS = 10;
const DEFERRED_STOP_TTL_MS = 10 * 60_000;
/** Retries per tick, so a wide outage cannot turn one tick into a long serial run. */
const DEFERRED_STOP_PER_TICK = 8;
/** In flight at once within a tick: bounded, never one-at-a-time and never a fan-out. */
const DEFERRED_STOP_CONCURRENCY = 4;
/**
 * The queue itself is bounded. A database outage during a mass teardown must
 * not turn an in-memory map into the thing that fails next; past this the
 * oldest entries are dropped, loudly, which is the same trade the backoff
 * above makes for a single id.
 */
const DEFERRED_STOP_MAX_ENTRIES = 200;
/**
 * Channels whose camera transcode died or was refused, and when another may
 * start.
 *
 * WHY THERE HAS TO BE ONE. A dead camera is dropped by the health monitor,
 * which tells the room, which reconciles, which finds the presenter's camera
 * still published and starts another. On a healthy box that is the right
 * behaviour and happens once. On a box that is struggling — which is exactly
 * when an egress dies — it is a loop: die, restart, die, at roughly the
 * monitor's cadence plus the grace, forever, on the machine that was already
 * too busy.
 *
 * Two minutes, and deliberately NOT the session's `restartHistory` budget: a
 * camera failing must never spend the restarts that exist to bring the FILM
 * back. Cleared the moment the presenter actually closes their camera, so
 * "turn it off and on again" — which is the first thing anybody does when
 * something looks broken — works at once.
 *
 * It doubles as the refusal's quiet period. `pushLiveHls` runs on every roster
 * event, so a full box with a camera published would re-price and re-log the
 * same budget refusal every time anybody joined or left, for the whole party.
 * Two minutes is also the right cadence at which to ask a busy box again.
 */
const cameraCooldownUntil = new Map<string, number>();
const CAMERA_COOLDOWN_MS = 2 * 60 * 1000;

/**
 * THE COOLDOWN ENDS ON A TIMER, NOT ON THE NEXT ROOM EVENT. A refused or
 * dead camera used to be asked about again only when something else made
 * the channel reconcile, and a presenter alone on stage produces nothing
 * else: on 2026-09-23 a refused camera sat unrecorded for the rest of the
 * show. When the cooldown runs out the channel is reconciled once more,
 * which retries the camera (and, when the box is still full, refuses it
 * again and starts the next cooldown: one line and one retry every two
 * minutes for as long as it does not fit).
 */
const cameraCooldownTimers = new Map<string, ReturnType<typeof setTimeout>>();
let cameraCooldownMs = CAMERA_COOLDOWN_MS;

/** Tests only: a shorter cooldown, or the default back with no argument. */
export function setCameraCooldownMsForTests(ms?: number): void {
  cameraCooldownMs = ms ?? CAMERA_COOLDOWN_MS;
}

function startCameraCooldown(channelId: string, now = Date.now()): number {
  cameraCooldownUntil.set(channelId, now + cameraCooldownMs);
  const previous = cameraCooldownTimers.get(channelId);
  if (previous) {
    clearTimeout(previous);
  }
  const timer = setTimeout(() => {
    cameraCooldownTimers.delete(channelId);
    notifyChanged(channelId, "camera-cooldown-over");
  }, cameraCooldownMs + 50);
  timer.unref?.();
  cameraCooldownTimers.set(channelId, timer);
  return cameraCooldownMs;
}

function clearCameraCooldown(channelId: string): void {
  cameraCooldownUntil.delete(channelId);
  const timer = cameraCooldownTimers.get(channelId);
  if (timer) {
    clearTimeout(timer);
    cameraCooldownTimers.delete(channelId);
  }
}

/**
 * Per channel: has the CURRENT presenter declared "separada"
 * (`set-voice-track-mode`, `server/src/ws/voice.ts`)?
 *
 * A SECOND SIGNAL, DELIBERATELY, ALONGSIDE THE `voice-track` PUBLICATION
 * `pickScreenTracks` already finds. A Farol review on the first version of
 * this feature pointed out that a publication is a fact about LiveKit's
 * state, not a fact about the presenter's CURRENT choice — it can outlive a
 * mode the presenter has since turned off (a pending `unpublishVoiceTrack`
 * still in flight, a dropped frame) or exist on a session with no chance to
 * declare it at all (a bare LiveKit room a load test or a future client
 * talks to directly). `reconcileCameraEgress` attaches the mic only when
 * BOTH agree — the track exists AND this map says so — so neither on its
 * own is trusted to carry the whole decision.
 *
 * `voice.ts` only calls the setter for the message's sender when they are
 * the room's CURRENT `pickHlsSharer` (the same authority `pushLiveHls`
 * already defers to for who is presenting at all); anybody else's
 * declaration is a no-op. Cleared whenever the room's own session ends
 * (`stopRoom`) so a stale `true` from a party that is over cannot be read
 * by whatever starts the next one under the same channel id.
 *
 * KEYED BY PEER ID, NOT JUST A BARE BOOLEAN — a second Farol finding on top
 * of the first. A channel-wide `true` with no owner survives the presenter
 * who set it: they leave (or hand the share to a co-host) without ever
 * sending `separated: false`, a NEW presenter starts sharing, and a bare
 * boolean would credit them with a choice they never made — the exact
 * authorization gap the presenter-only setter above exists to close, just
 * one hop further out. Storing the declaring peer's id means a read has to
 * match the room's CURRENT presenter to count; a handoff with no explicit
 * disable simply reads as "not declared" for whoever presents next, which
 * is the correct, conservative default (see `wantedAudio` in
 * `reconcileCameraEgress`: no declaration is no attachment).
 */
const voiceTrackSeparatedByChannel = new Map<string, string>();

export function setVoiceTrackSeparated(
  channelId: string,
  peerId: string,
  separated: boolean,
): void {
  if (separated) {
    voiceTrackSeparatedByChannel.set(channelId, peerId);
  } else if (voiceTrackSeparatedByChannel.get(channelId) === peerId) {
    // Only this peer's OWN declaration clears it. A stale "true" left by a
    // presenter who has since gone away is not cleared here at all — it
    // simply stops matching at read time the moment `presenterPeerId`
    // changes, which is the check that actually matters.
    voiceTrackSeparatedByChannel.delete(channelId);
  }
}

function presenterWantsSeparatedVoice(
  channelId: string,
  presenterPeerId: string,
): boolean {
  return voiceTrackSeparatedByChannel.get(channelId) === presenterPeerId;
}
/**
 * Bounded retry for a `probeScreenTracks` call that could not ask LiveKit at
 * all — a momentary hiccup, not "no camera" (see where this is scheduled, in
 * `reconcileLiveHlsNow`).
 *
 * WHY IT HAS TO EXIST. That call is deliberately a silent no-op: tearing a
 * running transcode down because one `listParticipants` timed out would be
 * worse than waiting. But `pushLiveHls` otherwise fires only on a roster
 * event or `set-camera`, so a presenter whose "turn the camera on" push lands
 * on exactly that hiccup would get no camera until some UNRELATED event
 * happened to trigger another push — which on a quiet two-person watch party
 * can be a long wait, and looks exactly like the feature not working.
 *
 * BACKOFF WITH A CEILING, NOT A FIXED THREE SECONDS FOREVER. A flat interval
 * turns a prolonged LiveKit or database outage into a permanent poll — every
 * presenting room in the deployment, one `listParticipants` every three
 * seconds, for as long as the outage lasts. `CAMERA_PROBE_RETRY_STEPS_MS`
 * spaces attempts out and `clearCameraProbeRetry` stops them after the last
 * step: a probe that still cannot be answered after that is not going to
 * start answering on this channel's own schedule, and this mechanism only
 * ever existed to cover the ONE push with no other trigger. Every other path
 * — a roster event, the presenter's next `set-camera` — reaches
 * `reconcileLiveHlsNow` on its own regardless of whether this gave up.
 *
 * Deliberately NOT the film's own `restartHistory` budget: a camera probe
 * hiccup must never spend the restarts that exist to bring the FILM back. At
 * most one pending retry per channel — a second push while one is already
 * scheduled does not stack another.
 */
const cameraProbeRetryTimers = new Map<string, ReturnType<typeof setTimeout>>();
/** Attempts made since the last success, per channel. Reset by `clearCameraProbeRetry`. */
const cameraProbeRetryAttempts = new Map<string, number>();
const CAMERA_PROBE_RETRY_STEPS_MS = [3_000, 10_000, 30_000, 60_000] as const;

function scheduleCameraProbeRetry(channelId: string): void {
  if (cameraProbeRetryTimers.has(channelId)) {
    return;
  }
  const attempt = cameraProbeRetryAttempts.get(channelId) ?? 0;
  if (attempt >= CAMERA_PROBE_RETRY_STEPS_MS.length) {
    // Given up for this run of failures. Not silent: this is exactly the
    // situation `voice.hlsTrackProbeFailed` (logged inside `probeScreenTracks`
    // itself) already narrates on every attempt, so an outage this long is
    // already on the log without this adding a repeating line of its own.
    return;
  }
  const delay = CAMERA_PROBE_RETRY_STEPS_MS[attempt]!;
  cameraProbeRetryAttempts.set(channelId, attempt + 1);
  const timer = setTimeout(() => {
    cameraProbeRetryTimers.delete(channelId);
    notifyChanged(channelId, "camera-probe-retry");
  }, delay);
  timer.unref?.();
  cameraProbeRetryTimers.set(channelId, timer);
}

function clearCameraProbeRetry(channelId: string): void {
  const timer = cameraProbeRetryTimers.get(channelId);
  if (timer) {
    clearTimeout(timer);
    cameraProbeRetryTimers.delete(channelId);
  }
  cameraProbeRetryAttempts.delete(channelId);
}
let changeListener: LiveHlsChangeListener | null = null;
let sfuLoadReader: LiveHlsSfuLoadReader | null = null;
let presenterCheck: LiveHlsPresenterCheck | null = null;
let monitorTimer: ReturnType<typeof setInterval> | null = null;

let injectedEgress: LiveHlsEgressApi | null = null;
let injectedFinder: LiveHlsTrackFinder | null = null;
/** What the (skipped) readiness probe answers under a fake egress. */
let injectedPlaylistReady = true;
/** The monitor's playlist read under a fake egress; null skips that check. */
let injectedPlaylistProbe:
  | ((channelId: string, rung: string) => string | null)
  | null = null;

function truthyEnabled(): boolean {
  return process.env.LIVE_HLS_ENABLED === "true";
}

function publicBaseUrl(): string | null {
  const raw = process.env.LIVE_HLS_PUBLIC_BASE_URL?.trim();
  if (!raw) {
    return null;
  }
  return raw.replace(/\/+$/, "");
}

/**
 * `LIVE_HLS_PLAYLIST_BASE_URL`: where a viewer's playlist URLs point.
 *
 * Unset (every deployment today): a viewer's `hlsUrl` / `cameraHlsUrl` stay
 * API-relative, and hls.js/native players poll it on the API process — see
 * `docs/plans/RELOAD_STORM.md` for why that does not scale past a few
 * hundred concurrent viewers.
 *
 * Set to an edge host (`tools/hls-edge/`, proposed `hls.pqp.gg`): the SAME
 * path, with this base prepended, so the request shape a client makes is
 * unchanged and only the host differs. Safe to flip with no client change
 * because `resolveHlsUrl` in `client/src/lib/hls-playback.ts` already passes
 * an absolute URL through untouched (it exists to handle
 * `LIVE_HLS_SIGNED_URLS=false`'s raw bucket URLs, which are absolute the same
 * way) and the master playlist's own rung URIs are written as absolute PATHS
 * (`buildMasterPlaylistFor` in `hls-playlist-proxy.ts`), which a player
 * resolves against whatever host actually served the master.
 *
 * ONLY APPLIED IN `stampViewerStream` (`hls-viewer-token.ts`), never here.
 * `viewerPlaylistUrl` / `cameraPlaylistUrl` below build the CHANNEL-WIDE
 * stream, shared by every viewer and never itself sent over the wire; the
 * per-recipient `?t=` token is stamped later, and the edge host has to go on
 * AFTER that stamping, not before. Prepending it here once produced a stream
 * whose `hlsUrl` was already absolute by the time `stampViewerStream` saw
 * it, which made that function's "already absolute -- a raw, unsigned bucket
 * URL, leave it alone" check (correct for `LIVE_HLS_SIGNED_URLS=false`) treat
 * an edge URL the same way and skip minting a token for it entirely: every
 * viewer got a `?t=`-less URL and the edge Worker 401'd "missing" on every
 * request. Caught in review before it shipped; `hls-viewer-token.test.ts`
 * pins the fix.
 *
 * Only meaningful in signed mode; `LIVE_HLS_SIGNED_URLS=false` keeps handing
 * out the raw bucket URL regardless, same as today.
 */
export function playlistBaseUrl(): string | null {
  const raw = process.env.LIVE_HLS_PLAYLIST_BASE_URL?.trim();
  if (!raw) {
    return null;
  }
  return raw.replace(/\/+$/, "");
}

function delaySeconds(): number {
  const raw = Number(process.env.LIVE_HLS_DELAY_SECONDS);
  return Number.isFinite(raw) && raw > 0
    ? Math.floor(raw)
    : DEFAULT_DELAY_SECONDS;
}

let warnedLadder: string | null = null;

/**
 * `LIVE_HLS_LADDER`: the renditions this deployment encodes, lowest first.
 * A comma-separated list of rung names (`720p30`, the default), each
 * optionally carrying a bitrate override (`1080p30@3500`). Named 1080 and
 * 60 fps rungs stay available for an operator who wants them.
 * `LIVE_HLS_PRESET` is still read as the name of a ONE-RUNG ladder, so a
 * deployment that already sets it keeps exactly the behaviour it has.
 *
 * Entries that name nothing log `voice.hlsLadderInvalid` once per distinct
 * value; a list with no valid entry at all falls back to the default rather
 * than leaving a watch party with no rendition.
 */
export function liveHlsLadder(): LadderRung[] {
  const raw = process.env.LIVE_HLS_LADDER;
  const preset = process.env.LIVE_HLS_PRESET;
  const parsed = parseLadder({ ladder: raw, preset });
  if (parsed.invalid.length > 0) {
    const key = parsed.invalid.join(",");
    if (warnedLadder !== key) {
      warnedLadder = key;
      logEvent("voice.hlsLadderInvalid", {
        value: key,
        accepted: Object.keys(LADDER_RUNGS),
        using: parsed.rungs.map((rung) => rung.name),
      });
    }
  }
  return parsed.rungs;
}

const DEFAULT_RETENTION_MINUTES = 10;
/**
 * Thirty days, and the window every recording gets by default now: new rows
 * are inserted with `keep_replay = TRUE` (`recordSessionStarted` here and
 * `recordLlSessionStarted` in `hls-remux.ts`), so a show is in "Transmissões
 * anteriores" the morning after without anybody having remembered to flip the
 * toggle within ten minutes of the end. Switching it off is what sends a
 * broadcast to the short `LIVE_HLS_RETENTION_MINUTES` window instead.
 */
const DEFAULT_REPLAY_HOURS = 720;
const DEFAULT_URL_TTL_SECONDS = 900;

function positiveIntFromEnv(name: string, fallback: number): number {
  const raw = Number(process.env[name]);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : fallback;
}

/** How long a finished session's objects stay once nobody asked to keep it. */
export function hlsRetentionMinutes(): number {
  return positiveIntFromEnv(
    "LIVE_HLS_RETENTION_MINUTES",
    DEFAULT_RETENTION_MINUTES,
  );
}

/** How long a finished session's objects stay when `keep_replay` is set. */
export function hlsReplayHours(): number {
  return positiveIntFromEnv("LIVE_HLS_REPLAY_HOURS", DEFAULT_REPLAY_HOURS);
}

/** TTL for a viewer's presigned segment URLs and playlist-proxy access. */
export function hlsUrlTtlSeconds(): number {
  return positiveIntFromEnv("LIVE_HLS_URL_TTL_SECONDS", DEFAULT_URL_TTL_SECONDS);
}

const DEFAULT_SEGMENT_SECONDS = 2;
const MAX_SEGMENT_SECONDS = 10;

/**
 * Segment length the egress is asked for, `LIVE_HLS_SEGMENT_SECONDS`.
 *
 * WHY THIS IS A KNOB. The egress uploads segments in parallel, but after
 * each one its playlist goroutine uploads the index playlist and the live
 * playlist one after the other, synchronously, before the segment is listed
 * (`pkg/pipeline/sink/segments.go` in egress 1.14.1, every segment in the
 * first hour). Each of those PUTs is a cross-region write to the bucket:
 * measured 2026-09-12 from the São Paulo box to the WEUR bucket, a 1 KB PUT
 * took 0.6 to 1.0 s (0.25 s from London). At 2 s segments that is two
 * seconds of serialised playlist uploads per two seconds of media, and on a
 * slow afternoon the live party's playlist advanced 19 to 25 segments a
 * minute instead of 30: every viewer, web and native, caught the edge and
 * starved every 10 to 15 s while the encoder sat at a third of a core.
 * Four-second segments halve the playlist PUTs per second of media for the
 * same bytes; viewers sit about twice as far behind (the client counts
 * segments, not seconds). Takes effect on the NEXT session: a running egress
 * keeps the length it started with.
 */
export function hlsSegmentSeconds(): number {
  const raw = positiveIntFromEnv("LIVE_HLS_SEGMENT_SECONDS", DEFAULT_SEGMENT_SECONDS);
  return Math.min(raw, MAX_SEGMENT_SECONDS);
}

/**
 * How many parties this process will transcode at once. Three.
 *
 * WHY THERE HAS TO BE ONE. `decideLadder` already prices the box, but read
 * its first rule: the lowest rung ALWAYS starts, because a party with no
 * rendition is a party nobody can see. That is right per party and unbounded
 * across parties: the fourth, tenth and fortieth simultaneous party each get
 * their floor rung whatever the budget says, and the budget only ever refuses
 * the rungs above it. So the ladder guard degrades quality and never refuses
 * a session, and something has to refuse the session.
 *
 * WHY THREE. Measured on the box production runs (`docs/CAPACITY.md`,
 * 2026-09-09): `1080p30` costs 0.88 of a core and `720p30` costs 0.51. The
 * first party gets the default two-rung ladder, 1.39 cores; every party after
 * it finds the ladder budget already spent and gets its floor rung alone,
 * 0.51. Three parties is therefore about 2.4 of the box's 4 cores, which
 * leaves the SFU, the TURN relay and everything else on the same machine the
 * rest. An operator with a bigger box says so with a bigger number; there is
 * no sentinel for "unlimited", because a value that turns the guard off is
 * the value somebody sets by accident.
 */
export const DEFAULT_MAX_HLS_SESSIONS = 3;

export function maxLiveHlsSessions(): number {
  return positiveIntFromEnv("LIVE_HLS_MAX_SESSIONS", DEFAULT_MAX_HLS_SESSIONS);
}

/**
 * ON BY DEFAULT, and `LIVE_HLS_REAP_ORPHANS=false` is the rollback switch.
 *
 * `reapForeignEgresses` is the only mechanism here that STOPS something it
 * did not start, and it is landing days before a large event. Its scope is
 * deliberately narrow (see the function), but "one command, no deploy" is how
 * this repo lands anything that can go wrong on a night that matters, the way
 * `TURN_PREFER_STATIC` and `WS_COMPRESSION` do. Turning it off restores the
 * pre-2026-09-09 behaviour: leftovers accumulate and `liveHls.orphansStopped`
 * stays at zero because nothing is looking.
 */
export function reapOrphansEnabled(): boolean {
  const raw = process.env.LIVE_HLS_REAP_ORPHANS?.trim().toLowerCase();
  return raw !== "false" && raw !== "0" && raw !== "off";
}

/**
 * `LIVE_HLS_MIC_ARCHIVE`: **off by default**, and off is a deployment that
 * behaves exactly as it did before this existed.
 *
 * On, two things change and neither touches the stream. The config endpoint
 * tells the presenter's browser to publish a second copy of its processed
 * microphone under the name `mic-archive`, and this process starts a LiveKit
 * **Track Egress** on it: no transcode, one Opus track straight to
 * `live/<channelId>/<startedAt>-mic.ogg` in the same bucket as the segments,
 * on the same retention row machinery as every rung. The HLS audience still
 * hears the mix; what this buys is a clip cut later with the film and the
 * voice on separate tracks.
 *
 * Read per call like every other switch in this file, so it can be turned on
 * or off without a deploy. Turning it off mid-party stops the archive at the
 * next monitor tick and leaves the party alone.
 */
export function micArchiveEnabled(): boolean {
  return process.env.LIVE_HLS_MIC_ARCHIVE === "true";
}

/**
 * ON BY DEFAULT, and `LIVE_HLS_CAMERA=false` is the rollback switch.
 *
 * The presenter's camera gets a transcode of its own so the seatless audience
 * can see a face (`docs/WATCH_PARTY.md`, "The presenter's camera, floating
 * over the film"). It costs about 0.2 to 0.3 of a core, only ever while the
 * host has deliberately turned a camera on, and `decideCameraEgress` refuses
 * it outright on a box with nothing left. Turning it off restores exactly the
 * pre-2026-09-13 behaviour: no second egress, no `cameraHlsUrl` on any frame,
 * and every client's PiP draws nothing because there is nothing to draw.
 *
 * One command and no deploy, the same shape as `TURN_PREFER_STATIC` and
 * `LIVE_HLS_REAP_ORPHANS`, because this lands on a box that also carries the
 * SFU and the TURN relay.
 */
export function liveHlsCameraEnabled(): boolean {
  const raw = process.env.LIVE_HLS_CAMERA?.trim().toLowerCase();
  return raw !== "false" && raw !== "0" && raw !== "off";
}

/**
 * `LIVE_HLS_VOICE_TRACK`: **off by default**, and off is exactly the
 * pre-2026-09-13 behaviour — `cameraHlsUrl` (when there is one at all) is
 * silent, and a host's voice, if the audience hears it, arrives mixed into
 * the film (`lib/screen-mix.ts`, "junto").
 *
 * On, two things become possible and neither is forced. The client's host
 * panel offers "voz separada" (only once `GET /api/live-hls/config` says
 * `voiceTrack: true` — a build must never publish an extra track against a
 * deployment that will not carry it, the same rule `micArchive` already
 * follows); and, when a presenter picks it, `reconcileCameraEgress` attaches
 * their ordinary microphone publication to the camera slot — beside their
 * camera video when they have one (`CAMERA_RUNG_WITH_VOICE`), alone when they
 * do not (`VOICE_RUNG`). Turning it off mid-party stops the attach at the
 * next reconcile and returns the slot to `CAMERA_RUNG` (or closes it, with no
 * camera), the same rollback shape every other switch in this file has.
 */
export function liveHlsVoiceTrackEnabled(): boolean {
  return process.env.LIVE_HLS_VOICE_TRACK === "true";
}

/**
 * Default true: a viewer gets a presigned, expiring URL rather than the raw
 * public bucket URL. Set `LIVE_HLS_SIGNED_URLS=false` to fall back to the
 * old public-base-URL behaviour (e.g. a bucket that is deliberately public).
 */
export function hlsSignedUrlsEnabled(): boolean {
  return process.env.LIVE_HLS_SIGNED_URLS !== "false";
}

/** The separate `LIVE_HLS_S3_*` bucket, in the shape `s3.ts` operations want. */
export function liveHlsStorageConfig(): StorageConfig | null {
  return buildStorageConfig({
    bucket: process.env.LIVE_HLS_S3_BUCKET,
    accessKeyId: process.env.LIVE_HLS_S3_ACCESS_KEY_ID,
    secretAccessKey: process.env.LIVE_HLS_S3_SECRET_ACCESS_KEY,
    endpoint: process.env.LIVE_HLS_S3_ENDPOINT,
    region: process.env.LIVE_HLS_S3_REGION,
    forcePathStyle: process.env.LIVE_HLS_S3_FORCE_PATH_STYLE === "true",
    publicBaseUrl: process.env.LIVE_HLS_PUBLIC_BASE_URL,
  });
}

/**
 * The exact string every object ONE RENDITION writes starts with: the
 * segments (`filenamePrefix`) and both playlist names all derive from
 * `live/{channelId}/{startedAt}-{rung}`, per `segmentOutput` below. The
 * retention sweep deletes only objects under this prefix, so this function
 * is the single source of truth both `hls-egress.ts` and `hls-cleanup.ts`
 * call, rather than each re-deriving the string.
 *
 * The rung is part of the prefix because a ladder runs one egress per
 * rendition and each needs its own segments, its own media playlist and its
 * own retention row. Omitting it names the session as a whole, which is what
 * `sessionPrefixPattern` matches on and what a pre-ladder session's single
 * row still looks like.
 */
export function hlsObjectPrefix(
  channelId: string,
  startedAt: number,
  rung?: string,
): string {
  const base = `live/${channelId}/${startedAt}`;
  return rung ? `${base}-${rung}` : base;
}

/**
 * A `LIKE` pattern matching every rung of one session. Safe as a literal:
 * the channel id is a UUID and `startedAt` is digits, so neither can carry
 * `%` or `_`.
 */
export function sessionPrefixPattern(
  channelId: string,
  startedAt: number,
): string {
  return `${hlsObjectPrefix(channelId, startedAt)}-%`;
}

/**
 * `live/<channelId>/<startedAt>-<rung>` -> startedAt, and the rung beside it:
 * `hlsObjectPrefix` read backwards, and it lives beside it so the two can
 * never drift apart.
 *
 * The rung suffix is why this cannot be a bare `Number(tail)`: with a ladder
 * every prefix ends `-1080p30` or similar, `Number` answers NaN, and a row
 * that cannot be parsed is treated as unadoptable and its egress STOPPED.
 * That would kill a live watch party on every deploy, which is the exact
 * failure the boot reconcile was written to stop.
 */
export function parseHlsObjectPrefix(
  prefix: string,
): { startedAt: number; rung: string | null } | null {
  const tail = prefix.split("/").pop() ?? "";
  const dash = tail.indexOf("-");
  const startedAtPart = dash === -1 ? tail : tail.slice(0, dash);
  const rung = dash === -1 ? null : tail.slice(dash + 1);
  const parsed = Number(startedAtPart);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return null;
  }
  return { startedAt: parsed, rung: rung || null };
}

/**
 * One row per rendition: each has its own objects, egress and retention.
 *
 * `reopen` IS THE CAMERA'S, AND IT IS NOT AN OPTIMISATION.
 *
 * A ladder rung never comes back under a prefix it has already used: every
 * restart mints a new `startedAt`, so `DO NOTHING` there is pure idempotency
 * and must stay that way. The camera is the one thing that starts and stops
 * INSIDE a session — that is the whole design, because a new `startedAt` would
 * rebuffer the audience — so a host switching their webcam off and on again
 * lands on the same `object_prefix` with the row already stamped `ended_at`.
 * `DO NOTHING` leaves it ended, and the playlist proxy refuses an ended
 * session by design (`renderSignedPlaylist`), so the second camera would
 * transcode perfectly and 404 for every viewer, for as long as the party ran.
 *
 * `cleaned_at` is cleared with it: a camera off for longer than
 * `LIVE_HLS_RETENTION_MINUTES` has had its objects swept, and the fresh egress
 * writes new ones under the same prefix.
 */
/** What `recordSessionStarted` hands back: whether the write is safe to
 * build on, separately from whether the row's id could be resolved. */
interface RecordedSession {
  /** False only when the write itself threw. Callers that gate on the write
   * succeeding (the camera path) check this, not `sessionId`. */
  ok: boolean;
  /**
   * The row's `hls_sessions.id` (BROADCAST_PIPELINE B0.4), threaded into
   * `voice.hlsStarted` and its neighbours and into the playlist's own
   * `#EXT-X-PQP-SESSION` tag. Null whenever it could not be resolved --
   * which is NOT the same as the write failing: see below.
   */
  sessionId: string | null;
}

/**
 * `RETURNING id` answers directly on an insert or a `reopen` update, but a
 * plain `DO NOTHING` conflict returns no row at all -- Postgres did not touch
 * one, so there is nothing to return -- even though the row the caller wants
 * the id of is sitting right there. One extra read on that one path hands
 * every caller the same id every other path gets.
 *
 * `sessionId: null` ON A SUCCESSFUL WRITE IS EXPECTED, NOT AN ERROR. A test
 * pool that answers every query with `{ rowCount: 0, rows: [] }` (most of
 * this file's suite) never gives either statement above a row to return, so
 * the id stays null while the write itself did exactly what it always did.
 * `ok` is the only field a caller may treat as failure; conflating "the id"
 * with "did it work" would make a mocked pool's silence about the id look
 * like the insert never happened, which is a different bug from B0.4.
 */
async function recordSessionStarted(
  channelId: string,
  startedAt: number,
  egressId: string,
  rung: string,
  presenterPeerId: string,
  videoTrackId: string,
  reopen = false,
  // The camera/voice slot's SEPARATE audio sid, when it has one
  // (`CAMERA_RUNG_WITH_VOICE` or `VOICE_RUNG`). Null for every ladder rung
  // and for a plain, silent `CAMERA_RUNG` — those never had two tracks to
  // tell apart. Stored in its own column so `reconcileStaleHlsSessions` can
  // adopt the exact shape a restart interrupted rather than guessing it
  // back from a single id: see `adoptCameraEgress`.
  audioTrackId: string | null = null,
): Promise<RecordedSession> {
  const objectPrefix = hlsObjectPrefix(channelId, startedAt, rung);
  try {
    const result = await getPool().query<{ id: string }>(
      // `keep_replay = TRUE` on every new row: recordings are kept by default
      // (see `DEFAULT_REPLAY_HOURS`). The camera's reopen below leaves the
      // column alone, so a broadcast a moderator already chose to drop is
      // not quietly kept again.
      `INSERT INTO hls_sessions
         (channel_id, object_prefix, started_at, egress_id, rung,
          presenter_peer_id, video_track_id, audio_track_id, instance_id,
          keep_replay)
       VALUES ($1, $2, to_timestamp($3 / 1000.0), $4, $5, $6, $7, $8, $9, TRUE)
       ${
         reopen
           ? `ON CONFLICT (object_prefix) DO UPDATE
                SET egress_id = EXCLUDED.egress_id,
                    presenter_peer_id = EXCLUDED.presenter_peer_id,
                    video_track_id = EXCLUDED.video_track_id,
                    audio_track_id = EXCLUDED.audio_track_id,
                    instance_id = EXCLUDED.instance_id,
                    ended_at = NULL,
                    cleaned_at = NULL`
           : "ON CONFLICT (object_prefix) DO NOTHING"
       }
       RETURNING id`,
      [
        channelId,
        objectPrefix,
        startedAt,
        egressId,
        rung,
        presenterPeerId,
        videoTrackId,
        audioTrackId,
        // WHICH PROCESS IS DRIVING THIS TRANSCODE. Read by every other
        // machine's boot reconcile, reaper and ghost filter before it adopts,
        // ends or stops anything: see `hls-ownership.ts`.
        hlsOwnerInstanceId(),
      ],
    );
    if (result.rows[0]) {
      return { ok: true, sessionId: result.rows[0].id };
    }
    const existing = await getPool().query<{ id: string }>(
      `SELECT id FROM hls_sessions WHERE object_prefix = $1`,
      [objectPrefix],
    );
    return { ok: true, sessionId: existing.rows[0]?.id ?? null };
  } catch (error) {
    logEvent("voice.hlsSessionRecordFailed", {
      channelId,
      startedAt,
      rung,
      error: error instanceof Error ? error.message : String(error),
    });
    return { ok: false, sessionId: null };
  }
}

/**
 * End one rung's row, or (no rung) every rung of the session. Ending a
 * single rung is what drops a dead secondary rendition out of the master
 * playlist while the rest of the ladder keeps playing.
 */
async function recordSessionEnded(
  channelId: string,
  startedAt: number,
  rung?: string,
): Promise<void> {
  try {
    if (rung) {
      await getPool().query(
        `UPDATE hls_sessions SET ended_at = NOW()
         WHERE object_prefix = $1 AND ended_at IS NULL`,
        [hlsObjectPrefix(channelId, startedAt, rung)],
      );
      return;
    }
    await getPool().query(
      `UPDATE hls_sessions SET ended_at = NOW()
       WHERE channel_id = $1
         AND (object_prefix = $2 OR object_prefix LIKE $3)
         AND ended_at IS NULL`,
      [
        channelId,
        hlsObjectPrefix(channelId, startedAt),
        sessionPrefixPattern(channelId, startedAt),
      ],
    );
  } catch (error) {
    logEvent("voice.hlsSessionEndFailed", {
      channelId,
      startedAt,
      rung: rung ?? null,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * A new start for this channel makes every earlier session for it finished,
 * including ones this process never had in `rooms` (a previous API, a
 * share that outlived its watch party). Ending the rows is what lets
 * retention delete their objects; stopping leftover LiveKit egresses is
 * what stops them writing a second live playlist next to the real one.
 *
 * `keepStartedAt` / `keepEgressIds` are THIS start. Without them a
 * concurrent list would stop the rungs we just asked for.
 */
async function endSupersededSessions(
  channelId: string,
  keepStartedAt: number,
  keepEgressIds: ReadonlySet<string>,
): Promise<void> {
  try {
    const ended = await getPool().query(
      `UPDATE hls_sessions SET ended_at = NOW()
       WHERE channel_id = $1
         AND ended_at IS NULL
         AND started_at <> to_timestamp($2 / 1000.0)`,
      [channelId, keepStartedAt],
    );
    if ((ended.rowCount ?? 0) > 0) {
      logEvent("voice.hlsSupersededSessionsEnded", {
        channelId,
        keepStartedAt,
        ended: ended.rowCount,
      });
    }
  } catch (error) {
    logEvent("voice.hlsSupersededSessionEndFailed", {
      channelId,
      keepStartedAt,
      error: error instanceof Error ? error.message : String(error),
    });
  }

  const active = await listActiveEgresses();
  if (!active) {
    return;
  }
  // PARALLEL, NOT A FOR-AWAIT LOOP. Each `stopEgressById` is its own bounded
  // RPC (see `EGRESS_REQUEST_TIMEOUT_SECONDS` in `getEgress`); a channel can
  // be superseding more than one leftover rung, and stopping them one at a
  // time meant N leftovers cost N sequential waits on the SFU before this
  // resolved. `startRoom` runs this alongside `waitForLivePlaylist`, so the
  // wall time this function takes rides directly on top of the new
  // session's time-to-first-playlist -- the "conventional ladder start took
  // 7.6-10.9s" measurement (2026-09-23) this exists to shrink.
  await Promise.all(
    active
      .filter(
        (info) => info.roomName === channelId && !keepEgressIds.has(info.egressId),
      )
      .map(async (info) => {
        const stopped = await stopEgressById(info.egressId, channelId);
        if (stopped) {
          logEvent("voice.hlsSupersededEgressStopped", {
            channelId,
            egressId: info.egressId,
            keepStartedAt,
          });
        }
      }),
  );
}

function liveHlsStorage(): {
  bucket: string;
  accessKey: string;
  secret: string;
  endpoint: string;
  region: string;
  forcePathStyle: boolean;
} | null {
  const bucket = process.env.LIVE_HLS_S3_BUCKET?.trim();
  const accessKey = process.env.LIVE_HLS_S3_ACCESS_KEY_ID?.trim();
  const secret = process.env.LIVE_HLS_S3_SECRET_ACCESS_KEY?.trim();
  const endpoint = process.env.LIVE_HLS_S3_ENDPOINT?.trim();
  if (!bucket || !accessKey || !secret || !endpoint) {
    return null;
  }
  return {
    bucket,
    accessKey,
    secret,
    endpoint,
    region: process.env.LIVE_HLS_S3_REGION?.trim() || "auto",
    forcePathStyle: process.env.LIVE_HLS_S3_FORCE_PATH_STYLE === "true",
  };
}

/**
 * Flag plus every secret the egress request needs. Read per call. The
 * public base is part of "configured" only in unsigned mode, where it is the
 * URL a viewer is handed; signed mode never reads it (see the file header).
 */
export function isLiveHlsEnabled(): boolean {
  return (
    truthyEnabled() &&
    isLiveKitConfigured() &&
    (hlsSignedUrlsEnabled() || publicBaseUrl() !== null) &&
    liveHlsStorage() !== null
  );
}

/**
 * `LIVE_HLS_SERVER_ALLOWLIST`: comma-separated server ids that may run live
 * HLS. Unset or empty means every server (null). Read per call, like the
 * flag, so an operator can widen the list without a deploy.
 */
export function liveHlsServerAllowlist(): Set<string> | null {
  const raw = process.env.LIVE_HLS_SERVER_ALLOWLIST;
  if (!raw) {
    return null;
  }
  const ids = raw
    .split(",")
    .map((id) => id.trim())
    .filter((id) => id.length > 0);
  return ids.length > 0 ? new Set(ids) : null;
}

/**
 * `servers.live_hls_enabled` for one server: TRUE / FALSE when an operator
 * has decided, NULL when nobody has.
 *
 * Read per call, never cached, for the same reason the flag is: the whole
 * point of moving this out of the environment is that a change takes effect
 * without a deploy and without restarting `pqp-api`. One indexed primary-key
 * lookup, on paths that run once per room pin and once per share, not per
 * frame.
 *
 * A failed read answers NULL, which falls back to the environment. A database
 * hiccup must not silently revoke a running event's stream, and the
 * environment is exactly the answer this deployment had before the column
 * existed.
 */
export async function liveHlsServerOverride(
  serverId: string,
): Promise<boolean | null> {
  try {
    const result = await getPool().query<{ live_hls_enabled: boolean | null }>(
      `SELECT live_hls_enabled FROM servers WHERE id = $1`,
      [serverId],
    );
    return result.rows[0]?.live_hls_enabled ?? null;
  } catch (error) {
    logEvent("voice.hlsOverrideReadFailed", {
      serverId,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

/**
 * The per-server answer, given the row this server carries. Pure, so the
 * whole resolution matrix is testable without a database.
 *
 * ORDER, AND WHY. The master switch first: `LIVE_HLS_ENABLED` plus LiveKit
 * plus the dedicated bucket. Nothing below can turn on a deployment that
 * cannot encode. Then the per-server row, TRUE or FALSE alike, because it is
 * a decision a person made about this one server, from the dashboard, after
 * whoever set the environment variable had left the building; it is also the
 * only kill switch that does not need a deploy, which is worth more during a
 * live event than consistency with a Fly secret. Only a NULL row falls
 * through to `LIVE_HLS_SERVER_ALLOWLIST`, which keeps behaving exactly as it
 * always did: on the list is on, no list at all is every server.
 *
 * The last two lines are the previous function verbatim, INCLUDING the case
 * where there is no allowlist and no server id: a deployment that confines
 * nothing answers true for a conversation too. That is not obviously right
 * (nothing starts an egress outside a `watch_party` channel, which is always
 * in a server), and it is deliberately left alone here: production runs with
 * an allowlist, so it already answers false, and widening or narrowing it is
 * a separate decision from moving the list into a table.
 */
export function resolveLiveHlsForServer(
  serverId: string | null | undefined,
  override: boolean | null,
): boolean {
  if (!isLiveHlsEnabled()) {
    return false;
  }
  if (override !== null) {
    return override;
  }
  const allowlist = liveHlsServerAllowlist();
  if (allowlist === null) {
    return true;
  }
  return Boolean(serverId) && allowlist.has(serverId!);
}

/**
 * The per-server answer, reading the row. Async since the source of truth
 * moved into the database; every caller was already on an async path.
 */
export async function isLiveHlsEnabledForServer(
  serverId: string | null | undefined,
): Promise<boolean> {
  if (!isLiveHlsEnabled()) {
    return false;
  }
  return resolveLiveHlsForServer(
    serverId,
    serverId ? await liveHlsServerOverride(serverId) : null,
  );
}

export interface LiveHlsConfig {
  /** Per-server when a `serverId` is given, the global flag otherwise. */
  enabled: boolean;
  delaySeconds: number;
  /**
   * Whether live HLS is confined to named servers rather than open to all.
   *
   * True when `LIVE_HLS_SERVER_ALLOWLIST` is set, and, for a per-server
   * answer, also when this server's own `live_hls_enabled` row decided it.
   * The client only ever reads it to say why streaming is off, so "somebody
   * chose, per server" is the same sentence as "there is a list".
   */
  allowlisted: boolean;
  /**
   * The renditions this deployment encodes, lowest first. The presenter's
   * client reads the TOP of it: the egress transcodes from the published
   * WebRTC track, so a 720p source cannot produce a 1080p rendition however
   * the ladder is configured. Sending it here rather than hard-coding 1080
   * in the client means an operator who runs a 720p-only ladder does not get
   * a presenter uploading 4 Mbit/s for nothing.
   */
  ladder: {
    name: string;
    width: number;
    height: number;
    framerate: number;
    videoKbps: number;
  }[];
  /**
   * Whether the presenter should publish the extra `mic-archive` track.
   *
   * The client must never decide this from a build flag: the recording is
   * this deployment's, the bucket is this deployment's, and a browser that
   * published the track against a server which is not recording it would put
   * a second microphone into every room for nothing. False whenever HLS is
   * off for this answer, because an archive with no session to hang off is
   * not a thing that can start.
   */
  micArchive: boolean;
  /**
   * Whether the client may offer "voz separada" at all (`LIVE_HLS_
   * VOICE_TRACK`). Same rule as `micArchive`: the client must never infer
   * this from a build flag, because whether it is worth excluding the mic
   * from the screen mix depends on whether THIS deployment's camera slot can
   * actually carry it. False whenever HLS is off for this answer.
   */
  voiceTrack: boolean;
  /**
   * Whether the client may offer "Baixa latência (beta)" at all
   * (`LIVE_HLS_LL` plus, when set, `LIVE_HLS_LL_ALLOWLIST`). Same rule as
   * `micArchive`/`voiceTrack`: a client must never infer this from a build
   * flag, and the switch stays hidden wherever this is false, whatever the
   * host's saved preference already says. See `liveHlsLLAvailable` in
   * `hls-remux.ts`.
   */
  lowLatency: { available: boolean };
}

/**
 * The deployment-wide answer, with no server in hand. Still synchronous:
 * nothing here reads a row, and the dashboard's metrics payload wants it on
 * the hot path with the rest of the process counters.
 */
export function liveHlsConfig(): LiveHlsConfig {
  const allowlist = liveHlsServerAllowlist();
  return {
    enabled: isLiveHlsEnabled(),
    delaySeconds: delaySeconds(),
    allowlisted: allowlist !== null,
    micArchive: isLiveHlsEnabled() && micArchiveEnabled(),
    voiceTrack: isLiveHlsEnabled() && liveHlsVoiceTrackEnabled(),
    lowLatency: { available: liveHlsLLAvailable(null) },
    ladder: liveHlsLadder().map((rung) => ({
      name: rung.name,
      width: rung.width,
      height: rung.height,
      framerate: rung.framerate,
      videoKbps: rung.videoKbps,
    })),
  };
}

/**
 * The answer for one server, or the deployment-wide one when there is no
 * server (`GET /api/live-hls/config` with no `?serverId=`, which is what a
 * client asks before it knows where it is).
 */
export async function liveHlsConfigForServer(
  serverId: string | null,
): Promise<LiveHlsConfig> {
  const base = liveHlsConfig();
  if (!serverId) {
    return base;
  }
  const override = await liveHlsServerOverride(serverId);
  const enabled = resolveLiveHlsForServer(serverId, override);
  return {
    ...base,
    enabled,
    allowlisted: base.allowlisted || override !== null,
    // Follows THIS server's answer, not the deployment's: a server the
    // operator has switched off records nothing, so its host must not be
    // asked to publish a track for it.
    micArchive: enabled && micArchiveEnabled(),
    voiceTrack: enabled && liveHlsVoiceTrackEnabled(),
    // Independent of `enabled`/`allowlisted` above (those gate the egress
    // itself, `LIVE_HLS_ENABLED` / `live_hls_enabled`): LL-HLS has its own
    // flag and its own allowlist, so a server with ordinary HLS on can still
    // be off the LL allowlist, and vice versa in a self-host that runs
    // `pqp-remux` everywhere.
    lowLatency: { available: liveHlsLLAvailable(serverId) },
  };
}

/** The channels this process is currently running an egress for. */
export function liveHlsRunningChannelIds(): string[] {
  return [...rooms.keys()];
}

/**
 * The stream this process is prepared to tell an audience about.
 *
 * `announced` is the whole of the difference from a bare `rooms.get`: a
 * session still inside its readiness probe is a real room to the monitor, the
 * reap and the restart path, and nothing at all to a viewer. See `RoomHls`.
 */
export function liveHlsStreamFor(channelId: string): LiveHlsStream | null {
  return announcedStreamOf(rooms.get(channelId));
}

/**
 * The same rule for a room the caller already holds: a session still inside
 * its readiness probe is nothing an audience may be handed. Every reconcile
 * branch that hands a caller's own `current` back goes through this, so
 * `startRoom`'s wait cannot leak a not-yet-playable URL out sideways through
 * a concurrent push.
 */
function announcedStreamOf(room: RoomHls | undefined): LiveHlsStream | null {
  return room && room.announced ? room.stream : null;
}

/**
 * WHOSE RECONCILE IS THE ONE THAT MATTERS FOR THIS CHANNEL.
 *
 * Both drivers' maps in one question, because "the machine that can actually
 * change this party's transcode" is exactly "the one holding the session",
 * whichever driver produced it. Read by `ws/voice.ts` to decide whether to
 * run a reconcile here or relay the intent to the machine that can: a
 * viewer's `voice.join` landing on the other machine ran `reconcileLiveHls`
 * against an empty `rooms` map and did nothing at all, which is how a party
 * that needed its mode re-checked (a demotion, a presenter change) sat on the
 * wrong one until something happened to touch the owner.
 */
export function liveHlsOwnsChannel(channelId: string): boolean {
  return rooms.has(channelId) || llHasRoom(channelId);
}

/**
 * When this process ADOPTED the session it holds for a channel (either mode),
 * or null when it started it itself or holds nothing. See `RoomHls.adoptedAtMs`.
 */
export function liveHlsAdoptedAt(channelId: string): number | null {
  const room = rooms.get(channelId);
  if (room) {
    return room.adoptedAtMs ?? null;
  }
  return llAdoptedAt(channelId);
}

/**
 * Forget every cached resume decision for a channel, both modes. Called when
 * the machine that held the session says it has just handed it to this one:
 * the `stand-down` remembered a moment ago ("a live machine owns this") is
 * precisely the answer that stopped being true, and serving it for another
 * five seconds would leave the party with no monitor for no reason.
 */
export function forgetLiveHlsResumeDecisions(channelId: string): void {
  resumeDecisionEpoch.set(channelId, (resumeDecisionEpoch.get(channelId) ?? 0) + 1);
  const prefix = `${channelId.length}:${channelId}:`;
  for (const key of resumeDecisionCache.keys()) {
    if (key.startsWith(prefix)) {
      resumeDecisionCache.delete(key);
    }
  }
  forgetLlResumeDecisions(channelId);
}

/** Sessions this process handed to another machine since it started. */
let handoversTotal = 0;

export function liveHlsHandoverCount(): number {
  return handoversTotal;
}

/**
 * HAND A RUNNING SESSION TO THE MACHINE THE PRESENTER IS ON, AND STOP NOTHING.
 *
 * The presenter's seat can land on the OTHER `pqp-api` machine at any time: a
 * rolling deploy drains this one's sockets, a Wi-Fi blip reconnects through
 * the proxy to the sibling. The transcode itself is not on either machine (it
 * is a LiveKit egress or a pqp-remux session on the media box), so the only
 * question is which process monitors it, and the answer has to be the one
 * holding the presenter: that is where `set-sharing-screen`, a track
 * replacement and the end of the share arrive.
 *
 * Until 2026-09-24 nothing could move it. The owner saw no local sharer and
 * ended the session after five seconds (`hlsStopped reason=no-share`) while
 * the machine with the sharer refused to adopt a session a live machine
 * owned (`hlsSkippedOwnedElsewhere site=resume-adopt`). Each side was right
 * by its own rules, and the party went dark twice in one rolling deploy of a
 * rehearsal (channel `ad99074f`).
 *
 * THE ROW IS THE HANDOVER. Every open row of the channel this process owns is
 * re-stamped with the target instance in one conditional UPDATE (and with the
 * presenter's current peer id, so a reattach this process made in memory does
 * not read as a different presenter over there). Only when that lands is the
 * room forgotten here, WITHOUT stopping a single egress. The target's own
 * `adoptRunningLiveHlsSession` / `adoptRunningLlHlsSession` then claims the
 * rows as its own, which is the path a resume already takes after a deploy.
 * Between the two nothing is torn down: the ladder keeps writing segments on
 * the media box, so viewers see nothing at all. Never two ladders (nothing is
 * started here), never zero (nothing is stopped here).
 *
 * If the UPDATE fails, nothing changes and the caller tries again later. If
 * the target dies before it adopts, its heartbeat lapses and the rows are free
 * for whichever machine the presenter resumes on next, exactly like a crash.
 *
 * Serialised on the channel's reconcile queue, so it can never interleave with
 * a start, a stop or a mode flip for the same channel.
 */
export function releaseLiveHlsSession(input: {
  channelId: string;
  startedAt: number;
  toInstanceId: string;
  presenterPeerId: string;
}): Promise<boolean> {
  const { channelId } = input;
  const previous = reconcileQueue.get(channelId) ?? Promise.resolve();
  const run = previous
    .catch(() => undefined)
    .then(() => releaseLiveHlsSessionNow(input));
  const queued = run.then(
    () => undefined,
    () => undefined,
  );
  reconcileQueue.set(channelId, queued);
  void queued.finally(() => {
    if (reconcileQueue.get(channelId) === queued) {
      reconcileQueue.delete(channelId);
    }
  });
  return run.catch((error: unknown) => {
    logEvent("voice.hlsHandoverFailed", {
      channelId,
      to: input.toInstanceId,
      error: error instanceof Error ? error.message : String(error),
    });
    return false;
  });
}

async function releaseLiveHlsSessionNow(input: {
  channelId: string;
  startedAt: number;
  toInstanceId: string;
  presenterPeerId: string;
}): Promise<boolean> {
  const { channelId, startedAt, toInstanceId, presenterPeerId } = input;
  const ladder = rooms.get(channelId);
  const ll = llStreamFor(channelId);
  const mode =
    ladder && ladder.stream.startedAt === startedAt
      ? "conventional"
      : ll && ll.startedAt === startedAt
        ? "ll"
        : null;
  if (mode === null || toInstanceId === hlsOwnerInstanceId()) {
    return false;
  }
  const result = await getPool().query<{ id: string }>(
    `UPDATE hls_sessions
        SET instance_id = $2,
            presenter_peer_id = CASE
              WHEN presenter_peer_id IS NULL THEN NULL
              ELSE $4
            END
      WHERE channel_id = $1
        AND ended_at IS NULL
        AND cleaned_at IS NULL
        -- Only what is ours to give. A row a third machine holds is not.
        AND (instance_id IS NULL OR instance_id = $3)
      RETURNING id`,
    [channelId, toInstanceId, hlsOwnerInstanceId(), presenterPeerId],
  );
  const sessionIds = result.rows.map((row) => row.id);
  // A queued stamp for these rows would write this process back over the
  // handover minutes from now.
  forgetPendingHlsSessionClaims(sessionIds);
  let egressIds: string[] = [];
  if (mode === "conventional") {
    const room = rooms.get(channelId);
    if (room && room.stream.startedAt === startedAt) {
      egressIds = [
        ...room.rungs.map((entry) => entry.egressId),
        ...(room.camera ? [room.camera.egressId] : []),
        ...(room.micArchive ? [room.micArchive.egressId] : []),
      ];
      rooms.delete(channelId);
      clearCameraCooldown(channelId);
      voiceTrackSeparatedByChannel.delete(channelId);
      clearCameraProbeRetry(channelId);
      const pending = pendingRestarts.get(channelId);
      if (pending) {
        clearTimeout(pending);
        pendingRestarts.delete(channelId);
      }
    }
  } else {
    releaseLlRoom(channelId, startedAt);
    const companion = llCompanions.get(channelId);
    if (companion && companion.stream.startedAt === startedAt) {
      egressIds = [
        ...(companion.camera ? [companion.camera.egressId] : []),
        ...(companion.micArchive ? [companion.micArchive.egressId] : []),
      ];
      llCompanions.delete(channelId);
      clearCameraCooldown(channelId);
      voiceTrackSeparatedByChannel.delete(channelId);
      clearCameraProbeRetry(channelId);
    }
  }
  handoversTotal += 1;
  logEvent("voice.hlsHandedOver", {
    channelId,
    startedAt,
    mode,
    to: toInstanceId,
    presenterPeerId,
    sessionIds,
    egressIds,
  });
  return true;
}

/**
 * The last resort `getChannelLiveState` (`server/src/ws/voice.ts`) reaches
 * for when this process never ran the egress itself: `rooms`, `llStreamFor`
 * and `hlsAudience.stream` are every one of them in-process maps, populated
 * only on the instance that actually started or adopted the session, with no
 * bus fanout for "a party went live" the way chat and roster have. On one
 * machine that gap is invisible. On two it is not: a viewer whose HTTP
 * request or WS session lands on the OTHER instance from the one running the
 * transcode reads `stream: null` for a party that is, in fact, live, because
 * nothing ever told this process it exists.
 *
 * `hls_sessions` is the one piece of this feature that was already durable
 * and shared (`adoptLiveHlsSession` reads it after a restart for exactly
 * this reason), so it is what a second instance can lean on without waiting
 * for a bus topic this feature does not have yet. Reconstructs only the
 * fields a viewer's `GET /live` actually needs to start watching: the master
 * playlist URL, `startedAt` (from the row's own timestamp, which is the same
 * millisecond value baked into `object_prefix` at session start) and the
 * presenter's peer id. Everything else `LiveHlsStream` can carry
 * (`cameraHlsUrl`, `topHeight`, `hasAudio`, ...) is optional and absent here
 * on purpose — this is the same degraded shape the schema already documents
 * for "a session this process adopted after a restart rather than started",
 * not a new one, and a client already knows how to render it.
 *
 * Does not adopt the session (no local `rooms` entry, no health monitor
 * started on this instance) — that is `adoptLiveHlsSession`'s job at boot,
 * and doing it lazily from a read path would mean two instances racing to
 * monitor the same egress. This only answers a read.
 */
/**
 * `voice.hlsLlUnservableFromDb`, at most once per channel per minute.
 *
 * A misconfigured instance answers this question on every `channel-live`
 * frame it builds for the channel, and a read path that fails is exactly
 * where an unthrottled log line becomes the write amplifier pitfall 16 warns
 * about. The condition is a deployment fact, not an event: one line a minute
 * is enough to find it, and the second one adds nothing.
 *
 * TWO BOUNDS, NOT ONE, AND THE FIRST DRAFT HAD NEITHER RIGHT (three Farol
 * findings, one per dimension, on the same eight lines). Expiring entries
 * whose window has closed is not a bound: a burst of N distinct channels
 * inside ONE window expires nothing, so the map grows to N and stays there
 * if traffic then stops. And sweeping on every previously-unseen key is
 * O(map) per key, which makes that same burst quadratic on the event loop —
 * the sweep being the expensive half of a defence against cheap writes.
 *
 * So, exactly the shape `logRejection` (`tools/hls-edge/src/viewer-access.ts`)
 * already uses for the same problem: the sweep is THROTTLED to at most one
 * full scan per `LL_UNSERVABLE_LOG_SWEEP_INTERVAL_MS`, and
 * `LL_UNSERVABLE_LOG_MAX_ENTRIES` is a hard ceiling checked in O(1) on every
 * new key regardless of that throttle, evicting the oldest by insertion
 * order. That is an approximation of LRU rather than a precise one (a
 * refreshed key keeps its original position), which is enough for a log
 * dedupe table and not something anything depends on for eviction precision.
 */
const LL_UNSERVABLE_LOG_WINDOW_MS = 60_000;
const LL_UNSERVABLE_LOG_MAX_ENTRIES = 256;
const LL_UNSERVABLE_LOG_SWEEP_INTERVAL_MS = 60_000;
const llUnservableLoggedAt = new Map<string, number>();
let llUnservableLastSweptAt = 0;

function noteLlUnservable(channelId: string, startedAt: number): void {
  const now = Date.now();
  const last = llUnservableLoggedAt.get(channelId);
  if (last !== undefined && now - last < LL_UNSERVABLE_LOG_WINDOW_MS) {
    return;
  }
  logEvent("voice.hlsLlUnservableFromDb", { channelId, startedAt });
  if (last === undefined) {
    // Active expiry, throttled: one full scan per interval at most, however
    // many new channels arrive in between.
    if (now - llUnservableLastSweptAt >= LL_UNSERVABLE_LOG_SWEEP_INTERVAL_MS) {
      for (const [key, at] of llUnservableLoggedAt) {
        if (now - at >= LL_UNSERVABLE_LOG_WINDOW_MS) {
          llUnservableLoggedAt.delete(key);
        }
      }
      llUnservableLastSweptAt = now;
    }
    // The hard ceiling, O(1), whatever the sweep did or did not do.
    if (llUnservableLoggedAt.size >= LL_UNSERVABLE_LOG_MAX_ENTRIES) {
      const oldestKey = llUnservableLoggedAt.keys().next().value;
      if (oldestKey !== undefined) {
        llUnservableLoggedAt.delete(oldestKey);
      }
    }
  }
  llUnservableLoggedAt.set(channelId, now);
}

/** Exported for `hls-live-state-db-fallback.test.ts`, which pins the ceiling. */
export function llUnservableLogEntryCount(): number {
  return llUnservableLoggedAt.size;
}

export async function liveHlsStreamFromDb(
  channelId: string,
  options: {
    /**
     * Rethrow a query failure (after logging it) instead of answering null.
     * `resolveChannelStream` (`ws/voice.ts`) needs to tell "no live session"
     * from "could not ask", because only the first may be sent to a client
     * as a positive `ended`.
     */
    strict?: boolean;
  } = {},
): Promise<LiveHlsStream | null> {
  let row:
    | {
        started_at: Date;
        presenter_peer_id: string | null;
        mode: string;
        part_target_ms: number | null;
      }
    | undefined;
  try {
    const result = await getPool().query<{
      started_at: Date;
      presenter_peer_id: string | null;
      mode: string;
      part_target_ms: number | null;
    }>(
      `SELECT started_at, presenter_peer_id, mode, part_target_ms
         FROM hls_sessions
        WHERE channel_id = $1 AND ended_at IS NULL AND cleaned_at IS NULL
        ORDER BY started_at DESC
        LIMIT 1`,
      [channelId],
    );
    row = result.rows[0];
  } catch (error) {
    logEvent("voice.hlsLiveStreamDbFallbackFailed", {
      channelId,
      error: error instanceof Error ? error.message : String(error),
    });
    if (options.strict) {
      throw error;
    }
    return null;
  }
  if (!row || !row.presenter_peer_id) {
    return null;
  }
  const startedAt = row.started_at.getTime();
  // THE URL AND THE MODE ARE ONE STATEMENT (`packages/shared/src/live-hls.ts`,
  // `LIVE_HLS_MODE_PARAM`). This path used to say `mode: "ll"` and hand out
  // `viewerPlaylistUrl`'s conventional-ladder path for it -- the two halves
  // disagreeing, on the exact read a viewer whose socket landed on the
  // machine NOT running the transcode depends on. `llPlaylistUrl` is the one
  // place either driver builds an LL master URL, marker included.
  if (row.mode === "ll") {
    if (!llPlaylistFrontConfigured()) {
      // THIS INSTANCE CANNOT ADDRESS THIS SESSION, WHICH IS NOT THE SAME AS
      // "NOTHING IS LIVE HERE" (a Farol finding on this PR). The LL master
      // is rendered by the edge Worker and by nothing else; with no
      // `LIVE_HLS_PLAYLIST_BASE_URL` on THIS process, `stampViewerStream`
      // leaves the URL API-relative and the API's own proxy answers "not
      // found" for a `mode = 'll'` row. `resolveHlsMode` already refuses to
      // PICK the mode without a front; this is the same rule on the durable
      // read, which runs on whichever machine a viewer's socket landed on
      // and can therefore disagree with the machine that started the
      // session during a rolling deploy or a configuration drift.
      //
      // Answered as "could not vouch", never as a positive absence: a bare
      // `null` here reaches `channelLiveFrameWith` as `ended: true` and
      // would hang up an audience watching a party that is, in fact, live
      // (the 2026-09-14 shape, `ChannelLiveMessage.ended`'s doc comment).
      // Throwing under `strict` is what `readChannelStreamFromDb` turns into
      // `known: false`.
      noteLlUnservable(channelId, startedAt);
      if (options.strict) {
        throw new Error("ll session with no LIVE_HLS_PLAYLIST_BASE_URL on this instance");
      }
      return null;
    }
    return {
      hlsUrl: llPlaylistUrl(channelId, startedAt),
      startedAt,
      presenterPeerId: row.presenter_peer_id,
      mode: "ll" as const,
      ...(row.part_target_ms ? { partTargetMs: row.part_target_ms } : {}),
    };
  }
  return {
    hlsUrl: viewerPlaylistUrl(channelId, startedAt),
    startedAt,
    presenterPeerId: row.presenter_peer_id,
  };
}

/**
 * IS THIS EXACT SESSION STILL OPEN? One row, addressed by the pair that
 * identifies a session everywhere else in this codebase (channel and
 * `startedAt`), answering nothing but "has it ended".
 *
 * Deliberately NOT `liveHlsStreamFromDb`, which is the other shape of the
 * same question and the wrong one here. That one answers "what is the newest
 * live session on this channel", which conflates a session that ended with a
 * session that was replaced; and for a `mode = 'll'` row it refuses outright
 * on an instance with no `LIVE_HLS_PLAYLIST_BASE_URL`, because it has to
 * build a URL. This has no URL to build, so it gives the same answer on every
 * machine whatever that machine is configured to serve.
 *
 * THREE-VALUED ON PURPOSE. `{ ok: false }` is "could not ask", and its one
 * caller (`resolveChannelStream` in `ws/voice.ts`) treats it as "assume the
 * session is fine": tearing a live party's playlist away from its audience
 * because one query timed out is the failure this read exists to prevent,
 * pointed the other way.
 */
export async function isHlsSessionOpen(
  channelId: string,
  startedAt: number,
): Promise<{ ok: true; open: boolean } | { ok: false }> {
  try {
    const result = await getPool().query(
      `SELECT 1
         FROM hls_sessions
        WHERE channel_id = $1
          AND started_at = to_timestamp($2 / 1000.0)
          AND ended_at IS NULL
          AND cleaned_at IS NULL
        LIMIT 1`,
      [channelId, startedAt],
    );
    return { ok: true, open: result.rows.length > 0 };
  } catch (error) {
    logEvent("voice.hlsSessionOpenCheckFailed", {
      channelId,
      startedAt,
      error: error instanceof Error ? error.message : String(error),
    });
    return { ok: false };
  }
}

/** Tests inject fakes; production leaves both null. */
export function setLiveHlsTestHooks(hooks: {
  egress?: LiveHlsEgressApi | null;
  findTracks?: LiveHlsTrackFinder | null;
  playlistReady?: boolean;
  /** Body the monitor reads for one rung's live playlist (fake stack). */
  playlistProbe?: ((channelId: string, rung: string) => string | null) | null;
}): void {
  if ("playlistProbe" in hooks) {
    injectedPlaylistProbe = hooks.playlistProbe ?? null;
  }
  if ("egress" in hooks) {
    injectedEgress = hooks.egress ?? null;
  }
  if ("findTracks" in hooks) {
    injectedFinder = hooks.findTracks ?? null;
  }
  if (hooks.playlistReady !== undefined) {
    injectedPlaylistReady = hooks.playlistReady;
  }
}

export function resetLiveHlsForTests(): void {
  rooms.clear();
  llCompanions.clear();
  restartHistory.clear();
  failedUntil.clear();
  for (const timer of pendingRestarts.values()) {
    clearTimeout(timer);
  }
  pendingRestarts.clear();
  reconcileQueue.clear();
  orphanStopBackoff.clear();
  orphansStopped = 0;
  hlsStartsTotal = 0;
  hlsStopsTotal = 0;
  restartsScheduledTotal = 0;
  restartsExhaustedTotal = 0;
  deferredStops.clear();
  resetHlsOwnershipForTests();
  loggedGhostEgressIds.clear();
  llUnservableLoggedAt.clear();
  llUnservableLastSweptAt = 0;
  cameraCooldownUntil.clear();
  for (const timer of cameraCooldownTimers.values()) {
    clearTimeout(timer);
  }
  cameraCooldownTimers.clear();
  cameraCooldownMs = CAMERA_COOLDOWN_MS;
  cameraRunSuffix.clear();
  voiceTrackSeparatedByChannel.clear();
  for (const timer of cameraProbeRetryTimers.values()) {
    clearTimeout(timer);
  }
  cameraProbeRetryTimers.clear();
  cameraProbeRetryAttempts.clear();
  resumeRefusalLoggedAt.clear();
  resumeDecisionCache.clear();
  resumeDecisionEpoch.clear();
  handoversTotal = 0;
  changeListener = null;
  sfuLoadReader = null;
  presenterCheck = null;
  stopLiveHlsMonitor();
  warnedLadder = null;
  injectedEgress = null;
  injectedFinder = null;
  injectedPlaylistReady = true;
  injectedPlaylistProbe = null;
  resetHlsRemuxForTests();
}

export function setLiveHlsChangeListener(
  listener: LiveHlsChangeListener | null,
): void {
  changeListener = listener;
}

export function setLiveHlsSfuLoadReader(
  reader: LiveHlsSfuLoadReader | null,
): void {
  sfuLoadReader = reader;
}

/** `ws/voice.ts` registers the room's own answer; see `LiveHlsPresenterCheck`. */
export function setLiveHlsPresenterCheck(
  check: LiveHlsPresenterCheck | null,
): void {
  presenterCheck = check;
}

/**
 * The presenter this work was decided for is no longer the one presenting:
 * they left, they stopped sharing, they lost the stage bit, or the party
 * itself is over.
 *
 * `false` with no check registered, and `false` on a check that throws: see
 * `LiveHlsPresenterCheck`'s fail-open note. A throw is a bug in the room, not
 * a verdict about the party, and a verdict is the only thing that may stop a
 * transcode.
 */
function presenterGone(channelId: string, presenterPeerId: string): boolean {
  const check = presenterCheck;
  if (!check) {
    return false;
  }
  try {
    return !check(channelId, presenterPeerId);
  } catch (error) {
    logEvent("voice.hlsPresenterCheckFailed", {
      channelId,
      presenterPeerId,
      error: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
}

/**
 * LiveKit's way of saying "there is nothing left to stop".
 *
 * `StopEgress` on an egress that has already finished answers `egress with
 * status EGRESS_COMPLETE cannot be stopped`, and production logged three of
 * those as `voice.hlsStopFailed` on 2026-09-17 for one ordinary teardown.
 * They are not failures: the outcome asked for is the outcome that already
 * holds. Treating them as errors costs twice -- an operator greps a clean
 * teardown and finds three red lines, and `stopEgressById` puts the id into
 * the orphan backoff and asks again, for an hour, about something that ended
 * before the first ask.
 *
 * ONLY ON THE STOP PATHS. "not found" is also what a START says about a track
 * that has gone away (`track TR_... not found`), which is a real failure and
 * a different decision; nothing here is reachable from that path.
 */
export function egressAlreadyStopped(error: unknown): boolean {
  const message = (
    error instanceof Error ? error.message : String(error)
  ).toLowerCase();
  return (
    message.includes("cannot be stopped") ||
    message.includes("egress does not exist") ||
    message.includes("does not exist") ||
    message.includes("not found")
  );
}

/**
 * WHAT A START IS ABOUT TO SUPERSEDE, and why a count has to be told.
 *
 * `endSupersededSessions` stops EVERY active egress on the channel it is
 * starting for, except the ids of that very start. So at the moment
 * `decideLadder` is priced, whatever the box is running for THIS channel is
 * already condemned: counting it charges the new ladder for the transcode it
 * is replacing. Production, 2026-09-15, mid rolling deploy: a resumed party
 * was priced against its own two still-running egresses, `ladderMbps` came
 * out at 600 against a 450 budget, and `720p30` was refused with
 * `ladder-budget` on a box that was about to be two rungs emptier.
 *
 * AN EXPLICIT SET OF IDS, NOT A CHANNEL (a Farol finding on this PR). "Every
 * egress on the channel" is a prediction, and two things falsify it: an id
 * whose last `StopEgress` failed is sitting in `orphanStopBackoff` precisely
 * because the box would not let go of it, and an id whose `hls_sessions` row
 * belongs to a machine that is still answering is not this process's to stop
 * at all. Discounting either prices the new ladder as though a transcode that
 * is still running had gone. `planSupersededEgresses` builds the set with both
 * questions asked, and anything it could not establish stays in the count.
 */
interface BoxCountOptions {
  /**
   * Egress ids this start has established it may stop and is about to: not
   * counted, here or in the in-process floor.
   */
  supersededEgressIds?: ReadonlySet<string>;
  /**
   * An `listEgress({active:true})` answer the caller already has, so a start
   * that had to list the box to build `supersededEgressIds` does not list it
   * a second time to price the ladder (a Farol finding on this PR). Already
   * filtered to alive by `listActiveEgresses`, which changes no verdict here:
   * `healthFromListing` answers "ended" for an id the listing does not carry.
   *
   * `null` is the OTHER half of that saving, and it is not the same as
   * omitting the field: it says the caller already tried to list the box and
   * could not. Listing again on the same tick would only fail again, one
   * serial RPC later, so the count falls straight back to the in-process
   * floor -- which is exactly what its own failure branch does.
   */
  listing?: EgressListing[] | null;
}

/** What `planSupersededEgresses` worked out, for one start. */
interface SupersedePlan {
  /** The box listing it read, or null when LiveKit could not be asked. */
  listing: EgressListing[] | null;
  /** The ids on this channel this start may stop, and is about to. */
  egressIds: Set<string>;
}

/**
 * Which of this channel's running egresses this start is entitled to
 * supersede, and the box listing that answered it.
 *
 * FAIL CLOSED IN BOTH DIRECTIONS. A listing it could not fetch, or an
 * ownership lookup it could not run, yields an EMPTY set: the budget then
 * counts everything, which costs the new ladder a rung it might have had and
 * never lets it start one the box has no room for. That is the same trade
 * every guard in this file makes, and the one `listActiveEgresses` states.
 */
async function planSupersededEgresses(
  channelId: string,
  now = Date.now(),
): Promise<SupersedePlan> {
  const listing = await listActiveEgresses();
  if (listing === null) {
    return { listing: null, egressIds: new Set() };
  }
  const onThisChannel = listing
    .filter((info) => info.roomName === channelId)
    .map((info) => info.egressId);
  if (onThisChannel.length === 0) {
    return { listing, egressIds: new Set() };
  }
  const ownedElsewhere = await egressIdsOwnedElsewhere(onThisChannel);
  if (ownedElsewhere === null) {
    return { listing, egressIds: new Set() };
  }
  return {
    listing,
    egressIds: new Set(
      onThisChannel.filter(
        (egressId) =>
          !ownedElsewhere.has(egressId) && !orphanStopHeld(egressId, now),
      ),
    ),
  };
}

/** Renditions this process has running, across every channel. */
export function runningRungCount(options: BoxCountOptions = {}): number {
  let total = 0;
  for (const room of rooms.values()) {
    for (const entry of room.rungs) {
      if (options.supersededEgressIds?.has(entry.egressId)) {
        continue;
      }
      total += 1;
    }
  }
  return total;
}

/** Camera transcodes running across every channel. */
export function runningCameraCount(): number {
  let total = 0;
  for (const room of companionHosts()) {
    if (room.camera) {
      total += 1;
    }
  }
  return total;
}

/** Voice archives (`-mic.ogg` Track Egress) running across every channel. */
export function runningMicArchiveCount(): number {
  let total = 0;
  for (const room of companionHosts()) {
    if (room.micArchive) {
      total += 1;
    }
  }
  return total;
}

/**
 * What the running cameras (and voice-only rungs) cost the box, in the
 * Mbit/s the ladder is priced in.
 *
 * Added to the SFU load rather than to `runningRungs`, and the distinction is
 * deliberate. `runningRungs` counts renditions OF A SHARE and multiplies by a
 * whole `HLS_RUNG_MBPS`; a camera is 30 % of that and is not a rung. Counting
 * it as one would refuse a real rendition of somebody's film to pay for a
 * webcam, which is exactly the trade `decideCameraEgress` refuses to make in
 * the other direction.
 *
 * PER SLOT, NOT A FLAT MULTIPLE, since `LIVE_HLS_VOICE_TRACK`: a slot with no
 * camera video (`cameraTrackId === null`) is a `VOICE_RUNG` audio-only
 * egress and costs `HLS_VOICE_ONLY_MBPS`, not a camera's `HLS_CAMERA_MBPS`.
 */
export function runningCameraMbps(): number {
  let total = 0;
  for (const room of companionHosts()) {
    if (!room.camera) {
      continue;
    }
    total += room.camera.cameraTrackId ? HLS_CAMERA_MBPS : HLS_VOICE_ONLY_MBPS;
  }
  return total;
}

/**
 * Which of `roomNames` has a session `hls_sessions` still calls live
 * (`ended_at IS NULL`). Scoped to the rooms the current `listEgress` call
 * actually returned rather than the whole table's distinct channels: the box
 * budget only ever judges records LiveKit just listed, so there is nothing to
 * gain from asking about every channel that has ever run an egress. Null
 * means "could not ask" — the same convention as `listActiveEgresses` — and
 * every caller must read that as "do not judge a record by this", never as
 * "no channel is live". Empty input is a no-op: no round trip, no rows.
 */
async function listChannelsWithLiveHlsSessions(
  roomNames: readonly string[],
): Promise<Set<string> | null> {
  if (roomNames.length === 0) {
    return new Set();
  }
  try {
    const result = await getPool().query<{ channel_id: string }>(
      `SELECT DISTINCT channel_id FROM hls_sessions
        WHERE ended_at IS NULL AND channel_id = ANY($1::uuid[])`,
      [roomNames],
    );
    return new Set(result.rows.map((row) => row.channel_id));
  } catch (error) {
    logEvent("voice.hlsLiveSessionsQueryFailed", {
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

/**
 * Renditions running on the WHOLE box right now, for the box-budget check —
 * across every process, not just this one's `rooms` map. `decideLadder`
 * used to be handed `runningRungCount()`, which is exactly right for a box
 * that has never restarted and exactly wrong the moment `listEgress` still
 * remembers something this process does not: an adopted session mid-boot, or
 * — the case that actually cost a rung — a ghost record LiveKit never
 * cleaned up.
 *
 * A record counts only when it is BOTH: `alive` per `healthFromListing`, AND
 * not a ghost. A record is a ghost only when its room has no live
 * `hls_sessions` row AND it is past `GHOST_EGRESS_GRACE_PERIOD_MS` — age
 * alone proves nothing (a real watch party runs for hours) and a brand-new
 * record proves nothing either (the session row is a second round trip that
 * has not always landed yet), so both have to hold. Every ghost id is logged
 * exactly once via `loggedGhostEgressIds`, pruned each call to whatever
 * `listing` still contains, because a real ghost sits there for hours and
 * this must not become the noisiest line in the log nor an unbounded set.
 *
 * Falls back to `runningRungCount()` — this process's own honest count —
 * when there is no egress, no `listEgress` support (an older fake in a
 * test), or the listing call itself failed, AND takes it as a floor even on
 * the success path: "could not ask" and "asked, got nothing back" must
 * never read as "the box is empty" and refuse nothing, but the count must
 * also never read as infinite and refuse everything, so the floor is what
 * this process knows for certain it is running right now.
 */
/**
 * "No live `hls_sessions` row for this room, and old enough that the row would
 * have landed by now." One rule, read by the pre-pass that decides whom to ask
 * about and by the loop that decides what to count -- two copies of it would
 * be a filter that drifts from the thing it filters for.
 */
function isGhostCandidate(
  info: EgressListing,
  liveChannels: Set<string> | null,
  now: number,
): boolean {
  const ageMs = info.startedAt !== undefined ? now - info.startedAt : null;
  const withinGracePeriod =
    ageMs === null || ageMs < GHOST_EGRESS_GRACE_PERIOD_MS;
  const noLiveSession =
    liveChannels !== null &&
    info.roomName !== undefined &&
    !liveChannels.has(info.roomName);
  return noLiveSession && !withinGracePeriod;
}

export async function activeBoxEgressCount(
  now = Date.now(),
  options: BoxCountOptions = {},
): Promise<number> {
  const localFloor = runningRungCount(options);
  if (options.listing === null) {
    // The caller already asked the media server and it could not answer. See
    // `BoxCountOptions.listing`.
    return localFloor;
  }
  const egress = getEgress();
  if (!egress?.listEgress && !options.listing) {
    return localFloor;
  }
  let listing: EgressListing[];
  if (options.listing) {
    listing = options.listing;
  } else {
    try {
      listing = await egress!.listEgress!({ active: true });
    } catch (error) {
      logEvent("voice.hlsBoxBudgetListFailed", {
        error: error instanceof Error ? error.message : String(error),
      });
      return localFloor;
    }
  }
  const roomNames = [
    ...new Set(
      listing
        .map((info) => info.roomName)
        .filter((room): room is string => room !== undefined),
    ),
  ];
  const liveChannels = await listChannelsWithLiveHlsSessions(roomNames);
  let count = 0;
  const currentIds = new Set(listing.map((info) => info.egressId));
  // A RECORD THE OTHER MACHINE IS DRIVING IS NOT A GHOST. `liveChannels` is a
  // channel-level answer and the ghost rule reads it as "nobody has a live row
  // for this room"; a row the other instance ENDED (or is about to reopen)
  // makes its still-running transcode look abandoned to us, and calling it a
  // ghost discounts a rendition that is really costing the box a core. Ask by
  // egress id instead, and take "could not ask" as "not a ghost".
  //
  // ONLY THE CANDIDATES ARE ASKED ABOUT, and on a healthy box there are none,
  // so this tick costs no query at all. Sending every listed id would put a
  // join over `hls_sessions` on the monitor's cadence for nothing.
  const ghostCandidates = listing
    .filter(
      (info) =>
        healthFromListing(info.egressId, listing) === "alive" &&
        isGhostCandidate(info, liveChannels, now),
    )
    .map((info) => info.egressId);
  const ownerLookup = await egressIdsOwnedElsewhere(ghostCandidates);
  const ownedElsewhere = ownerLookup ?? new Set<string>();
  const ownerLookupFailed = ownerLookup === null;
  for (const id of loggedGhostEgressIds) {
    if (!currentIds.has(id)) {
      loggedGhostEgressIds.delete(id);
    }
  }
  for (const info of listing) {
    if (options.supersededEgressIds?.has(info.egressId)) {
      // CONDEMNED, SO NOT CHARGED. See `BoxCountOptions`: these are the ids
      // `planSupersededEgresses` established this start may stop and is about
      // to, so pricing the ladder against them refuses rungs the box is a
      // second away from having room for.
      continue;
    }
    if (healthFromListing(info.egressId, listing) !== "alive") {
      continue;
    }
    const ageMs = info.startedAt !== undefined ? now - info.startedAt : null;
    if (
      isGhostCandidate(info, liveChannels, now) &&
      (ownerLookupFailed || ownedElsewhere.has(info.egressId))
    ) {
      // Owned, live, and someone else's: count it against the box budget like
      // any other rendition rather than writing it off as a leak. A lookup we
      // could not run lands here too, deliberately -- but is not counted as a
      // skip, since nothing was proved about who owns it.
      if (!ownerLookupFailed) {
        noteHlsSkippedOwnedElsewhere({
          site: "ghost",
          channelId: info.roomName ?? null,
          egressId: info.egressId,
          now,
        });
      }
      count += 1;
      continue;
    }
    if (isGhostCandidate(info, liveChannels, now)) {
      if (!loggedGhostEgressIds.has(info.egressId)) {
        loggedGhostEgressIds.add(info.egressId);
        logEvent("voice.hlsGhostEgress", {
          egressId: info.egressId,
          roomName: info.roomName ?? null,
          ageMs,
          reason: "no-live-session",
        });
      }
      continue;
    }
    count += 1;
  }
  return Math.max(count, localFloor);
}

/**
 * `activeBoxEgressCount`, minus this process's own camera egresses.
 *
 * WHY THIS HAS TO EXIST SEPARATELY. LiveKit's `ListEgress` carries no rung
 * name — only an id, a room and a status — so `activeBoxEgressCount` cannot
 * itself tell a camera egress from a ladder rendition; every active egress on
 * the box, camera included, is counted as one `HLS_RUNG_MBPS` rendition. Both
 * `decideLadder` and `decideCameraEgress` also add every running camera's
 * cost separately, at its own much smaller `HLS_CAMERA_MBPS`, via
 * `runningCameraMbps()`. Feeding either of them `activeBoxEgressCount()`
 * directly therefore charges each of THIS PROCESS's cameras twice: once here
 * as a full rendition and once again as a camera, which can refuse a camera
 * that fits or drop a film rendition despite the box having room for both.
 *
 * Subtracting `runningCameraCount()` is an approximation, not a full fix: a
 * camera this process has not adopted yet, or one another instance is
 * running, is still counted as a full rung on the box side (nothing here can
 * tell those apart without a query keyed on `hls_sessions.egress_id`, which
 * `activeBoxEgressCount` does not do). It is the same approximation
 * `runningRungCount` already makes everywhere else in this file — "what THIS
 * process itself knows it is running" — and it can never undercount: the
 * subtraction is floored at zero.
 */
async function activeLadderEgressCount(
  options: BoxCountOptions = {},
): Promise<number> {
  // AND MINUS ITS VOICE ARCHIVES, for the same reason and a bigger one: a
  // `-mic.ogg` is a Track Egress writing one Opus stream to a file, no
  // decode and no encode, and it was being priced as a full 150 Mbit/s video
  // rendition. With the archive on (the default for a watch party) a
  // two-rung conventional show was 3 x 150 before the camera's own 45, and
  // the camera was refused `box-budget` on an otherwise idle box: the
  // 2026-09-23 production rehearsal logged boxMbps=629 and then 637 against
  // 600 with nothing else live, so no conventional show could ever record
  // the presenter's camera. It is not added back at any weight: it costs the
  // box nothing the budget measures.
  return Math.max(
    0,
    (await activeBoxEgressCount(Date.now(), options)) -
      runningCameraCount() -
      runningMicArchiveCount(),
  );
}

/**
 * The rungs a live session is actually serving, lowest first. The playlist
 * proxy builds the master from the database rather than from this, so that a
 * request mid-restart still answers; this is for the room, the tests and the
 * config endpoint.
 */
export function liveHlsRungsFor(channelId: string): LadderRung[] {
  return (rooms.get(channelId)?.rungs ?? []).map((entry) => entry.rung);
}

export interface LiveHlsActivity {
  /** Sessions this process is running an egress for, right now. */
  sessions: number;
  /**
   * `LIVE_HLS_MAX_SESSIONS`. The number `sessions` is refused at, so the
   * dashboard can show "2 of 3" rather than a count with no ceiling, and so
   * an operator raising the cap can read back that the process took it.
   */
  maxSessions: number;
  /** Renditions across all of them: what the media box is actually encoding. */
  rungs: number;
  /** Longest-running session, in minutes, or null when none is live. */
  oldestMinutes: number | null;
  /**
   * Sessions this process started whose transcode has NO audio track: the
   * share was picked without its own audio, so the seatless audience is
   * watching a silent film while the seated room hears everything.
   *
   * It is not an error and it is not always wrong (a silent slideshow is a
   * legitimate share), which is exactly why it needs a number rather than an
   * alert. Sitting at `sessions` during a film night is the thing to look at.
   * Adopted sessions never count: a process that inherited an egress across a
   * restart knows the video track sid from the row and nothing about the
   * audio, and guessing "silent" there would invent an incident.
   */
  silentSessions: number;
  /**
   * Leftover transcodes stopped by `reapForeignEgresses` since this process
   * started. **Belongs at zero**, and anything else is the number that proves
   * a session leaked handlers onto the media box, which is otherwise silent:
   * the box just gets slower and the parties on it start stalling. Per
   * process, so it resets on deploy like every counter here.
   */
  orphansStopped: number;
  /**
   * Live sessions with the host's voice being written to its own file right
   * now (`LIVE_HLS_MIC_ARCHIVE`). Zero on a deployment where the flag is off,
   * which is every deployment until somebody sets it; zero with the flag ON
   * is the number that says the browsers have not picked up the bundle that
   * publishes the track, or that the Track Egress request is failing.
   */
  micArchives: number;
  /**
   * Sessions currently carrying a second transcode beside the presenter's
   * ladder: a camera, a camera with the presenter's voice attached
   * (`LIVE_HLS_VOICE_TRACK`), or the voice alone with no camera. Each camera
   * slot is about 0.2 to 0.3 of a core on top of that party's ladder, so this
   * is the number that turns "the box feels slow" into "three hosts have
   * their webcams (or their separated voice) on". Zero when
   * `LIVE_HLS_CAMERA=false`.
   */
  cameraSessions: number;
  /**
   * Rows this process left alone because another instance that is still
   * answering its `voice_instances` heartbeat owns them: a boot adoption it
   * did not take, a row it did not end, a transcode the reaper or the ghost
   * filter did not stop. **Belongs at zero on a one-machine deployment** and
   * is the number that proves the cross-machine guard runs on a two-machine
   * one -- pitfall 12, a flag-gated path nobody could see. Zero with two
   * machines and a party running means the `instance_id` stamp never landed.
   */
  skippedOwnedElsewhere: number;
  /**
   * Teardowns parked because this process could not prove the egress was its
   * own (the ownership lookup failed), waiting on the monitor's retry. Belongs
   * at zero; a number that stays up is a database that is not answering.
   */
  deferredStops: number;
  /**
   * Watch-party transcode lifecycle since this process started (NOT a live
   * count — these only grow):
   *  - `startsTotal` / `stopsTotal`: sessions started (`voice.hlsStarted`) and
   *    torn down (`voice.hlsStopped` via `stopRoom`). Started well above
   *    stopped over a party's life is normal; a `stopsTotal` climbing without
   *    `startsTotal` is churn.
   *  - `restartsScheduledTotal`: a rung died and is being brought back
   *    (`voice.hlsRestartScheduled`). A stream that will not stay up shows up
   *    here as a rising slope during a single party.
   *  - `restartsExhaustedTotal`: `scheduleRestart` gave up after
   *    `HLS_MAX_RESTARTS` in the window (`voice.hlsFailed`). Nonzero means an
   *    audience got a blank pane, not a recovered stream.
   */
  startsTotal: number;
  stopsTotal: number;
  restartsScheduledTotal: number;
  restartsExhaustedTotal: number;
}

/**
 * WHAT THE DASHBOARD READS TO KNOW A TRANSCODE EVER RAN.
 *
 * In-process, so it is the number for the instance that answered, the same
 * way `voice.rooms` is. Zero on a machine that is not the one presenting;
 * zero everywhere for a deployment where the flag is on and the egress
 * silently never starts, which is the case worth being able to see. Pair it
 * with `retention.uncleaned` below: sessions climbing with `uncleaned` flat
 * is healthy, `uncleaned` climbing on its own is a sweep that is not running.
 */
export function liveHlsActivity(now = Date.now()): LiveHlsActivity {
  let rungs = 0;
  let oldest: number | null = null;
  let silentSessions = 0;
  let micArchives = 0;
  for (const room of rooms.values()) {
    rungs += room.rungs.length;
    oldest = oldest === null ? room.startedAtMs : Math.min(oldest, room.startedAtMs);
    if (room.stream.hasAudio === false) {
      silentSessions += 1;
    }
  }
  // Ladder rooms AND LL companions, like `cameraSessions` below: an LL
  // broadcast's archive and camera are egresses on the same box all the same.
  for (const room of companionHosts()) {
    if (room.micArchive) {
      micArchives += 1;
    }
  }
  return {
    sessions: rooms.size,
    maxSessions: maxLiveHlsSessions(),
    rungs,
    oldestMinutes: oldest === null ? null : Math.floor((now - oldest) / 60_000),
    silentSessions,
    orphansStopped,
    micArchives,
    cameraSessions: runningCameraCount(),
    skippedOwnedElsewhere: hlsSkippedOwnedElsewhereCount(),
    deferredStops: deferredStops.size,
    startsTotal: hlsStartsTotal,
    stopsTotal: hlsStopsTotal,
    restartsScheduledTotal,
    restartsExhaustedTotal,
  };
}

function notifyChanged(channelId: string, reason: string): void {
  if (!changeListener) {
    return;
  }
  try {
    changeListener(channelId, reason);
  } catch (error) {
    logEvent("voice.hlsChangeListenerFailed", {
      channelId,
      reason,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/** Timestamps inside the window, oldest first. */
function orphanStopBackoffMs(failures: number): number {
  const index = Math.min(
    Math.max(failures, 1),
    ORPHAN_STOP_BACKOFF_STEPS_MS.length,
  );
  return ORPHAN_STOP_BACKOFF_STEPS_MS[index - 1]!;
}

function orphanStopHeld(egressId: string, now: number): boolean {
  return (orphanStopBackoff.get(egressId)?.until ?? 0) > now;
}

function rememberOrphanStopFailure(
  egressId: string,
  now: number,
): { failures: number; waitMs: number } {
  const failures = (orphanStopBackoff.get(egressId)?.failures ?? 0) + 1;
  const waitMs = orphanStopBackoffMs(failures);
  orphanStopBackoff.set(egressId, { failures, until: now + waitMs });
  return { failures, waitMs };
}

function recentRestarts(channelId: string, now: number): number[] {
  const kept = (restartHistory.get(channelId) ?? []).filter(
    (at) => now - at < HLS_RESTART_WINDOW_MS,
  );
  if (kept.length === 0) {
    restartHistory.delete(channelId);
  } else {
    restartHistory.set(channelId, kept);
  }
  return kept;
}

/**
 * An egress for this channel is gone while the share may still be live.
 * Counts the attempt; under the cap, asks the listener to reconcile after
 * a backoff (2 s, 4 s, 8 s, capped at 15 s), which starts a new session
 * and hands viewers the new playlist URL. Over the cap, the channel is
 * marked failed for `FAILED_COOLDOWN_MS` (or until the share stops) and the
 * listener is asked once more so viewers get `stream: null` instead of a
 * frozen last frame.
 *
 * AND NOT AT ALL WHEN THERE IS NOBODY TO RESTART FOR. A restart exists to
 * bring a LIVE share's audience a new session; for a presenter who has left
 * the room or a party that is over it is a second ladder on the media box and
 * one more `voice.hlsStarted` in a log that is already hard to read. On
 * 2026-09-17 the restart scheduled at 19:21:21 was for a presenter who had
 * left at 19:20:47 and a party that had ended in the same second. The budget
 * is not spent either: a cancellation is not a failure, so a presenter who
 * comes back gets their full three.
 */
function scheduleRestart(
  channelId: string,
  reason: string,
  now = Date.now(),
  /**
   * Whose session this restart would be for. Passed explicitly because the
   * one caller that matters most (`checkLiveHlsHealth`'s dead primary) has
   * already deleted the room by the time it asks, so `rooms` cannot answer.
   */
  presenter?: string | null,
): "scheduled" | "failed" | "cancelled" {
  const presenterPeerId =
    presenter ?? rooms.get(channelId)?.stream.presenterPeerId ?? null;
  if (presenterPeerId !== null && presenterGone(channelId, presenterPeerId)) {
    logEvent("voice.hlsRestartSkipped", {
      channelId,
      reason,
      presenterPeerId,
      cause: "presenter-gone",
    });
    // The audience is still holding whatever they were last told. Say the
    // stream is gone rather than leaving them on a playlist nobody is
    // writing: the same seam the cap uses, for the same reason.
    notifyChanged(channelId, "presenter-gone");
    return "cancelled";
  }
  const history = recentRestarts(channelId, now);
  if (history.length >= HLS_MAX_RESTARTS) {
    failedUntil.set(channelId, now + FAILED_COOLDOWN_MS);
    restartHistory.delete(channelId);
    restartsExhaustedTotal += 1;
    logEvent("voice.hlsFailed", {
      channelId,
      reason,
      restarts: history.length,
      windowMs: HLS_RESTART_WINDOW_MS,
    });
    notifyChanged(channelId, "failed");
    return "failed";
  }
  history.push(now);
  restartHistory.set(channelId, history);
  const attempt = history.length;
  const backoff = Math.min(
    RESTART_BACKOFF_BASE_MS * 2 ** (attempt - 1),
    RESTART_BACKOFF_MAX_MS,
  );
  restartsScheduledTotal += 1;
  logEvent("voice.hlsRestartScheduled", {
    channelId,
    reason,
    attempt,
    backoffMs: backoff,
  });
  const existing = pendingRestarts.get(channelId);
  if (existing) {
    clearTimeout(existing);
  }
  pendingRestarts.set(
    channelId,
    setTimeout(() => {
      pendingRestarts.delete(channelId);
      notifyChanged(channelId, reason);
    }, backoff),
  );
  return "scheduled";
}

function isFailed(channelId: string, now = Date.now()): boolean {
  const until = failedUntil.get(channelId);
  if (until === undefined) {
    return false;
  }
  if (until <= now) {
    failedUntil.delete(channelId);
    return false;
  }
  return true;
}

/** Whether the channel is in its post-cap cooldown (for the room and tests). */
export function isLiveHlsFailed(channelId: string): boolean {
  return isFailed(channelId);
}

function clearFailure(channelId: string): void {
  failedUntil.delete(channelId);
  restartHistory.delete(channelId);
  const pending = pendingRestarts.get(channelId);
  if (pending) {
    clearTimeout(pending);
    pendingRestarts.delete(channelId);
  }
}

function healthFromListing(
  egressId: string,
  listing: EgressListing[],
): EgressHealth {
  const info = listing.find((item) => item.egressId === egressId);
  if (!info) {
    // LiveKit forgot it (a restart of the SFU, or Redis wiped). Egress
    // cannot be running in a room LiveKit does not know about.
    return "ended";
  }
  return info.status === EgressStatus.EGRESS_STARTING ||
    info.status === EgressStatus.EGRESS_ACTIVE
    ? "alive"
    : "ended";
}

/**
 * `EXT-X-MEDIA-SEQUENCE` plus the segment count: the two numbers that move
 * while an egress is writing. Either one changing is progress.
 */
export function playlistProgressKey(body: string): string {
  let sequence = "";
  let segments = 0;
  for (const raw of body.split("\n")) {
    const line = raw.trim();
    if (line.startsWith("#EXT-X-MEDIA-SEQUENCE:")) {
      sequence = line.slice("#EXT-X-MEDIA-SEQUENCE:".length);
    } else if (line !== "" && !line.startsWith("#")) {
      segments += 1;
    }
  }
  return `${sequence}:${segments}`;
}

/** The live playlist body for one rendition, or null when unreadable now. */
async function probePlaylist(
  channelId: string,
  startedAt: number,
  rung: string,
): Promise<string | null> {
  if (injectedEgress) {
    return injectedPlaylistProbe
      ? injectedPlaylistProbe(channelId, rung)
      : null;
  }
  try {
    const response = await fetch(
      internalPlaylistUrl(channelId, startedAt, rung),
      {
        cache: "no-store",
        signal: AbortSignal.timeout(5_000),
      },
    );
    if (!response.ok) {
      return null;
    }
    return await response.text();
  } catch {
    return null;
  }
}

/**
 * Whether one rendition's playlist has stopped moving. Records the shape it
 * sees on the rung so the next pass can compare; `unknown` when it could not
 * read.
 */
async function playlistHealth(
  channelId: string,
  startedAt: number,
  entry: RunningRung,
  now: number,
): Promise<EgressHealth> {
  const body = await probePlaylist(channelId, startedAt, entry.rung.name);
  if (body === null) {
    return "unknown";
  }
  const key = playlistProgressKey(body);
  if (!entry.progress || entry.progress.key !== key) {
    entry.progress = { key, at: now };
    return "alive";
  }
  return now - entry.progress.at >= PLAYLIST_STUCK_MS ? "ended" : "alive";
}

/** Status plus playlist movement, for one rendition. */
async function rungHealth(
  egress: LiveHlsEgressApi,
  channelId: string,
  startedAt: number,
  entry: RunningRung,
  now: number,
): Promise<{ health: EgressHealth; detail?: string; stillRunning: boolean }> {
  let health: EgressHealth = "unknown";
  let detail: string | undefined;
  if (egress.listEgress) {
    try {
      const listing = await egress.listEgress({ egressId: entry.egressId });
      health = healthFromListing(entry.egressId, listing);
      detail = listing.find((item) => item.egressId === entry.egressId)?.error;
    } catch (error) {
      logEvent("voice.hlsHealthCheckFailed", {
        channelId,
        egressId: entry.egressId,
        rung: entry.rung.name,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  if (health !== "ended") {
    const playlist = await playlistHealth(channelId, startedAt, entry, now);
    if (playlist === "ended") {
      health = "ended";
      detail = detail ?? `playlist stuck for ${PLAYLIST_STUCK_MS} ms`;
      // THE DISTINCTION THAT COST A CORE. "Ended" here means the playlist has
      // not moved for `PLAYLIST_STUCK_MS`, and the whole reason that rule
      // exists (see the constant's comment) is that LiveKit goes on reporting
      // a dead node's egress as ACTIVE forever. The converse is the case that
      // was never handled: a transcode whose playlist stalled while the
      // handler is genuinely still running and still burning a core. The
      // monitor used to drop such a rung from its bookkeeping and never stop
      // it, so it transcoded until somebody restarted the media box, and the
      // restart started a second ladder beside it.
      return { health, detail, stillRunning: true };
    }
  }
  // LiveKit itself said it is over, so there is nothing left to stop and
  // asking would only log a failure about an egress that finished normally.
  return { health, detail, stillRunning: false };
}

/**
 * ANY OTHER TRANSCODE RUNNING ON THIS ROOM IS A LEFTOVER. Stop it.
 *
 * The safety net, and the reason it exists is that every path that leaks one
 * looks identical to a healthy party from the API's side. A live production
 * watch party on 2026-09-09 showed two `voice.hlsStarted` for one channel nine
 * minutes apart with the same presenter and **nothing at all logged in
 * between**, and the earlier pair's handlers were still on the media box two
 * minutes after the later pair started: four transcoders on one room, on a
 * four core box that also carries the SFU and the TURN relay.
 *
 * The individual leaks are worth fixing one at a time and are (the stuck-but-
 * running rung directly above, the silent teardowns in `reconcileLiveHlsNow`).
 * This is the net under them, because `LIVE_HLS_MAX_SESSIONS` counts SESSIONS
 * and a session that can transiently be four handlers instead of two makes the
 * cap of 3 mean twelve.
 *
 * SCOPED TO ROOMS THIS PROCESS HAS A SESSION FOR, deliberately. "Stop every
 * active egress I do not recognise" would kill the ones `adoptLiveHlsSession`
 * exists to inherit across a deploy, which is the opposite of the promise that
 * a party does not notice a restart. Within a room we are already presenting,
 * an egress that is not one of our rungs cannot be anything but ours from
 * before. The 15 s health grace covers the boot window in which a ladder's
 * rungs are still being adopted one at a time.
 *
 * A listing we could not fetch is never a reason to act, the same rule
 * `listActiveEgresses` states for the retention sweep: "could not ask" is not
 * "nothing is running".
 */
async function reapForeignEgresses(
  egress: LiveHlsEgressApi,
  channelId: string,
  room: RoomHls,
  now: number,
): Promise<void> {
  if (!egress.listEgress || !reapOrphansEnabled()) {
    return;
  }
  let listing: EgressListing[];
  try {
    listing = await egress.listEgress({ roomName: channelId, active: true });
  } catch (error) {
    logEvent("voice.hlsReapListFailed", {
      channelId,
      error: error instanceof Error ? error.message : String(error),
    });
    return;
  }
  // THE CAMERA IS ONE OF OURS. Leaving it out of this set would have the
  // reaper stop it on the first monitor tick and the reconcile start it again
  // on the next push, forever, with `liveHls.orphansStopped` climbing and
  // nothing wrong: a silent, total failure of the shape this file has already
  // been bitten by twice.
  const ours = new Set(room.rungs.map((entry) => entry.egressId));
  // THE ARCHIVE IS ONE OF OURS. It is an ACTIVE egress on a room this process
  // is presenting and it is not a rung, which is the exact description of what
  // this function stops. Forgetting it here would kill the recording on the
  // first monitor tick and count it as a leak.
  if (room.micArchive) {
    ours.add(room.micArchive.egressId);
  }
  if (room.camera) {
    ours.add(room.camera.egressId);
  }
  const candidates: string[] = [];
  for (const info of listing) {
    if (ours.has(info.egressId)) {
      continue;
    }
    // THE FILTER IS RE-CHECKED HERE, and it is not paranoia about our own
    // code. `roomName` went into the request; if a LiveKit version, a proxy or
    // a future SDK ignored it, this loop would stop every other party's live
    // transcode across the instance, which is the worst outcome available to
    // anything in this file. A listing entry that does not name its room is
    // left alone rather than assumed to be this one.
    if (info.roomName !== channelId) {
      continue;
    }
    if (healthFromListing(info.egressId, listing) !== "alive") {
      continue;
    }
    if (orphanStopHeld(info.egressId, now)) {
      continue;
    }
    candidates.push(info.egressId);
  }
  if (candidates.length === 0) {
    return;
  }
  // AND THE SECOND MACHINE IS NOT A LEAK. "An egress in a room I am
  // presenting that is not one of my rungs can only be mine from before" was
  // true while one process existed. With two, the other one can legitimately
  // be driving a rung here -- a camera it started, a ladder it adopted -- and
  // stopping it would be this function killing a live stream instead of
  // tidying one up. So a candidate whose session row belongs to an instance
  // that is still answering its heartbeat is left alone. A lookup that FAILED
  // is not permission either: stop nothing this tick and try again on the
  // next, the same way a listing we could not fetch is never a reason to act.
  const ownedElsewhere = await egressIdsOwnedElsewhere(candidates);
  if (ownedElsewhere === null) {
    return;
  }
  for (const egressId of candidates) {
    if (ownedElsewhere.has(egressId)) {
      noteHlsSkippedOwnedElsewhere({ site: "reap", channelId, egressId, now });
      continue;
    }
    const stopped = await stopEgressById(egressId, channelId);
    if (stopped) {
      orphansStopped += 1;
      logEvent("voice.hlsOrphanStopped", {
        channelId,
        egressId,
        ours: [...ours],
      });
    }
  }
}

/**
 * One monitor pass: every room's egress is looked up by id, and its live
 * playlist is read to see whether it still moves. Either saying "ended" is
 * enough; the status check catches a clean failure fast, the playlist
 * check catches the killed node LiveKit never hears about. Exported so the
 * test can drive it with a fake clock; `startLiveHlsMonitor` runs it on an
 * interval. Returns the channels it restarted or failed, for the log and
 * the test.
 */
/**
 * A boot pass that left rows to another live machine asks to be run again, in
 * case that machine has since died: on one machine the boot pass was the only
 * thing that ever adopted or ended an abandoned session, and a skip must not
 * turn "not yet" into "never".
 *
 * IMPORTED LAZILY because `hls-cleanup.ts` imports this module: a static
 * import here would close the cycle. Failures are swallowed on purpose — this
 * is a best-effort repair on a monitor tick, not part of presenting anything.
 */
async function revisitSkippedHlsSessions(): Promise<void> {
  try {
    const { reconcileSkippedHlsSessions } = await import("./hls-cleanup.js");
    await reconcileSkippedHlsSessions();
  } catch (error) {
    logEvent("voice.hlsReconcileRevisitFailed", {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

async function retryDeferredStops(now = Date.now()): Promise<void> {
  for (const [egressId, entry] of [...deferredStops]) {
    if (
      entry.attempts >= DEFERRED_STOP_MAX_ATTEMPTS ||
      now - entry.queuedAt > DEFERRED_STOP_TTL_MS
    ) {
      deferredStops.delete(egressId);
      logEvent("voice.hlsStopDeferredAbandoned", {
        channelId: entry.channelId,
        egressId,
        sessionId: entry.sessionId,
        attempts: entry.attempts,
        ageMs: now - entry.queuedAt,
      });
    }
  }
  if (deferredStops.size === 0) {
    return;
  }
  const batch = [...deferredStops.keys()].slice(0, DEFERRED_STOP_PER_TICK);
  const owned = await egressIdsOwnedElsewhere(batch);
  if (owned === null) {
    // Still cannot ask. Keep them; this runs again in a few seconds.
    return;
  }
  await runBounded(batch, DEFERRED_STOP_CONCURRENCY, async (egressId) => {
    const entry = deferredStops.get(egressId);
    if (!entry) {
      return;
    }
    entry.attempts += 1;
    if (owned.has(egressId)) {
      // Somebody alive owns it after all: never ours to stop, and no longer
      // ours to remember.
      deferredStops.delete(egressId);
      noteHlsSkippedOwnedElsewhere({
        site: "stop-deferred",
        channelId: entry.channelId,
        egressId,
        sessionId: entry.sessionId,
      });
      return;
    }
    if (await stopEgressById(egressId, entry.channelId)) {
      deferredStops.delete(egressId);
      logEvent("voice.hlsStopped", {
        channelId: entry.channelId,
        reason: "deferred-stop-retried",
        egressIds: [egressId],
        sessionIds: [entry.sessionId],
        rung: entry.rung,
      });
    }
    // A stop that failed keeps its place: `stopEgressById` is already backing
    // off, and forgetting it here is the leak this queue exists to prevent.
  });
}

/**
 * Test seam: put an entry in the deferred-stop queue directly. The state it
 * models is a teardown whose ownership lookup failed, which needs a database
 * that fails DURING a room teardown to reach honestly, and the thing worth
 * pinning is what the retry does with it afterwards.
 */
export function seedDeferredHlsStopForTests(entry: {
  egressId: string;
  channelId: string;
  sessionId: string;
  rung?: string;
  attempts?: number;
  queuedAt?: number;
}): void {
  deferredStops.set(entry.egressId, {
    channelId: entry.channelId,
    sessionId: entry.sessionId,
    rung: entry.rung ?? "720p30",
    queuedAt: entry.queuedAt ?? Date.now(),
    attempts: entry.attempts ?? 0,
  });
}

/** How many teardowns are waiting on an ownership answer. Belongs at zero. */
export function deferredHlsStopCount(): number {
  return deferredStops.size;
}

/**
 * The camera slot's health, for a ladder room and an LL companion alike (see
 * `llCompanions`), and moved here out of `checkLiveHlsHealth` so both run the
 * same rule.
 */
async function tendCameraHealth(
  egress: LiveHlsEgressApi,
  channelId: string,
  room: RoomHls,
  startedAt: number,
  now: number,
): Promise<void> {
  // The camera, on exactly the terms a secondary rung gets: if it dies the
  // film does not, and it is stopped before it is forgotten so a stalled but
  // still-running transcode cannot become an orphan (the 2026-09-09 lesson,
  // above). Checked before the primary so a room the primary is about to
  // tear down does not pay for a probe.
  const camera = room.camera;
  // Its OWN grace, not the room's. A camera started ten minutes into a party
  // is brand new on a session that is not, and the room-level grace above
  // has long since expired for it.
  if (camera && now - camera.startedAtMs >= HEALTH_GRACE_MS) {
    const cameraHealth = await rungHealth(
      egress,
      channelId,
      startedAt,
      camera,
      now,
    );
    // `room.camera === camera`, NOT JUST the room's identity. `rungHealth`
    // is an await, and a camera replaced during it (a device switch, or the
    // presenter re-declaring) is a NEW egress on the same `room` object:
    // `room.camera` was mutated in place by `reconcileCameraEgress`, so the
    // room-identity check alone still passes and this stale health result
    // would null out the replacement's `room.camera`, strip its
    // `cameraHlsUrl`, start its cooldown, and stop the OLD egress ID,
    // leaving the NEW one running and unowned, forever, since nothing else
    // ever looks for it again.
    if (
      cameraHealth.health === "ended" &&
      companionHost(channelId) === room &&
      room.camera === camera
    ) {
      room.camera = null;
      if (cameraHealth.stillRunning) {
        await stopRungs(channelId, [camera]);
      }
      await recordSessionEnded(channelId, startedAt, CAMERA_RUNG_NAME);
      room.stream = withoutCameraUrl(room.stream);
      startCameraCooldown(channelId, now);
      logEvent("voice.hlsCameraDied", {
        channelId,
        egressId: camera.egressId,
        sessionId: camera.sessionId,
        error: cameraHealth.detail ?? null,
        cooldownMs: cameraCooldownMs,
      });
      // The viewers are holding a `cameraHlsUrl` that will now 404. Tell
      // them so the PiP disappears instead of spinning.
      notifyChanged(channelId, "camera-ended");
    }
  }
}

export async function checkLiveHlsHealth(
  now = Date.now(),
): Promise<
  { channelId: string; outcome: "scheduled" | "failed" | "cancelled" }[]
> {
  // FIRST, AND WHETHER OR NOT THERE IS AN EGRESS TO TALK TO: both of these are
  // repairs of writes that did not land, and neither depends on this process
  // still presenting anything.
  await retryPendingHlsSessionClaims();
  await revisitSkippedHlsSessions();
  // AND BEFORE `getEgress()`, because a demotion is not a LiveKit question.
  // The remux box has its own watchdog and its own verdict; this process's
  // only job is to hear it and put the party back on the conventional
  // ladder. `notifyChanged` is the same seam a dead egress uses
  // (`ws/voice.ts` turns it into a `pushLiveHls`, which re-resolves the mode
  // -- now `conventional`, because `sweepLlDemotions` has both cleared
  // `low_latency_requested` and memoed the party -- and starts the rungs).
  for (const channelId of await sweepLlDemotions()) {
    notifyChanged(channelId, "ll-demoted");
  }
  const egress = getEgress();
  if (!egress) {
    return [];
  }
  await retryDeferredStops();
  const outcomes: {
    channelId: string;
    outcome: "scheduled" | "failed" | "cancelled";
  }[] = [];
  for (const [channelId, room] of [...rooms.entries()]) {
    if (now - room.startedAtMs < HEALTH_GRACE_MS) {
      continue;
    }
    const startedAt = room.stream.startedAt;
    const primary = room.rungs[0];
    if (!primary) {
      continue;
    }
    // BEFORE the health checks, not after: a leftover ladder is what makes the
    // box slow enough for the live one's playlist to stall, which is the
    // stuck-playlist verdict, which schedules a restart, which starts a third.
    await reapForeignEgresses(egress, channelId, room, now);
    if (rooms.get(channelId) !== room) {
      continue;
    }
    // AFTER the reap, so a just-started archive is never the thing the reap
    // has not been told about yet, and before the health checks, which can
    // delete the room from under it.
    await tendMicArchive(egress, channelId, room, now);
    if (rooms.get(channelId) !== room) {
      continue;
    }
    // Secondary rungs first, and one at a time: a dead extra rendition is
    // dropped from the ladder and the viewers on it fall to the primary,
    // which is what a master playlist is for. Only the primary dying is a
    // dead stream, because it is the one every viewer can always reach.
    for (const entry of [...room.rungs.slice(1)]) {
      const { health, detail, stillRunning } = await rungHealth(
        egress,
        channelId,
        startedAt,
        entry,
        now,
      );
      if (health !== "ended" || rooms.get(channelId) !== room) {
        continue;
      }
      room.rungs = room.rungs.filter((item) => item !== entry);
      // BEFORE forgetting it, not after. A rung dropped from `room.rungs` is
      // unreachable from `stopRoom`, so anything not stopped here is an
      // orphan for the life of the media box.
      if (stillRunning) {
        await stopRungs(channelId, [entry]);
      }
      await recordSessionEnded(channelId, startedAt, entry.rung.name);
      logEvent("voice.hlsRungDied", {
        channelId,
        egressId: entry.egressId,
        sessionId: entry.sessionId,
        rung: entry.rung.name,
        remaining: room.rungs.map((item) => item.rung.name),
        error: detail ?? null,
      });
      // The master playlist is built per request from the rows, so it
      // already lists one variant fewer. Tell the room anyway: a viewer
      // pinned to this rung needs a fresh source, not a stalled one.
      notifyChanged(channelId, "rung-ended");
    }
    if (rooms.get(channelId) !== room) {
      continue;
    }
    await tendCameraHealth(egress, channelId, room, startedAt, now);
    if (rooms.get(channelId) !== room) {
      continue;
    }
    const { health, detail, stillRunning } = await rungHealth(
      egress,
      channelId,
      startedAt,
      primary,
      now,
    );
    if (health !== "ended") {
      continue;
    }
    // Still the same session? A reconcile may have replaced it meanwhile.
    if (rooms.get(channelId) !== room) {
      continue;
    }
    rooms.delete(channelId);
    // The room is gone from the map, so nothing else can reach its archive:
    // stop it here or it transcodes to a file forever. Stated with its own
    // reason rather than folded into the rung teardown.
    await stopMicArchive(channelId, room, "egress-died");
    // EVERY RUNG, INCLUDING THE PRIMARY. This used to be `slice(1)`, on the
    // reasoning that a primary judged "ended" has already ended. That is true
    // of the LiveKit-said-so half and false of the other half: a primary whose
    // playlist stalled while its handler is still running was deleted from
    // `rooms` and never stopped, and `scheduleRestart` immediately below then
    // started a whole fresh ladder beside the one still transcoding. Two
    // restarts inside the window make three ladders on a four core box that
    // also carries the SFU and the TURN relay. `stillRunning` is what tells
    // the two halves apart, so a clean end still costs no pointless RPC.
    await stopRungs(
      channelId,
      // The camera unconditionally: unlike the primary there is no "LiveKit
      // already said it ended" about it, and a camera transcode left running
      // in a room this process has just forgotten is an orphan nothing owns.
      [
        ...(stillRunning ? room.rungs : room.rungs.slice(1)),
        ...(room.camera ? [room.camera] : []),
      ],
    );
    await recordSessionEnded(channelId, startedAt);
    logEvent("voice.hlsEgressDied", {
      channelId,
      egressId: primary.egressId,
      sessionId: primary.sessionId,
      rung: primary.rung.name,
      error: detail ?? null,
    });
    outcomes.push({
      channelId,
      outcome: scheduleRestart(
        channelId,
        "egress-ended",
        now,
        // The room is already out of `rooms` (above), so the presenter has to
        // travel with the call: without it a restart for a presenter who has
        // left reads as a restart for nobody in particular and is scheduled.
        room.stream.presenterPeerId,
      ),
    });
  }
  // THE LL BROADCASTS' CAMERA AND ARCHIVE, on the ladder's own terms minus
  // the ladder. A companion outlives nothing: the moment this process no
  // longer holds the LL session it was started beside (a demotion, a stop, a
  // replacement with a new `startedAt`), it is stopped here, since none of
  // those paths lives in this file.
  for (const [channelId, room] of [...llCompanions.entries()]) {
    const ll = llStreamFor(channelId);
    if (!ll || ll.startedAt !== room.stream.startedAt) {
      // Not inside the boot window: a companion the boot reconcile parked
      // (`parkLlCompanion`) is waiting for `adoptLlHlsSessions`, which runs
      // after it, to take the LL session itself back.
      if (now - room.startedAtMs >= LL_COMPANION_BOOT_GRACE_MS) {
        await stopLlCompanions(channelId, "ll-session-gone");
      }
      continue;
    }
    if (now - room.startedAtMs < HEALTH_GRACE_MS) {
      continue;
    }
    await tendMicArchive(egress, channelId, room, now);
    if (llCompanions.get(channelId) !== room) {
      continue;
    }
    await tendCameraHealth(egress, channelId, room, room.stream.startedAt, now);
  }
  return outcomes;
}

/**
 * Build, refresh or retire this channel's LL companion (`llCompanions`) after
 * the LL half of `reconcileLiveHlsNow` has decided what is on air, and hand the
 * camera and voice sids back for `reconcileLiveHls` to reconcile the camera
 * slot with, exactly as a ladder room's reconcile does.
 *
 * THE ARCHIVE STARTS ONLY INSIDE ITS OWN WINDOW, measured from the LL
 * session's `startedAt` rather than from when this companion was built. A
 * companion built late is one this process is inheriting (an API restart
 * mid-party, whose boot reconcile stopped the old egresses because no ladder
 * room claimed them), and a second archive would write the same
 * `<startedAt>-mic.ogg` over the first: the rule a ladder room's adoption
 * already follows (`RoomHls.micArchiveUntil`).
 */
async function reconcileLlCompanions(
  channelId: string,
  stream: LiveHlsStream | null,
): Promise<LiveHlsReconcileResult> {
  const existing = llCompanions.get(channelId);
  if (!stream) {
    if (existing) {
      await stopLlCompanions(channelId, "ll-stopped");
    }
    return { stream };
  }
  if (existing && existing.stream.startedAt !== stream.startedAt) {
    await stopLlCompanions(channelId, "ll-session-replaced");
  }
  const egress = getEgress();
  if (!egress) {
    return { stream };
  }
  const tracks = await probeScreenTracks(channelId, stream.presenterPeerId);
  if (!tracks) {
    // Could not ask. The film is fine; the camera and the archive are tried
    // again on the next reconcile, and the monitor keeps the archive's window.
    return { stream };
  }
  let room = llCompanions.get(channelId);
  if (!room) {
    room = {
      rungs: [],
      stream: { ...stream },
      videoTrackId: tracks.videoTrackId,
      audioTrackId: tracks.audioTrackId ?? null,
      camera: null,
      startedAtMs: Date.now(),
      micArchive: null,
      micArchiveUntil: stream.startedAt + MIC_ARCHIVE_WAIT_MS,
      announced: true,
    };
    llCompanions.set(channelId, room);
    // A COMPANION THAT ALREADY EXISTS ON THE MEDIA BOX IS INHERITED, NOT
    // DUPLICATED. This process is building the slot for an LL session it may
    // just have adopted (a resume onto this machine, a handover from the
    // other one), in which case the camera and the archive are still running
    // under rows somebody else started. Starting fresh ones beside them would
    // write a second archive over `<startedAt>-mic.ogg` and a second camera
    // nobody tracks. Cheap on a genuinely new session: one indexed read that
    // finds nothing.
    await adoptLlCompanionRows(channelId, room, stream.startedAt);
    if (llCompanions.get(channelId) !== room) {
      return { stream };
    }
    if (
      !room.micArchive &&
      micArchiveEnabled() &&
      tracks.micArchiveTrackId &&
      Date.now() < room.micArchiveUntil
    ) {
      await startMicArchive(egress, channelId, room, tracks.micArchiveTrackId);
    }
  } else {
    // A reconnect that kept the media keeps the session under a new peer id
    // (`voice.hlsPresenterReattached`'s case); the slots follow it.
    room.stream = { ...room.stream, presenterPeerId: stream.presenterPeerId };
  }
  return {
    stream,
    cameraTrackId: tracks.cameraTrackId ?? null,
    voiceTrackId: tracks.voiceTrackId ?? null,
  };
}

/**
 * Take back an LL broadcast's camera and mic-archive egresses that are still
 * running under open rows for this session: the LL twin of the camera and
 * archive half of `adoptRunningLiveHlsSession`. Same refusals: a row a live
 * other machine owns is left alone, "could not ask" adopts nothing, and an
 * egress LiveKit no longer lists is not inherited.
 */
async function adoptLlCompanionRows(
  channelId: string,
  room: RoomHls,
  startedAt: number,
): Promise<void> {
  let rows: OpenHlsSessionRow[];
  try {
    const result = await getPool().query<OpenHlsSessionRow>(
      `SELECT id, object_prefix, egress_id, presenter_peer_id,
              video_track_id, audio_track_id, rung, instance_id
         FROM hls_sessions
        WHERE channel_id = $1
          AND ended_at IS NULL
          AND cleaned_at IS NULL
          AND mode <> 'll'
          AND egress_id IS NOT NULL`,
      [channelId],
    );
    rows = result.rows;
  } catch (error) {
    logEvent("voice.hlsLlCompanionLookupFailed", {
      channelId,
      error: error instanceof Error ? error.message : String(error),
    });
    // Could not ask whether an archive is already running for this session,
    // so do not start a second one: the same rule an adopted ladder follows.
    room.micArchiveUntil = 0;
    return;
  }
  const candidates = rows.flatMap((row) => {
    const parsed = parseHlsObjectPrefix(row.object_prefix);
    const rung = row.rung ?? parsed?.rung ?? null;
    return parsed &&
      parsed.startedAt === startedAt &&
      (rung === CAMERA_RUNG_NAME || rung === MIC_ARCHIVE_RUNG)
      ? [{ row, rung }]
      : [];
  });
  if (candidates.length === 0) {
    return;
  }
  // Rows exist, so this session was inherited: never a second archive,
  // whatever happens below.
  room.micArchiveUntil = 0;
  const liveOthers = await liveOtherInstances();
  const active = liveOthers === null ? null : await listActiveEgresses();
  if (liveOthers === null || active === null) {
    return;
  }
  const listed = new Set(active.map((info) => info.egressId));
  const adopted: string[] = [];
  for (const { row, rung } of candidates) {
    if (
      ownedByLiveOtherInstance(row.instance_id, liveOthers) ||
      !row.egress_id ||
      !listed.has(row.egress_id)
    ) {
      continue;
    }
    if (rung === CAMERA_RUNG_NAME) {
      const stream = adoptLiveHlsSession({
        channelId,
        egressId: row.egress_id,
        startedAt,
        presenterPeerId: room.stream.presenterPeerId,
        videoTrackId: row.video_track_id ?? "",
        audioTrackId: row.audio_track_id,
        rung: CAMERA_RUNG_NAME,
      });
      if (stream) {
        adopted.push(row.id);
      }
    } else if (
      adoptLiveHlsMicArchive({
        channelId,
        egressId: row.egress_id,
        startedAt,
        trackId: row.video_track_id ?? "",
      })
    ) {
      adopted.push(row.id);
    }
  }
  if (adopted.length > 0) {
    await claimHlsSessionRows(adopted);
    logEvent("voice.hlsLlCompanionsAdopted", {
      channelId,
      startedAt,
      sessionIds: adopted,
    });
  }
}

/**
 * Give the boot reconcile somewhere to put an LL broadcast's camera and
 * archive egresses, which outlive an API restart exactly as a ladder's do.
 * `adoptCameraEgress` and `adoptLiveHlsMicArchive` find it through
 * `companionHost`, so they adopt onto it the way they adopt onto a ladder
 * room. Called only for a session whose LL row is still open; the monitor
 * stops the companion if the LL session itself does not come back.
 */
export function parkLlCompanion(input: {
  channelId: string;
  startedAt: number;
  presenterPeerId: string;
  videoTrackId: string;
}): void {
  if (rooms.has(input.channelId)) {
    return;
  }
  const existing = llCompanions.get(input.channelId);
  if (existing && existing.stream.startedAt === input.startedAt) {
    return;
  }
  llCompanions.set(input.channelId, {
    rungs: [],
    stream: {
      hlsUrl: llPlaylistUrl(input.channelId, input.startedAt),
      startedAt: input.startedAt,
      presenterPeerId: input.presenterPeerId,
      delaySeconds: llDelaySeconds(),
      mode: "ll",
    },
    videoTrackId: input.videoTrackId,
    audioTrackId: null,
    camera: null,
    startedAtMs: Date.now(),
    micArchive: null,
    // Never a second archive after a restart: see `RoomHls.micArchiveUntil`.
    micArchiveUntil: 0,
    announced: true,
  });
}

/** Whether a ladder room for exactly this session is in `rooms`, which is
 * what a camera or archive adopts onto without any LL question at all. */
export function hasLadderRoomFor(channelId: string, startedAt: number): boolean {
  return rooms.get(channelId)?.stream.startedAt === startedAt;
}

/** Stop an LL broadcast's camera and archive and close their rows. */
async function stopLlCompanions(channelId: string, reason: string): Promise<void> {
  const room = llCompanions.get(channelId);
  if (!room) {
    return;
  }
  llCompanions.delete(channelId);
  const camera = room.camera;
  room.camera = null;
  await stopMicArchive(channelId, room, reason);
  if (camera) {
    await stopRungs(channelId, [camera]);
    await recordSessionEnded(channelId, room.stream.startedAt, CAMERA_RUNG_NAME);
  }
  logEvent("voice.hlsLlCompanionsStopped", {
    channelId,
    startedAt: room.stream.startedAt,
    reason,
    cameraEgressId: camera?.egressId ?? null,
  });
}

export function startLiveHlsMonitor(): void {
  if (monitorTimer) {
    return;
  }
  monitorTimer = setInterval(() => {
    void checkLiveHlsHealth().catch((error: unknown) => {
      logEvent("voice.hlsMonitorFailed", {
        error: error instanceof Error ? error.message : String(error),
      });
    });
  }, HLS_HEALTH_CHECK_INTERVAL_MS);
  monitorTimer.unref?.();
}

export function stopLiveHlsMonitor(): void {
  if (monitorTimer) {
    clearInterval(monitorTimer);
    monitorTimer = null;
  }
}

function liveKitHttpUrl(): string {
  const url = process.env.LIVEKIT_URL!;
  return url.replace(/^ws:/, "http:").replace(/^wss:/, "https:");
}

/**
 * Bound on every Egress RPC (`startTrackCompositeEgress`, `startTrackEgress`,
 * `stopEgress`, `listEgress`).
 *
 * `livekit-server-sdk`'s Twirp client defaults `requestTimeout` to 10 SECONDS
 * and, since `sfu.pqp.gg` is not LiveKit Cloud, never fails over -- so with
 * no override a single stuck call rode the SDK's full 10s window. Egress
 * RPCs route over Redis (psrpc) to the egress worker rather than being
 * answered in-process by the LiveKit server, which is the extra hop
 * `stopEgress` timeouts (2026-09-23, 18:28:22, 20:13:14-27, 21:24:06-11) sat
 * in. See `REQUEST_TIMEOUT_SECONDS` in `admin.ts` for the matching bound on
 * RoomService calls and why 5s.
 */
const EGRESS_REQUEST_TIMEOUT_SECONDS = 5;

function getEgress(): LiveHlsEgressApi | null {
  if (injectedEgress) {
    return injectedEgress;
  }
  if (!isLiveKitConfigured()) {
    return null;
  }
  const client = new EgressClient(
    liveKitHttpUrl(),
    process.env.LIVEKIT_API_KEY,
    process.env.LIVEKIT_API_SECRET,
    { requestTimeout: EGRESS_REQUEST_TIMEOUT_SECONDS },
  );
  return {
    startTrackCompositeEgress: async (roomName, output, opts) => {
      const info = await client.startTrackCompositeEgress(
        roomName,
        { segments: output },
        {
          audioTrackId: opts.audioTrackId,
          videoTrackId: opts.videoTrackId,
          encodingOptions: opts.encodingOptions,
        },
      );
      return { egressId: info.egressId };
    },
    startTrackEgress: async (roomName, output, trackId) => {
      const info = await client.startTrackEgress(roomName, output, trackId);
      return { egressId: info.egressId };
    },
    stopEgress: async (egressId) => {
      await client.stopEgress(egressId);
    },
    listEgress: async (opts) => {
      const infos = await client.listEgress(opts);
      return infos.map((info) => ({
        egressId: info.egressId,
        status: info.status,
        error: info.error || undefined,
        roomName: info.roomName,
        // `startedAt` is unix nanoseconds (protobuf int64). Dividing the
        // bigint first keeps the result inside Number's safe range — doing
        // that division after `Number()` would already have lost precision,
        // since nanoseconds-since-1970 overflows MAX_SAFE_INTEGER today.
        startedAt:
          info.startedAt > 0n ? Number(info.startedAt / 1_000_000n) : undefined,
      }));
    },
  };
}

/**
 * Every egress the media server is running right now, across all rooms. Null
 * means "could not ask", which callers must not confuse with "none": the
 * retention sweep in particular has to refuse to delete when it cannot tell.
 */
export async function listActiveEgresses(): Promise<EgressListing[] | null> {
  const egress = getEgress();
  if (!egress) {
    // NO LIVEKIT HERE. This used to answer `[]` — "there is genuinely nothing
    // running" — which is true of the process that would have started an
    // egress and false of any OTHER process asking about one. The retention
    // sweep's whole safety rule is "ask the media server, do not trust the
    // row", and `[]` turns that into a rubber stamp: a session whose egress is
    // still writing segments reads as finished and its objects get deleted
    // underneath a live watch party.
    //
    // That is reachable on the split deployment. `pqp-worker` is where the
    // sweep runs and it holds neither `LIVEKIT_*` nor `LIVE_HLS_S3_*`; the
    // moment somebody fixes half of that by giving it the bucket, this
    // function starts saying "nothing is running" about a box that is running
    // everything. `null` means "could not ask", every caller already treats
    // that as "leave it alone", and the log line names the reason.
    logEvent("voice.hlsListEgressUnavailable", { reason: "no-livekit" });
    return null;
  }
  if (!egress.listEgress) {
    return null;
  }
  try {
    const listing = await egress.listEgress({ active: true });
    return listing.filter(
      (info) => healthFromListing(info.egressId, listing) === "alive",
    );
  } catch (error) {
    logEvent("voice.hlsListEgressFailed", {
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

/** Stop one egress by id, for an orphan nobody owns. */
export async function stopEgressById(
  egressId: string,
  channelId?: string,
  now = Date.now(),
): Promise<boolean> {
  const egress = getEgress();
  if (!egress) {
    return false;
  }
  if (orphanStopHeld(egressId, now)) {
    return false;
  }
  try {
    await egress.stopEgress(egressId);
    orphanStopBackoff.delete(egressId);
    return true;
  } catch (error) {
    if (egressAlreadyStopped(error)) {
      // The outcome asked for is the outcome that holds. Clearing the backoff
      // is the point: an EGRESS_COMPLETE id kept in it is retried for an hour
      // about something that finished before the first ask.
      orphanStopBackoff.delete(egressId);
      logEvent("voice.hlsStopNoop", {
        channelId: channelId ?? null,
        egressId,
        error: error instanceof Error ? error.message : String(error),
      });
      return true;
    }
    const { failures, waitMs } = rememberOrphanStopFailure(egressId, now);
    logEvent("voice.hlsStopFailed", {
      channelId: channelId ?? null,
      egressId,
      error: error instanceof Error ? error.message : String(error),
      failures,
      backoffMs: waitMs,
    });
    return false;
  }
}

/**
 * Take ownership of an egress that outlived the process which started it.
 *
 * WHY ADOPT RATHER THAN STOP. An API restart does not stop the media box: the
 * transcode keeps running and keeps writing segments. The first version of the
 * boot reconcile ended the row and stopped the egress, which killed a live
 * watch party on every deploy, and if the stop did not land it left an orphan
 * burning about a core of a four-core box that is also carrying voice. Adopting
 * is both kinder and safer: the party does not notice the deploy, which is the
 * same promise the voice resume machinery already makes.
 *
 * The room entry is rebuilt from the session row, which is why
 * `presenter_peer_id` and `video_track_id` are stored: `reconcileLiveHls`
 * compares both, and a presenter's client keeps its peer id across a restart,
 * so a resumed presenter matches and the egress is left alone.
 */
export function adoptLiveHlsSession(input: {
  channelId: string;
  egressId: string;
  startedAt: number;
  presenterPeerId: string;
  videoTrackId: string;
  /**
   * `hls_sessions.audio_track_id`. For the camera/voice slot
   * (`rung === CAMERA_RUNG_NAME`) this is the separated mic sid. For a
   * ladder rung it is the screen's own audio sid the egress was started
   * with ("música"), recorded there since 2026-09-20 for exactly this
   * adoption: without it, every ladder row read back null regardless of
   * whether the presenter's tab audio was live, and the next reconcile
   * after an API restart would see the SFU's real audio sid disagree with
   * that remembered null and restart a session that had not actually
   * changed. See `RoomHls.audioTrackId`.
   */
  audioTrackId?: string | null;
  /** Which rendition this egress is. Null is a pre-ladder single-rung row. */
  rung: string | null;
}): LiveHlsStream | null {
  // THE CAMERA IS NOT A RUNG, and adopting it as one is the failure this
  // branch exists to stop: `LADDER_RUNGS[input.rung]` answers undefined for
  // `cam360p30` and the fallback below would turn a 400 kbit/s webcam into a
  // 720p30 ladder rung, on the master playlist, for the whole party.
  //
  // `reconcileStaleHlsSessions` adopts camera egresses LAST (it sorts them
  // there, and says why), so by the time one arrives its session's room
  // exists. A camera whose session did not come back is unadoptable and is
  // said so: the caller stops it rather than leaving a transcode nothing owns.
  if (input.rung === CAMERA_RUNG_NAME) {
    return adoptCameraEgress(input);
  }
  const rung =
    (input.rung ? LADDER_RUNGS[input.rung] : undefined) ?? LADDER_RUNGS["720p30"]!;
  const entry: RunningRung = {
    rung,
    egressId: input.egressId,
    // Counts as freshly started for the health monitor's grace period: the
    // playlist's progress has not been sampled by THIS process yet.
    startedAtMs: Date.now(),
    progress: null,
    // `adoptLiveHlsSession` is synchronous (its caller is the boot reconcile
    // walking LiveKit's own egress list, not a DB read), so there is no row
    // id in hand here. The next health check or stop that touches this rung
    // logs `sessionId: null` until then, which is an honest "not known yet"
    // rather than a wrong guess.
    sessionId: null,
  };
  // ADOPTION IS PER EGRESS AND A LADDER HAS SEVERAL. The boot reconcile walks
  // what the media server is running, one egress at a time, so the rungs of
  // one session arrive here separately and in no particular order. Replacing
  // the room each time would leave it holding whichever rung happened to come
  // last, and the master playlist would then be built from rows the room does
  // not know it owns.
  const existing = rooms.get(input.channelId);
  const rungs =
    existing && existing.stream.startedAt === input.startedAt
      ? [...existing.rungs.filter((r) => r.egressId !== input.egressId), entry]
      : [entry];
  rungs.sort((a, b) => a.rung.videoKbps - b.rung.videoKbps);
  const stream: LiveHlsStream = {
    hlsUrl: viewerPlaylistUrl(input.channelId, input.startedAt),
    startedAt: input.startedAt,
    presenterPeerId: input.presenterPeerId,
    delaySeconds: delaySeconds(),
    topHeight: Math.max(...rungs.map((r) => r.rung.height)),
    topFramerate: Math.max(...rungs.map((r) => r.rung.framerate)),
  };
  // A camera adopted before its ladder (it should not be — the caller sorts
  // them last and says why — but the ordering is the caller's and this must
  // not throw it away) keeps its slot, and keeps the URL that advertises it.
  const carriedCamera =
    existing && existing.stream.startedAt === input.startedAt
      ? existing.camera
      : null;
  // Same idea as `carriedCamera`: whichever rung arrives first sets the
  // ladder's audio sid, and a later rung of the same session (all started
  // together, so all recorded with the same `audio_track_id`) must not
  // clobber it back to null just because its own row carries none of the
  // rung-specific fields being read here.
  const carriedAudioTrackId =
    existing && existing.stream.startedAt === input.startedAt
      ? existing.audioTrackId
      : null;
  rooms.set(input.channelId, {
    rungs,
    stream: carriedCamera ? withCameraUrl(stream, input.channelId) : stream,
    videoTrackId: input.videoTrackId,
    audioTrackId: input.audioTrackId ?? carriedAudioTrackId,
    camera: carriedCamera,
    startedAtMs: Date.now(),
    // Carried over from the entry this adoption is rebuilding, so a ladder
    // whose rungs arrive one at a time does not drop an archive the first of
    // them already attached. `adoptLiveHlsMicArchive` fills it otherwise.
    micArchive: existing?.micArchive ?? null,
    // NEVER hunt for a new one after a deploy. The archive either came back
    // with the process (the boot reconcile attaches it below) or its egress
    // is gone, and starting a second one mid-film would write a second file
    // that begins nowhere and that nobody asked for.
    micArchiveUntil: 0,
    // An adopted session was serving a playlist on the media box before this
    // process knew it existed: there is nothing to wait for.
    announced: true,
    adoptedAtMs:
      existing && existing.stream.startedAt === input.startedAt
        ? (existing.adoptedAtMs ?? Date.now())
        : Date.now(),
  });
  logEvent("voice.hlsSessionAdopted", {
    channelId: input.channelId,
    egressId: input.egressId,
    startedAt: input.startedAt,
    presenterPeerId: input.presenterPeerId,
    rung: rung.name,
    rungs: rungs.map((r) => r.rung.name),
  });
  return rooms.get(input.channelId)!.stream;
}

/**
 * Take a camera transcode back after a restart, onto the session it belongs
 * to.
 *
 * Null when there is no such session in this process: the party it was
 * filming did not come back, and a camera egress with no room is a core of the
 * media box spent on a webcam nobody can reach. The caller stops it.
 */
function adoptCameraEgress(input: {
  channelId: string;
  egressId: string;
  startedAt: number;
  videoTrackId: string;
  /** `hls_sessions.audio_track_id`. Null/absent for a silent camera row. */
  audioTrackId?: string | null;
}): LiveHlsStream | null {
  const audioTrackId = input.audioTrackId ?? null;
  const hasVideo = input.videoTrackId !== "";
  const hasAudio = audioTrackId !== null && audioTrackId !== "";
  // THE ROLLBACK SWITCH APPLIES ACROSS A DEPLOY TOO, and now checks the
  // shape THIS ROW actually is rather than always requiring `LIVE_HLS_
  // CAMERA`: a boot reconcile on a deployment with the camera off but
  // `LIVE_HLS_VOICE_TRACK` on must still adopt a voice-only row, or an
  // operator's `LIVE_HLS_CAMERA=false` incident response would drop
  // separated-voice parties that never had a camera in them at all. Null is
  // the same "unadoptable" answer a missing session gives, so the caller
  // (`reconcileStaleHlsSessions`) stops the egress by the same path.
  if (hasVideo && !liveHlsCameraEnabled()) {
    logEvent("voice.hlsCameraAdoptionDisabled", {
      channelId: input.channelId,
      egressId: input.egressId,
      startedAt: input.startedAt,
    });
    return null;
  }
  if (hasAudio && !liveHlsVoiceTrackEnabled()) {
    logEvent("voice.hlsVoiceTrackAdoptionDisabled", {
      channelId: input.channelId,
      egressId: input.egressId,
      startedAt: input.startedAt,
    });
    return null;
  }
  const room = companionHost(input.channelId);
  if (!room || room.stream.startedAt !== input.startedAt) {
    logEvent("voice.hlsCameraNotAdoptable", {
      channelId: input.channelId,
      egressId: input.egressId,
      startedAt: input.startedAt,
      sessionStartedAt: room?.stream.startedAt ?? null,
    });
    return null;
  }
  // A DUPLICATE, NOT A REPLACEMENT. `hls_sessions.object_prefix` is unique, so
  // there is only ever one row for this session's camera, but the row's
  // `egress_id` and what LiveKit is actually running can disagree: a stop
  // issued right before a deploy can fail silently or not be confirmed yet,
  // leaving the OLD egress still ACTIVE on the box while the row (and this
  // adoption) already point at a newer one. Overwriting `room.camera` without
  // stopping the one it replaces would leave that old egress owned by nobody
  // — not `room.camera` (just overwritten), not the orphan sweep (its id was
  // never unrecognised, `reapForeignEgresses` treats whatever `room.camera`
  // holds as ours) — consuming an encoder until something else notices.
  // Fire-and-forget: `stopEgressById` has its own retry/backoff, and this
  // adoption must not block on it.
  if (room.camera && room.camera.egressId !== input.egressId) {
    const staleEgressId = room.camera.egressId;
    logEvent("voice.hlsCameraDuplicateAdopted", {
      channelId: input.channelId,
      keptEgressId: input.egressId,
      stoppedEgressId: staleEgressId,
    });
    void stopEgressById(staleEgressId, input.channelId);
  }
  // THE EXACT SHAPE, FROM THE ROW'S TWO COLUMNS — not guessed. Before
  // `audio_track_id` existed, an adopted voice-only row had nowhere to keep
  // its mic sid but `video_track_id`, so it came back mislabelled as a
  // silent camera and cost one extra restart on the very next reconcile
  // tick to self-correct. With both columns this is exact: the rung, the
  // sids and the `cameraHasVideo`/`cameraHasVoiceAudio` flags a viewer's PiP
  // reads all match what was actually running before the restart.
  room.camera = {
    rung: hasVideo
      ? hasAudio
        ? CAMERA_RUNG_WITH_VOICE
        : CAMERA_RUNG
      : VOICE_RUNG,
    egressId: input.egressId,
    startedAtMs: Date.now(),
    progress: null,
    cameraTrackId: hasVideo ? input.videoTrackId : null,
    audioTrackId: hasAudio ? audioTrackId : null,
    // Same gap as the ladder's own adoption path above: no row read here.
    sessionId: null,
  };
  room.stream = withCameraUrl(room.stream, input.channelId, {
    hasVideo,
    hasVoiceAudio: hasAudio,
  });
  logEvent("voice.hlsCameraAdopted", {
    channelId: input.channelId,
    egressId: input.egressId,
    startedAt: input.startedAt,
    hasVideo,
    hasAudio,
  });
  return room.stream;
}

/**
 * Take back a mic-archive Track Egress that outlived the process which started
 * it, the same way `adoptLiveHlsSession` takes back a rendition.
 *
 * IT CANNOT GO THROUGH `adoptLiveHlsSession`, and that is the whole reason
 * this exists. That function turns a row into a RUNG: it looks the rung name
 * up in `LADDER_RUNGS`, and an unknown name falls back to `720p30`. A `mic`
 * row put through it would join the room as a fake 720p rendition, be listed
 * as a variant, be kept warm, and be handed to viewers as a playlist that is
 * really an audio file.
 *
 * Returns whether it attached. False means there is no live session for that
 * channel and startedAt to attach to, and the caller should stop the egress
 * rather than leave a handler writing into a session nobody owns.
 */
export function adoptLiveHlsMicArchive(input: {
  channelId: string;
  egressId: string;
  startedAt: number;
  trackId: string;
}): boolean {
  const room = companionHost(input.channelId);
  if (!room || room.stream.startedAt !== input.startedAt) {
    return false;
  }
  if (room.micArchive && room.micArchive.egressId !== input.egressId) {
    // Two archives for one session is a leak, not a spare. Refuse the second
    // and let the caller stop it.
    return false;
  }
  // No `hls_sessions.id` to hand back here: adoption inherits the egress and
  // the track from the boot reconcile, not the row. The next thing that
  // touches this archive (the health monitor, a stop) leaves it null too --
  // adoption is rare enough that a gap in B0.4's coverage here is an honest
  // one, not worth a second query on a boot-time path.
  room.micArchive = { egressId: input.egressId, trackId: input.trackId, sessionId: null };
  room.micArchiveUntil = 0;
  logEvent("voice.hlsMicArchiveAdopted", {
    channelId: input.channelId,
    egressId: input.egressId,
    startedAt: input.startedAt,
  });
  return true;
}

/**
 * When each channel last narrated a refused resume adoption, per reason.
 *
 * RATE LIMITED PER CHANNEL PER REASON, which is pitfall 16's own fix applied
 * where it applies again: `reconcileLiveHlsNow` reaches the adoption on every
 * roster event for a channel this process has a sharer in and no room for, so
 * a channel whose fresh start is itself being refused (the restart budget's
 * cooldown, the session cap) would repeat one line for every join and leave
 * until it clears. A refusal that cannot be read is worse than no refusal at
 * all, and a line repeated a hundred times is one nobody reads.
 */
const resumeRefusalLoggedAt = new Map<string, number>();
const RESUME_REFUSAL_LOG_THROTTLE_MS = 60_000;

/**
 * WHAT A RESUME ADOPTION ANSWERS, AND WHY "NO" IS TWO DIFFERENT ANSWERS.
 *
 * `fresh` is a genuine restart: nothing to inherit, a different presenter, an
 * egress LiveKit no longer lists. The caller starts a ladder, which is what it
 * did before this existed.
 *
 * `stand-down` is NOT that. It is "somebody else alive is driving this, or the
 * question could not be answered" -- and starting a ladder on either is the
 * incident this whole change is about, one step further along: `startRoom`
 * would mint a new `startedAt` and `endSupersededSessions` would stop the
 * healthy egresses of the session the other machine had just claimed. So the
 * caller does NOTHING this reconcile and asks again on the next roster event.
 * If the other machine really is gone, its heartbeat lapses and the very next
 * attempt adopts; if it is there, its own `pushLiveHls` owns the party and
 * relays the stream over `voice.live`.
 */
type ResumeAdoption =
  | { kind: "adopted"; stream: LiveHlsStream | null }
  | { kind: "fresh" }
  | { kind: "stand-down"; reason: string };

/**
 * The last non-adopted answer per channel AND PRESENTER, and when it was
 * decided.
 *
 * `reconcileLiveHlsNow` reaches the adoption on EVERY roster event for a
 * channel with a local sharer and no local room. An adoption that succeeds is
 * asked once (`rooms.has` short-circuits every later call), but one that
 * answers `fresh` or `stand-down` while the start itself is also failing --
 * the restart cooldown, the session cap, the other machine still holding the
 * rows -- would put a `hls_sessions` read, an instance lookup and a full
 * `ListEgress` behind every join and leave in the room. Five seconds is
 * shorter than any of those conditions lasts and longer than a burst of
 * roster events, so a party joining en masse asks once.
 *
 * THE PRESENTER IS PART OF THE KEY (a Farol finding on this PR). Every answer
 * this function gives is about one person: `presenter-changed` is literally a
 * comparison against them, and a `stand-down` decided while A was sharing says
 * nothing about B. Keyed by the channel alone, a co-host taking over inside
 * the window would be served A's answer and wait five seconds for a party that
 * is ready now.
 */
const resumeDecisionCache = new Map<
  string,
  { at: number; decision: ResumeAdoption }
>();
const RESUME_DECISION_TTL_MS = 5_000;
/**
 * Bumped per channel by `forgetLiveHlsResumeDecisions`, so a decision that was
 * already being made when the cache was cleared cannot write itself back.
 */
const resumeDecisionEpoch = new Map<string, number>();
/**
 * Sweep only past this many entries, not on every miss. The sweep is O(size)
 * and a burst of first-time channels would otherwise be quadratic in it; past
 * this the map is worth walking once, and below it the whole thing is smaller
 * than the sweep's own bookkeeping.
 */
const RESUME_DECISION_MAX_ENTRIES = 128;

/** One open `hls_sessions` row, as the resume adoption below reads it. */
interface OpenHlsSessionRow {
  id: string;
  object_prefix: string;
  egress_id: string | null;
  presenter_peer_id: string | null;
  video_track_id: string | null;
  audio_track_id: string | null;
  rung: string | null;
  instance_id: string | null;
}

/**
 * THE PRESENTER MOVED MACHINES; THE TRANSCODE DID NOT.
 *
 * A rolling deploy drains one `pqp-api` machine at a time, and a presenter
 * whose socket is closed with 1001 resumes on the sibling within a second,
 * keeping their peer id (`voice.resumeAdopted`). The egresses are not on
 * either machine: they run on the LiveKit box, and an API process only
 * monitors them. But `rooms` is per process, so the machine the presenter
 * lands on found nothing for the channel and took the only path it had —
 * `startRoom`, a brand-new `startedAt`, a brand-new ladder, and
 * `endSupersededSessions` stopping the perfectly healthy egresses it had just
 * replaced. Production, 2026-09-15: two machines restarted one after the
 * other, three healthy rungs became two, then one, every viewer rebuffered
 * twice in two minutes, and the second restart refused `720p30` outright.
 *
 * `adoptLiveHlsSession` already knows how to inherit a live session — that is
 * what the boot reconcile does with a dead owner's rows. This is the same act
 * asked at the same moment the SEAT is adopted rather than at boot: the rows
 * are open, the egresses are alive, the presenter is the same person, and the
 * owner is not answering its heartbeat, so the session changes hands with no
 * new transcode, no new `startedAt` and nothing for a viewer to notice.
 *
 * WHAT IT REFUSES, and each refusal falls through to an ordinary fresh start:
 * a different presenter (a genuine handover), an egress LiveKit no longer
 * lists (a genuine restart), an owner that is still answering (not ours), and
 * any question that could not be asked at all. A refusal says which, because
 * a path that silently declines is a path nobody can debug (pitfall 16).
 *
 * DELIBERATELY NOT GATED ON `LIVE_HLS_MAX_SESSIONS` OR THE RESTART BUDGET.
 * Both exist to stop this process asking the box for MORE work; adoption asks
 * for none. Refusing here would leave a live transcode with no monitor and an
 * open row with a dead owner, which is strictly worse than taking it.
 */
export async function adoptRunningLiveHlsSession(
  channelId: string,
  presenterPeerId: string,
  now = Date.now(),
): Promise<ResumeAdoption> {
  if (!isLiveHlsEnabled() || rooms.has(channelId)) {
    return { kind: "fresh" };
  }
  // LENGTH-PREFIXED, not `a:b`. Both halves are ids this process is handed
  // rather than ids it mints, so a separator either of them could contain
  // would let two different pairs share one key and hand a presenter an
  // answer decided about somebody else -- the very thing keying by presenter
  // is here to stop. The length makes the split unambiguous for any string.
  const decisionKey = `${channelId.length}:${channelId}:${presenterPeerId}`;
  const cached = resumeDecisionCache.get(decisionKey);
  if (cached && now - cached.at < RESUME_DECISION_TTL_MS) {
    return cached.decision;
  }
  const epoch = resumeDecisionEpoch.get(channelId) ?? 0;
  const remember = (decision: ResumeAdoption): ResumeAdoption => {
    // A HANDOVER LANDED WHILE THIS WAS BEING DECIDED. The answer is still
    // returned (it was true when it was read), but not remembered: the next
    // reconcile, already queued behind this one, must ask again rather than
    // be served "a live machine owns this" about a session that is now ours.
    if ((resumeDecisionEpoch.get(channelId) ?? 0) !== epoch) {
      return decision;
    }
    if (resumeDecisionCache.size > RESUME_DECISION_MAX_ENTRIES) {
      for (const [seen, entry] of resumeDecisionCache) {
        if (now - entry.at >= RESUME_DECISION_TTL_MS) {
          resumeDecisionCache.delete(seen);
        }
      }
    }
    resumeDecisionCache.set(decisionKey, { at: now, decision });
    return decision;
  };
  let rows: OpenHlsSessionRow[];
  try {
    const result = await getPool().query<OpenHlsSessionRow>(
      `SELECT id, object_prefix, egress_id, presenter_peer_id,
              video_track_id, audio_track_id, rung, instance_id
         FROM hls_sessions
        WHERE channel_id = $1
          AND ended_at IS NULL
          AND cleaned_at IS NULL
          -- An LL row names a pqp-remux session, not an egress id, and has
          -- its own resume-adopt twin in adoptRunningLlHlsSession
          -- (hls-remux.ts). This pass decides a row fate by whether LiveKit
          -- still lists its egress, which an LL row can never match.
          AND mode <> 'll'
          AND egress_id IS NOT NULL`,
      [channelId],
    );
    rows = result.rows;
  } catch (error) {
    logEvent("voice.hlsResumeLookupFailed", {
      channelId,
      presenterPeerId,
      error: error instanceof Error ? error.message : String(error),
    });
    // COULD NOT ASK IS NOT "NOTHING TO INHERIT". A database blip here must not
    // become a fresh ladder on top of a session that is still running.
    return remember({ kind: "stand-down", reason: "lookup-failed" });
  }
  if (rows.length === 0) {
    // The ordinary case for a share that is starting: nothing to inherit, and
    // nothing worth a log line on every first push in the deployment.
    return remember({ kind: "fresh" });
  }
  const refuse = (
    kind: ResumeAdoption["kind"] & ("fresh" | "stand-down"),
    reason: string,
    detail: Record<string, unknown> = {},
  ): ResumeAdoption => {
    const key = `${channelId}:${reason}`;
    const now = Date.now();
    for (const [seen, at] of resumeRefusalLoggedAt) {
      if (now - at > RESUME_REFUSAL_LOG_THROTTLE_MS) {
        resumeRefusalLoggedAt.delete(seen);
      }
    }
    const previous = resumeRefusalLoggedAt.get(key);
    if (previous === undefined || now - previous >= RESUME_REFUSAL_LOG_THROTTLE_MS) {
      resumeRefusalLoggedAt.set(key, now);
      logEvent("voice.hlsResumeNotAdopted", {
        channelId,
        presenterPeerId,
        kind,
        reason,
        ...detail,
      });
    }
    return remember(
      kind === "fresh" ? { kind: "fresh" } : { kind: "stand-down", reason },
    );
  };

  // THE NEWEST SESSION, AND ONLY IT. `object_prefix` embeds the `startedAt`
  // every rung of one session shares, so a channel with rows from more than
  // one session (a previous start whose rows were never closed) is read as
  // the latest one plus stragglers, exactly as `liveHlsStreamFromDb` reads it.
  const parsed = rows.flatMap((row) => {
    const session = parseHlsObjectPrefix(row.object_prefix);
    return session
      ? [{ row, startedAt: session.startedAt, rung: row.rung ?? session.rung }]
      : [];
  });
  if (parsed.length === 0) {
    return refuse("fresh", "unparsable-prefix");
  }
  const startedAt = Math.max(...parsed.map((entry) => entry.startedAt));
  const session = parsed.filter((entry) => entry.startedAt === startedAt);
  if (session.some((entry) => entry.row.presenter_peer_id !== presenterPeerId)) {
    // A DIFFERENT PERSON IS PRESENTING NOW. A resume keeps its peer id, so a
    // mismatch here is a genuine handover and deserves its own session.
    return refuse("fresh", "presenter-changed", {
      startedAt,
      was: session[0]?.row.presenter_peer_id ?? null,
    });
  }

  const liveOthers = await liveOtherInstances();
  if (liveOthers === null) {
    return refuse("stand-down", "owner-lookup-failed", { startedAt });
  }
  const heldElsewhere = session.find((entry) =>
    ownedByLiveOtherInstance(entry.row.instance_id, liveOthers),
  );
  if (heldElsewhere) {
    // NOT OURS. The other machine is answering its heartbeat, so it still has
    // a monitor on these egresses; taking them would put two monitors on one
    // transcode, which is the failure `hls-ownership.ts` exists to stop.
    noteHlsSkippedOwnedElsewhere({
      site: "resume-adopt",
      channelId,
      sessionId: heldElsewhere.row.id,
      egressId: heldElsewhere.row.egress_id,
      ownerInstanceId: heldElsewhere.row.instance_id,
    });
    // AND THE CALLER STARTS NOTHING EITHER. A fresh ladder here would be
    // `endSupersededSessions` stopping a live machine's egresses, which is
    // exactly the failure `hls-ownership.ts` exists to stop, reached from a
    // different direction.
    return remember({ kind: "stand-down", reason: "owned-elsewhere" });
  }

  const active = await listActiveEgresses();
  if (active === null) {
    return refuse("stand-down", "list-egress-failed", { startedAt });
  }
  const listed = new Map(active.map((info) => [info.egressId, info]));
  const stillRunning = (row: OpenHlsSessionRow): boolean => {
    const info = row.egress_id ? listed.get(row.egress_id) : undefined;
    // The ROW already says which channel the egress belongs to; the listing
    // only has to confirm it is alive. A listing that states a DIFFERENT room
    // is a disagreement, not a confirmation, and is refused.
    return info !== undefined && (info.roomName ?? channelId) === channelId;
  };
  const running = session.filter((entry) => stillRunning(entry.row));
  const ladder = running.filter(
    (entry) => entry.rung !== MIC_ARCHIVE_RUNG && entry.rung !== CAMERA_RUNG_NAME,
  );
  if (ladder.length === 0) {
    // Nothing of the film is still being written. That is a genuine restart,
    // and the caller's `startRoom` is the right answer to it.
    return refuse("fresh", "no-live-rung", { startedAt, openRows: session.length });
  }
  // Lowest bitrate first, the order `adoptLiveHlsSession` builds the room in
  // and the order the master playlist lists. A rung name this build does not
  // know sorts last rather than guessing where it belongs.
  ladder.sort(
    (a, b) =>
      (hlsRungVideoKbps(a.rung ?? "") ?? Number.MAX_SAFE_INTEGER) -
      (hlsRungVideoKbps(b.rung ?? "") ?? Number.MAX_SAFE_INTEGER),
  );

  // THE CLAIM IS THE VERDICT, not a repair afterwards. Two machines can reach
  // this at the same moment during a rolling deploy — both reading an owner
  // whose heartbeat has lapsed — and only one may drive the session. The
  // heartbeat goes first for the reason `ensureHlsOwnerHeartbeat` states: a
  // claimant that cannot say it is alive is one the other machine is entitled
  // to take the row straight back from.
  if (!(await ensureHlsOwnerHeartbeat())) {
    return refuse("stand-down", "heartbeat-unavailable", { startedAt });
  }
  const primary = ladder[0]!;
  const claim = await claimHlsSessionRow(primary.row.id);
  if (claim !== "claimed") {
    // A CLAIM THIS PROCESS LOST IS NOT A RESTART. `refused` means the row was
    // taken by a machine that is answering, or ended under us between the read
    // and the write; `failed` means the write could not be issued at all.
    // Falling through to `startRoom` on either would have the loser of a
    // two-machine race mint a second ladder and supersede the winner's healthy
    // egresses, which is the incident this function exists to end.
    return refuse("stand-down", `claim-${claim}`, {
      startedAt,
      sessionId: primary.row.id,
    });
  }

  // THE RUNGS FIRST, THEN THE CAMERA, THEN THE ARCHIVE — the boot reconcile's
  // order, and for its reason: both siblings attach to a room that a ladder
  // rung creates rather than creating one themselves.
  for (const entry of ladder) {
    adoptLiveHlsSession({
      channelId,
      egressId: entry.row.egress_id!,
      startedAt,
      presenterPeerId,
      videoTrackId: entry.row.video_track_id ?? "",
      audioTrackId: entry.row.audio_track_id,
      rung: entry.rung,
    });
  }
  for (const entry of running) {
    if (entry.rung === CAMERA_RUNG_NAME) {
      adoptLiveHlsSession({
        channelId,
        egressId: entry.row.egress_id!,
        startedAt,
        presenterPeerId,
        videoTrackId: entry.row.video_track_id ?? "",
        audioTrackId: entry.row.audio_track_id,
        rung: CAMERA_RUNG_NAME,
      });
    }
  }
  for (const entry of running) {
    if (entry.rung === MIC_ARCHIVE_RUNG) {
      adoptLiveHlsMicArchive({
        channelId,
        egressId: entry.row.egress_id!,
        startedAt,
        trackId: entry.row.video_track_id ?? "",
      });
    }
  }
  const adoptedIds = new Set(running.map((entry) => entry.row.id));
  const rest = [...adoptedIds].filter((id) => id !== primary.row.id);
  if (rest.length > 0) {
    // The primary's claim decided the session; these are the repair shape,
    // which is what `claimHlsSessionRows` is for.
    await claimHlsSessionRows(rest);
  }

  // END WHAT IS PROVABLY FINISHED, AND STOP NOTHING.
  //
  // TWO DIFFERENT RULES, because "still listed by LiveKit" means opposite
  // things either side of the session line, and one rule for both left an old
  // session open for ever (a Farol finding on this PR).
  //
  //  - A ROW OF AN EARLIER SESSION is superseded by definition: this channel
  //    is serving `startedAt` now, so nothing will ever play that one again.
  //    It is ended whether or not a leftover egress is still writing to it,
  //    because otherwise retention can never collect its objects and the row
  //    sits open for the life of the deployment.
  //  - A ROW OF THIS SESSION is ended only when its egress is GONE: a rung
  //    that died is dropped from the master, and one that is still running is
  //    the film.
  //
  // In both cases the EGRESS is left alone. Stopping one is
  // `reapForeignEgresses` on the monitor's tick, which asks who owns an id
  // before it stops it, and which now runs for this channel because this
  // process holds the room. Doing it inline is what `endSupersededSessions`
  // does on a fresh start, and doing that across machines is the bug above.
  const finished = rows
    .filter((row) => !adoptedIds.has(row.id))
    .filter((row) => !ownedByLiveOtherInstance(row.instance_id, liveOthers))
    .filter((row) => {
      const parsedRow = parseHlsObjectPrefix(row.object_prefix);
      const olderSession = parsedRow === null || parsedRow.startedAt !== startedAt;
      return olderSession || !stillRunning(row);
    })
    .map((row) => row.id);
  if (finished.length > 0) {
    try {
      await getPool().query(
        `UPDATE hls_sessions SET ended_at = NOW()
          WHERE id = ANY($1::uuid[]) AND ended_at IS NULL`,
        [finished],
      );
    } catch (error) {
      logEvent("voice.hlsResumeStaleEndFailed", {
        channelId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  const stream = rooms.get(channelId)?.stream ?? null;
  // Not remembered in `resumeDecisionCache`: an adoption is answered once and
  // every later call short-circuits on `rooms.has(channelId)` above, so
  // caching it could only ever serve a stale stream to a channel this process
  // has since torn down.
  logEvent("voice.hlsSessionResumeAdopted", {
    channelId,
    presenterPeerId,
    startedAt,
    from: primary.row.instance_id,
    rungs: ladder.map((entry) => entry.rung),
    egressIds: running.map((entry) => entry.row.egress_id),
    sessionIds: [...adoptedIds],
    endedStale: finished.length,
  });
  return { kind: "adopted", stream };
}

function isTrackSource(source: unknown, wanted: TrackSource): boolean {
  return source === wanted || source === TrackSource[wanted];
}

/** The fields of a LiveKit `TrackInfo` this picker reads. */
export interface EgressCandidateTrack {
  source?: unknown;
  sid?: string;
  width?: number;
  height?: number;
  /** The publication's name. Only `mic-archive` means anything here. */
  name?: unknown;
}

export interface EgressCandidateParticipant {
  identity?: string;
  tracks?: readonly EgressCandidateTrack[];
}

/**
 * WHICH TWO TRACKS THE TRANSCODE IS BOUND TO. Exported because this is the
 * whole of what the HLS audience receives, and until it was pulled out of
 * `defaultFindTracks` no test could reach it: every case in
 * `hls-egress.test.ts` injects `findTracks`, so the real selection ran only in
 * production.
 *
 * A Track Composite egress takes ONE video sid and ONE audio sid
 * (`TrackCompositeEgressRequest` has singular fields, not repeated ones), so
 * this is a choice and not a mix. It picks the screen share and that same
 * share's own audio. **No microphone and no camera reaches the HLS audience**,
 * whatever the seated room can hear; `docs/WATCH_PARTY.md`, "What the stream
 * carries", is the product statement of that and
 * `docs/plans/WATCH_PARTY_STREAM_AUDIO.md` is what it would cost to change.
 *
 * PER PARTICIPANT, which the first version was not. It scanned every
 * participant's tracks into two variables, so with two people sharing at once
 * (two holders of START_WATCH_PARTY, which a party with co-hosts has) the
 * video could come from one and the audio from the other, in whatever order
 * `listParticipants` happened to answer. Now one participant supplies both or
 * the audio is dropped.
 *
 * `presenterIdentity` is the peer id `reconcileLiveHls` already decided to
 * follow, and LiveKit identities are peer ids, so it is the right sharer by
 * construction rather than the first one found. A presenter who is not in the
 * answer yet (the listing races the publish) falls back to any sharer, which
 * is the old behaviour and never worse than it.
 */
export function pickScreenTracks(
  participants: readonly EgressCandidateParticipant[],
  presenterIdentity?: string,
): LiveHlsScreenTracks | null {
  const sharers = participants.filter((participant) =>
    (participant.tracks ?? []).some(
      (track) => isTrackSource(track.source, TrackSource.SCREEN_SHARE) && track.sid,
    ),
  );
  const sharer =
    sharers.find((participant) => participant.identity === presenterIdentity) ??
    sharers[0];
  if (!sharer) {
    return null;
  }
  let videoTrackId: string | undefined;
  let audioTrackId: string | undefined;
  let sourceHeight: number | undefined;
  let micArchiveTrackId: string | undefined;
  let cameraTrackId: string | undefined;
  let voiceTrackId: string | undefined;
  let stageMixTrackId: string | undefined;
  for (const track of sharer.tracks ?? []) {
    if (!track.sid) {
      continue;
    }
    if (isTrackSource(track.source, TrackSource.SCREEN_SHARE)) {
      videoTrackId ??= track.sid;
      if (typeof track.height === "number" && track.height > 0) {
        sourceHeight ??= track.height;
      }
    }
    if (isTrackSource(track.source, TrackSource.SCREEN_SHARE_AUDIO)) {
      audioTrackId ??= track.sid;
    }
    // BY NAME, NOT BY SOURCE, and the source is deliberately not checked:
    // this publication is a MICROPHONE (pitfall 14 — a grant is an allowlist
    // of sources and an invented one is refused), so the source says nothing
    // that tells it from the host's ordinary mic. The name is the only thing
    // that does, and it is the same string the browser publishes under.
    if (track.name === MIC_ARCHIVE_TRACK_NAME) {
      micArchiveTrackId ??= track.sid;
    }
    // THE SAME PARTICIPANT'S CAMERA, in the same pass. A second
    // `listParticipants` on the reconcile path would double an RPC that runs
    // on every roster event to learn something this answer already carried.
    // The sharer's, never anybody else's: a second person's webcam is a second
    // transcode, which is the capacity conversation this feature defers.
    if (isTrackSource(track.source, TrackSource.CAMERA)) {
      cameraTrackId ??= track.sid;
    }
    // BY NAME, LIKE THE ARCHIVE, AND FOR A SECOND REASON ON TOP OF PITFALL
    // 14: the sharer's ORDINARY microphone (source `Microphone`, no special
    // name) exists whether or not "separada" is chosen, so picking it up
    // by source alone would attach it regardless of the host's actual mode
    // — see `VOICE_TRACK_NAME`'s doc for the bug that shape caused.
    if (track.name === VOICE_TRACK_NAME) {
      voiceTrackId ??= track.sid;
    }
    // CONVIDADOS: the same by-name rule, one more name. When both exist
    // (should never happen — the client publishes one or the other, never
    // both, see `STAGE_MIX_TRACK_NAME`'s doc) `stageMixTrackId` wins below,
    // which is the side that carries every guest rather than the presenter
    // alone.
    if (track.name === STAGE_MIX_TRACK_NAME) {
      stageMixTrackId ??= track.sid;
    }
  }
  return videoTrackId
    ? {
        videoTrackId,
        audioTrackId,
        ...(sourceHeight ? { sourceHeight } : {}),
        ...(micArchiveTrackId ? { micArchiveTrackId } : {}),
        ...(cameraTrackId ? { cameraTrackId } : {}),
        ...(stageMixTrackId || voiceTrackId
          ? { voiceTrackId: stageMixTrackId ?? voiceTrackId }
          : {}),
      }
    : null;
}

async function defaultFindTracks(
  roomName: string,
  logInventory: boolean,
  presenterIdentity?: string,
): Promise<LiveHlsScreenTracks | null> {
  if (!isLiveKitConfigured()) {
    return null;
  }
  const client = new RoomServiceClient(
    process.env.LIVEKIT_URL!,
    process.env.LIVEKIT_API_KEY,
    process.env.LIVEKIT_API_SECRET,
  );
  const participants = await client.listParticipants(roomName);
  const picked = pickScreenTracks(participants, presenterIdentity);
  if (!picked && logInventory) {
    logEvent("voice.hlsTrackInventory", {
      room: roomName,
      participants: participants.length,
      tracks: participants.flatMap((participant) =>
        participant.tracks.map((track) => ({
          source: track.source,
          sid: track.sid,
          name: track.name,
        })),
      ),
    });
  }
  return picked;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/** Tests skip the public GET; production waits so joiners are not handed a 404. */
async function waitForLivePlaylist(url: string): Promise<boolean> {
  if (injectedEgress) {
    return injectedPlaylistReady;
  }
  for (let attempt = 0; attempt < PLAYLIST_WAIT_ATTEMPTS; attempt += 1) {
    try {
      const response = await fetch(url, { cache: "no-store" });
      if (response.ok && playlistLooksLive(await response.text())) {
        return true;
      }
    } catch (error) {
      if (attempt + 1 === PLAYLIST_WAIT_ATTEMPTS) {
        logEvent("voice.hlsPlaylistPollFailed", {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    if (attempt + 1 < PLAYLIST_WAIT_ATTEMPTS) {
      await sleep(PLAYLIST_WAIT_GAP_MS);
    }
  }
  return false;
}

async function findScreenTracks(
  roomName: string,
  presenterIdentity?: string,
): Promise<LiveHlsScreenTracks | null> {
  if (injectedFinder) {
    return injectedFinder(roomName);
  }
  for (let attempt = 0; attempt < TRACK_FIND_ATTEMPTS; attempt += 1) {
    try {
      const last = attempt + 1 === TRACK_FIND_ATTEMPTS;
      const tracks = await defaultFindTracks(roomName, last, presenterIdentity);
      if (tracks) {
        return tracks;
      }
    } catch (error) {
      logEvent("voice.hlsTrackFindFailed", {
        room: roomName,
        attempt,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    if (attempt + 1 < TRACK_FIND_ATTEMPTS) {
      await sleep(TRACK_FIND_GAP_MS);
    }
  }
  return null;
}

/**
 * One look at the SFU, no retries: this runs while a share is already up,
 * so an empty answer means "cannot tell right now", not "not sharing yet".
 */
async function probeScreenTracks(
  roomName: string,
  presenterIdentity?: string,
): Promise<LiveHlsScreenTracks | null> {
  try {
    if (injectedFinder) {
      return await injectedFinder(roomName);
    }
    return await defaultFindTracks(roomName, false, presenterIdentity);
  } catch (error) {
    logEvent("voice.hlsTrackProbeFailed", {
      room: roomName,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

/** How long this process's own presigned read of the playlist is valid. */
const INTERNAL_PLAYLIST_TTL_SECONDS = 60;

/**
 * The URL THIS PROCESS fetches the live playlist from: the readiness probe
 * after egress starts, and the playlist proxy's own read. Always a presigned
 * GET in endpoint form (never the custom domain), so it works against a
 * fully private bucket and needs no `LIVE_HLS_PUBLIC_BASE_URL`. Production
 * runs exactly that: signed mode, `pqp-live` private, no public base.
 */
export function internalPlaylistUrl(
  channelId: string,
  startedAt: number,
  rung?: string,
): string {
  const config = liveHlsStorageConfig();
  if (!config) {
    return rawPlaylistUrl(channelId, startedAt, rung);
  }
  return signRequest({
    method: "GET",
    key: `${hlsObjectPrefix(channelId, startedAt, rung)}.m3u8`,
    ttlSeconds: INTERNAL_PLAYLIST_TTL_SECONDS,
    forRead: false,
    config,
  }).url;
}

/**
 * Can this process reach the live-HLS bucket, with credentials it is allowed
 * to use? For `/ready`.
 *
 * WHY IT IS NOT COVERED BY THE EXISTING `storage` CHECK. That one probes the
 * ATTACHMENT bucket (`S3_*`). Live HLS deliberately uses a second, separate
 * set (`LIVE_HLS_S3_*`) with its own bucket and its own key pair, so
 * `storage: ok` says nothing whatsoever about whether a watch party can
 * write a segment. Production had `LIVE_HLS_S3_*` deployed and `/ready`
 * green for a week without either fact implying the other.
 *
 * A 404 is a PASS: the key cannot exist, and answering "not found" with a
 * valid signature is exactly the proof wanted — the endpoint resolves, the
 * bucket is there, and the credentials are accepted. Only a transport
 * failure or a non-404 error status is a failure. Same trick as the
 * attachment probe and the status page.
 */
const LIVE_HLS_PROBE_KEY = "__ready_probe__/does-not-exist";

export async function probeLiveHlsStorage(): Promise<void> {
  const config = liveHlsStorageConfig();
  if (!config) {
    throw new Error("live HLS storage is not configured");
  }
  const url = signRequest({
    method: "HEAD",
    key: LIVE_HLS_PROBE_KEY,
    ttlSeconds: 60,
    forRead: false,
    config,
  }).url;
  const response = await fetch(url, {
    method: "HEAD",
    signal: AbortSignal.timeout(5_000),
  });
  if (response.status === 404 || response.ok) {
    return;
  }
  // 403 here is the one worth having: the bucket answers and the key pair is
  // wrong or has lost its grant, which is invisible until a party starts.
  throw new Error(`live HLS storage answered HTTP ${response.status}`);
}

/**
 * The raw public bucket URL. Only meaningful with `LIVE_HLS_SIGNED_URLS=false`
 * and a public base, where it is what a viewer is handed. Nothing internal
 * reads it any more (`internalPlaylistUrl` does that), so with the default
 * signed mode this is never called.
 *
 * LiveKit treats filenamePrefix as a file prefix, not a directory. Segments
 * land at live/{channel}/{startedAt}_00000.ts; a reused live.m3u8 keeps the
 * previous share's #EXT-X-ENDLIST until overwrite, so each share gets its
 * own playlist name.
 */
export function rawPlaylistUrl(
  channelId: string,
  startedAt: number,
  rung?: string,
): string {
  return `${publicBaseUrl()}/${hlsObjectPrefix(channelId, startedAt, rung)}.m3u8`;
}

/**
 * What a viewer is actually handed as `LiveHlsStream.hlsUrl`.
 *
 * `startedAt` rides in the signed path (not just the sibling `startedAt`
 * field) so this string changes every time a session restarts -- the same
 * reason each session already gets its own playlist name on the raw bucket
 * URL: `reconcileLiveHls`'s track-replace restart needs viewers to reload,
 * and a stable per-channel URL would not carry that signal on its own.
 */
export function viewerPlaylistUrl(channelId: string, startedAt: number): string {
  if (!hlsSignedUrlsEnabled()) {
    return rawPlaylistUrl(channelId, startedAt);
  }
  // API-relative: the client prefixes this with its own API base URL and
  // (for hls.js) attaches its Bearer token via xhrSetup. See
  // `hls-playlist-proxy.ts` for the proxy that answers this route.
  //
  // NOT edge-prefixed here, even when `LIVE_HLS_PLAYLIST_BASE_URL` is set.
  // This value is the CHANNEL-WIDE stream (`liveHlsStreamFor`), built once
  // and shared by every viewer; the `?t=` token is stamped per RECIPIENT,
  // later, by `stampViewerStream` in `hls-viewer-token.ts`, which is also
  // where the edge host gets prepended -- AFTER the token, not before. A
  // token-less absolute URL handed straight to the edge Worker would 401
  // "missing" on every request: the Worker only ever reads `?t=`, and
  // `stampViewerStream`'s own "is this already absolute" check (the one that
  // correctly leaves a raw, unsigned bucket URL alone) would otherwise treat
  // an edge-prefixed-but-unstamped URL the same way and skip minting a token
  // for it entirely. See `stampViewerStream`'s doc comment.
  return `/api/voice/hls-playlist/${channelId}/${startedAt}`;
}

/**
 * The camera's playlist, as a viewer is handed it.
 *
 * SAME SIGNED/UNSIGNED SPLIT AS `viewerPlaylistUrl`, and it has to be: a
 * deployment running `LIVE_HLS_SIGNED_URLS=false` is a supported
 * configuration, not a degraded one, and it must not lose the camera on top
 * of losing signing. The signed branch is the rung path the playlist proxy
 * serves, authorised by the same `?t=` token as the film; the unsigned branch
 * is the raw bucket URL for this rendition (`rawPlaylistUrl` already takes a
 * rung), the same shape every ladder rung already gets unsigned.
 */
function cameraPlaylistUrl(channelId: string, startedAt: number): string {
  if (!hlsSignedUrlsEnabled()) {
    return rawPlaylistUrl(channelId, startedAt, CAMERA_RUNG_NAME);
  }
  // Not edge-prefixed here either -- same reasoning as `viewerPlaylistUrl`.
  return `/api/voice/hls-playlist/${channelId}/${startedAt}/${CAMERA_RUNG_NAME}`;
}

/**
 * The same stream, now advertising the camera/voice slot.
 *
 * `hasVideo`/`hasVoiceAudio` default to the pre-2026-09-13 shape (a picture,
 * no sound) so every caller that has not been taught about
 * `LIVE_HLS_VOICE_TRACK` keeps behaving exactly as it always did.
 */
function withCameraUrl(
  stream: LiveHlsStream,
  channelId: string,
  shape: { hasVideo: boolean; hasVoiceAudio: boolean } = {
    hasVideo: true,
    hasVoiceAudio: false,
  },
): LiveHlsStream {
  return {
    ...stream,
    cameraHlsUrl: cameraPlaylistUrl(channelId, stream.startedAt),
    cameraHasVideo: shape.hasVideo,
    cameraHasVoiceAudio: shape.hasVoiceAudio,
  };
}

/** The same stream with the camera/voice slot gone. Deleted, not falsed. */
function withoutCameraUrl(stream: LiveHlsStream): LiveHlsStream {
  if (stream.cameraHlsUrl === undefined) {
    return stream;
  }
  const {
    cameraHlsUrl: _dropped,
    cameraHasVideo: _droppedVideo,
    cameraHasVoiceAudio: _droppedAudio,
    ...rest
  } = stream;
  return rest;
}

function segmentOutput(
  prefix: string,
  startedAt: number,
  rung: string,
): SegmentedFileOutput {
  const storage = liveHlsStorage()!;
  // LiveKit resolves both playlist names against the DIRECTORY of
  // `filenamePrefix`, so the rung has to be repeated in the names or every
  // rendition would overwrite the same two playlist objects.
  return new SegmentedFileOutput({
    filenamePrefix: prefix,
    playlistName: `${startedAt}-${rung}-index.m3u8`,
    livePlaylistName: `${startedAt}-${rung}.m3u8`,
    segmentDuration: hlsSegmentSeconds(),
    output: {
      case: "s3",
      value: new S3Upload({
        accessKey: storage.accessKey,
        secret: storage.secret,
        bucket: storage.bucket,
        region: storage.region,
        endpoint: storage.endpoint,
        forcePathStyle: storage.forcePathStyle,
      }),
    },
  });
}

/**
 * One camera run's names. The first run of a session keeps the names the
 * camera always had (`<startedAt>-cam360p30_NNNNN.ts`,
 * `<startedAt>-cam360p30-index.m3u8`), so everything written before runs had
 * names still reads the same way. Every later run adds `-r<its own start,
 * epoch ms>` after the rung: `<startedAt>-cam360p30-r1790190732000_00000.ts`
 * and its own `-index.m3u8`. Epoch ms rather than a counter so a run started
 * by a process that restarted mid-show (and remembers nothing) can never pick
 * a name an earlier run used.
 *
 * All of them still start with the session row's `object_prefix`
 * (`live/<channel>/<startedAt>-cam360p30`), which is what the retention sweep
 * lists and deletes and what `keep_replay` keeps: every run is covered by the
 * one row, as before. The LIVE playlist name is the same for every run on
 * purpose: viewers follow one URL, and it should always be the current run.
 */
export function cameraRunNames(
  channelId: string,
  startedAt: number,
  runSuffix: string,
): { filenamePrefix: string; playlistName: string; livePlaylistName: string } {
  const rung = `${CAMERA_RUNG_NAME}${runSuffix}`;
  return {
    filenamePrefix: hlsObjectPrefix(channelId, startedAt, rung),
    playlistName: `${startedAt}-${rung}-index.m3u8`,
    livePlaylistName: `${startedAt}-${CAMERA_RUNG_NAME}.m3u8`,
  };
}

/** Per channel, the session whose first camera run this process started. */
const cameraRunSuffix = new Map<string, number>();

/**
 * "" for the first run this process starts for a session it opened itself,
 * "-r<now>" for every other. A process that inherited a running session (an
 * API restart mid-show) cannot know whether a first run already happened, so
 * it always suffixes: a first run with a suffix reads back exactly as well,
 * and the alternative is overwriting.
 */
function nextCameraRunSuffix(channelId: string, startedAt: number): string {
  const seen = cameraRunSuffix.get(channelId);
  cameraRunSuffix.set(channelId, startedAt);
  const room = companionHost(channelId);
  const openedHere =
    room !== undefined && Math.abs(room.startedAtMs - startedAt) < 60_000;
  if (seen !== startedAt && openedHere) {
    return "";
  }
  return `-r${Date.now()}`;
}

function cameraSegmentOutput(
  channelId: string,
  startedAt: number,
  runSuffix: string,
): SegmentedFileOutput {
  const names = cameraRunNames(channelId, startedAt, runSuffix);
  const storage = liveHlsStorage()!;
  return new SegmentedFileOutput({
    filenamePrefix: names.filenamePrefix,
    playlistName: names.playlistName,
    livePlaylistName: names.livePlaylistName,
    segmentDuration: hlsSegmentSeconds(),
    output: {
      case: "s3",
      value: new S3Upload({
        accessKey: storage.accessKey,
        secret: storage.secret,
        bucket: storage.bucket,
        region: storage.region,
        endpoint: storage.endpoint,
        forcePathStyle: storage.forcePathStyle,
      }),
    },
  });
}

/**
 * The rung name the archive's retention row carries.
 *
 * It is a rung in the `hls_sessions` sense (one row, one `object_prefix`, one
 * `egress_id`, swept and kept by exactly the same rules as a rendition) and it
 * is deliberately NOT a name in `LADDER_RUNGS`. That is what keeps it off the
 * master playlist and out of the keep-warm loop for free: `sessionRungs` in
 * `hls-playlist-proxy.ts` already filters the rows to rungs this build knows,
 * so a viewer never sees a variant pointing at an audio file, and nothing
 * polls it. `keep_replay` and the retention sweep, meanwhile, work on the
 * prefix and know nothing about ladders, so the archive is kept or deleted
 * with the session it belongs to and no code there changes.
 */
export const MIC_ARCHIVE_RUNG = "mic";

/**
 * Where the host's voice lands: `live/<channelId>/<startedAt>-mic.ogg`.
 *
 * **OGG because the muxer is chosen by the extension.** A Track Egress does
 * not transcode; it remuxes the published track, which for us is Opus, and
 * LiveKit writes Opus into an OGG container. Asking for `.mp4` here would
 * either fail or silently produce something no editor opens.
 *
 * The `.ogg` is INSIDE the session prefix (`...-mic` is the prefix, `.ogg` the
 * suffix), which is what makes the retention sweep's prefix listing find it.
 */
export function micArchiveObjectKey(
  channelId: string,
  startedAt: number,
): string {
  return `${hlsObjectPrefix(channelId, startedAt, MIC_ARCHIVE_RUNG)}.ogg`;
}

function micArchiveOutput(channelId: string, startedAt: number): DirectFileOutput {
  const storage = liveHlsStorage()!;
  return new DirectFileOutput({
    filepath: micArchiveObjectKey(channelId, startedAt),
    output: {
      case: "s3",
      value: new S3Upload({
        accessKey: storage.accessKey,
        secret: storage.secret,
        bucket: storage.bucket,
        region: storage.region,
        endpoint: storage.endpoint,
        forcePathStyle: storage.forcePathStyle,
      }),
    },
  });
}

/**
 * Start the archive for a session that has just found its `mic-archive`
 * track. Failure is never fatal: the party is the segments, and a party that
 * refused to start because a side recording could not is a worse product than
 * one that plays with no recording.
 */
async function startMicArchive(
  egress: LiveHlsEgressApi,
  channelId: string,
  room: RoomHls,
  trackId: string,
): Promise<void> {
  if (!egress.startTrackEgress || room.micArchive) {
    return;
  }
  const startedAt = room.stream.startedAt;
  let egressId: string;
  try {
    const started = await egress.startTrackEgress(
      channelId,
      micArchiveOutput(channelId, startedAt),
      trackId,
    );
    egressId = started.egressId;
  } catch (error) {
    logEvent("voice.hlsMicArchiveFailed", {
      channelId,
      startedAt,
      trackId,
      error: error instanceof Error ? error.message : String(error),
    });
    // No retry budget of its own: the deadline below is still open, so the
    // next monitor tick tries again until it closes.
    return;
  }
  // The room may have been replaced while LiveKit was answering. Stop what we
  // just started rather than filing it on a session nobody owns any more.
  if (companionHost(channelId) !== room) {
    await stopEgressById(egressId, channelId);
    return;
  }
  // Set synchronously, before the write below, so a second call landing
  // during that await sees `room.micArchive` already taken and refuses
  // rather than starting a duplicate egress on the same track.
  room.micArchive = { egressId, trackId, sessionId: null };
  room.micArchiveUntil = 0;
  const { sessionId } = await recordSessionStarted(
    channelId,
    startedAt,
    egressId,
    MIC_ARCHIVE_RUNG,
    room.stream.presenterPeerId,
    room.videoTrackId,
  );
  if (room.micArchive && room.micArchive.egressId === egressId) {
    room.micArchive.sessionId = sessionId;
  }
  logEvent("voice.hlsMicArchiveStarted", {
    channelId,
    startedAt,
    egressId,
    trackId,
    sessionId,
    key: micArchiveObjectKey(channelId, startedAt),
  });
}

/**
 * Stop the archive and close its row. `reason` is not optional here for the
 * same reason it is not on `stopRoom`: three callers that log nothing is how
 * pitfall 15 stayed invisible for a week.
 */
async function stopMicArchive(
  channelId: string,
  room: RoomHls,
  reason: string,
  { stopEgress = true }: { stopEgress?: boolean } = {},
): Promise<void> {
  const archive = room.micArchive;
  if (!archive) {
    return;
  }
  room.micArchive = null;
  room.micArchiveUntil = 0;
  logEvent("voice.hlsMicArchiveStopped", {
    channelId,
    startedAt: room.stream.startedAt,
    egressId: archive.egressId,
    sessionId: archive.sessionId,
    reason,
  });
  if (stopEgress) {
    const egress = getEgress();
    if (egress) {
      try {
        await egress.stopEgress(archive.egressId);
      } catch (error) {
        logEvent(
          egressAlreadyStopped(error)
            ? "voice.hlsStopNoop"
            : "voice.hlsStopFailed",
          {
            channelId,
            egressId: archive.egressId,
            rung: MIC_ARCHIVE_RUNG,
            error: error instanceof Error ? error.message : String(error),
          },
        );
      }
    }
  }
  await recordSessionEnded(channelId, room.stream.startedAt, MIC_ARCHIVE_RUNG);
}

/**
 * One monitor pass for the archive: start it when the track finally shows up,
 * notice when it has ended, and stop it when the flag went off underneath.
 *
 * The late arrival is the normal case, not an edge: the browser publishes the
 * second track only once the mix is running, which is after the share is up,
 * which is what starts the session. So the first look almost always misses it
 * and the tick a few seconds later finds it.
 */
async function tendMicArchive(
  egress: LiveHlsEgressApi,
  channelId: string,
  room: RoomHls,
  now: number,
): Promise<void> {
  if (!micArchiveEnabled()) {
    // Turned off mid-party. Stop the recording; leave the party alone.
    await stopMicArchive(channelId, room, "disabled");
    return;
  }
  if (room.micArchive) {
    if (!egress.listEgress) {
      return;
    }
    let health: EgressHealth = "unknown";
    try {
      const listing = await egress.listEgress({
        egressId: room.micArchive.egressId,
      });
      health = healthFromListing(room.micArchive.egressId, listing);
    } catch (error) {
      logEvent("voice.hlsMicArchiveHealthFailed", {
        channelId,
        egressId: room.micArchive.egressId,
        error: error instanceof Error ? error.message : String(error),
      });
      return;
    }
    if (health === "ended") {
      // LiveKit says it is over, so there is nothing to stop: asking would
      // only log a failure about an egress that finished. The row is closed
      // so retention collects whatever was written.
      await stopMicArchive(channelId, room, "egress-ended", {
        stopEgress: false,
      });
    }
    return;
  }
  if (now >= room.micArchiveUntil) {
    return;
  }
  const tracks = await probeScreenTracks(channelId, room.stream.presenterPeerId);
  if (!tracks?.micArchiveTrackId || companionHost(channelId) !== room) {
    return;
  }
  await startMicArchive(egress, channelId, room, tracks.micArchiveTrackId);
}

/**
 * Stop these renditions' egresses, tolerating one that is already gone.
 *
 * ONE LAST OWNERSHIP CHECK, cheap and defensive. Every entry here came out of
 * this process's own `rooms` map, so it is ours by construction -- unless the
 * other machine restarted the session under us between our adoption and this
 * teardown, in which case stopping it hangs up a stream that has a live owner.
 * A lookup that fails falls back to stopping: an egress we believe is ours and
 * do not stop is pitfall 15's leaked handler, which is the worse of the two.
 */
/**
 * Resolves to the egress ids LiveKit confirmed are stopped (the stop landed,
 * or it said they had already finished). Anything else passed in may still be
 * running: deferred, owned elsewhere, or a stop that failed.
 */
async function stopRungs(
  channelId: string,
  entries: readonly RunningRung[],
): Promise<Set<string>> {
  const stopped = new Set<string>();
  const egress = getEgress();
  if (!egress) {
    return stopped;
  }
  const ownedElsewhere = await sessionIdsOwnedElsewhere(
    entries.map((entry) => entry.sessionId),
  );
  // THE ROWS ARE FINISHED, SO THEIR QUEUED STAMPS ARE TOO. A claim that failed
  // moments ago still carries `reopen`, and replaying it after this teardown
  // would clear the `ended_at` that retention needs.
  forgetPendingHlsSessionClaims(entries.map((entry) => entry.sessionId));
  // PARALLEL, NOT A FOR-AWAIT LOOP. Each `stopEgress` is its own bounded RPC
  // (`EGRESS_REQUEST_TIMEOUT_SECONDS`), and a ladder is 1-3 rungs: stopping
  // them one at a time meant a 3-rung stop cost up to 3x one call's worst
  // case, entirely inside a channel's serialised `reconcileQueue`, so the
  // NEXT reconcile for that channel (a restart, a presenter switching) queued
  // behind all of it. `stopped` / `deferredStops` are mutated from async
  // callbacks that never themselves await concurrently with each other
  // mid-mutation (JS has no preemption between awaits), so this is safe with
  // no lock.
  await Promise.all(
    entries.map(async (entry) => {
      if (ownedElsewhere === null && entry.sessionId) {
        // COULD NOT ASK IS NOT PERMISSION, HERE EITHER. Stopping on a failed
        // lookup is how one machine hangs up the other machine's stream during
        // an ordinary database blip. But a handler we never stop is pitfall 15's
        // leak, and this room is about to leave `rooms`, so nothing else would
        // ever look at it again: the id is parked and the monitor tick retries
        // it until ownership is knowable.
        deferredStops.set(entry.egressId, {
          channelId,
          sessionId: entry.sessionId,
          rung: entry.rung.name,
          queuedAt: Date.now(),
          attempts: 0,
        });
        // COALESCED PER EGRESS ID ALREADY: the queue is a Map keyed by it, so a
        // room torn down twice is one entry, not two. Past the cap the oldest
        // entry is given up on -- memory has to be bounded somewhere -- but it
        // is given up on LOUDLY, under its own event, because what is being
        // dropped is a transcode that may still be running on the media box and
        // now has nothing tracking it. `voice.hlsStopAbandoned` is the line to
        // alert on: unlike the attempt cap, nothing here has even been tried.
        while (deferredStops.size > DEFERRED_STOP_MAX_ENTRIES) {
          const [oldest] = deferredStops.keys();
          if (!oldest) {
            break;
          }
          const dropped = deferredStops.get(oldest);
          deferredStops.delete(oldest);
          logEvent("voice.hlsStopAbandoned", {
            channelId: dropped?.channelId ?? null,
            egressId: oldest,
            sessionId: dropped?.sessionId ?? null,
            rung: dropped?.rung ?? null,
            attempts: dropped?.attempts ?? 0,
            reason: "queue-full",
            queued: deferredStops.size,
          });
        }
        logEvent("voice.hlsStopDeferred", {
          channelId,
          egressId: entry.egressId,
          sessionId: entry.sessionId,
          rung: entry.rung.name,
          reason: "owner-lookup-failed",
          pending: deferredStops.size,
        });
        return;
      }
      if (entry.sessionId && ownedElsewhere?.has(entry.sessionId)) {
        noteHlsSkippedOwnedElsewhere({
          site: "stop-rungs",
          channelId,
          egressId: entry.egressId,
          sessionId: entry.sessionId,
        });
        return;
      }
      deferredStops.delete(entry.egressId);
      try {
        await egress.stopEgress(entry.egressId);
        stopped.add(entry.egressId);
      } catch (error) {
        if (egressAlreadyStopped(error)) {
          stopped.add(entry.egressId);
        }
        // An egress LiveKit says has already finished is not a failed stop: see
        // `egressAlreadyStopped`. Three of these on one ordinary teardown is
        // what 2026-09-17's log opened with, and every one of them was fine.
        logEvent(
          egressAlreadyStopped(error)
            ? "voice.hlsStopNoop"
            : "voice.hlsStopFailed",
          {
            channelId,
            egressId: entry.egressId,
            sessionId: entry.sessionId,
            rung: entry.rung.name,
            error: error instanceof Error ? error.message : String(error),
          },
        );
      }
    }),
  );
  return stopped;
}

/**
 * `reason` IS NOT OPTIONAL, and that is the whole point of it.
 *
 * A live party on 2026-09-09 produced two `voice.hlsStarted` nine minutes
 * apart for one channel, same presenter, with **not one line between them**,
 * because three of this function's five callers logged nothing and the fourth
 * logged only in a branch the third one pre-empted. An operator reading that
 * log cannot tell a host re-picking their share from a transcode dying, and
 * those two want completely different responses during an event.
 *
 * The stop is now always narrated, and `voice.hlsStopped` is the one line to
 * grep for when a stream restarted and nobody knows why.
 */
async function stopRoom(channelId: string, reason: string): Promise<void> {
  const current = rooms.get(channelId);
  if (!current) {
    return;
  }
  rooms.delete(channelId);
  clearCameraCooldown(channelId);
  voiceTrackSeparatedByChannel.delete(channelId);
  clearCameraProbeRetry(channelId);
  hlsStopsTotal += 1;
  logEvent("voice.hlsStopped", {
    channelId,
    reason,
    presenterPeerId: current.stream.presenterPeerId,
    startedAt: current.stream.startedAt,
    egressIds: current.rungs.map((entry) => entry.egressId),
    sessionIds: current.rungs.map((entry) => entry.sessionId),
    cameraEgressId: current.camera?.egressId ?? null,
    cameraSessionId: current.camera?.sessionId ?? null,
  });
  // BEFORE the rungs, and unconditionally: the archive is an egress on the
  // media box like any other, and a session torn down without stopping it
  // leaves a handler writing to a file whose row has just been closed for
  // retention — the exact shape of pitfall 15, one flag later.
  await stopMicArchive(channelId, current, reason);
  await recordSessionEnded(channelId, current.stream.startedAt);
  // The camera with the rungs, in the same call. `recordSessionEnded` with no
  // rung already ended its row; an egress whose row says ended and which is
  // still transcoding is the exact orphan shape this file keeps paying for.
  await stopRungs(channelId, [
    ...current.rungs,
    ...(current.camera ? [current.camera] : []),
  ]);
}

/**
 * Ask LiveKit for one rendition. Returns the egress id, or null when the
 * request itself failed (the caller decides whether that is fatal: it is for
 * the primary rung, and merely a shorter ladder for the rest).
 */
async function startRung(
  egress: LiveHlsEgressApi,
  channelId: string,
  startedAt: number,
  tracks: LiveHlsScreenTracks,
  rung: LadderRung,
): Promise<string | null> {
  try {
    const started = await egress.startTrackCompositeEgress(
      channelId,
      segmentOutput(
        hlsObjectPrefix(channelId, startedAt, rung.name),
        startedAt,
        rung.name,
      ),
      {
        videoTrackId: tracks.videoTrackId,
        audioTrackId: tracks.audioTrackId,
        encodingOptions: rungEncodingOptions(rung),
      },
    );
    return started.egressId;
  } catch (error) {
    logEvent("voice.hlsRungStartFailed", {
      channelId,
      rung: rung.name,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

/**
 * The presenter's camera, reconciled against the session already running.
 *
 * FOUR CASES, AND THE SESSION IS NEVER RESTARTED FOR ANY OF THEM. A new
 * `startedAt` is a new playlist path, a new viewer token and a new master, so
 * every viewer re-attaches and rebuffers; turning a webcam on or off must
 * cost an audience nothing. So this only ever adds or removes one egress
 * beside the ladder, and the only thing a viewer sees is `cameraHlsUrl`
 * appearing or disappearing on a frame they were already being sent.
 *
 *  - no camera published, none running: nothing.
 *  - a camera published, none running: start one, if the box can carry it.
 *  - no camera published, one running: stop it.
 *  - a camera published on a DIFFERENT sid (a device switch, a republish, a
 *    reconnect): stop and start. A Track Composite egress is bound to one sid
 *    and goes on running against a dead one, writing nothing — the same
 *    failure `videoTrackId` on the room exists to catch for the share.
 *
 * `cameraTrackId` is `null` for "the presenter has no camera" and for "we
 * could not ask", and the caller is what tells those apart: it passes null
 * only when it actually looked. A probe that failed returns before reaching
 * here, so a momentary LiveKit hiccup never tears the camera down.
 */
/**
 * Whether the camera egress this call is about to advertise (or has just
 * started) is still the one this room actually wants, re-checked after every
 * await in `reconcileCameraEgress` that can itself take real time or fail
 * (the LiveKit start call, the session-row write).
 *
 * THE PER-CHANNEL QUEUE (`reconcileLiveHls`) is what stops two RECONCILES for
 * the same channel from running this function concurrently — but the health
 * monitor is a separate timer, not a queued reconcile, and it directly clears
 * `room.camera` when a camera dies. This is the belt to that brace: room and
 * film-session identity alone (the old check) would still let a camera
 * disabled mid-write, or a slot something else has since claimed, be
 * resurrected or clobbered.
 *
 *  - room/session identity: unchanged from before.
 *  - `liveHlsCameraEnabled()`: the operator's rollback switch, re-read rather
 *    than trusted from when this call started.
 *  - `room.camera === null`: by the time either checkpoint below runs, THIS
 *    call has not set it yet, so anything else already sitting there means
 *    another attempt won the slot first and this one must back off rather
 *    than overwrite it.
 */
function cameraStillWanted(
  channelId: string,
  room: RoomHls,
  startedAt: number,
  // WHICH FLAG GOVERNS THIS ATTEMPT, and only that one: an audio-only
  // ("separada", no camera) start must not be judged against
  // `LIVE_HLS_CAMERA`, or a deployment with the camera off but the voice
  // track on would start the egress and immediately stop it again — a
  // presenter with no webcam could never use "separada" at all. Symmetric
  // the other way: a camera+voice attempt needs BOTH flags still on.
  shape: { hasVideo: boolean; hasAudio: boolean },
): boolean {
  const current = companionHost(channelId);
  if (!current || current !== room || current.stream.startedAt !== startedAt) {
    return false;
  }
  if (!shape.hasVideo && !shape.hasAudio) {
    return false;
  }
  if (shape.hasVideo && !liveHlsCameraEnabled()) {
    return false;
  }
  if (shape.hasAudio && !liveHlsVoiceTrackEnabled()) {
    return false;
  }
  return current.camera === null;
}

async function reconcileCameraEgress(
  channelId: string,
  cameraTrackId: string | null,
  voiceTrackId: string | null,
): Promise<void> {
  const room = companionHost(channelId);
  if (!room) {
    return;
  }
  const wantedVideo = liveHlsCameraEnabled() ? cameraTrackId : null;
  // THREE THINGS HAVE TO AGREE before the mic is attached: the deployment
  // flag, the presenter's OWN word that they chose "separada"
  // (`presenterWantsSeparatedVoice` — see its doc), and the named `voice-
  // track` publication actually being there to attach (`voiceTrackId`). The
  // flag off must reproduce the pre-2026-09-13 shape exactly (a camera,
  // silent, `CAMERA_RUNG`), whatever the other two say; the mode off must
  // never attach a track that merely happens to still be published; and a
  // mode that is on with no publication yet (mid-transition) attaches
  // nothing until the next reconcile finds it, rather than manufacturing an
  // id from nowhere.
  const wantedAudio =
    liveHlsVoiceTrackEnabled() &&
    presenterWantsSeparatedVoice(channelId, room.stream.presenterPeerId)
      ? voiceTrackId
      : null;
  const current = room.camera;
  if (
    current &&
    current.cameraTrackId === wantedVideo &&
    current.audioTrackId === wantedAudio
  ) {
    return;
  }
  // The egress this call is replacing. LiveKit can go on listing it ACTIVE
  // well after we asked it to stop (a stop that times out, 2026-09-23
  // 20:13:14Z), and priced as a full rendition it refused its own
  // replacement: boxMbps=651 against 600, the camera gone for the cooldown.
  //
  // FREE ONLY WHEN THE STOP LANDED. A stop that failed or was deferred leaves
  // it running, so then it is charged at its own weight (a camera, or a
  // voice-only slot): not as a rendition, and not as nothing.
  const replaced = new Set<string>();
  let replacedMbps = 0;
  if (current) {
    replaced.add(current.egressId);
    room.camera = null;
    room.stream = withoutCameraUrl(room.stream);
    await recordSessionEnded(channelId, room.stream.startedAt, CAMERA_RUNG_NAME);
    const confirmed = await stopRungs(channelId, [current]);
    if (!confirmed.has(current.egressId)) {
      replacedMbps = current.cameraTrackId ? HLS_CAMERA_MBPS : HLS_VOICE_ONLY_MBPS;
    }
    logEvent("voice.hlsCameraStopped", {
      channelId,
      egressId: current.egressId,
      sessionId: current.sessionId,
      reason: wantedVideo || wantedAudio ? "track-replaced" : "no-camera",
      // What changed, so a replace nobody asked for can be explained.
      fromVideo: current.cameraTrackId,
      toVideo: wantedVideo,
      fromAudio: current.audioTrackId,
      toAudio: wantedAudio,
    });
  }
  if (!wantedVideo && !wantedAudio) {
    // A DELIBERATE CLOSE CLEARS THE COOLDOWN. Turning it off and on again is
    // the first thing anybody does when something looks broken, and holding
    // them out for two minutes after they did exactly the right thing would
    // read as the feature being dead.
    clearCameraCooldown(channelId);
    return;
  }
  const cooldown = cameraCooldownUntil.get(channelId);
  if (cooldown !== undefined) {
    if (cooldown > Date.now()) {
      return;
    }
    clearCameraCooldown(channelId);
  }
  const egress = getEgress();
  if (!egress) {
    return;
  }
  // Priced against the WHOLE box, and never against the ladder budget: see
  // `decideCameraEgress`. A refusal costs a face (or a voice), never a
  // rendition of the film.
  //
  // `activeLadderEgressCount`, NOT `activeBoxEgressCount`, for `runningRungs`:
  // every running camera (this one's neighbours included) is already added
  // below via `runningCameraMbps()`, at its own much smaller weight, and
  // `activeBoxEgressCount` cannot itself tell a camera egress from a ladder
  // rendition. Passing it directly would charge every existing camera twice.
  const decision = decideCameraEgress({
    runningRungs: await activeLadderEgressCount({
      supersededEgressIds: replaced,
    }),
    sfuLoadMbps:
      (await currentSfuLoadMbps()) + runningCameraMbps() + replacedMbps,
    boxBudgetMbps: promotionBudgetMbps(),
    hasVideo: Boolean(wantedVideo),
  });
  if (!decision.start) {
    // THE SAME COOLDOWN, and it is what keeps this off the log. `pushLiveHls`
    // runs on every roster event, so a full box with a camera published would
    // otherwise re-price and re-log the same refusal every time anybody joined
    // or left the room, for the whole party. One line, then two minutes of
    // quiet, then it asks again — which is also the right retry cadence for a
    // box that may have freed up.
    const retryInMs = startCameraCooldown(channelId);
    logEvent("voice.hlsCameraRefused", {
      channelId,
      refusal: decision.refusal,
      boxMbps: Math.round(decision.boxMbps),
      boxBudgetMbps: promotionBudgetMbps(),
      retryInMs,
    });
    return;
  }
  const startedAt = room.stream.startedAt;
  // Which of the three shapes this attempt is. Same `CAMERA_RUNG_NAME` object
  // prefix and playlist path for all three — see the `RoomHls.camera` doc —
  // so nothing downstream needs to know which one is running.
  const rung = wantedVideo
    ? wantedAudio
      ? CAMERA_RUNG_WITH_VOICE
      : CAMERA_RUNG
    : VOICE_RUNG;
  let egressId: string | null = null;
  // EVERY CAMERA RUN WRITES UNDER ITS OWN NAMES. The camera is the one slot
  // that stops and starts inside a session, and a fresh egress numbers its
  // segments from `_00000` again and rewrites its `-index.m3u8` from empty:
  // under one fixed prefix the second run overwrote the first (2026-09-23
  // production rehearsal: camera off and on again, and the download held only
  // the part after). See `cameraRunNames`.
  const runSuffix = nextCameraRunSuffix(channelId, startedAt);
  try {
    const started = await egress.startTrackCompositeEgress(
      channelId,
      cameraSegmentOutput(channelId, startedAt, runSuffix),
      {
        videoTrackId: wantedVideo ?? undefined,
        // ABSENT UNLESS `LIVE_HLS_VOICE_TRACK` FOUND ONE. The pre-2026-09-13
        // shape (`wantedAudio` null) is exactly the old "no audio track at
        // all" request: the audience's sound comes off the main stream, and a
        // second audio channel two seconds out of step with the first is
        // worse than silence. With the flag on and a mic to attach, this is
        // the presenter's OWN voice — the one thing `hlsUrl`'s film audio no
        // longer carries once they pick "separada" — never a duplicate of it.
        audioTrackId: wantedAudio ?? undefined,
        encodingOptions: rungEncodingOptions(rung),
      },
    );
    egressId = started.egressId;
  } catch (error) {
    logEvent("voice.hlsCameraStartFailed", {
      channelId,
      error: error instanceof Error ? error.message : String(error),
    });
    return;
  }
  // The room may have been replaced while LiveKit was answering. Starting a
  // transcode into a session that no longer exists is an orphan, so stop it
  // rather than filing it under a room that moved on. `cameraStillWanted`
  // checks more than identity — see its comment — because the per-channel
  // queue keeps another RECONCILE from running concurrently, but the health
  // monitor is a separate timer and is not, so this is the belt to that
  // brace.
  if (
    !cameraStillWanted(channelId, room, startedAt, {
      hasVideo: Boolean(wantedVideo),
      hasAudio: Boolean(wantedAudio),
    })
  ) {
    await stopEgressById(egressId, channelId);
    return;
  }
  // THE ROW BEFORE THE STATE, and its success is part of starting the camera,
  // not an afterthought. Everything that reads this camera back from outside
  // this process's memory — deploy adoption, the box-budget ghost filter, a
  // human looking at `hls_sessions` — goes through the row, not `room.camera`.
  // Advertising `cameraHlsUrl` before the row exists would hand viewers a
  // playlist path `renderSignedPlaylist` 404s (no session to be found) while
  // the transcode goes on consuming an encoder with nothing here to reclaim
  // it once this process exits.
  const { ok: recorded, sessionId } = await recordSessionStarted(
    channelId,
    startedAt,
    egressId,
    CAMERA_RUNG_NAME,
    room.stream.presenterPeerId,
    // Both sids, in their own columns, so a restart can adopt the EXACT
    // shape this attempt started rather than reconstructing it from one id
    // — see `audio_track_id` in `schema.sql` and `adoptCameraEgress`.
    // `""` for video only when this is an audio-only (`VOICE_RUNG`) slot;
    // the column stays nullable in shape, this call site's own contract does
    // not.
    wantedVideo ?? "",
    // Reopen: this slot is the one rendition that starts and stops INSIDE a
    // session, so the second time round it lands on a row it already ended.
    true,
    wantedAudio,
  );
  if (!recorded) {
    await stopEgressById(egressId, channelId);
    return;
  }
  // The room may have moved on again — or the slot may have been disabled, or
  // claimed by something else — while that write was in flight. THIS is the
  // check that stops a slot turned off mid-write from being resurrected:
  // `LIVE_HLS_CAMERA` (or `LIVE_HLS_VOICE_TRACK`) flipping, or `room.camera`
  // already holding something, both fail it now, where the old version only
  // checked room and film-session identity.
  if (
    !cameraStillWanted(channelId, room, startedAt, {
      hasVideo: Boolean(wantedVideo),
      hasAudio: Boolean(wantedAudio),
    })
  ) {
    await stopEgressById(egressId, channelId);
    return;
  }
  room.camera = {
    rung,
    egressId,
    startedAtMs: Date.now(),
    progress: null,
    cameraTrackId: wantedVideo,
    audioTrackId: wantedAudio,
    sessionId,
  };
  room.stream = withCameraUrl(room.stream, channelId, {
    hasVideo: Boolean(wantedVideo),
    hasVoiceAudio: Boolean(wantedAudio),
  });
  logEvent("voice.hlsCameraStarted", {
    channelId,
    egressId,
    startedAt,
    sessionId,
    cameraTrackId: wantedVideo,
    audioTrackId: wantedAudio,
    boxMbps: Math.round(decision.boxMbps),
  });
}

/**
 * What the WebRTC side already costs, or 0 when nothing can tell us.
 *
 * Returns a NUMBER rather than a promise when there is no reader, so the
 * common path (and every test with no load registered) adds no await to the
 * restart chain. Awaiting a resolved promise is free at runtime and is not
 * free for a suite that drives this with fake timers.
 */
function currentSfuLoadMbps(): number | Promise<number> {
  const reader = sfuLoadReader;
  if (!reader) {
    return 0;
  }
  return readSfuLoad(reader);
}

async function readSfuLoad(reader: LiveHlsSfuLoadReader): Promise<number> {
  try {
    return await reader();
  } catch (error) {
    logEvent("voice.hlsLoadReadFailed", {
      error: error instanceof Error ? error.message : String(error),
    });
    return 0;
  }
}

/**
 * What one film-side reconcile pass decided: the film's own outcome, plus —
 * when THIS pass is the one that decided it — the camera track to reconcile
 * next.
 *
 * `cameraTrackId` is optional-vs-null on purpose, not just nullable:
 * `undefined` means "already handled, nothing left to do" (the room was torn
 * down, or a probe genuinely could not be made and a bounded retry is already
 * scheduled — see `scheduleCameraProbeRetry`), and `null` means "handle it:
 * the presenter has no camera published right now." Collapsing the two would
 * either skip a stop that has to happen or repeat a probe retry that is
 * already pending.
 *
 * WHY THE CAMERA IS NEVER DECIDED INSIDE THIS RETURN. `reconcileLiveHls`
 * (below) is what actually calls `reconcileCameraEgress`, as the NEXT link of
 * this channel's own per-channel queue — chained so it can never overlap a
 * later push's camera work for the same channel, but never awaited by the
 * film path either. A version of this that ran the camera step here (or
 * detached it with a free-floating promise, which is what a previous revision
 * did) let two reconciles for the same channel run their camera logic
 * concurrently: a roster event arriving while a brand-new room's camera start
 * was still awaiting LiveKit or its session-row write could start a SECOND
 * camera egress, or resurrect one a concurrent "turn the camera off" had just
 * stopped.
 */
interface LiveHlsReconcileResult {
  stream: LiveHlsStream | null;
  cameraTrackId?: string | null;
  /** Same optional-vs-null convention as `cameraTrackId`, for the mic. */
  voiceTrackId?: string | null;
}

async function startRoom(
  channelId: string,
  presenterPeerId: string,
  knownTracks?: LiveHlsScreenTracks,
  sourceHeight?: number | null,
): Promise<LiveHlsReconcileResult> {
  const egress = getEgress();
  if (!egress || !isLiveHlsEnabled()) {
    return { stream: null };
  }
  if (isFailed(channelId)) {
    logEvent("voice.hlsStartSuppressed", { channelId, presenterPeerId });
    return { stream: null };
  }
  // IS THIS STILL TRUE? The caller decided it was, some awaits ago. See
  // `LiveHlsPresenterCheck` for the 2026-09-17 race this closes: the cheapest
  // possible place to notice, before a track probe and before a core.
  if (presenterGone(channelId, presenterPeerId)) {
    logEvent("voice.hlsStartCancelled", {
      channelId,
      presenterPeerId,
      stage: "before-probe",
    });
    return { stream: null };
  }
  // The concurrency guard, and it comes BEFORE the track probe on purpose:
  // `findScreenTracks` polls LiveKit up to sixteen times over six seconds,
  // and spending that on a session that is going to be refused is the wrong
  // work to be doing on precisely the box that is already full.
  //
  // Deliberately here rather than inside `decideLadder`: that one degrades a
  // party (it refuses the rungs above the lowest and never the lowest), this
  // one refuses a session, and nothing else bounds the count.
  //
  // `rooms.size` is the count of OTHER sessions without having to subtract
  // one, because every caller that reaches here for a channel that was
  // already running stopped that room first (the three `stopRoom` calls in
  // `reconcileLiveHlsNow`, and the restart path, which stops before it
  // schedules). A restart is therefore judged on the same terms as a first
  // start: if three other parties have filled the box meanwhile, it waits.
  const maxSessions = maxLiveHlsSessions();
  if (rooms.size >= maxSessions) {
    logEvent("voice.hlsSessionsCapped", {
      channelId,
      presenterPeerId,
      sessions: rooms.size,
      maxSessions,
    });
    return { stream: null };
  }
  const tracks = knownTracks ?? (await findScreenTracks(channelId, presenterPeerId));
  if (!tracks) {
    logEvent("voice.hlsNoScreenTrack", { channelId, presenterPeerId });
    return { stream: null };
  }
  // AND AGAIN AFTER THE PROBE, which is up to six seconds of polling LiveKit
  // (`TRACK_FIND_ATTEMPTS`). A presenter who hangs up during it leaves a track
  // the SFU has not forgotten yet, so the probe succeeds and the rungs would
  // start against media that is already going away -- which is exactly the
  // `track TR_... not found` those two egresses died of 34 s later.
  if (presenterGone(channelId, presenterPeerId)) {
    logEvent("voice.hlsStartCancelled", {
      channelId,
      presenterPeerId,
      stage: "after-probe",
    });
    return { stream: null };
  }
  // WHAT THIS START IS ENTITLED TO SUPERSEDE, decided once and used twice:
  // to price the ladder below without charging it for the transcode it is
  // replacing, and to spare `activeBoxEgressCount` a second `ListEgress` of
  // the whole box on the same tick.
  const supersede = await planSupersededEgresses(channelId);
  const ladder = liveHlsLadder();
  const decisions = decideLadder({
    rungs: ladder,
    // `activeLadderEgressCount`, not `activeBoxEgressCount`: see the comment
    // on that function. The cameras go in with the WebRTC load rather than
    // into `runningRungs` either way — one is 30 % of a rendition, not one of
    // them — but `activeBoxEgressCount` counts every active egress as a full
    // rendition, cameras included, so passing it here on top of
    // `runningCameraMbps()` below would price every running camera twice.
    //
    // AND NOT THE RUNGS THIS START IS ABOUT TO END. `endSupersededSessions`
    // below stops every active egress on this channel that is not one of the
    // ids started here, so counting them would charge the new ladder for the
    // transcode it is replacing -- which on 2026-09-15 refused a live party's
    // `720p30` with `ladder-budget` on a box that emptied a second later.
    // `supersede.egressIds` is the set it has actually established it may
    // stop; its listing is reused so the box is not listed twice.
    runningRungs: await activeLadderEgressCount({
      supersededEgressIds: supersede.egressIds,
      // Including `null`, which says "already asked, could not be answered"
      // rather than "not asked": a second `ListEgress` on the same tick would
      // only fail again.
      listing: supersede.listing,
    }),
    sfuLoadMbps: (await currentSfuLoadMbps()) + runningCameraMbps(),
    ladderBudgetMbps: ladderBudgetMbps(),
    boxBudgetMbps: promotionBudgetMbps(),
    // The host's getSettings() height, when announced, is the pixels. LiveKit
    // `track.height` is the declared layer and can be the frozen 1080 from a
    // 480p window. An upscale rung is a wasted x264 and a flapping ABR.
    sourceHeight: sourceHeight ?? tracks.sourceHeight ?? null,
  });
  const startedAt = Date.now();
  const running: RunningRung[] = [];
  for (const decision of decisions) {
    if (!decision.start) {
      logEvent("voice.hlsRungRefused", {
        channelId,
        rung: decision.rung.name,
        refusal: decision.refusal,
        ladderMbps: Math.round(decision.ladderMbps),
        boxMbps: Math.round(decision.boxMbps),
        ladderBudgetMbps: ladderBudgetMbps(),
        boxBudgetMbps: promotionBudgetMbps(),
      });
      continue;
    }
    const egressId = await startRung(
      egress,
      channelId,
      startedAt,
      tracks,
      decision.rung,
    );
    if (!egressId) {
      if (running.length === 0) {
        // The lowest rung is the stream. Nothing above it is worth starting
        // if a viewer would have no rendition to fall back to.
        scheduleRestart(channelId, "start-failed");
        return { stream: null };
      }
      continue;
    }
    running.push({
      rung: decision.rung,
      egressId,
      startedAtMs: startedAt,
      progress: null,
      // Filled in below, once `recordSessionStarted` has actually run: this
      // object exists before that write starts.
      sessionId: null,
    });
  }
  const primary = running[0];
  if (!primary) {
    scheduleRestart(channelId, "start-failed");
    return { stream: null };
  }
  const stream: LiveHlsStream = {
    hlsUrl: viewerPlaylistUrl(channelId, startedAt),
    startedAt,
    presenterPeerId,
    delaySeconds: delaySeconds(),
    // What actually started, not what was configured: a rung refused for
    // budget must not tell the presenter to upload for it.
    topHeight: Math.max(...running.map((entry) => entry.rung.height)),
    topFramerate: Math.max(...running.map((entry) => entry.rung.framerate)),
    // The one fact the host cannot check for themselves. They hear the film
    // out of their own speakers whether or not its audio was ever captured.
    hasAudio: Boolean(tracks.audioTrackId),
  };
  const room: RoomHls = {
    rungs: running,
    stream,
    videoTrackId: tracks.videoTrackId,
    audioTrackId: tracks.audioTrackId ?? null,
    // Started below, after the readiness probe: a camera must never be the
    // reason the film is late, and a session that fails its probe is torn down
    // anyway.
    camera: null,
    startedAtMs: startedAt,
    micArchive: null,
    // Open the window even when the flag is off right now: it is read per
    // call, so an operator who turns it on thirty seconds into a party gets
    // the archive rather than having to restart the share.
    micArchiveUntil: startedAt + MIC_ARCHIVE_WAIT_MS,
    // Not until the readiness probe below says there is a playlist to watch.
    // See `RoomHls.announced`.
    announced: false,
  };
  rooms.set(channelId, room);
  // The rows AFTER the room is published, not before. They are what the
  // playlist proxy checks and what retention sweeps, so they have to exist
  // before the URL goes out (which is below, past the readiness probe), but
  // nothing in memory may wait on Postgres to become true: putting a real
  // round trip in front of `rooms.set` is what made the health-monitor tests
  // flake on the CI runner and would delay a restart in production for
  // exactly as long as the database felt like taking.
  const recordedSessions = await Promise.all(
    running.map((entry) =>
      recordSessionStarted(
        channelId,
        startedAt,
        entry.egressId,
        entry.rung.name,
        presenterPeerId,
        tracks.videoTrackId,
        false,
        // The ladder's own audio sid now, same column the camera/voice slot
        // already used: `adoptLiveHlsSession` reads it back for the ladder
        // rows too, so an API restart mid-party does not forget whether the
        // running egress had the presenter's tab audio and cause a spurious
        // restart the moment the next reconcile notices.
        tracks.audioTrackId ?? null,
      ),
    ),
  );
  // Mutates the same objects `primary` and `stream`'s callers already hold a
  // reference to, so `voice.hlsStarted` below (and every later log that reads
  // `room.rungs`) sees the id without a second lookup. A per-rung write
  // failing here is not new behaviour: the pre-B0.4 code discarded this
  // result too, and `recordSessionStarted` already logged
  // `voice.hlsSessionRecordFailed` for it.
  running.forEach((entry, i) => {
    entry.sessionId = recordedSessions[i]?.sessionId ?? null;
  });
  // The readiness probe reads the bucket itself (presigned, endpoint form),
  // never the viewer-facing URL: a viewer gets the signed master path, which
  // this same process cannot usefully fetch from here. It waits on the
  // PRIMARY rung, because that is the one a viewer is guaranteed to land on.
  //
  // RUN ALONGSIDE THE READINESS PROBE, NOT BEFORE IT. Neither superseded-
  // session cleanup nor the mic archive proves the film is ready -- same
  // reasoning as the comment on the returned camera track below: a LiveKit
  // control-plane call that is slow must never be the reason a presenter
  // waits longer to go live. Production evidence, 2026-09-23: `stopEgress`
  // timed out at 18:28:22, 20:13:14-27 and 21:24:06-11, and conventional
  // ladder start measured 7.6-10.9s from share to first playlist -- with
  // this awaited serially beforehand, one slow superseded stop landed
  // entirely in front of the readiness timer instead of overlapping it.
  // `startMicArchive` still runs strictly AFTER `endSupersededSessions`
  // resolves (nested here, not parallel with it): the sweep of "every
  // active egress on this room that is not one of the ids I just started"
  // would otherwise stop the archive one line after starting it. Usually a
  // no-op on this pass: the browser publishes the archive track only once
  // the mix is up, which is after the share, which is what got us here. The
  // monitor picks it up.
  const waitStartedAt = Date.now();
  const [ready] = await Promise.all([
    waitForLivePlaylist(
      internalPlaylistUrl(channelId, startedAt, primary.rung.name),
    ),
    (async () => {
      await endSupersededSessions(
        channelId,
        startedAt,
        new Set(running.map((entry) => entry.egressId)),
      );
      if (micArchiveEnabled() && tracks.micArchiveTrackId) {
        await startMicArchive(egress, channelId, room, tracks.micArchiveTrackId);
      }
    })(),
  ]);
  hlsStartsTotal += 1;
  logEvent("voice.hlsStarted", {
    channelId,
    presenterPeerId,
    // The primary rung's `hls_sessions.id` (BROADCAST_PIPELINE B0.4): the
    // same id every rung's row carries its own copy of in `sessionIds`
    // below, and the same one the playlist's `#EXT-X-PQP-SESSION` tag names.
    sessionId: primary.sessionId,
    playlistReady: ready,
    // How long the first live playlist actually took. The only way to know
    // whether `PLAYLIST_WAIT_ATTEMPTS` is set anywhere near right, and the
    // reason the number above can be revised from data instead of argument.
    playlistWaitMs: Date.now() - waitStartedAt,
    // WHAT THE TRANSCODE IS ACTUALLY CARRYING, not what it was asked for.
    // "screen" is the share's own audio; "none" is a silent stream, which is
    // what a whole-screen or window capture always produces and what a tab
    // share produces when the host leaves the audio box unticked. `grep`ping
    // for `"audio":"none"` is how an operator answers "could they hear it?"
    // after the fact, and `liveHls.silentSessions` on /api/admin/metrics is
    // how they answer it during.
    audio: tracks.audioTrackId ? "screen" : "none",
    started: running.map((entry) => entry.rung.name),
    refused: decisions
      .filter((decision) => !decision.start)
      .map((decision) => `${decision.rung.name}:${decision.refusal}`),
    egressIds: running.map((entry) => entry.egressId),
    sessionIds: running.map((entry) => entry.sessionId),
    // WHETHER ANYBODY IS GOING TO BE TOLD ABOUT THIS. `voice.hlsStarted` is
    // the line an operator greps to answer "did the party start", and until
    // now it said the same thing for a session that went on air and for one
    // that was torn down two lines later. Both remaining falses -- the probe
    // timing out, and the presenter having left during it -- are right here.
    announced: ready && !presenterGone(channelId, presenterPeerId),
  });
  // THE PRESENTER LEFT WHILE WE WERE WAITING FOR THEIR PLAYLIST. Up to
  // forty-five seconds pass inside `waitForLivePlaylist`, and on 2026-09-17
  // fifty-two of them did, for a presenter who had already left the room. A
  // ready playlist for a share that is over is a rung still transcoding and
  // an audience about to be handed a URL that stops moving; stop it here,
  // where the session is still ours, rather than leaving it to whichever push
  // eventually notices.
  if (rooms.get(channelId) === room && presenterGone(channelId, presenterPeerId)) {
    logEvent("voice.hlsStartCancelled", {
      channelId,
      presenterPeerId,
      stage: "after-playlist-wait",
      playlistReady: ready,
    });
    await stopRoom(channelId, "presenter-gone");
    return { stream: null };
  }
  if (!ready) {
    // Twenty seconds and no live playlist: this egress is not going to
    // produce one. Handing the URL out anyway parks every viewer on
    // "loading" for the whole share (the pre-fix behaviour). Tear it
    // down and let the restart path try again, under the same cap.
    if (rooms.get(channelId) === room) {
      await stopRoom(channelId, "playlist-not-ready");
      scheduleRestart(channelId, "playlist-not-ready", Date.now(), presenterPeerId);
    }
    return { stream: null };
  }
  // THE SESSION IS NOW REAL TO EVERYBODY ELSE. Set before the return, because
  // the return is what a push turns into `voice-stream` frames, and read by
  // `liveHlsStreamFor` for every OTHER reader of this channel's stream.
  room.announced = true;
  // AFTER the film is proven, but NOT DONE HERE. This function hands the film
  // back the moment it is ready — a camera-specific LiveKit RPC, box-budget
  // probe or session-row write stalling must never hold up or abort the
  // primary result. The camera track is returned alongside the film instead,
  // for `reconcileLiveHls` to reconcile as the NEXT link of this channel's own
  // serialisation queue: chained, so it can never overlap a later push's own
  // camera work for this channel, but never awaited by the film path either.
  return { stream, cameraTrackId: tracks.cameraTrackId ?? null, voiceTrackId: tracks.voiceTrackId ?? null };
}

/**
 * First sharer in the room wins. A later share does not steal the transcode.
 * `presenterPeerId: null` means nobody is sharing: stop if we were. The
 * same presenter re-declaring is a no-op unless their screen track is a new
 * sid, in which case the egress is bound to a dead track and is restarted
 * (new playlist URL, so the caller broadcasts it and viewers reload).
 * `serverId` is the channel's server: a server whose `live_hls_enabled` row
 * (or, with no row, `LIVE_HLS_SERVER_ALLOWLIST`) says no never starts an
 * egress, and one already running for it is stopped. Read here, per share,
 * so turning a server off from the dashboard ends its stream at the next
 * reconcile rather than at the next deploy.
 */
export function reconcileLiveHls(
  channelId: string,
  presenterPeerId: string | null,
  serverId: string | null,
  sourceHeight?: number | null,
): Promise<LiveHlsStream | null> {
  const previous = reconcileQueue.get(channelId) ?? Promise.resolve();
  const filmPromise = previous
    .catch(() => undefined)
    .then(() =>
      reconcileLiveHlsNow(channelId, presenterPeerId, serverId, sourceHeight),
    );
  const streamPromise = filmPromise.then((result) => result.stream);
  // THE CAMERA IS THE NEXT LINK OF THIS CHANNEL'S OWN QUEUE, not a
  // free-floating promise. `reconcileLiveHls` still resolves the moment the
  // film does (`streamPromise`, returned below), but `reconcileQueue` is
  // updated to point at THIS combined chain, so the next call for this
  // channel — a roster event, `set-camera`, anything — waits for the camera
  // step to finish first. That is what stops two reconciles for the same
  // channel from running their camera logic at the same time: a previous
  // revision detached the camera step here, and a roster event arriving
  // while a brand-new room's camera start was still awaiting LiveKit or its
  // session-row write could start a second camera egress, or resurrect one a
  // concurrent "turn the camera off" had just stopped.
  const queued = filmPromise
    .then((result) =>
      result.cameraTrackId === undefined
        ? undefined
        : reconcileCameraEgress(
            channelId,
            result.cameraTrackId,
            result.voiceTrackId ?? null,
          ),
    )
    .catch((error: unknown) => {
      logEvent("voice.hlsCameraReconcileFailed", {
        channelId,
        error: error instanceof Error ? error.message : String(error),
      });
    });
  reconcileQueue.set(channelId, queued);
  void queued.finally(() => {
    if (reconcileQueue.get(channelId) === queued) {
      reconcileQueue.delete(channelId);
    }
  });
  return streamPromise;
}

async function reconcileLiveHlsNow(
  channelId: string,
  presenterPeerId: string | null,
  serverId: string | null,
  sourceHeight?: number | null,
): Promise<LiveHlsReconcileResult> {
  // THE MODE BRANCH, BEFORE ANYTHING ELSE HERE READS TRACKS OR RUNGS.
  // `resolveHlsModeForChannel` answers `conventional` unconditionally while
  // `LIVE_HLS_LL` is unset and asks the database nothing at all, so the flag
  // off leaves this function byte-for-byte what it was before L1.5.
  // `pqp-remux` finds its own screen track (its README), so the LL half
  // skips every LiveKit-specific probe this function does for the ladder.
  //
  // The decision itself -- the party's request, the post-demotion veto that
  // is scoped to THAT party, the allowlist, and the `voice.hlsModeResolved`
  // line that says which of them chose the mode -- lives in one place in
  // `hls-remux.ts`, because it was spread across here and there that a
  // per-channel veto on one machine silently overruled a new party's request
  // written on the other (2026-09-15, channel `d5559e70`).
  const resolved = await resolveHlsModeForChannel(channelId, serverId, {
    sharing: presenterPeerId !== null,
  });
  if (resolved === null) {
    // FAIL CLOSED (a Farol finding on PR #580, fourth round): a database
    // read failure here must be indistinguishable from "try again later",
    // never read as "this party did not ask" -- that would fall through to
    // `resolveHlsMode`'s `conventional` default and tear down a running LL
    // session on a transient blip. Make no mode decision at all this
    // reconcile: hand back whatever is already running, untouched, and let
    // the next reconcile (the next roster event) ask again.
    const existing = rooms.get(channelId);
    return {
      stream:
        existing && existing.announced
          ? existing.stream
          : llStreamFor(channelId),
    };
  }
  const { mode } = resolved;
  if (mode === "ll") {
    // A mode flip mid-party (the request field changed between two "Ir ao
    // vivo" presses for the same channel) must never leave two transcodes
    // running for one room.
    if (rooms.has(channelId)) {
      await stopRoom(channelId, "ll-mode-selected");
    }
    // The camera and the archive ride along (`llCompanions`).
    return reconcileLlCompanions(
      channelId,
      await reconcileLlHlsNow(channelId, presenterPeerId),
    );
  }
  // Before the LL session itself, so nothing is left filed under it.
  await stopLlCompanions(channelId, "conventional-mode-selected");
  if (llHasRoom(channelId)) {
    await stopLlSession(channelId, "conventional-mode-selected");
  }
  if (!(await isLiveHlsEnabledForServer(serverId))) {
    // "not allowlisted" and "nobody is sharing" used to arrive here as the
    // same thing, because `pushLiveHls` resolved the server id only when it
    // had a sharer and passed null otherwise. So an ordinary end of share was
    // torn down by this branch, which logs nothing, instead of the branch
    // below, which does. The caller resolves the id either way now; this one
    // is the genuine allowlist case again and says so.
    if (rooms.has(channelId)) {
      await stopRoom(channelId, "not-allowlisted");
    }
    return { stream: null };
  }
  const current = rooms.get(channelId);
  if (!presenterPeerId) {
    // A share that stopped resets the restart budget: the next one starts
    // clean rather than inheriting the last one's failures.
    clearFailure(channelId);
    if (current) {
      await stopRoom(channelId, "no-share");
    }
    return { stream: null };
  }
  if (current && current.stream.presenterPeerId === presenterPeerId) {
    const tracks = await probeScreenTracks(channelId, presenterPeerId);
    if (!tracks) {
      // COULD NOT ASK, which is not "no camera". A momentary LiveKit hiccup
      // must not tear a running camera transcode down and start another one
      // on the next push. But it also must not leave a presenter who just
      // turned their camera on stuck with no PiP until some unrelated roster
      // event happens to try again — see `scheduleCameraProbeRetry`.
      scheduleCameraProbeRetry(channelId);
      return { stream: announcedStreamOf(current) };
    }
    clearCameraProbeRetry(channelId);
    const nextAudioTrackId = tracks.audioTrackId ?? null;
    if (
      tracks.videoTrackId === current.videoTrackId &&
      nextAudioTrackId === current.audioTrackId
    ) {
      // The film has not moved and its own audio sid has not either; the
      // camera may have. This is the ordinary path: it runs on every roster
      // event and on the `set-camera` frame, and it is where a webcam being
      // switched on actually starts its transcode. It reuses the
      // `listParticipants` call above, so it costs no extra RPC. The camera
      // itself is reconciled by the caller, as the next link of the queue —
      // never here.
      return { stream: announcedStreamOf(current), cameraTrackId: tracks.cameraTrackId ?? null, voiceTrackId: tracks.voiceTrackId ?? null };
    }
    // A NEW AUDIO SID WITH THE SAME VIDEO SID IS STILL A REPLACEMENT. Ticking
    // "share audio" on after the ladder was already running, losing the
    // share's audio, or the browser handing the presenter a new audio track
    // while the video track stays put all change `nextAudioTrackId` alone —
    // see `RoomHls.audioTrackId`. The running egress is bound to whichever
    // sid it started with either way, so this restarts on that too, not only
    // on the video sid the comment above used to name alone.
    logEvent("voice.hlsTrackReplaced", {
      channelId,
      egressIds: current.rungs.map((entry) => entry.egressId),
      from: current.videoTrackId,
      to: tracks.videoTrackId,
      audioFrom: current.audioTrackId,
      audioTo: nextAudioTrackId,
    });
    await stopRoom(channelId, "screen-track-replaced");
    return startRoom(channelId, presenterPeerId, tracks, sourceHeight);
  }
  if (current) {
    // A NEW PEER ID IS NOT NECESSARILY A NEW PRESENTER. A reconnect that
    // reconstructs or cold-joins gets a fresh peer id, and LiveKit identities
    // are peer ids, so the room reports a different presenter for what is
    // plainly the same person. If the SFU still holds the very screen track
    // this session was started on, the media never moved and there is nothing
    // to restart: adopt the new id onto the running session instead of
    // rebuffering every viewer to say the same picture again.
    //
    // Sids are unique per publication, so this cannot confuse two people: a
    // genuine second presenter has a track this session was never bound to.
    const tracks = await probeScreenTracks(channelId, presenterPeerId);
    if (tracks && tracks.videoTrackId === current.videoTrackId) {
      const from = current.stream.presenterPeerId;
      current.stream = { ...current.stream, presenterPeerId };
      logEvent("voice.hlsPresenterReattached", {
        channelId,
        from,
        to: presenterPeerId,
        videoTrackId: current.videoTrackId,
      });
      // The reconnect republished their camera on a fresh sid, so the running
      // camera egress is bound to a dead track. Same reasoning as the share's
      // `videoTrackId` comparison directly above; reconciled by the caller.
      return { stream: announcedStreamOf(current), cameraTrackId: tracks.cameraTrackId ?? null, voiceTrackId: tracks.voiceTrackId ?? null };
    }
    await stopRoom(channelId, "presenter-changed");
  } else {
    // NOTHING LOCAL, BUT MAYBE NOT NOTHING AT ALL. This process holds no room
    // for a channel it has never presented -- and also for one whose
    // presenter has just RESUMED here off a machine that is draining for a
    // deploy, while the egresses carry on untouched on the LiveKit box. The
    // two look identical from here and only one of them wants a new ladder.
    // Gated on `current` having been absent, so a genuine handover
    // (`presenter-changed` above, which has just ended this channel's rows)
    // still falls through to a fresh start.
    const resumed = await adoptRunningLiveHlsSession(channelId, presenterPeerId);
    if (resumed.kind === "adopted") {
      // No `cameraTrackId` on purpose: adoption restores the camera slot from
      // the row it was recorded under, and the caller reconciles cameras only
      // when this field is present. The next push for this channel takes the
      // same-presenter path above, probes the tracks and reconciles it then.
      return { stream: resumed.stream };
    }
    if (resumed.kind === "stand-down") {
      // SOMEBODY ELSE ALIVE IS DRIVING THIS, OR THE QUESTION COULD NOT BE
      // ANSWERED. Starting a ladder on either would have `startRoom` mint a
      // new `startedAt` and `endSupersededSessions` stop egresses this
      // process has no business stopping. Do nothing at all and ask again on
      // the next roster event; a genuinely dead owner's heartbeat lapses and
      // the next attempt adopts, while a live one is publishing the stream
      // over `voice.live` already.
      //
      // Not logged again here: the decision narrated itself where it was made
      // (`voice.hlsResumeNotAdopted` with `kind: "stand-down"` and the reason,
      // or `voice.hlsSkippedOwnedElsewhere` for the owner case), throttled per
      // channel per reason. A second line on every roster event would repeat
      // the same fact until the condition clears.
      return { stream: null };
    }
  }
  return startRoom(channelId, presenterPeerId, undefined, sourceHeight);
}
