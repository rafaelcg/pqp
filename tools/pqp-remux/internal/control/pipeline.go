package control

import (
	"net/http"
	"time"
)

// PipelineHealth is the minimal snapshot a Pipeline reports at an instant:
// enough for GET /sessions (SessionInfo) and for the watchdog's
// restart-then-demote decision (watchdog.go's evaluateWatchdog), and
// nothing about HOW media gets produced. Times are absolute (time.Time),
// never elapsed-since-start milliseconds -- see
// internal/session.Session.Started's doc comment for why that conversion
// happens once, in remux_pipeline.go, rather than leaking
// internal/session's own elapsed-ms convention into this package.
type PipelineHealth struct {
	Subscribed   bool
	PartsWritten uint64
	// LastPartAt/LastIdrAt are the zero time.Time when no part/IDR has
	// ever arrived yet, distinguishing "never" from "at the epoch" the
	// same way internal/session.Session.HasPart/HasIdr do for their own
	// elapsed-ms fields.
	LastPartAt time.Time
	LastIdrAt  time.Time
	// OpenSegmentMs/OpenSegmentOK mirror
	// internal/session.Session.OpenSegmentMs's own two-value return.
	OpenSegmentMs int64
	OpenSegmentOK bool

	AudioEnabled  bool
	AudioDead     bool
	AudioRestarts uint64

	// VideoSegmentIndex/AudioSegmentIndex are the CURRENT (open,
	// not-yet-sealed) segment index of each track's fragmenter --
	// internal/session.Session's CurrentVideoSegmentIndex/
	// CurrentAudioSegmentIndex. managed_session.go's restart reads these
	// from the OLD pipeline, before closing it, to compute the
	// replacement pipeline's StartVideoSegmentIndex/StartAudioSegmentIndex
	// (PipelineConfig below) -- see restart's own doc comment for why
	// "+1" past these values, not the values themselves, is what a
	// restart actually resumes at.
	VideoSegmentIndex int
	AudioSegmentIndex int
}

// Pipeline is the minimal surface a managed session's media pipeline
// exposes to the control server and its watchdog. *remuxPipeline (production,
// remux_pipeline.go) wraps a real session.Session + subscriber.Session pair;
// a fake in registry_test.go/watchdog_test.go satisfies the same interface
// with no LiveKit connection at all, which is what makes "concurrent
// sessions isolation" and "watchdog restart-then-demote with a fake
// pipeline clock" testable without a live room.
type Pipeline interface {
	Health() PipelineHealth
	// ServeHTTP answers this session's media routes -- init.mp4,
	// playlist.m3u8, part-N.m4s, seg-N.m4s and their audio-* twins --
	// exactly internal/serve.Server's own contract; production delegates
	// to a real *serve.Server built around the pipeline's own rings.
	ServeHTTP(w http.ResponseWriter, r *http.Request)
	// Close tears the pipeline down: unsubscribe from LiveKit, stop the
	// audio encoder, flush and close this pipeline's own R2 upload queue.
	// Called at most once per Pipeline instance, either by a restart
	// (managed_session.go's restart, closing the OLD pipeline once a new
	// one has taken over) or by demotion/explicit stop.
	Close()
}

// PipelineConfig is everything a PipelineFactory needs to build one
// session's Pipeline: the per-request fields from StartSessionRequest, this
// session's own fixed identity (SessionID, StartedAtMs -- unchanged across
// an internal restart, since from pqp-api's point of view it is still the
// same session), and the box-wide settings loaded once at process start
// (GlobalConfig, global_config.go).
type PipelineConfig struct {
	SessionID      string
	Room           string
	ChannelID      string
	StartedAtMs    int64
	PartMs         int
	SegmentMs      int
	RingSegments   int
	KeyframePolicy KeyframePolicy
	PliPaceMs      int
	PliGateFactor  float64

	// StartVideoSegmentIndex/StartAudioSegmentIndex are 0 for a session's
	// very first pipeline (ordinary "start counting from segment 0"), and
	// set by managed_session.go's restart to continue a replacement
	// pipeline's numbering (and therefore its R2 object keys) past
	// whatever a stalled predecessor already used -- see
	// internal/session.Session.SetStartSegmentIndex's doc comment.
	StartVideoSegmentIndex int
	StartAudioSegmentIndex int

	Global GlobalConfig
}

// PipelineFactory builds a fresh Pipeline from cfg -- called once when a
// session starts, and again (with the SAME cfg) for the watchdog's one
// allowed restart. Production uses NewRemuxPipeline
// (remux_pipeline.go); tests substitute a fake that never touches a
// network.
type PipelineFactory func(cfg PipelineConfig) (Pipeline, error)
