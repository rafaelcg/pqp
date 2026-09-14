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
	"context"
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
	"github.com/rafaelcg/pqp/tools/pqp-remux/internal/pipeline"
	"github.com/rafaelcg/pqp/tools/pqp-remux/internal/r2"
	"github.com/rafaelcg/pqp/tools/pqp-remux/internal/ring"
	"github.com/rafaelcg/pqp/tools/pqp-remux/internal/serve"
)

// Session owns the one video track's whole pipeline: depacketize, mux,
// publish into the ring. HandleVideoPacket is meant to be called from a
// single goroutine (the subscriber's own RTP reader for that track), so the
// depacketizer/fragmenter/ring writes below need no lock of their own; the
// atomics exist only because Health() is read concurrently from HTTP
// handler goroutines.
type Session struct {
	dep  *h264.Depacketizer
	frag *pipeline.Fragmenter
	ring *ring.Ring

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

	initSet          atomic.Bool
	subscribed       atomic.Bool
	partsWritten     atomic.Uint64
	bytesWritten     atomic.Uint64
	lastPartAtMs     atomic.Int64
	lastIdrAtMs      atomic.Int64
	audioPacketsSeen atomic.Uint64

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
}

// New builds a Session that writes into r using cfg's part/segment
// durations. keyReq may be nil (see the Session.keyReq doc comment) and
// set later with SetKeyframeRequester.
func New(partTicks, segmentTicks uint32, r *ring.Ring, keyReq *keyframe.Requester) *Session {
	s := &Session{
		dep: h264.NewDepacketizer(),
		frag: pipeline.NewFragmenter(pipeline.Config{
			Timescale:       h264.ClockRate,
			PartDuration:    partTicks,
			SegmentDuration: segmentTicks,
		}),
		ring:    r,
		started: time.Now(),
		epoch:   time.Now(),
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
	// SegmentTicks is the audio track's own segment target, in the audio
	// track's 48kHz timescale (aacenc.SampleRate) — NOT the same tick
	// count New's segmentTicks used, which is in the video track's 90kHz
	// RTP clock. Ordinarily the same SEGMENT_MS config value, converted
	// into each track's own timescale.
	SegmentTicks uint32
	// Encoder configures internal/aacenc.New. A zero-value Config is
	// fine (its own defaults apply: 128kbps, "ffmpeg" via PATH).
	Encoder aacenc.Config
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
		SegmentDuration: cfg.SegmentTicks,
	})
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
	s.audioRing.SetInit(audioInit)
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

func (s *Session) objectPrefix() string {
	return r2.ObjectPrefix(s.r2ChannelID, s.r2StartedAtMs, s.r2Rung)
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

// HandleVideoPacket feeds one RTP packet from the subscribed screen-share
// video track through depacketization, CMAF muxing and the ring, in that
// order. A malformed packet is logged and otherwise ignored: one bad
// packet must not take down the whole session (the depacketizer already
// keeps accumulating past it; see internal/h264's doc comment).
func (s *Session) HandleVideoPacket(pkt *rtp.Packet) {
	au, err := s.dep.Push(pkt.Payload, pkt.Timestamp, pkt.Marker)
	if err != nil {
		log.Printf("pqp-remux: h264 depacketize: %v", err)
	}
	if au == nil {
		return
	}

	if au.IsIDR {
		s.lastIdrAtMs.Store(s.elapsedMs())
		s.idrSeen.Store(true)
		if kr := s.keyReq.Load(); kr != nil {
			kr.OnIDR(time.Now())
		}
	}

	if !s.initSet.Load() && len(au.SPS) > 0 && len(au.PPS) > 0 {
		initSeg, err := cmaf.BuildInitSegment(cmaf.InitParams{
			Timescale: h264.ClockRate,
			SPS:       au.SPS,
			PPS:       au.PPS,
		})
		if err != nil {
			log.Printf("pqp-remux: building init segment: %v", err)
		} else {
			s.ring.SetInit(initSeg)
			s.initSet.Store(true)
			s.enqueueR2("video-init.mp4", initSeg, "video/mp4")
		}
	}

	frag, err := s.frag.Push(au)
	if err != nil && err != pipeline.ErrWaitingForIDR {
		log.Printf("pqp-remux: fragmenter: %v", err)
	}
	if frag == nil {
		return
	}
	s.publish(frag)
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
	if readerDone != nil {
		select {
		case <-readerDone:
		case <-time.After(audioCloseFlushDeadline):
			log.Printf("pqp-remux: timed out after %s waiting for the audio reader to drain during shutdown; the final segment may be incomplete", audioCloseFlushDeadline)
		}
	}

	// The session ending is what closes the audio track's last (still
	// open) segment, in the same sense Finish does for video: nothing
	// else will ever start a *next* segment to trigger the ordinary
	// roll-over upload.
	if s.audioFrag != nil {
		s.uploadAudioSegment(s.audioFrag.CurrentSegmentIndex())
	}
}

// audioCloseFlushDeadline bounds Close's wait for the audio reader to
// finish draining the encoder's final output. Generous next to a single
// AAC frame's own cadence (~21ms) but still short enough not to
// meaningfully delay process shutdown if the reader is ever stuck.
const audioCloseFlushDeadline = 5 * time.Second

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
	}
	s.partsWritten.Add(1)
	s.bytesWritten.Add(uint64(len(frag.Bytes)))
	s.lastPartAtMs.Store(s.elapsedMs())
}

func (s *Session) uploadVideoSegment(index int) {
	if s.r2Writer == nil {
		return
	}
	b, ok := s.ring.Segment(index)
	if !ok {
		return
	}
	s.enqueueR2(fmt.Sprintf("video-seg-%d.m4s", index), b, "video/mp4")
}

func (s *Session) uploadAudioSegment(index int) {
	if s.r2Writer == nil {
		return
	}
	b, ok := s.audioRing.Segment(index)
	if !ok {
		return
	}
	s.enqueueR2(fmt.Sprintf("audio-seg-%d.m4s", index), b, "audio/mp4")
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
			pts := s.audioNextPTS.Add(aacenc.SamplesPerFrame) - aacenc.SamplesPerFrame
			frag := s.audioFrag.Push(pts, aacenc.SamplesPerFrame, frame.Data)

			sealedIndex := -1
			if frag.IsSegmentStart && frag.SegmentIndex > 0 {
				sealedIndex = frag.SegmentIndex - 1
			}
			s.audioRing.Push(frag) // seals sealedIndex, if any; see publish's matching comment
			if sealedIndex >= 0 {
				s.uploadAudioSegment(sealedIndex)
			}
			s.audioPartsWritten.Add(1)
			s.audioBytesWritten.Add(uint64(len(frag.Bytes)))
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
