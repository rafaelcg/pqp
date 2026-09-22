// Package session wires the pieces every other internal package built in
// isolation: RTP in from internal/subscriber, through
// internal/h264 (depacketize) and internal/pipeline (fragment), into an
// internal/ring for internal/serve to answer HTTP with. It is the "L1.2"
// glue task 2 in the PR description refers to as one thing, kept in its
// own file so main.go stays a thin bag of flag parsing and Run() calls.
//
// L1.3 (audio: mix and AAC) and L1.4 (the R2 writer) are both opt-in,
// wired on after New via EnableAudio and EnableR2: a Session that never
// calls either behaves exactly as it did before those tasks existed,
// which is what "keep the video path untouched and passthrough" (the
// L1.3/L1.4 task description) means at the API level, not just the byte
// level.
package session

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"log"
	"sync"
	"sync/atomic"
	"time"

	"github.com/pion/rtp"

	"github.com/rafaelcg/pqp/tools/pqp-remux/internal/aacenc"
	"github.com/rafaelcg/pqp/tools/pqp-remux/internal/audiomix"
	"github.com/rafaelcg/pqp/tools/pqp-remux/internal/cmaf"
	"github.com/rafaelcg/pqp/tools/pqp-remux/internal/h264"
	"github.com/rafaelcg/pqp/tools/pqp-remux/internal/keyframe"
	"github.com/rafaelcg/pqp/tools/pqp-remux/internal/nal"
	"github.com/rafaelcg/pqp/tools/pqp-remux/internal/pipeline"
	"github.com/rafaelcg/pqp/tools/pqp-remux/internal/r2"
	"github.com/rafaelcg/pqp/tools/pqp-remux/internal/ring"
	"github.com/rafaelcg/pqp/tools/pqp-remux/internal/serve"
	"github.com/rafaelcg/pqp/tools/pqp-remux/internal/skipframe"
)

// Session owns the one video track's whole pipeline: depacketize, mux,
// publish into the ring. HandleVideoPacket is called from a single
// goroutine (the subscriber's own RTP reader for that track) -- but it is
// no longer the ONLY toucher of the depacketizer/fragmenter/ring: since
// 2026-09-15 RunMonitor's keep-alive tick publishes the held access unit
// when the publisher stops sending, which by definition cannot run on the
// packet goroutine. videoMu is what makes those two safe together; see its
// own doc comment. The atomics below are for Health()/Stats(), read
// concurrently from HTTP handler and watchdog goroutines.
type Session struct {
	// videoMu serializes the video muxing path. Until 2026-09-15 this
	// file's own doc comment could truthfully say "HandleVideoPacket is
	// meant to be called from a single goroutine, so the
	// depacketizer/fragmenter/ring writes need no lock" -- the
	// subscriber's RTP reader was the only caller. RunMonitor's
	// keep-alive tick (idleTick) is a SECOND caller of the fragmenter,
	// by necessity: the whole point of it is to close a part when no
	// packet is arriving to close it, so it cannot run on the packet
	// goroutine. Every touch of dep/frag and every publish now takes
	// this; Finish takes it too. Contention is one uncontended
	// lock/unlock per video frame.
	videoMu sync.Mutex

	dep  *h264.Depacketizer
	frag *pipeline.Fragmenter
	ring *ring.Ring
	// videoStopped is set by Close, under videoMu, and checked by
	// idleTick under the same lock. It is what makes "Close has
	// returned" imply "no keep-alive tick is inside the fragmenter, and
	// none ever will be again" -- which internal/control's restart
	// depends on: it reads the old pipeline's Health() (an
	// unsynchronized read of the fragmenter's segment index and part
	// sequence) immediately after closing it, and until the keep-alive
	// existed the subscriber's RTP goroutine was the only other toucher,
	// already joined by subscriber.Session.Close.
	videoStopped bool

	// partTicks is New's own partTicks argument, kept because idleTick
	// needs to know the part target to decide how long "no new frame" has
	// to last before the held access unit is published early.
	partTicks uint32

	// keyReq is an atomic pointer, nil under KEYFRAME_POLICY=natural and
	// under --idr-log (L0.1 result item 4 requires idr-log to stay passive
	// regardless of KEYFRAME_POLICY, which callers get for free by simply
	// never constructing a Requester in that mode — see
	// cmd/pqp-remux/main.go). It is atomic because the caller cannot
	// always construct the Requester before Session starts receiving
	// packets: a Requester needs the subscriber.Session that Connect
	// returns, which in turn needs this Session's bound methods to set up
	// its Handlers, so SetKeyframeRequester is called once, shortly after
	// New, from a different goroutine than HandleVideoPacket runs on.
	keyReq atomic.Pointer[keyframe.Requester]

	started time.Time
	// epoch is the ONE shared wall-clock anchor L1.3's audio pipeline
	// places every source on (internal/audiomix.Source.Push's doc
	// comment): this Session's own construction time. Set once, in New,
	// before any goroutine that could read it is started, so it needs no
	// atomic or lock — see New's doc comment on why that ordering is
	// guaranteed. Unused entirely when EnableAudio is never called.
	epoch time.Time

	initSet atomic.Bool
	// initGeneration is how many video init segments this session has
	// published (1 after the first SPS/PPS, 2 after the first real
	// parameter-set change, …). Used only to name init-N.mp4.
	initGeneration       atomic.Uint64
	implausibleParamSets atomic.Uint64
	droppingDamaged      atomic.Bool
	damagedAUsDropped    atomic.Uint64
	// damageEpisodes counts the times droppingDamaged was armed by packet
	// loss (a sequence gap or a discarded access unit); videoLatePackets
	// counts late/duplicate RTP packets the depacketizer ignored.
	damageEpisodes   atomic.Uint64
	videoLatePackets atomic.Uint64
	// videoMarkerlessAUs counts access units the depacketizer closed on a
	// timestamp change rather than on a marker packet. NOT damage and NOT
	// a drop: the frame is delivered. It is here because a publisher that
	// leans on the markerless boundary is worth being able to see, and
	// because the eight of these in fifteen minutes on 2026-09-17 were
	// being counted as damage and answered with a PLI. markerlessLogged
	// keeps the first one to one log line per session.
	videoMarkerlessAUs atomic.Uint64
	markerlessLogged   atomic.Bool
	// damageOpen is true from a discard until the next IDR: further
	// discards inside the same wait are the same episode (one PLI).
	damageOpen atomic.Bool
	// reorder holds out-of-order video packets briefly so a retransmission
	// fills a hole before it counts as loss. Guarded by videoMu.
	reorder *reorderBuffer
	// initSPS/initPPS are the parameter sets the CURRENT init segment was
	// built from. Compared byte-for-byte against every later in-band
	// pair; a real change rebuilds the init. Protected by videoMu.
	initSPS []byte
	initPPS []byte
	// clockCutParts is the CLOCK_CUT_PARTS switch: build a repeat-frame
	// synthesizer for each init segment and hand it to the fragmenter, so
	// parts close on the clock instead of on an access unit. Off by
	// default; see pipeline.Fragmenter.SetRepeater for what it buys and
	// what it costs. Set once, before the session starts receiving, by
	// EnableClockCutParts.
	clockCutParts bool
	// synth is the current repeat-frame synthesizer, rebuilt with every
	// init segment (its frames are only valid for the parameter sets they
	// were written against) and nil while the publisher's stream is one
	// skipframe refuses. Touched only under videoMu.
	synth *skipframe.Synth
	// demoteReason, when non-empty, asks the control-plane watchdog to
	// demote this session off the LL rung (parameter-set change that
	// could not be represented). Read without videoMu from Health.
	demoteReason     atomic.Value // string
	subscribed       atomic.Bool
	partsWritten     atomic.Uint64
	bytesWritten     atomic.Uint64
	lastPartAtMs     atomic.Int64
	lastIdrAtMs      atomic.Int64
	audioPacketsSeen atomic.Uint64

	// --- instrumentation (2026-09-15) ---
	//
	// WHY. On 2026-09-15 a production session stalled producing parts
	// twice on a Chrome TAB share, restarted once and then demoted the
	// party off the low-latency rung, and the service log for the whole
	// five minutes held fourteen depacketize warnings and nothing else:
	// it could not distinguish "no RTP arrived at all" (a static tab
	// sends no frames) from "RTP arrived and no access unit came out"
	// (a depacketizer wedged after loss) from "access units came out and
	// no part was published" (a muxer bug). These counters exist so the
	// next one of those is one log line, not an afternoon. They are
	// deliberately cheap: atomics on paths that already do real work
	// per packet.
	videoPacketsSeen      atomic.Uint64
	videoFramesSeen       atomic.Uint64
	videoKeyframesSeen    atomic.Uint64
	videoDepacketizeErrs  atomic.Uint64
	videoSegmentsWritten  atomic.Uint64
	audioFramesSeen       atomic.Uint64
	audioSegmentsWritten  atomic.Uint64
	keepAlivePartsWritten atomic.Uint64
	// repeatFrames/clockCuts mirror the fragmenter's own counters,
	// copied under videoMu on the paths that move them so Stats can read
	// them from the monitor goroutine without racing the muxer. Both stay
	// at zero unless EnableClockCutParts was called AND the stream turned
	// out to be one internal/skipframe can synthesize into.
	repeatFrames atomic.Uint64
	clockCuts    atomic.Uint64
	// videoMediaMs/audioMediaMs are the total MEDIA time each track has
	// published (the sum of every part's own duration), and
	// videoTimelineAnchorNs/audioTimelineAnchorNs are the wall-clock
	// instant that media started from -- the first part's publish
	// instant minus that part's own duration, so the two are directly
	// comparable. Their ratio is `timelineRatio` on the stats line.
	//
	// WHY A COUNTER FOR THIS. On 2026-09-15 the video timeline advanced
	// 0.54 seconds of media per second of wall clock for five minutes
	// (see pipeline.Fragmenter's pendingTruePTS) while every other
	// number on the stats line looked healthy: parts were being
	// published, segments were closing, audio was fine. A timeline that
	// runs slow is invisible in counts and obvious in one ratio, and it
	// is the kind of bug that comes back, so the ratio is on the line
	// whether or not anyone is looking for it. It belongs at 1.00.
	videoMediaMs          atomic.Int64
	audioMediaMs          atomic.Int64
	videoTimelineAnchorNs atomic.Int64
	audioTimelineAnchorNs atomic.Int64
	// lastVideoPacketAtNs/lastVideoFrameAtNs are wall-clock UnixNano (0
	// = never). Wall clock, not the elapsed-ms convention the rest of
	// this type uses for its health fields, because the two questions
	// they answer -- "is the publisher still sending?" and "has the
	// depacketizer produced anything from what it sent?" -- are asked by
	// a watchdog that has its own clock and no interest in this
	// session's start time.
	lastVideoPacketAtNs atomic.Int64
	lastVideoFrameAtNs  atomic.Int64
	// videoIdle is this session's own idea of whether the source has
	// stopped sending frames, flipped (and logged) by idleTick and
	// HandleVideoPacket. See idleTick.
	videoIdle atomic.Bool
	// depacketizeLogAtNs/depacketizeLogSuppressed rate-limit the
	// per-error depacketize log line. Under the 27% large-packet loss
	// the 2026-09-15 presenter's uplink was measured at, "log every
	// malformed packet" is a log flood, and a flood is as unreadable as
	// silence.
	depacketizeLogAtNs       atomic.Int64
	depacketizeLogSuppressed atomic.Uint64

	// now is time.Now in production. It is a field only so a test can
	// drive the video path and the keep-alive tick off ONE clock
	// (idleTick already takes its instant as a parameter, and a test
	// that stamped frames with the real clock while ticking a synthetic
	// one would be comparing two unrelated timelines). Set it, if at
	// all, immediately after New and before any packet or goroutine.
	now func() time.Time

	// segmentOpenedAtMs is elapsedMs() at the moment the currently-open
	// segment began (the fragment whose IsSegmentStart was true most
	// recently), or -1 before the session's first segment has opened
	// (before the first IDR). L1.6's control-plane watchdog reads this
	// (via OpenSegmentMs) to report `openSegmentMs` on GET /sessions --
	// "how long the currently-open segment has been accumulating, ms"
	// (docs/plans/LL_HLS.md §5). Nothing before L1.6 needed this value, so
	// it did not exist until now.
	segmentOpenedAtMs atomic.Int64
	// idrSeen flips true the first time an IDR is depacketized on this
	// session's video track, so a caller can tell "no IDR yet" (a fresh
	// session) apart from "an IDR really did arrive at elapsed time zero",
	// which lastIdrAtMs's own zero value alone cannot distinguish. See
	// HasIdr.
	idrSeen atomic.Bool

	// --- L1.3: audio (nil/zero until EnableAudio succeeds) ---

	audioMixer        *audiomix.Mixer
	screenAudioSource *audiomix.Source
	// audioEncoder holds a remuxEncoder (atomic.Value, not
	// atomic.Pointer[aacenc.Encoder]: an interface lets
	// audio_robustness_test.go substitute a fake encoder whose writes
	// fail on command, without spawning real ffmpeg). runAudioPacer is
	// the sole writer, swapping it inside recoverAudioEncoder for the one
	// restart attempt that function allows; Close (a different
	// goroutine, on process shutdown) reads it to know which encoder to
	// stop. Loaded/stored only through loadEncoder/storeEncoder, which
	// centralize the type assertion.
	audioEncoder atomic.Value
	// audioNextPTS is the audio track's own running sample-position
	// counter, atomic (not a runAudioPacer-local variable) so it survives
	// an encoder restart unbroken: internal/pipeline.AudioFragmenter's
	// tfdt must never go backwards, and a plain local would reset to 0 in
	// a freshly started readEncoderFrames goroutine.
	audioNextPTS atomic.Int64
	// audioReaderDone is the currently-running readEncoderFrames
	// goroutine's completion signal. Touched only from runAudioPacer's
	// own goroutine (set once in EnableAudio before that goroutine
	// starts, then read-and-replaced inside recoverAudioEncoder, which
	// runs on it) — see recoverAudioEncoder's doc comment for why waiting
	// on it before starting a replacement matters.
	audioReaderDone chan struct{}
	// audioEncoderFailed is the current generation's "the encoder ended
	// unexpectedly" signal (closed by readEncoderFrames when it observes
	// a genuine error on Errs(), as opposed to a clean, intentional
	// shutdown) — runAudioPacer selects on it alongside its ticker so an
	// ffmpeg crash mid-session goes through the exact same
	// recoverAudioEncoder path a WriteSamples failure does, rather than
	// silently ending the audio track. Same single-owner (the pacer
	// goroutine) reasoning as audioReaderDone.
	audioEncoderFailed chan struct{}
	audioFrag          *pipeline.AudioFragmenter
	audioRing          *ring.Ring
	// audioMu guards the restart decision in recoverAudioEncoder and the
	// audioClosed flag together, as one critical section: recoverAudioEncoder
	// holds it for its ENTIRE body, including the (possibly slow, a real
	// subprocess spawn) newEncoderFunc call, and Close takes it too before
	// deciding what to close. That is what makes "a replacement ffmpeg can
	// never outlive the session" true by construction rather than by
	// timing luck — Close either runs to completion before a restart ever
	// starts (nothing to race), or it blocks on this mutex until the
	// in-flight restart finishes and then closes whatever encoder that
	// restart left as current, instead of the (possibly already-closed)
	// one it started with. See TestSession_CloseDuringInFlightRestart*.
	audioMu     sync.Mutex
	audioClosed bool
	// audioDead is set once, permanently, when the audio pipeline gives
	// up (a WriteSamples failure survives the one allowed restart):
	// Health() reports it so a broken pipe that still "looks alive" (the
	// shape pitfall 15 already cost this repo a debugging afternoon on)
	// is visible on /healthz instead of silent.
	audioDead         atomic.Bool
	audioRestarts     atomic.Uint64
	audioPartsWritten atomic.Uint64
	audioBytesWritten atomic.Uint64

	// --- L1.4: the R2 writer (nil until EnableR2 is called) ---

	r2Writer      *r2.Writer
	r2ChannelID   string
	r2StartedAtMs int64
	r2Rung        string

	// --- the VOD index (nil until EnableVodIndex is called) ---

	// vod accumulates every closed segment this session uploads and renders
	// the media and multivariant playlists that make those objects playable
	// after the party ends -- see internal/r2.VodIndex. It is owned by the
	// SESSION (internal/control's ManagedSession), not by this Session, so a
	// watchdog restart does not lose everything before it.
	vod *r2.VodIndex
	// vodInitNames maps a RING init file name (init.mp4, init-2.mp4) onto
	// the object name that init was actually PUT under (video-init.mp4,
	// video-init-2.mp4). Recorded at publishInit rather than re-derived at
	// upload time, so the playlist can never name an object nothing wrote.
	// Guarded by videoMu: written in publishInit and read in
	// uploadVideoSegment, both of which run under it.
	vodInitNames map[string]string
	// vodVideoAdded/vodAudioAdded record whether THIS Session has added a
	// segment to each track yet. The first one it adds is flagged a
	// discontinuity: to the index it follows whatever a predecessor
	// pipeline wrote, and the fragmenter's timestamps start over here.
	// Atomic because Close's timeout branch uploads the last audio segment
	// while the encoder reader may still be doing the same.
	vodVideoAdded atomic.Bool
	vodAudioAdded atomic.Bool
}

// New builds a Session that writes into r using cfg's part/segment
// durations. keyReq may be nil (see the Session.keyReq doc comment) and
// set later with SetKeyframeRequester.
func New(partTicks, segmentTicks uint32, r *ring.Ring, keyReq *keyframe.Requester) *Session {
	s := &Session{
		dep:     h264.NewDepacketizer(),
		reorder: newReorderBuffer(reorderHoldMax),
		frag: pipeline.NewFragmenter(pipeline.Config{
			Timescale:       h264.ClockRate,
			PartDuration:    partTicks,
			SegmentDuration: segmentTicks,
		}),
		ring:      r,
		partTicks: partTicks,
		now:       time.Now,
		started:   time.Now(),
		epoch:     time.Now(),
	}
	if keyReq != nil {
		s.keyReq.Store(keyReq)
	}
	s.segmentOpenedAtMs.Store(-1)
	return s
}

// remuxEncoder is the full surface this file needs from an AAC encoder:
// write PCM in, read frames/errors out, close it down. *aacenc.Encoder
// satisfies this structurally (Go needs no explicit declaration for
// that); audio_robustness_test.go substitutes a fake to exercise
// write-failure, restart and shutdown-ordering behaviour without a real
// ffmpeg subprocess.
type remuxEncoder interface {
	WriteSamples(pcm []float32) error
	Frames() <-chan aacenc.Frame
	Errs() <-chan error
	Close() error
}

// newEncoderFunc abstracts aacenc.New so tests can substitute a fake
// encoder factory (see audio_robustness_test.go); production code never
// reassigns this.
var newEncoderFunc = func(ctx context.Context, cfg aacenc.Config) (remuxEncoder, error) {
	return aacenc.New(ctx, cfg)
}

func (s *Session) loadEncoder() remuxEncoder {
	v := s.audioEncoder.Load()
	if v == nil {
		return nil
	}
	return v.(remuxEncoder)
}

func (s *Session) storeEncoder(enc remuxEncoder) { s.audioEncoder.Store(enc) }

// AudioConfig is everything EnableAudio needs to wire L1.3's audio
// pipeline onto an already-constructed video Session.
type AudioConfig struct {
	// Ring receives the audio track's init segment and every fragment,
	// exactly like the video Ring passed to New — a second, independent
	// ring.Ring instance (audio is a separate CMAF stream; see
	// internal/cmaf/audio_init.go's doc comment).
	Ring *ring.Ring
	// PartTicks is the audio track's own PART_MS target, in the audio
	// track's 48kHz timescale (aacenc.SampleRate). Leaving it zero is
	// what shipped the 2026-09-15 incident this field exists to close:
	// see pipeline.AudioConfig's own doc comment, which carries the
	// production evidence. Ordinarily the same PART_MS the video
	// Fragmenter gets, converted into this track's clock.
	PartTicks uint32
	// SegmentTicks is the audio track's own segment target, in the audio
	// track's 48kHz timescale (aacenc.SampleRate) — NOT the same tick
	// count New's segmentTicks used, which is in the video track's 90kHz
	// RTP clock. Ordinarily the same SEGMENT_MS config value, converted
	// into each track's own timescale.
	SegmentTicks uint32
	// Encoder configures internal/aacenc.New. A zero-value Config is
	// fine (its own defaults apply: 128kbps, "ffmpeg" via PATH).
	Encoder aacenc.Config
	// StartSegmentIndex is the audio counterpart of
	// Session.SetStartSegmentIndex's video parameter -- see that method's
	// doc comment. 0 (the zero value) is ordinary "start counting from
	// segment 0" behaviour; L1.6's watchdog restart is the only caller
	// that ever sets this to anything else.
	StartSegmentIndex int
	// StartSequence is the audio counterpart of
	// Session.SetStartPartSequence's parameter -- see that method's doc
	// comment. 0 is ordinary "number parts from 1"; only a watchdog
	// restart sets it.
	StartSequence uint32
}

// EnableAudio starts the AAC encoder subprocess and this session's audio
// pacing/encoding goroutines. Returns an error only if the encoder
// subprocess itself could not start (e.g. ffmpeg missing from PATH) — a
// caller should treat that as non-fatal to the whole process (see
// cmd/pqp-remux/main.go): video passthrough never depends on this
// succeeding, per the plan's "keep the video path untouched" instruction.
//
// Call EnableR2 BEFORE EnableAudio if both are wanted: EnableAudio builds
// and stores the audio init segment (and enqueues it for upload)
// immediately, so an EnableR2 call after that point would miss it.
//
// Call at most once; ctx's cancellation stops both goroutines this starts
// and (via aacenc.New's own exec.CommandContext) the ffmpeg subprocess.
func (s *Session) EnableAudio(ctx context.Context, cfg AudioConfig) error {
	enc, err := newEncoderFunc(ctx, cfg.Encoder)
	if err != nil {
		return fmt.Errorf("session: starting the AAC encoder: %w", err)
	}

	s.audioMixer = audiomix.NewMixer()
	s.screenAudioSource = audiomix.NewSource()
	s.audioMixer.AddSource("screen", s.screenAudioSource)

	s.storeEncoder(enc)
	s.audioFrag = pipeline.NewAudioFragmenter(pipeline.AudioConfig{
		Timescale:       aacenc.SampleRate,
		PartDuration:    cfg.PartTicks,
		SegmentDuration: cfg.SegmentTicks,
	})
	if cfg.StartSegmentIndex > 0 {
		s.audioFrag.SetStartSegmentIndex(cfg.StartSegmentIndex)
	}
	if cfg.StartSequence > 0 {
		s.audioFrag.SetStartSequence(cfg.StartSequence)
	}
	s.audioRing = cfg.Ring

	audioInit, err := cmaf.BuildAudioInitSegment(cmaf.AudioInitParams{
		Timescale:  aacenc.SampleRate,
		SampleRate: aacenc.SampleRate,
		Channels:   aacenc.Channels,
	})
	if err != nil {
		// aacenc.SampleRate/Channels are fixed, valid constants: this is
		// unreachable in practice. Fail loudly rather than silently
		// serving an audio rendition with no init segment.
		enc.Close()
		return fmt.Errorf("session: building the audio init segment: %w", err)
	}
	s.audioRing.SetNamedInit("audio-init.mp4", audioInit, false)
	s.enqueueR2("audio-init.mp4", audioInit, "audio/mp4")

	done := make(chan struct{})
	failed := make(chan struct{})
	s.audioReaderDone = done
	s.audioEncoderFailed = failed
	go s.readEncoderFrames(enc, done, failed)
	go s.runAudioPacer(ctx, cfg)

	return nil
}

// EnableR2 turns on async upload of every closed segment (video, and
// audio once EnableAudio has also been called) plus each track's init
// segment, to writer under the LiveKit-room-is-the-channel-id key layout
// r2.ObjectPrefix computes (channelID, startedAtMs, rung). This is L1.4,
// independent of L1.3: a Session may enable R2 with no audio, audio with
// no R2, both, or neither.
//
// Call at most once, and before EnableAudio if both are used (see
// EnableAudio's doc comment).
func (s *Session) EnableR2(writer *r2.Writer, channelID string, startedAtMs int64, rung string) {
	s.r2Writer = writer
	s.r2ChannelID = channelID
	s.r2StartedAtMs = startedAtMs
	s.r2Rung = rung
}

// EnableVodIndex hands this Session the index it records every closed
// segment into, so the session's `video.m3u8` / `audio.m3u8` / `master.m3u8`
// can be written beside the media. A no-op path when never called (every
// method on a nil *r2.VodIndex is), which is what keeps a Session with no
// replay copy behaving exactly as it did.
//
// The index belongs to the SESSION, not to this pipeline: pass the same one
// to a replacement built by internal/control's watchdog restart, or the
// replay loses everything the predecessor wrote (see r2.VodIndex's own doc
// comment). Call at most once, before the session receives anything.
func (s *Session) EnableVodIndex(index *r2.VodIndex) {
	s.vod = index
	s.vodInitNames = make(map[string]string)
}

func (s *Session) objectPrefix() string {
	return r2.ObjectPrefix(s.r2ChannelID, s.r2StartedAtMs, s.r2Rung)
}

// publishVodPlaylist enqueues one rendered playlist under this session's
// prefix. Through the SAME async writer the segments go through, so a slow
// or dead bucket degrades the replay copy and never blocks the media
// pipeline; a PUT that fails is logged by the writer and simply rewritten
// whole on the next segment, since every render is the complete playlist and
// the object is last-write-wins.
func (s *Session) publishVodPlaylist(name string, body string, ok bool) {
	if !ok || s.r2Writer == nil {
		return
	}
	s.enqueueR2(name, []byte(body), r2.PlaylistContentType)
}

// publishVodVideoPlaylists writes the video media playlist and, when there is
// an init to describe, the multivariant playlist beside it. The master is
// rewritten on every segment rather than once: it costs one small PUT per
// segment and it is the only thing that picks up a parameter-set change's new
// CODECS/RESOLUTION without a second code path to get wrong.
func (s *Session) publishVodVideoPlaylists() {
	if s.vod == nil || s.r2Writer == nil {
		return
	}
	body, ok := s.vod.VideoPlaylist()
	s.publishVodPlaylist(r2.VodVideoPlaylistName, body, ok)
	master, ok := s.vod.MasterPlaylist()
	s.publishVodPlaylist(r2.VodMasterPlaylistName, master, ok)
}

func (s *Session) publishVodAudioPlaylist() {
	if s.vod == nil || s.r2Writer == nil {
		return
	}
	body, ok := s.vod.AudioPlaylist()
	s.publishVodPlaylist(r2.VodAudioPlaylistName, body, ok)
}

// finishVodPlaylists stamps #EXT-X-ENDLIST on whatever exists and rewrites
// all three objects one last time. Called from Close, which runs BEFORE
// r2.Writer.Close in every teardown path (see internal/control's
// remuxPipeline.Close), so these last PUTs still get a worker.
func (s *Session) finishVodPlaylists() {
	if s.vod == nil || s.r2Writer == nil {
		return
	}
	s.vod.Finish()
	s.publishVodVideoPlaylists()
	s.publishVodAudioPlaylist()
}

// enqueueR2 is a no-op when EnableR2 was never called, so every call site
// elsewhere in this file can call it unconditionally.
func (s *Session) enqueueR2(name string, body []byte, contentType string) {
	if s.r2Writer == nil {
		return
	}
	s.r2Writer.Enqueue(s.objectPrefix()+"/"+name, body, contentType)
}

// MarkSubscribed flips Health().Subscribed to true; call it once the
// presenter's screen-share video track is actually found (subscriber's
// OnVideoTrackFound), not merely once the room connects.
func (s *Session) MarkSubscribed() { s.subscribed.Store(true) }

// SetKeyframeRequester wires a keyframe.Requester in (or out, with nil)
// after construction. Safe to call concurrently with HandleVideoPacket.
func (s *Session) SetKeyframeRequester(r *keyframe.Requester) { s.keyReq.Store(r) }

// SetStartSegmentIndex overrides the index the video track's FIRST segment
// will carry (0 by default). Call it, if at all, immediately after New and
// before the first HandleVideoPacket call: L1.6's control-plane watchdog
// restart uses this so a replacement pipeline's segment numbering (and
// therefore its R2 object keys, internal/r2.ObjectPrefix) continues from
// where a stalled predecessor left off, instead of starting back at 0 and
// silently overwriting objects the predecessor already uploaded (Farol
// review, PR #584).
func (s *Session) SetStartSegmentIndex(index int) { s.frag.SetStartSegmentIndex(index) }

// SetStartPartSequence makes the video track's NEXT part carry sequence
// number next -- the part-level twin of SetStartSegmentIndex, added
// because state.json (internal/llstate) now publishes part FILE NAMES to
// the edge Worker, which caches them by path alone. See
// pipeline.Fragmenter.SetStartSequence for the full reasoning. Call it,
// if at all, immediately after New and before the first
// HandleVideoPacket.
func (s *Session) SetStartPartSequence(next uint32) { s.frag.SetStartSequence(next) }

// SetStartInitGeneration makes the video track's FIRST init segment the
// (n+1)th this session has published, so its R2 object is
// `video-init-<n+1>.mp4` rather than `video-init.mp4` again. The init-level
// twin of SetStartSegmentIndex: a watchdog replacement numbering its inits
// from 1 overwrote the predecessor's `video-init.mp4` with its own, and
// every earlier segment in the replay's playlist would then be decoded
// against an init that does not describe it. Call it, if at all,
// immediately after New and before the first HandleVideoPacket.
func (s *Session) SetStartInitGeneration(n uint64) { s.initGeneration.Store(n) }

// CurrentInitGeneration is how many video inits this session has published,
// counting any SetStartInitGeneration offset. Read through Health after
// Close by the watchdog restart, for the replacement's
// SetStartInitGeneration.
func (s *Session) CurrentInitGeneration() uint64 { return s.initGeneration.Load() }

// CurrentVideoPartSequence returns the sequence number of the last part
// the video fragmenter emitted (0 before the first). internal/control
// reads it (via Health) after closing a stalled pipeline, so the
// replacement can resume past it.
func (s *Session) CurrentVideoPartSequence() uint32 { return s.frag.CurrentSequence() }

// CurrentAudioPartSequence is CurrentVideoPartSequence's audio
// counterpart; 0 before EnableAudio has ever run.
func (s *Session) CurrentAudioPartSequence() uint32 {
	if s.audioFrag == nil {
		return 0
	}
	return s.audioFrag.CurrentSequence()
}

// CurrentVideoSegmentIndex returns the video fragmenter's current (open,
// not-yet-sealed) segment index. internal/control reads this (via Health,
// remux_pipeline.go) before closing a stalled pipeline, so the replacement
// built by SetStartSegmentIndex above can continue past it -- see that
// method's doc comment for the full reasoning.
func (s *Session) CurrentVideoSegmentIndex() int { return s.frag.CurrentSegmentIndex() }

// CurrentAudioSegmentIndex is CurrentVideoSegmentIndex's audio
// counterpart; 0 before EnableAudio has ever run (no fragmenter exists yet,
// so there is nothing meaningful to continue).
func (s *Session) CurrentAudioSegmentIndex() int {
	if s.audioFrag == nil {
		return 0
	}
	return s.audioFrag.CurrentSegmentIndex()
}

// HandleVideoPacket feeds one RTP packet from the subscribed screen-share
// video track through depacketization, CMAF muxing and the ring, in that
// order. A malformed packet is logged and otherwise ignored: one bad
// packet must not take down the whole session (the depacketizer already
// keeps accumulating past it; see internal/h264's doc comment).
func (s *Session) HandleVideoPacket(pkt *rtp.Packet) {
	s.videoMu.Lock()
	defer s.videoMu.Unlock()

	if s.DemoteReason() != "" {
		return
	}

	now := s.now()
	s.videoPacketsSeen.Add(1)
	s.lastVideoPacketAtNs.Store(now.UnixNano())

	for _, ordered := range s.reorder.push(pkt, now) {
		s.handleOrderedVideoPacket(ordered, now)
	}
}

// handleOrderedVideoPacket is HandleVideoPacket after the reorder buffer:
// packets arrive here in sequence order, with any hole the buffer gave up
// on left for the depacketizer's sequence check to catch.
func (s *Session) handleOrderedVideoPacket(pkt *rtp.Packet, now time.Time) {
	aus, err := s.dep.PushRTP(pkt.Payload, pkt.SequenceNumber, pkt.Timestamp, pkt.Marker)
	if err != nil {
		if errors.Is(err, h264.ErrLatePacket) {
			s.videoLatePackets.Add(1)
			return
		}
		s.videoDepacketizeErrs.Add(1)
		s.logDepacketizeError(now, err)
		if h264.IsDamage(err) {
			s.markDamaged(now, err)
		}
	}
	// One packet can close two access units: the markerless AU in front of
	// it plus its own, when it is a whole single-packet frame. Deliver them
	// in the order the depacketizer returned, which is PTS order, because
	// the fragmenter's timeline depends on it.
	for _, au := range aus {
		if au == nil {
			continue
		}
		if !s.deliverAccessUnit(au, now) {
			return
		}
	}
}

// deliverAccessUnit is the per-AU half of handleOrderedVideoPacket. It
// returns false when the session must stop accepting access units at all
// (it demoted itself off the LL rung); an AU that is merely skipped
// returns true, because the ones behind it are still good.
func (s *Session) deliverAccessUnit(au *h264.AccessUnit, now time.Time) bool {
	if au.Markerless {
		n := s.videoMarkerlessAUs.Add(1)
		if s.markerlessLogged.CompareAndSwap(false, true) {
			// Once per session: this publisher does not always set the
			// marker bit, and that is legal. The running count is
			// markerless= on the stats line.
			log.Printf("pqp-remux: video: access unit closed by the RTP timestamp, no marker packet (delivered, not damage; %d so far)", n)
		}
	}

	silence := s.idleFor(now)
	s.videoFramesSeen.Add(1)
	s.lastVideoFrameAtNs.Store(now.UnixNano())
	if s.videoIdle.CompareAndSwap(true, false) {
		log.Printf("pqp-remux: video source resumed: first frame after %s of silence (frames=%d idr=%d)",
			silence.Round(time.Millisecond), s.videoFramesSeen.Load(), s.videoKeyframesSeen.Load())
	}

	if au.IsIDR {
		s.damageOpen.Store(false)
		s.videoKeyframesSeen.Add(1)
		s.lastIdrAtMs.Store(s.elapsedMs())
		s.idrSeen.Store(true)
		if kr := s.keyReq.Load(); kr != nil {
			kr.OnIDR(now)
		}
	}

	if len(au.SPS) > 0 && len(au.PPS) > 0 {
		if !s.initSet.Load() {
			if !s.publishInit(au.SPS, au.PPS, ring.DefaultInitURI, false) {
				// Build failed; keep waiting for a later pair.
			}
		} else if !bytes.Equal(au.SPS, s.initSPS) || !bytes.Equal(au.PPS, s.initPPS) {
			if !s.handleParameterSetChange(au) {
				return s.DemoteReason() == ""
			}
			if s.DemoteReason() != "" {
				return false
			}
		}
	}
	if s.droppingDamaged.Load() {
		// A damaged parameter set poisoned this GOP: every frame until the
		// next keyframe references pictures that never decoded. Drop them
		// rather than hand the decoder slices it will reject (-12911 measured).
		if !au.IsIDR {
			s.damagedAUsDropped.Add(1)
			return true
		}
		s.droppingDamaged.Store(false)
	}

	frags, err := s.frag.Push(au)
	if err != nil && err != pipeline.ErrWaitingForIDR {
		log.Printf("pqp-remux: fragmenter: %v", err)
	}
	// One access unit closes at most one part in the ordinary case, and
	// several when clock cutting fills a long frame gap with repeat
	// frames (pipeline.Fragmenter.SetRepeater). Publish them in order: the
	// ring's own sequence numbering depends on it.
	for _, frag := range frags {
		s.publish(frag)
	}
	s.mirrorRepeatCounters()
	return true
}

// mirrorRepeatCounters copies the fragmenter's repeat-frame counters into
// atomics Stats can read. Called on the two paths that move them, both
// already holding videoMu.
func (s *Session) mirrorRepeatCounters() {
	s.repeatFrames.Store(s.frag.RepeatFrames())
	s.clockCuts.Store(s.frag.ClockCuts())
}

// EnableClockCutParts turns on clock-cut parts for this session: every
// part closes at exactly the part target, with the remainder of a long
// frame gap filled by synthesized frames that repeat the picture already
// on screen (internal/skipframe). Call it immediately after New, before
// the session receives anything.
//
// It is a REQUEST, not a guarantee. The synthesizer refuses any stream
// whose parameter sets it cannot write a correct slice for (CABAC,
// multiple slice groups, weighted prediction, field coding,
// pic_order_cnt_type other than 2, more than one reference frame), and a
// session on such a stream behaves exactly as it does with this off:
// parts close on access units and may run longer than the target. What
// the publisher actually sends decides, and the stats line's repeats/cuts
// counters are what say which way it went.
func (s *Session) EnableClockCutParts() { s.clockCutParts = true }

// SetReorderHold sets how long this session's video reorder buffer holds
// a packet waiting for the one in front of it (REORDER_HOLD_MS). Zero
// turns holding off entirely: every gap goes straight to the depacketizer,
// which is the behaviour before the buffer existed and the rollback if the
// hold ever costs more than it buys.
//
// Call it immediately after New, before the session receives anything --
// it REPLACES the buffer, so anything already pending would be dropped.
func (s *Session) SetReorderHold(d time.Duration) {
	s.videoMu.Lock()
	defer s.videoMu.Unlock()
	s.reorder = newReorderBuffer(d)
}

// publishInit builds and stores one video init segment. Returns false when
// BuildInitSegment rejects the pair (caller keeps waiting / demotes).
func (s *Session) publishInit(sps, pps []byte, uri string, discontinuity bool) bool {
	initSeg, err := cmaf.BuildInitSegment(cmaf.InitParams{
		Timescale: h264.ClockRate,
		SPS:       sps,
		PPS:       pps,
	})
	if err != nil {
		log.Printf("pqp-remux: building init segment %s: %v", uri, err)
		return false
	}
	s.ring.SetNamedInit(uri, initSeg, discontinuity)
	s.initSPS = append([]byte(nil), sps...)
	s.initPPS = append([]byte(nil), pps...)
	s.initSet.Store(true)
	// discontinuity is exactly "these are new parameter sets, not the
	// session's first", which is also exactly when the replacement
	// synthesizer has to wait for the segment boundary.
	s.refreshRepeater(sps, pps, discontinuity)
	gen := s.initGeneration.Add(1)
	r2Name := "video-init.mp4"
	if gen > 1 {
		r2Name = fmt.Sprintf("video-init-%d.mp4", gen)
	}
	s.enqueueR2(r2Name, initSeg, "video/mp4")
	if s.vodInitNames != nil {
		s.vodInitNames[uri] = r2Name
	}
	// The codec string and picture size the replay's multivariant playlist
	// states, taken from the SPS this init was just built from rather than
	// re-parsed out of the init segment afterwards.
	w, h, _, _ := spsSummary(sps)
	s.vod.SetVideoInit(avcCodecString(sps), int(w), int(h))
	return true
}

// avcCodecString builds the RFC 6381 `avc1.PPCCLL` string a CODECS attribute
// needs, straight from the SPS NAL's first three payload bytes
// (profile_idc, the constraint-set/reserved byte, level_idc) -- which is
// exactly what an avcC record carries and what tools/hls-edge's
// ll-init-codecs.js reads back out of one. Empty for a payload too short to
// hold them, in which case the master playlist simply is not written yet.
func avcCodecString(sps []byte) string {
	if len(sps) < 4 {
		return ""
	}
	return fmt.Sprintf("avc1.%02x%02x%02x", sps[1], sps[2], sps[3])
}

// refreshRepeater rebuilds the repeat-frame synthesizer for the parameter
// sets the init segment was just built from, and hands it to the
// fragmenter. Called from publishInit, under videoMu, for the same reason
// it exists: a synthesized frame carries the picture's macroblock count,
// so one written against the previous SPS decodes to a DIFFERENT picture
// after Chrome's screen-share encoder ramps from 640x360 to 1280x720 --
// which is not hypothetical, it is what the first run of skipframe's
// bitstream test against a real capture caught.
//
// A stream the synthesizer refuses leaves the fragmenter with no
// repeater, which is exactly its pre-clock-cut behaviour: parts close on
// access units and may run long. That is a log line, never an error.
//
// atNextSegment says the parameter sets CHANGED rather than arrived, in
// which case the replacement must not take over until the segment that
// the new init describes actually opens. Swapping any earlier writes
// frames for the new picture size into the last part of the old segment,
// which is undecodable against the init that part is listed under: it
// happened on London staging on 2026-09-17 at 23:11:00Z, one part wide,
// "mb_skip_run 3645 is invalid" from ffmpeg. See
// pipeline.Fragmenter.SetRepeaterAtNextSegment.
func (s *Session) refreshRepeater(sps, pps []byte, atNextSegment bool) {
	if !s.clockCutParts {
		return
	}
	arm := s.frag.SetRepeater
	when := "now"
	if atNextSegment {
		arm = s.frag.SetRepeaterAtNextSegment
		when = "at the next segment boundary"
	}
	synth, err := skipframe.New(sps, pps)
	if err != nil {
		log.Printf("pqp-remux: clock-cut parts unavailable for this stream (%s): %v", when, err)
		s.synth = nil
		arm(nil)
		return
	}
	synth.Inherit(s.synth)
	s.synth = synth
	arm(synth)
	log.Printf("pqp-remux: clock-cut parts armed %s: parts close on the clock, gaps filled with repeat frames (inserted=%d renumbered=%d)",
		when, synth.Inserted(), synth.Rewritten())
}

// handleParameterSetChange rebuilds the init segment when the publisher's
// in-band SPS/PPS differ from the ones the current init was built from.
// Production 2026-09-16: Chrome's screen-share encoder starts at 640x360
// and ramps to 1280x720 a second or two later; the remuxer that captured
// the 360p SPS into init.mp4 then delivered 720p frames against it, and
// every viewer died with MEDIA_ERR_DECODE for the rest of the party.
//
// On a real change with an IDR: arm a forced segment boundary, publish a
// new init-N.mp4, and mark the next segment discontinuous. Without an
// IDR, or if the new init cannot be built, demote — shipping undecodable
// media is worse than falling back to the conventional ladder.
// handleParameterSetChange reports whether the access unit may continue into
// the fragmenter. False means it carried a damaged parameter set and must be
// dropped, along with the rest of its GOP.
func (s *Session) handleParameterSetChange(au *h264.AccessUnit) bool {
	oldW, oldH, oldProfile, oldLevel := spsSummary(s.initSPS)
	newW, newH, newProfile, newLevel := spsSummary(au.SPS)
	segIdx := s.frag.CurrentSegmentIndex()
	partSeq := s.frag.CurrentSequence()

	if !plausibleVideoDimensions(newW, newH) {
		// A parameter set that parses to an absurd picture size is corruption
		// (a truncated SPS at the tail of a stream, a packet-loss-damaged NAL),
		// not a publisher decision. Measured 2026-09-16: the end of a test
		// stream produced a 2x2 SPS plus a 160-byte "IDR"; rebuilding the init
		// on it killed every viewer's decoder. Keep the init we have and skip
		// this access unit's parameter sets; the next sane pair is honoured.
		s.implausibleParamSets.Add(1)
		s.droppingDamaged.Store(true)
		log.Printf("pqp-remux: parameter-set change ignored, implausible dimensions: old=%dx%d profile=%d level=%d -> new=%dx%d profile=%d level=%d (seg=%d part=%d); dropping this GOP",
			oldW, oldH, oldProfile, oldLevel, newW, newH, newProfile, newLevel, segIdx, partSeq)
		return false
	}
	if !au.IsIDR {
		log.Printf("pqp-remux: parameter-set change without IDR: old=%dx%d profile=%d level=%d -> new=%dx%d profile=%d level=%d (seg=%d part=%d); demoting",
			oldW, oldH, oldProfile, oldLevel, newW, newH, newProfile, newLevel, segIdx, partSeq)
		s.requestDemote("parameter-set-change-without-idr")
		return true
	}

	nextGen := s.initGeneration.Load() + 1
	uri := fmt.Sprintf("init-%d.mp4", nextGen)
	s.frag.ForceSegmentBoundary()
	if !s.publishInit(au.SPS, au.PPS, uri, true) {
		log.Printf("pqp-remux: parameter-set change could not build init %s: old=%dx%d profile=%d level=%d -> new=%dx%d profile=%d level=%d (seg=%d part=%d); demoting",
			uri, oldW, oldH, oldProfile, oldLevel, newW, newH, newProfile, newLevel, segIdx, partSeq)
		s.requestDemote("parameter-set-change-init-failed")
		return true
	}
	log.Printf("pqp-remux: parameter-set change: old=%dx%d profile=%d level=%d -> new=%dx%d profile=%d level=%d (seg=%d part=%d); published %s as a new init map",
		oldW, oldH, oldProfile, oldLevel, newW, newH, newProfile, newLevel, segIdx, partSeq, uri)
	return true
}

// markDamaged is the response to the depacketizer throwing media away: ask
// the publisher for a keyframe at once (Requester.OnLoss, then a retry
// every second while it is owed) instead of after the periodic gate. The
// frames that follow may reference what was lost and are forwarded anyway:
// a decoder conceals a missing reference for the ~300 ms until the IDR
// lands, which every player survived for months, whereas holding those
// frames back (tried 2026-09-17 20:04Z to 21:45Z) stretched one sample
// across the whole wait, put PART-TARGET at seconds for the rest of the
// session, and that is a playlist Apple refuses outright ("non-terminal
// partial segment duration must be at least 85% of PART-TARGET") and
// hls.js stalls on. The malformed access unit itself never goes out; that
// is the depacketizer's job and the part that killed viewers.
//
// damagedEpisodes counts these; the drop-until-IDR path stays for the
// implausible-parameter-set case only (handleParameterSetChange), where
// the frames that follow are damaged themselves, not merely mis-referenced.
func (s *Session) markDamaged(now time.Time, cause error) {
	if !s.damageOpen.CompareAndSwap(false, true) {
		return
	}
	s.damageEpisodes.Add(1)
	pliSent := false
	if kr := s.keyReq.Load(); kr != nil {
		pliSent = kr.OnLoss(now)
	}
	// gap= is THIS episode's gap, lostTotal= the session's running total.
	// They used to be one field called `lost=`, which was the cumulative
	// total: an analysis of the 2026-09-17 stalls read the differences
	// between successive episodes' `lost=` as burst lengths, and since an
	// episode latches until the next IDR (the CAS above) each of those
	// differences was a sum over an unknown number of holes. Two numbers,
	// each named for what it is. See h264.Depacketizer.GapHistogram for
	// the shape across the whole session.
	log.Printf("pqp-remux: video damage: %v; keyframe requested (episode %d, gap=%d, lostTotal=%d, pli=%t)",
		cause, s.damageEpisodes.Load(), s.dep.LastGap(), s.dep.LostPackets(), pliSent)
}

func (s *Session) requestDemote(reason string) {
	if reason == "" {
		return
	}
	// First writer wins: a later call must not erase the original cause.
	if cur, _ := s.demoteReason.Load().(string); cur != "" {
		return
	}
	s.demoteReason.Store(reason)
}

// DemoteReason is non-empty when this session has asked the control plane
// to demote it off the LL rung. The watchdog reads it every tick.
func (s *Session) DemoteReason() string {
	if v, ok := s.demoteReason.Load().(string); ok {
		return v
	}
	return ""
}

// spsSummary pulls the fields the parameter-set-change log line wants.
// A malformed SPS still yields profile/level from the header bytes when
// present; width/height stay zero.
// plausibleVideoDimensions bounds what a real publisher can send. Below 64
// lines is smaller than any screen share or camera this codebase publishes;
// above 8192 is beyond every H.264 level. Either means the SPS is damaged.
func plausibleVideoDimensions(width, height uint32) bool {
	return width >= 64 && height >= 64 && width <= 8192 && height <= 8192
}

func spsSummary(sps []byte) (width, height, profile, level uint32) {
	if len(sps) >= 4 {
		profile = uint32(sps[1])
		level = uint32(sps[3])
	}
	if info, err := nal.ParseSPS(sps); err == nil {
		width, height = info.Width, info.Height
	}
	return
}

// Finish flushes any partial fragment still open in the fragmenter and
// publishes it, exactly as HandleVideoPacket would for a fragment closed
// by a part/segment boundary. Call it once, when the subscribed video
// track ends (subscriber.Handlers.OnVideoTrackEnded): without it, whatever
// was accumulated since the last part boundary is silently lost, and a
// stream that ends between parts never exposes its true tail through
// /part-*.m4s or the segment it belongs to.
//
// It also uploads the now-final video segment to R2 (if EnableR2 was
// called): the stream ending is what closes that segment, in the same
// sense a mid-stream rollover closes the one before it.
func (s *Session) Finish() {
	s.videoMu.Lock()
	defer s.videoMu.Unlock()

	frag, err := s.frag.Flush()
	if err != nil {
		log.Printf("pqp-remux: flushing the trailing fragment: %v", err)
		return
	}
	if frag != nil {
		s.publish(frag)
	}
	s.uploadVideoSegment(s.frag.CurrentSegmentIndex())
}

// Close stops the AAC encoder subprocess started by EnableAudio, if any,
// and waits for it to exit. Safe to call even when EnableAudio was never
// called or failed. Call once, on process shutdown, AFTER cancelling the
// ctx EnableAudio was given: cancelling ctx first stops runAudioPacer
// from writing any more PCM, so this Close drains whatever the encoder
// already has rather than racing a final in-flight write against the
// pipe this closes.
//
// Close takes audioMu before deciding what to close, the same lock
// recoverAudioEncoder holds for its entire body: if a restart is
// in-flight when Close runs, Close blocks here until that restart
// finishes, THEN closes whichever encoder the restart left as current —
// never the (possibly already-closed) one that failed. This is what
// makes a replacement ffmpeg unable to outlive the session: either Close
// runs to completion before any restart begins, or it waits for the
// restart and closes its result, and no third interleaving exists
// because recoverAudioEncoder never releases audioMu in between.
func (s *Session) Close() {
	// Fence the video side first: taking videoMu waits out a keep-alive
	// tick that is already inside the fragmenter, and the flag stops any
	// later one from entering. See the videoStopped field.
	s.videoMu.Lock()
	s.videoStopped = true
	s.videoMu.Unlock()

	// DEFERRED, because this method has four early returns and the replay
	// playlists have to be stamped ENDLIST on every one of them. Last, so
	// the audio tail below is already in the index when they are rendered,
	// and still inside Close, which every teardown path runs BEFORE
	// r2.Writer.Close -- so these final PUTs get a worker.
	defer s.finishVodPlaylists()

	s.audioMu.Lock()
	s.audioClosed = true
	enc := s.loadEncoder()
	readerDone := s.audioReaderDone
	s.audioMu.Unlock()

	if enc == nil {
		return
	}
	enc.Close() // stops feeding ffmpeg, waits for it to exit and drain its own ADTS reader

	// Bounded wait for THIS session's own reader goroutine to finish
	// processing whatever aacenc.Encoder.Close just finished delivering:
	// without this, the final segment upload below could run before the
	// last few AAC frames ever reach audioFrag, silently truncating the
	// tail of the audio track. Bounded (not "wait forever") for the same
	// reason r2.Writer.Close is: shutdown must complete even if something
	// downstream is unexpectedly stuck.
	//
	// drained records whether that wait actually SUCCEEDED, which is a
	// different question from whether it finished, and the difference is
	// load bearing: the only thing that makes audioFrag safe to touch
	// from this goroutine is the reader having returned (AudioFragmenter
	// is explicitly not safe for concurrent use, and audioClosed --
	// already set above, under audioMu -- is what stops a replacement
	// reader from ever starting). On the timeout branch the reader may
	// still be inside Push, so nothing below may look at the fragmenter
	// at all. Farol review, PR #623.
	drained := true
	if readerDone != nil {
		select {
		case <-readerDone:
		case <-time.After(audioCloseFlushDeadline):
			drained = false
			log.Printf("pqp-remux: timed out after %s waiting for the audio reader to drain during shutdown; the final segment may be incomplete", audioCloseFlushDeadline)
		}
	}

	// The session ending is what closes the audio track's last (still
	// open) segment, in the same sense Finish does for video: nothing
	// else will ever start a *next* segment to trigger the ordinary
	// roll-over upload.
	if s.audioFrag == nil {
		return
	}
	if drained {
		// Drain the part still accumulating inside the fragmenter
		// BEFORE uploading the final segment: since parts batch to
		// PART_MS, up to half a second of already-encoded audio is held
		// there at any instant, and it belongs in the segment this
		// upload is about to seal. Only reachable with drained true --
		// see its declaration.
		if frag := s.audioFrag.Flush(); frag != nil {
			s.publishAudioPart(frag)
		}
	}
	// Which segment to upload is asked of the RING, not of the
	// fragmenter. The ring answers under its own lock, so this is
	// correct on the timeout branch too -- where the racing reader is
	// also the thing still pushing into it, and the ring's own last
	// segment is exactly as up to date as that reader has managed to
	// make it. (It used to be audioFrag.CurrentSegmentIndex(), an
	// unsynchronized read of the same not-concurrency-safe type.)
	if s.audioRing == nil {
		return
	}
	if index, ok := s.audioRing.LastSegmentIndex(); ok {
		s.uploadAudioSegment(index)
	}
}

// publishAudioPart is readEncoderFrames' and Close's shared tail: push one
// closed audio part into the ring, upload whichever segment that sealed,
// and count it. Push FIRST, upload second -- Ring.Push is what marks the
// previous segment sealed, exactly as publish's own comment explains for
// video.
func (s *Session) publishAudioPart(frag *pipeline.Fragment) {
	sealedIndex := -1
	if frag.IsSegmentStart && frag.SegmentIndex > 0 {
		sealedIndex = frag.SegmentIndex - 1
	}
	s.audioRing.Push(frag)
	if sealedIndex >= 0 {
		s.uploadAudioSegment(sealedIndex)
		s.audioSegmentsWritten.Add(1)
	}
	s.audioPartsWritten.Add(1)
	s.audioBytesWritten.Add(uint64(len(frag.Bytes)))
	s.recordMedia(&s.audioMediaMs, &s.audioTimelineAnchorNs, frag.DurationTicks, aacenc.SampleRate)
}

// audioCloseFlushDeadline bounds Close's wait for the audio reader to
// finish draining the encoder's final output. Generous next to a single
// AAC frame's own cadence (~21ms) but still short enough not to
// meaningfully delay process shutdown if the reader is ever stuck.
//
// A var, not a const, only so a test can exercise the TIMEOUT branch --
// the one where Close must not touch the fragmenter at all -- without
// spending five real seconds on it. Production never assigns it.
var audioCloseFlushDeadline = 5 * time.Second

// publish is HandleVideoPacket and Finish's shared tail: a fragment is
// only written into the ring once a valid init segment exists. Publishing
// media the very first client can never initialize is worse than briefly
// holding a fragment back — and since SPS/PPS repeat on (at least) every
// IDR, initSet reliably becomes true on the session's first keyframe in
// practice, so this is not a real availability cost.
func (s *Session) publish(frag *pipeline.Fragment) {
	if !s.initSet.Load() {
		return
	}
	if frag.IsSegmentStart {
		s.segmentOpenedAtMs.Store(s.elapsedMs())
	}
	sealedIndex := -1
	if frag.IsSegmentStart && frag.SegmentIndex > 0 {
		sealedIndex = frag.SegmentIndex - 1
	}
	// Push FIRST, upload second: Ring.Push is what actually marks the
	// previous segment sealed (Ring.updateTargetDuration, the sealed
	// flag Playlist() reads), so calling the upload only after Push
	// returns is what makes "uploaded" and "sealed" the same fact rather
	// than two events whose relative order depends on reading Ring's
	// internals correctly by inspection. See
	// TestSession_R2UploadHappensOnlyAfterSegmentSeals.
	s.ring.Push(frag)
	if sealedIndex >= 0 {
		s.uploadVideoSegment(sealedIndex)
		s.videoSegmentsWritten.Add(1)
	}
	s.partsWritten.Add(1)
	s.bytesWritten.Add(uint64(len(frag.Bytes)))
	s.lastPartAtMs.Store(s.elapsedMs())
	s.recordMedia(&s.videoMediaMs, &s.videoTimelineAnchorNs, frag.DurationTicks, h264.ClockRate)
}

// recordMedia adds one published part's own duration to a track's media
// total, anchoring the track's wall clock on the first part. See the
// videoMediaMs field.
func (s *Session) recordMedia(mediaMs *atomic.Int64, anchorNs *atomic.Int64, durationTicks uint32, timescale uint32) {
	if timescale == 0 {
		return
	}
	ms := int64(durationTicks) * 1000 / int64(timescale)
	if anchorNs.Load() == 0 {
		// The first part's media began one part-duration before we
		// published it, which is what makes media and wall directly
		// comparable from here on.
		anchorNs.Store(s.now().Add(-time.Duration(ms) * time.Millisecond).UnixNano())
	}
	mediaMs.Add(ms)
}

func (s *Session) uploadVideoSegment(index int) {
	if s.r2Writer == nil {
		return
	}
	b, ok := s.ring.Segment(index)
	if !ok {
		return
	}
	name := fmt.Sprintf("video-seg-%d.m4s", index)
	s.enqueueR2(name, b, "video/mp4")
	// The playlist line for what was just uploaded, and only then: an entry
	// naming an object no PUT was ever enqueued for is a 404 in somebody's
	// player two days from now.
	if meta, found := s.ring.SegmentMeta(index); found && s.vod != nil {
		s.vod.AddVideoSegment(r2.VodSegment{
			Name:          name,
			Seconds:       meta.Seconds,
			InitURI:       s.vodInitNameFor(meta.InitURI),
			Discontinuity: meta.Discontinuity || !s.vodVideoAdded.Swap(true),
		}, len(b))
		s.publishVodVideoPlaylists()
	}
}

// vodInitNameFor translates a ring init file name into the R2 object name
// publishInit uploaded it under. The fallback derivation exists only for a
// segment stamped with an init this Session never published itself (nothing
// produces one today), because a VOD entry with no EXT-X-MAP is a segment no
// decoder can configure itself for, which is worse than one naming the
// object by its own rule.
func (s *Session) vodInitNameFor(ringName string) string {
	if name, ok := s.vodInitNames[ringName]; ok {
		return name
	}
	return "video-" + ringName
}

func (s *Session) uploadAudioSegment(index int) {
	if s.r2Writer == nil {
		return
	}
	b, ok := s.audioRing.Segment(index)
	if !ok {
		return
	}
	name := fmt.Sprintf("audio-seg-%d.m4s", index)
	s.enqueueR2(name, b, "audio/mp4")
	if meta, found := s.audioRing.SegmentMeta(index); found && s.vod != nil {
		// The audio ring's init is the fixed "audio-init.mp4" EnableAudio
		// named it, which is also the object name it was PUT under, so
		// (unlike video) there is no name to translate.
		s.vod.AddAudioSegment(r2.VodSegment{
			Name:          name,
			Seconds:       meta.Seconds,
			InitURI:       meta.InitURI,
			Discontinuity: !s.vodAudioAdded.Swap(true),
		}, len(b))
		s.publishVodAudioPlaylist()
	}
}

// HandleAudioPacket decodes the presenter's screen-share audio and mixes
// it into the session's audio track (L1.3), once EnableAudio has been
// called; before that (or if it failed), packets are only counted, the
// pre-L1.3 behaviour.
func (s *Session) HandleAudioPacket(pkt *rtp.Packet) {
	if s.audioPacketsSeen.Add(1) == 1 {
		log.Printf("pqp-remux: screen-share audio track present (payload type %d)", pkt.PayloadType)
	}
	if s.screenAudioSource == nil {
		return
	}
	if err := s.screenAudioSource.Push(pkt.Payload, pkt.Timestamp, time.Now(), s.epoch); err != nil {
		log.Printf("pqp-remux: screen-share audio decode: %v", err)
	}
}

// MicAudioSink implements subscriber.AudioSink structurally (Go's
// interface satisfaction needs no import here — see NewMicSink's doc
// comment for why that is deliberate): one stage microphone's decode/mix
// state, added to the mixer on discovery and removed when the
// publication ends.
type MicAudioSink struct {
	session *Session
	id      string
	src     *audiomix.Source
}

// HandlePacket decodes one RTP packet from this microphone and mixes it
// in, at whatever position its RTP timestamp places it relative to the
// session's shared epoch.
func (m *MicAudioSink) HandlePacket(pkt *rtp.Packet) {
	if err := m.src.Push(pkt.Payload, pkt.Timestamp, time.Now(), m.session.epoch); err != nil {
		log.Printf("pqp-remux: microphone audio decode (%s): %v", m.id, err)
	}
}

// Close removes this microphone from the mix. Called exactly once, when
// the publication ends (the participant muted-and-unpublished, or left).
func (m *MicAudioSink) Close() {
	m.session.audioMixer.RemoveSource(m.id)
}

// noopMicAudioSink is returned by NewMicSink before EnableAudio has run:
// the track is still found and drained by internal/subscriber (its own
// contract), just discarded, mirroring how HandleAudioPacket behaves for
// the screen-share slot when audio mixing is off.
type noopMicAudioSink struct{}

func (noopMicAudioSink) HandlePacket(*rtp.Packet) {}
func (noopMicAudioSink) Close()                   {}

// micAudioSink is the interface both MicAudioSink and noopMicAudioSink
// satisfy; declared so NewMicSink has one return type regardless of
// whether audio is enabled, without this package importing
// internal/subscriber for its AudioSink interface (structural typing:
// *MicAudioSink already satisfies subscriber.AudioSink's method set, and
// main.go — which imports both packages — is where that gets named).
type micAudioSink interface {
	HandlePacket(pkt *rtp.Packet)
	Close()
}

// NewMicSink creates (or, before EnableAudio, stubs out) one stage
// microphone's mix slot, keyed by identity so a second publication from
// the same participant (e.g. a quick mute/unmute cycle that LiveKit
// represents as unpublish+republish) gets its own clean state rather than
// colliding with a still-draining previous one.
func (s *Session) NewMicSink(identity string) micAudioSink {
	if s.audioMixer == nil {
		return noopMicAudioSink{}
	}
	id := "mic:" + identity
	src := audiomix.NewSource()
	s.audioMixer.AddSource(id, src)
	return &MicAudioSink{session: s, id: id, src: src}
}

// runAudioPacer pulls fixed AAC-frame-sized chunks of mixed PCM from the
// mixer and writes them to the AAC encoder, at a cadence corrected
// against wall-clock elapsed time on every tick (framesElapsed) so
// scheduler jitter never accumulates into audio/video drift: only the
// *content* of each chunk is deterministic from the mixer's own sample
// cursor (Mixer.Pull), but *when* a chunk is requested is re-derived from
// time.Since(s.epoch) every tick, so a late tick catches up immediately
// rather than letting the whole session's audio fall progressively behind
// video. Stops when ctx is done, or when the audio pipeline is marked
// dead (see recoverAudioEncoder).
//
// This is the sole writer to s.audioEncoder (via Store, inside
// recoverAudioEncoder) and to s.audioReaderDone, so neither needs a lock
// beyond audioEncoder's own atomic.Pointer.
func (s *Session) runAudioPacer(ctx context.Context, cfg AudioConfig) {
	// Finer than one AAC frame (1024/48000 ~= 21.3ms) so a tick's own
	// jitter is caught up within roughly one tick, not one frame.
	const tick = 10 * time.Millisecond
	ticker := time.NewTicker(tick)
	defer ticker.Stop()

	var emittedFrames int
	restarted := false
	for {
		select {
		case <-ctx.Done():
			return
		case <-s.audioEncoderFailed:
			// The current generation's readEncoderFrames observed the
			// encoder end unexpectedly (aacenc's own "not asked for"
			// case: a crash, a kill, ffmpeg exiting on its own). Route
			// through the exact same recovery this pacer already uses
			// for a WriteSamples failure, so an ffmpeg crash gets one
			// restart attempt instead of the audio track quietly going
			// dark while Health() still reports it enabled.
			if !s.recoverAudioEncoder(ctx, cfg, &restarted) {
				s.markAudioDead()
				return
			}
		case <-ticker.C:
			if s.audioDead.Load() {
				return
			}
			n := framesElapsed(time.Since(s.epoch), aacenc.SamplesPerFrame, emittedFrames)
			for i := 0; i < n; i++ {
				pcm := s.audioMixer.Pull(aacenc.SamplesPerFrame)
				enc := s.loadEncoder()
				if enc == nil {
					s.markAudioDead()
					return
				}
				if err := enc.WriteSamples(pcm); err != nil {
					log.Printf("pqp-remux: writing PCM to the AAC encoder: %v", err)
					if !s.recoverAudioEncoder(ctx, cfg, &restarted) {
						s.markAudioDead()
						return
					}
					// The chunk that failed to write is lost (ffmpeg
					// never saw it), but emittedFrames must still
					// advance: it tracks the session's own sample clock
					// against wall-clock elapsed time (framesElapsed), not
					// how many chunks were actually delivered, so a lost
					// chunk here is a brief, bounded glitch rather than a
					// clock that falls behind and never catches up.
					emittedFrames++
					continue
				}
				emittedFrames++
			}
		}
	}
}

// recoverAudioEncoder is called from runAudioPacer's own goroutine after a
// WriteSamples failure: a broken pipe reported as "fine" by everything
// downstream is exactly pitfall 15's shape (see CLAUDE.md), so this
// process attempts exactly ONE replacement ffmpeg subprocess before
// giving up, rather than silently continuing to look alive while
// producing nothing.
//
// It closes the broken encoder and waits for its reader goroutine to
// fully finish (via audioReaderDone) BEFORE starting a replacement: two
// readEncoderFrames goroutines racing to call the single-writer
// s.audioFrag.Push at once, however briefly, is exactly the kind of bug
// this ordering exists to make impossible rather than merely unlikely
// (aacenc.Encoder.Close's own doc comment covers the first half of this —
// the ffmpeg subprocess and its internal ADTS reader are both fully done
// by the time Close returns — audioReaderDone covers the second half,
// this session's own consumer of that now-closed encoder).
//
// The whole body runs under audioMu, held for as long as newEncoderFunc
// takes (a real subprocess spawn, in production): that is deliberate, not
// an oversight — see Close's doc comment for why holding it across the
// entire restart, rather than releasing it around the slow part, is what
// makes "Close either fully precedes a restart or fully waits for one"
// true without a second check after construction. A shutdown racing this
// call blocks briefly on audioMu rather than closing a session while a
// replacement ffmpeg is still being decided.
//
// restarted is the pacer's own "have I already used my one restart"
// flag, passed by reference so both this call and the next tick's checks
// share it. Returns true if a replacement encoder is now running (the
// caller should keep going), false if a restart was already spent, the
// session is already closed, or the new subprocess itself failed to
// start.
func (s *Session) recoverAudioEncoder(ctx context.Context, cfg AudioConfig, restarted *bool) bool {
	s.audioMu.Lock()
	defer s.audioMu.Unlock()

	if old := s.loadEncoder(); old != nil {
		old.Close()
	}
	if s.audioReaderDone != nil {
		<-s.audioReaderDone
	}

	if s.audioClosed {
		log.Print("pqp-remux: session is closing; skipping the AAC encoder restart")
		return false
	}
	if *restarted {
		log.Print("pqp-remux: AAC encoder failed again after its one allowed restart; giving up on audio for this session")
		return false
	}
	*restarted = true

	enc, err := newEncoderFunc(ctx, cfg.Encoder)
	if err != nil {
		log.Printf("pqp-remux: restarting the AAC encoder failed: %v", err)
		return false
	}
	s.audioRestarts.Add(1)
	s.storeEncoder(enc)
	done := make(chan struct{})
	failed := make(chan struct{})
	s.audioReaderDone = done
	s.audioEncoderFailed = failed // a fresh channel: the old one may already be closed, and a closed channel is always select-ready, which would re-trigger recovery every tick
	go s.readEncoderFrames(enc, done, failed)
	log.Print("pqp-remux: AAC encoder restarted")
	return true
}

// markAudioDead permanently flags the audio pipeline as unavailable:
// Health().AudioDead reports it so a broken pipe that would otherwise
// still "look enabled" (audioFrag stays non-nil) is visible on /healthz
// instead of silently producing nothing — pitfall 15's lesson applied to
// this task's own failure mode.
func (s *Session) markAudioDead() {
	s.audioDead.Store(true)
	log.Print("pqp-remux: audio pipeline marked dead; video passthrough is unaffected")
}

// framesElapsed returns how many whole frameSamples-sized frames should
// have been emitted by now (elapsed since the session's epoch), given how
// many already have. Wall-clock-anchored so a delayed tick catches up
// rather than drifting (ticker jitter never accumulates): the error at
// any instant is bounded by one tick's worth of scheduling slack, not by
// how long the process has been running.
func framesElapsed(elapsed time.Duration, frameSamples, emitted int) int {
	targetSamples := int64(elapsed.Seconds() * audiomix.SampleRate)
	targetFrames := int(targetSamples / int64(frameSamples))
	if targetFrames <= emitted {
		return 0
	}
	return targetFrames - emitted
}

// readEncoderFrames is the single goroutine that ever calls
// s.audioFrag.Push (see AudioFragmenter's own "not safe for concurrent
// use" doc comment) for one encoder generation: it reads each AAC frame
// enc produces, in order, assigns it the next 1024-sample slot on the
// audio track's own timeline (from the session-wide, restart-surviving
// audioNextPTS counter), and publishes the resulting CMAF fragment
// exactly like HandleVideoPacket does for video. Closes done (exactly
// once, via defer) when it returns, which is either encoder's Frames()
// channel closing (Session.Close was called, or the ffmpeg subprocess
// exited) or — see the loop body — never on Errs() alone, since Errs()
// closing only means no more error reports will ever arrive, not that
// Frames() is done delivering already-buffered data.
func (s *Session) readEncoderFrames(enc remuxEncoder, done, failed chan struct{}) {
	defer close(done)

	framesCh := enc.Frames()
	errsCh := enc.Errs()
	reportedFailure := false
	reportFailure := func(err error) {
		log.Printf("pqp-remux: AAC encode: %v", err)
		if !reportedFailure {
			reportedFailure = true
			close(failed) // wakes runAudioPacer's select immediately, even mid-tick
		}
	}

	for {
		select {
		case frame, ok := <-framesCh:
			if !ok {
				// The only definitive "no more data, ever" signal. But
				// aacenc.Encoder always queues an unexpected-exit error
				// (if any) onto Errs() BEFORE closing Frames() -- see
				// its own readADTS doc comment -- and select does not
				// guarantee we would have observed it first just
				// because it happened first, so take one last
				// non-blocking look here rather than risk silently
				// missing it.
				select {
				case err, ok2 := <-errsCh:
					if ok2 {
						reportFailure(err)
					}
				default:
				}
				return
			}
			s.audioFramesSeen.Add(1)
			pts := s.audioNextPTS.Add(aacenc.SamplesPerFrame) - aacenc.SamplesPerFrame
			// nil means "this part is not full yet": since PART_MS
			// batching, most frames land inside an open part rather
			// than becoming one. (Before that, every frame was a part,
			// which is the bug pipeline.AudioConfig documents.)
			if frag := s.audioFrag.Push(pts, aacenc.SamplesPerFrame, frame.Data); frag != nil {
				s.publishAudioPart(frag)
			}
		case err, ok := <-errsCh:
			if !ok {
				// Errs() will never send again, but Frames() may still
				// have buffered frames (or more to come, if this
				// happened mid-session rather than at shutdown): stop
				// selecting this channel (a nil channel blocks forever
				// in a select, so this case simply never fires again)
				// instead of returning, which would drop that data, and
				// instead of leaving it selectable, which would busy-loop
				// this case forever once closed (every receive on a
				// closed channel is immediately ready).
				errsCh = nil
				continue
			}
			reportFailure(err)
		}
	}
}

func (s *Session) elapsedMs() int64 { return time.Since(s.started).Milliseconds() }

// Started returns the wall-clock instant this Session was constructed
// (New). L1.6's control-plane pipeline wrapper (internal/control) uses it
// to convert the elapsed-millisecond fields Health() reports (LastPartAtMs,
// LastIdrAtMs) into the absolute Unix-millisecond values
// docs/plans/LL_HLS.md's control contract
// (packages/shared/src/hls-remux-control.ts) exposes on GET /sessions --
// this package's own /healthz (internal/serve) deliberately keeps reporting
// elapsed-ms, unchanged: that shape is already documented and tested, and
// only the control layer needs the absolute conversion.
func (s *Session) Started() time.Time { return s.started }

// HasPart reports whether this session has ever published a part, i.e.
// whether Health().LastPartAtMs actually names a real event rather than its
// zero value. Exists purely so a caller (internal/control) can report a
// nullable lastPartAtMs without guessing from the zero value alone.
func (s *Session) HasPart() bool { return s.partsWritten.Load() > 0 }

// HasIdr reports whether an IDR has ever been depacketized on this
// session's video track, for the same "distinguish zero from never" reason
// as HasPart.
func (s *Session) HasIdr() bool { return s.idrSeen.Load() }

// OpenSegmentMs reports how long the currently-open segment has been
// accumulating, in milliseconds, and whether one is open at all yet (false
// before the session's first IDR opens segment 0). docs/plans/LL_HLS.md §5
// names this exact quantity as something L1.6's watchdog needs; it did not
// exist before L1.6 added segmentOpenedAtMs.
func (s *Session) OpenSegmentMs() (ms int64, ok bool) {
	at := s.segmentOpenedAtMs.Load()
	if at < 0 {
		return 0, false
	}
	return s.elapsedMs() - at, true
}

// Health implements serve.HealthSource.
func (s *Session) Health() serve.Health {
	status := "waiting-for-track"
	if s.subscribed.Load() {
		status = "ok"
	}
	h := serve.Health{
		Status:       status,
		Subscribed:   s.subscribed.Load(),
		PartsWritten: s.partsWritten.Load(),
		BytesWritten: s.bytesWritten.Load(),
		LastPartAtMs: s.lastPartAtMs.Load(),
		LastIdrAtMs:  s.lastIdrAtMs.Load(),
	}
	if s.audioFrag != nil {
		h.AudioPartsWritten = s.audioPartsWritten.Load()
		h.AudioBytesWritten = s.audioBytesWritten.Load()
		h.AudioDead = s.audioDead.Load()
		h.AudioRestarts = s.audioRestarts.Load()
	}
	if s.r2Writer != nil {
		h.R2Uploaded = s.r2Writer.Uploaded()
		h.R2Failed = s.r2Writer.Failed()
		h.R2Dropped = s.r2Writer.Dropped()
	}
	return h
}
