package control

import (
	"context"
	"fmt"
	"log"
	"net/http"
	"time"

	"github.com/rafaelcg/pqp/tools/pqp-remux/internal/aacenc"
	"github.com/rafaelcg/pqp/tools/pqp-remux/internal/h264"
	"github.com/rafaelcg/pqp/tools/pqp-remux/internal/keyframe"
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

	r2Writer     *r2.Writer
	audioEnabled bool
}

// NewRemuxPipeline is the production PipelineFactory (pipeline.go). Its
// body mirrors cmd/pqp-remux/main.go's runServer closely on purpose: same
// pieces, same wiring, same shutdown-order reasoning (see Close) -- a
// reader who already knows that function should recognize this one.
func NewRemuxPipeline(cfg PipelineConfig) (Pipeline, error) {
	r := ring.New(cfg.RingSegments, h264.ClockRate)

	ctx, cancel := context.WithCancel(context.Background())

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

	if r2Writer != nil {
		sess.EnableR2(r2Writer, cfg.ChannelID, cfg.StartedAtMs, rung)
	}

	audioRing := ring.New(cfg.RingSegments, aacenc.SampleRate)
	audioEnabled := true
	if err := sess.EnableAudio(ctx, session.AudioConfig{
		Ring:         audioRing,
		SegmentTicks: uint32(cfg.SegmentMs) * aacenc.SampleRate / 1000,
		Encoder: aacenc.Config{
			FFmpegPath:  global.FFmpegPath,
			BitrateKbps: global.AACBitrateKbps,
		},
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

	return &remuxPipeline{
		sess:         sess,
		srv:          srv,
		sub:          sub,
		cancel:       cancel,
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

// msDuration converts internal/session.Session's own elapsed-milliseconds
// convention into a time.Duration, for adding onto Session.Started() --
// see Health's own doc comment on why that conversion happens here, once.
func msDuration(ms int64) time.Duration { return time.Duration(ms) * time.Millisecond }

func (p *remuxPipeline) Health() PipelineHealth {
	h := p.sess.Health()
	ph := PipelineHealth{
		Subscribed:    h.Subscribed,
		PartsWritten:  h.PartsWritten,
		AudioEnabled:  p.audioEnabled,
		AudioDead:     h.AudioDead,
		AudioRestarts: h.AudioRestarts,
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
// found the bug in getting backwards once): sub.Close() first (stop new
// packets), then cancel() (stop the audio pacer writing more PCM), then
// sess.Close() (drain the encoder and flush the final segments, enqueuing
// their uploads), then r2Writer.Close() LAST, so those final uploads get a
// chance to actually run before the writer stops accepting work.
func (p *remuxPipeline) Close() {
	p.sub.Close()
	p.cancel()
	p.sess.Close()
	if p.r2Writer != nil {
		p.r2Writer.Close()
	}
}
