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

	// --- L1.3: audio (nil/zero until EnableAudio succeeds) ---

	audioMixer        *audiomix.Mixer
	screenAudioSource *audiomix.Source
	audioEncoder      *aacenc.Encoder
	audioFrag         *pipeline.AudioFragmenter
	audioRing         *ring.Ring
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
	return s
}

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
	enc, err := aacenc.New(ctx, cfg.Encoder)
	if err != nil {
		return fmt.Errorf("session: starting the AAC encoder: %w", err)
	}

	s.audioMixer = audiomix.NewMixer()
	s.screenAudioSource = audiomix.NewSource()
	s.audioMixer.AddSource("screen", s.screenAudioSource)

	s.audioEncoder = enc
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

	go s.runAudioPacer(ctx)
	go s.readEncoderFrames()

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
func (s *Session) Close() {
	if s.audioEncoder != nil {
		s.audioEncoder.Close()
	}
}

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
	if frag.IsSegmentStart && frag.SegmentIndex > 0 {
		// The segment this fragment's arrival just sealed: every part it
		// will ever have is already in the ring (Push only marks it
		// sealed below; it never adds bytes to an already-closed
		// segment), so fetching it now, before Push, is safe and exact.
		s.uploadVideoSegment(frag.SegmentIndex - 1)
	}
	s.ring.Push(frag)
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
// video. Stops when ctx is done.
func (s *Session) runAudioPacer(ctx context.Context) {
	// Finer than one AAC frame (1024/48000 ~= 21.3ms) so a tick's own
	// jitter is caught up within roughly one tick, not one frame.
	const tick = 10 * time.Millisecond
	ticker := time.NewTicker(tick)
	defer ticker.Stop()

	var emittedFrames int
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			n := framesElapsed(time.Since(s.epoch), aacenc.SamplesPerFrame, emittedFrames)
			for i := 0; i < n; i++ {
				pcm := s.audioMixer.Pull(aacenc.SamplesPerFrame)
				if err := s.audioEncoder.WriteSamples(pcm); err != nil {
					log.Printf("pqp-remux: writing PCM to the AAC encoder: %v", err)
					return
				}
				emittedFrames++
			}
		}
	}
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
// use" doc comment): it reads each AAC frame the encoder produces, in
// order, assigns it the next 1024-sample slot on the audio track's own
// timeline, and publishes the resulting CMAF fragment exactly like
// HandleVideoPacket does for video. Returns once the encoder's Frames()
// channel closes (Session.Close was called, or the ffmpeg subprocess
// exited).
func (s *Session) readEncoderFrames() {
	var pts int64
	for {
		select {
		case frame, ok := <-s.audioEncoder.Frames():
			if !ok {
				return
			}
			frag := s.audioFrag.Push(pts, aacenc.SamplesPerFrame, frame.Data)
			pts += aacenc.SamplesPerFrame

			if frag.IsSegmentStart && frag.SegmentIndex > 0 {
				s.uploadAudioSegment(frag.SegmentIndex - 1)
			}
			s.audioRing.Push(frag)
			s.audioPartsWritten.Add(1)
			s.audioBytesWritten.Add(uint64(len(frag.Bytes)))
		case err := <-s.audioEncoder.Errs():
			log.Printf("pqp-remux: AAC encode: %v", err)
		}
	}
}

func (s *Session) elapsedMs() int64 { return time.Since(s.started).Milliseconds() }

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
	}
	if s.r2Writer != nil {
		h.R2Uploaded = s.r2Writer.Uploaded()
		h.R2Failed = s.r2Writer.Failed()
		h.R2Dropped = s.r2Writer.Dropped()
	}
	return h
}
