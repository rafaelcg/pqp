package control

import (
	"context"
	"fmt"
	"log"
	"net/http"

	"github.com/rafaelcg/pqp/tools/pqp-remux/internal/aacenc"
	"github.com/rafaelcg/pqp/tools/pqp-remux/internal/h264"
	"github.com/rafaelcg/pqp/tools/pqp-remux/internal/keyframe"
	"github.com/rafaelcg/pqp/tools/pqp-remux/internal/llstate"
	"github.com/rafaelcg/pqp/tools/pqp-remux/internal/r2"
	"github.com/rafaelcg/pqp/tools/pqp-remux/internal/ring"
	"github.com/rafaelcg/pqp/tools/pqp-remux/internal/serve"
	"github.com/rafaelcg/pqp/tools/pqp-remux/internal/session"
	"github.com/rafaelcg/pqp/tools/pqp-remux/internal/subscriber"
)

// rung is fixed at "ll": this control server exists ONLY to run L1.5/L1.6's
// low-latency rendition (docs/plans/LL_HLS.md §4/§6, "its hls_sessions row
// carries rung = 'll'"). Unlike the single-session pqp-remux binary's own
// RUNG env var (an override that exists for a test or a future topology,
// per config.Config's own doc comment), there is no env override here: this
// binary has no OTHER rung to produce.
const rung = "ll"

// remuxPipeline is the production Pipeline (pipeline.go): a real
// session.Session driven by a real subscriber.Session, served by a real
// serve.Server, with L1.4's R2 writer wired in exactly the way
// cmd/pqp-remux/main.go's runServer already does for the single-session
// binary -- this is that same construction and (critically) the same
// shutdown ORDER, refactored so a control-plane ManagedSession can build
// and tear one down repeatedly (once per session, and again for the
// watchdog's one allowed restart) instead of once per process lifetime.
type remuxPipeline struct {
	sess *session.Session
	srv  *serve.Server
	sub  *subscriber.Session

	cancel context.CancelFunc
	// stopMonitor cancels the session's monitor goroutine and waits for
	// it to return; see Close for why it runs first of all.
	stopMonitor func()

	r2Writer     *r2.Writer
	audioEnabled bool
}

// NewRemuxPipeline is the production PipelineFactory (pipeline.go). Its
// body mirrors cmd/pqp-remux/main.go's runServer closely on purpose: same
// pieces, same wiring, same shutdown-order reasoning (see Close) -- a
// reader who already knows that function should recognize this one.
//
// parentCtx is the supervisor's own lifetime context (see PipelineFactory's
// own doc comment) -- this function's internal ctx is a child of it, not
// of context.Background(), specifically so a process shutdown that fires
// WHILE this function is still running (still inside EnableAudio's ffmpeg
// spawn, or blocked in subscriber.Connect's network dial) tears down
// whatever this construction has built so far instead of leaving it to
// outlive the supervisor that asked to stop. Two known-narrower cases,
// both because of what they depend on:
//   - Anything built AFTER parentCtx is cancelled but BEFORE this
//     function notices (the check right after subscriber.Connect, below)
//     still gets built and then torn down immediately -- a real but
//     bounded amount of wasted work, not a leak: the teardown path is the
//     SAME one a Connect failure already uses.
//   - subscriber.Connect itself takes no context (lksdk's own
//     ConnectToRoomWithToken has no cancellation parameter this package
//     can reach), so a dial that is genuinely wedged inside that call
//     cannot be interrupted from here -- only unblocked by the SDK's own
//     internal timeout. This is a real limitation of the dependency, not
//     something ctx threading alone can close; the check below catches
//     every case where Connect DOES return (success or failure) during or
//     after a shutdown, which is the case this task's own acceptance bar
//     ("no goroutine or ffmpeg child remains" after a cancel) needs.
func NewRemuxPipeline(parentCtx context.Context, cfg PipelineConfig) (Pipeline, error) {
	r := ring.New(cfg.RingSegments, h264.ClockRate)

	ctx, cancel := context.WithCancel(parentCtx)

	var r2Writer *r2.Writer
	global := cfg.Global
	if global.LiveHlsS3Configured() {
		r2Writer = r2.NewWriter(r2.NewUploader(r2.Config{
			Endpoint:        global.LiveHlsS3Endpoint,
			Bucket:          global.LiveHlsS3Bucket,
			Region:          global.LiveHlsS3Region,
			AccessKeyID:     global.LiveHlsS3AccessKeyID,
			SecretAccessKey: global.LiveHlsS3SecretAccessKey,
			ForcePathStyle:  global.LiveHlsS3ForcePathStyle,
		}), r2.WriterConfig{
			QueueDepth: global.R2UploadQueueDepth,
			MaxRetries: global.R2UploadMaxRetries,
		})
		log.Printf("pqp-remux: control: session %s: R2 writer enabled: bucket=%s prefix=%s",
			cfg.SessionID, global.LiveHlsS3Bucket, r2.ObjectPrefix(cfg.ChannelID, cfg.StartedAtMs, rung))
	}

	partTicks := uint32(msToTicks(cfg.PartMs))
	segmentTicks := uint32(msToTicks(cfg.SegmentMs))
	sess := session.New(partTicks, segmentTicks, r, nil)
	if cfg.StartVideoSegmentIndex > 0 {
		sess.SetStartSegmentIndex(cfg.StartVideoSegmentIndex)
	}
	if cfg.StartVideoPartSeq > 0 {
		sess.SetStartPartSequence(cfg.StartVideoPartSeq)
	}

	if r2Writer != nil {
		sess.EnableR2(r2Writer, cfg.ChannelID, cfg.StartedAtMs, rung)
	}

	audioRing := ring.New(ring.AudioSegments(cfg.RingSegments), aacenc.SampleRate)
	audioEnabled := true
	if err := sess.EnableAudio(ctx, session.AudioConfig{
		Ring:         audioRing,
		PartTicks:    uint32(cfg.PartMs) * aacenc.SampleRate / 1000,
		SegmentTicks: uint32(cfg.SegmentMs) * aacenc.SampleRate / 1000,
		Encoder: aacenc.Config{
			FFmpegPath:  global.FFmpegPath,
			BitrateKbps: global.AACBitrateKbps,
		},
		StartSegmentIndex: cfg.StartAudioSegmentIndex,
		StartSequence:     cfg.StartAudioPartSeq,
	}); err != nil {
		audioEnabled = false
		log.Printf("pqp-remux: control: session %s: audio mixing disabled: %v", cfg.SessionID, err)
	}

	sub, err := subscriber.Connect(subscriber.Config{
		URL:       global.LiveKitURL,
		APIKey:    global.LiveKitAPIKey,
		APISecret: global.LiveKitAPISec,
		Room:      cfg.Room,
	}, subscriber.Handlers{
		OnVideoTrackFound: func(*subscriber.Session) { sess.MarkSubscribed() },
		OnVideoPacket:     sess.HandleVideoPacket,
		OnAudioPacket:     sess.HandleAudioPacket,
		OnMicTrackFound:   func(identity string) subscriber.AudioSink { return sess.NewMicSink(identity) },
		OnVideoTrackEnded: sess.Finish,
	})
	if err != nil {
		// Nothing subscribed: tear down in the same order Close below
		// would, so a failed start leaks nothing (no dangling ffmpeg
		// subprocess, no R2 writer still accepting work for a session
		// that never actually started).
		cancel()
		sess.Close()
		if r2Writer != nil {
			r2Writer.Close()
		}
		return nil, fmt.Errorf("connecting to %s room %q: %w", global.LiveKitURL, cfg.Room, err)
	}

	// The supervisor may have started shutting down WHILE the network
	// calls above (EnableAudio's ffmpeg spawn, subscriber.Connect's
	// dial) were still in flight -- Connect can succeed even after
	// parentCtx is already cancelled, since it has no way to observe
	// that cancellation itself (see this function's own doc comment).
	// Catch that here, before this pipeline is ever handed back to a
	// caller that would register it: tear down exactly like a Connect
	// failure does (same order, same cleanup) and refuse to start,
	// rather than let a session finish constructing successfully after
	// the process that owns it has already begun tearing everything
	// else down.
	if parentCtx.Err() != nil {
		sub.Close()
		cancel()
		sess.Close()
		if r2Writer != nil {
			r2Writer.Close()
		}
		return nil, fmt.Errorf("control: session %s: supervisor is shutting down: %w", cfg.SessionID, parentCtx.Err())
	}

	if cfg.KeyframePolicy == KeyframePolicyPLI {
		keyCfg := keyframe.Config{
			Policy:          keyframe.PolicyPLI,
			SegmentTargetMs: cfg.SegmentMs,
			GateFactor:      cfg.PliGateFactor,
			PaceMs:          cfg.PliPaceMs,
		}
		keyReq := keyframe.NewRequester(keyCfg, sub)
		sess.SetKeyframeRequester(keyReq)
		go keyReq.Run(ctx)
	}

	srv := serve.New(r, sess)
	if audioEnabled {
		srv.SetAudioRing(audioRing)
	}
	// GET /s/<sessionId>/state.json -- the FIRST thing L2.3's edge Worker
	// asks this box for, and (until 2026-09-15) the one thing it did not
	// answer: a live party had parts, segments and a 200 on every other
	// media route while every viewer stalled, because the Worker builds
	// the LL playlist itself and had no numbers to build it from. See
	// internal/llstate's package comment.
	srv.SetLlState(llstate.Meta{
		SessionID:       cfg.SessionID,
		ChannelID:       cfg.ChannelID,
		PartTargetMs:    cfg.PartMs,
		SegmentTargetMs: cfg.SegmentMs,
	})

	// The session's own always-on instrumentation and video keep-alive
	// (internal/session.Session.StartMonitor): one stats line every few
	// seconds, and the idle flush that stops a static screen share from
	// looking like a stalled pipeline. Derived from ctx, so a process
	// shutdown stops it too; stopMonitor is what Close uses to be sure it
	// is finished before anything reads the fragmenter.
	stopMonitor := sess.StartMonitor(ctx, "session="+cfg.SessionID)

	return &remuxPipeline{
		sess:         sess,
		srv:          srv,
		sub:          sub,
		cancel:       cancel,
		stopMonitor:  stopMonitor,
		r2Writer:     r2Writer,
		audioEnabled: audioEnabled,
	}, nil
}

// msToTicks converts a millisecond duration into 90kHz RTP-clock ticks,
// the same overflow-safe order internal/config.msToTicks uses (multiply in
// uint64 before dividing) -- repeated here rather than imported because
// internal/config's version is unexported and this package's inputs are
// already bounded by StartSessionRequest.Validate's own positive-int check,
// not by internal/config.Config.Validate's fuller bound check (this
// package never constructs an internal/config.Config at all).
func msToTicks(ms int) uint64 { return uint64(ms) * uint64(h264.ClockRate) / 1000 }

// msDuration -- the one that converts internal/session.Session's own
// elapsed-milliseconds convention into a time.Duration for adding onto
// Session.Started() (see Health below) -- lives in watchdog.go, because
// this package's OTHER callers of it convert operator-supplied env values
// and need it to saturate rather than wrap. One definition, one behaviour.

func (p *remuxPipeline) Health() PipelineHealth {
	h := p.sess.Health()
	// Stats() is the SAME snapshot internal/session's own periodic log
	// line is rendered from (see its monitor.go): the numbers in a
	// `part-stuck` verdict and the numbers on the routine stats line an
	// operator reads beside it are the same numbers, by construction,
	// rather than two hand-maintained lists that drift.
	st := p.sess.Stats()
	ph := PipelineHealth{
		Subscribed:        h.Subscribed,
		PartsWritten:      h.PartsWritten,
		AudioEnabled:      p.audioEnabled,
		AudioDead:         h.AudioDead,
		AudioRestarts:     h.AudioRestarts,
		VideoSegmentIndex: p.sess.CurrentVideoSegmentIndex(),
		AudioSegmentIndex: p.sess.CurrentAudioSegmentIndex(),
		VideoPartSeq:      p.sess.CurrentVideoPartSequence(),
		AudioPartSeq:      p.sess.CurrentAudioPartSequence(),

		LastVideoPacketAt:    st.LastVideoPacket,
		LastVideoFrameAt:     st.LastVideoFrame,
		VideoPacketsSeen:     st.VideoPacketsSeen,
		VideoFramesSeen:      st.VideoFramesSeen,
		VideoKeyframesSeen:   st.VideoKeyframesSeen,
		VideoDepacketizeErrs: st.VideoDepacketizeErrs,
		KeepAliveParts:       st.KeepAlivePartsWrites,
		AudioPartsWritten:    st.AudioPartsWritten,
		PLIsSent:             st.Keyframe.PLIsSent,
		PLIsSinceIdr:         st.Keyframe.PLIsSinceIDR,
		R2Uploaded:           st.R2Uploaded,
		R2Failed:             st.R2Failed,
		R2Dropped:            st.R2Dropped,
		R2Queued:             st.R2Queued,
		R2InFlight:           st.R2InFlight,
		R2LastLatencyMs:      st.R2LastLatencyMs,
		R2MaxLatencyMs:       st.R2MaxLatencyMs,
	}
	started := p.sess.Started()
	if p.sess.HasPart() {
		ph.LastPartAt = started.Add(msDuration(h.LastPartAtMs))
	}
	if p.sess.HasIdr() {
		ph.LastIdrAt = started.Add(msDuration(h.LastIdrAtMs))
	}
	if ms, ok := p.sess.OpenSegmentMs(); ok {
		ph.OpenSegmentMs = ms
		ph.OpenSegmentOK = true
	}
	return ph
}

func (p *remuxPipeline) ServeHTTP(w http.ResponseWriter, r *http.Request) { p.srv.ServeHTTP(w, r) }

// Close tears this pipeline down in the exact order
// cmd/pqp-remux/main.go's runServer already established (and Farol already
// found the bug in getting backwards once), with the monitor stopped and
// joined ahead of all of it (see the body): sub.Close() (stop new
// packets), then cancel() (stop the audio pacer writing more PCM), then
// sess.Close() (drain the encoder and flush the final segments, enqueuing
// their uploads), then r2Writer.Close() LAST, so those final uploads get a
// chance to actually run before the writer stops accepting work.
//
// sub.Close() (internal/subscriber.Session.Close) now blocks until the
// video track's own async teardown -- including the OnVideoTrackEnded
// call that runs session.Session.Finish -- has fully completed (Farol
// review, PR #584), not merely until disconnect was requested. That is
// what makes it safe for restart() (managed_session.go) to read this
// pipeline's Health() immediately after Close returns: Finish is what
// flushes the trailing fragment and can advance the fragmenter's segment
// index, and it used to be able to still be running, on a goroutine this
// method never waited for, after Close had already returned.
func (p *remuxPipeline) Close() {
	// FIRST, before the subscriber: the monitor's keep-alive tick is the
	// only toucher of the fragmenter that is not joined by sub.Close, and
	// managed_session.go's restart reads that fragmenter's final segment
	// index and part sequence the instant this method returns. Stopping
	// and JOINING it here means the rest of this teardown, and that read,
	// run with exactly one other goroutine in the picture -- the RTP
	// reader sub.Close already waits for (Farol review, PR #626).
	p.stopMonitor()
	p.sub.Close()
	p.cancel()
	p.sess.Close()
	if p.r2Writer != nil {
		p.r2Writer.Close()
	}
}
