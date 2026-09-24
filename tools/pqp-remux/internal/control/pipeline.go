package control

import (
	"context"
	"net/http"
	"time"

	"github.com/rafaelcg/pqp/tools/pqp-remux/internal/r2"
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
	// not-yet-sealed, or -- read right after Close -- the now-final)
	// segment index of each track's fragmenter --
	// internal/session.Session's CurrentVideoSegmentIndex/
	// CurrentAudioSegmentIndex. managed_session.go's restart closes the
	// OLD pipeline FIRST and only then reads these, to compute the
	// replacement pipeline's StartVideoSegmentIndex/StartAudioSegmentIndex
	// (PipelineConfig below) -- see restart's own doc comment for why
	// reading this after Close, not before, is what makes "+1" past these
	// values a value a restart can safely resume at.
	VideoSegmentIndex int
	AudioSegmentIndex int

	// VideoPartSeq/AudioPartSeq are the sequence number of the LAST part
	// each track's fragmenter emitted -- the part-level twin of the two
	// segment indices above, and read at the same moment for the same
	// reason. It matters now because state.json (internal/llstate)
	// publishes part FILE NAMES ("part-<seq>.m4s") to the edge Worker,
	// whose media cache keys that path and deliberately drops the token:
	// a replacement pipeline that started numbering at 1 again would
	// advertise names whose bytes are already cached from its
	// predecessor (Farol review, PR #621).
	VideoPartSeq uint32
	AudioPartSeq uint32

	// VideoInitGeneration is how many video init segments the pipeline has
	// published (internal/session.Session.CurrentInitGeneration), read at
	// the same moment as the two pairs above, so a replacement names its
	// first init past the predecessor's last instead of overwriting
	// `video-init.mp4` in R2.
	VideoInitGeneration uint64

	// DemoteReason is non-empty when the pipeline itself has asked to be
	// taken off the LL rung (today: an H.264 parameter-set change that
	// could not be represented as a new init + discontinuity). The
	// watchdog demotes on the next tick — see evaluateWatchdog.
	DemoteReason string

	// --- the source's own liveness, added 2026-09-15 ---
	//
	// WHY A WATCHDOG NEEDS THESE. Until now the only thing this struct
	// said about a session in trouble was "no part has been published
	// for N seconds", and that one fact has at least three completely
	// different causes: the publisher stopped sending (a Chrome TAB
	// share of static content sends NO frames while nothing repaints),
	// the publisher is sending and nothing comes out of the depacketizer
	// (loss, a wedged access unit), or frames come out and the muxer
	// publishes nothing. Only the first is NOT a stall, and on
	// 2026-09-15 it was treated as one: a production session was
	// restarted and then demoted off the low-latency rung for a source
	// that was behaving normally. LastVideoPacketAt and LastVideoFrameAt
	// are what let evaluateWatchdog tell those three apart -- see
	// sourceIdle there. Zero means "never", and a Pipeline that does not
	// report them (every fake in this package's own tests) is evaluated
	// exactly as it was before they existed.
	LastVideoPacketAt time.Time
	LastVideoFrameAt  time.Time

	VideoPacketsSeen     uint64
	VideoFramesSeen      uint64
	VideoKeyframesSeen   uint64
	VideoDepacketizeErrs uint64
	// KeepAliveParts counts parts published by the idle keep-alive rather
	// than by an arriving access unit (internal/session's idleTick). A
	// session whose parts are ALL keep-alives is a frozen picture, which
	// is a real thing to see on a dashboard and not visible from
	// PartsWritten alone.
	KeepAliveParts    uint64
	AudioPartsWritten uint64

	// PLIsSent/PLIsSinceIdr come from internal/keyframe.Requester under
	// KEYFRAME_POLICY=pli, and are 0 under "natural" (no requester is
	// ever constructed). PLIsSinceIdr above zero means this process has
	// asked for a keyframe and not been answered yet.
	PLIsSent     uint64
	PLIsSinceIdr uint64

	R2Uploaded      uint64
	R2Failed        uint64
	R2Dropped       uint64
	R2Queued        int
	R2InFlight      int64
	R2LastLatencyMs int64
	R2MaxLatencyMs  int64

	// VideoRebinds is how many replacement screen-share tracks this
	// pipeline bound (internal/session.Session.VideoRebinds).
	VideoRebinds uint64
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
	// (managed_session.go's restart, closing the OLD pipeline BEFORE
	// building its replacement -- see restart's own doc comment for why
	// that order, not the reverse, is what a correct segment-index handoff
	// requires) or by demotion/explicit stop.
	Close()
}

// Rebinder is the optional half of Pipeline a production pipeline has and a
// test fake need not: follow a different presenter identity inside the same
// pipeline (internal/subscriber.Session.SetPresenter). A pipeline without
// it answers POST /sessions/:id/rebind with "unsupported".
type Rebinder interface {
	Rebind(identity string) string
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
	// PresenterIdentity is who the pipeline's subscriber follows: the
	// start request's, or the latest rebind's for a watchdog replacement.
	PresenterIdentity string

	// StartVideoSegmentIndex/StartAudioSegmentIndex are 0 for a session's
	// very first pipeline (ordinary "start counting from segment 0"), and
	// set by managed_session.go's restart to continue a replacement
	// pipeline's numbering (and therefore its R2 object keys) past
	// whatever a stalled predecessor already used -- see
	// internal/session.Session.SetStartSegmentIndex's doc comment.
	StartVideoSegmentIndex int
	StartAudioSegmentIndex int

	// StartVideoPartSeq/StartAudioPartSeq are the sequence number the
	// replacement pipeline's FIRST part should carry, one past whatever
	// its predecessor last emitted (0 for a session's first pipeline) --
	// see PipelineHealth.VideoPartSeq and
	// internal/session.Session.SetStartPartSequence.
	StartVideoPartSeq uint32
	StartAudioPartSeq uint32

	// StartVideoInitGeneration is the predecessor's
	// PipelineHealth.VideoInitGeneration (0 for a session's first
	// pipeline): see internal/session.Session.SetStartInitGeneration.
	StartVideoInitGeneration uint64

	// VodIndex is the SESSION's replay index, not this pipeline's: every
	// closed segment either this pipeline or any predecessor uploaded, and
	// the renderer of the `video.m3u8` / `audio.m3u8` / `master.m3u8` that
	// make a finished LL broadcast playable. Built once, in
	// newManagedSession, and handed to every pipeline this session ever
	// builds -- a restart replaces the ring and the upload queue, and an
	// index living on either of those would publish a playlist that starts
	// in the middle of the show. Nil when the box has no S3 configuration,
	// in which case there is nothing to write playlists to either.
	VodIndex *r2.VodIndex

	Global GlobalConfig
}

// PipelineFactory builds a fresh Pipeline from cfg -- called once when a
// session starts, and again (with the SAME cfg) for the watchdog's one
// allowed restart. Production uses NewRemuxPipeline
// (remux_pipeline.go); tests substitute a fake that never touches a
// network.
//
// ctx is the SUPERVISOR's own lifetime context (cmd/pqp-remuxd/main.go's
// top-level ctx, threaded through Registry and ManagedSession -- see
// Registry's own doc comment), not a per-pipeline one: a factory that
// derives its pipeline's internal context from ctx (NewRemuxPipeline
// does) means a process shutdown cancels a session's construction even
// while it is still in flight -- e.g. still inside subscriber.Connect's
// network dial, or partway through spawning the AAC encoder's ffmpeg
// subprocess -- rather than only the sessions that had already finished
// starting and been registered (Farol review, PR #584: "pipeline startup
// uses an independent background context and can outlive the HTTP
// request and registry shutdown").
type PipelineFactory func(ctx context.Context, cfg PipelineConfig) (Pipeline, error)
