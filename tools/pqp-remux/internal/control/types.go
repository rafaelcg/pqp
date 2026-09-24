package control

import (
	"fmt"
	"math"
	"regexp"

	"github.com/rafaelcg/pqp/tools/pqp-remux/internal/h264"
)

// KeyframePolicy mirrors packages/shared/src/hls-remux-control.ts's
// remuxKeyframePolicySchema ("natural" | "pli") one for one, and
// internal/keyframe.Policy's two values one for one -- kept as its own type
// (rather than an alias of keyframe.Policy) so this package's wire types
// have no compile-time dependency on internal/keyframe; StartSessionRequest
// converts with keyframe.Policy(req.KeyframePolicy) at the one call site
// that needs it (managed_session.go).
type KeyframePolicy string

const (
	KeyframePolicyNatural KeyframePolicy = "natural"
	KeyframePolicyPLI     KeyframePolicy = "pli"
)

func (p KeyframePolicy) valid() bool {
	return p == KeyframePolicyNatural || p == KeyframePolicyPLI
}

// minRingSegments/maxRingSegments bound RingSegments (Farol review, PR
// #584): the schema's own z.number().int().positive() has no upper bound,
// but a session's ring lives entirely in this process's memory
// (internal/ring), so an unbounded value from a caller is a memory-DoS
// knob, not a real DVR-window choice. 2 is the least that still gives a
// "current plus one sealed" window; 60 is comfortably past any DVR window
// this plan has ever discussed (docs/plans/LL_HLS.md §5 budgets 6 as the
// default, "~24s of DVR at the default segment target").
const (
	minRingSegments = 2
	maxRingSegments = 60
)

// maxTicksSafeMs is the largest PartMs/SegmentMs value whose conversion to
// 90kHz ticks (NewRemuxPipeline's msToTicks) still fits in a uint32,
// computed the same overflow-safe way internal/config's own
// maxTicksSafeMs is (Farol review, PR #584): this request is
// caller-controlled and reaches msToTicks with no bound of its own today
// -- a "positive integer" check alone lets a value large enough to wrap
// through uint32(...) truncation land on a tiny or zero tick count,
// exactly the boundary internal/config's own analogous check already
// closes for the env-configured single-session binary. Duplicated rather
// than imported: this package's wire types intentionally have no
// compile-time dependency on internal/config (see KeyframePolicy's own
// doc comment for the same reasoning applied to internal/keyframe).
var maxTicksSafeMs = uint64(math.MaxUint32) * 1000 / uint64(h264.ClockRate)

// exceedsTicksBound reports whether ms would overflow a uint32 once
// converted to 90kHz ticks -- checked against ms directly, never against
// a tick conversion that may have already wrapped.
func exceedsTicksBound(ms int) bool {
	return ms < 0 || uint64(ms) > maxTicksSafeMs
}

// uuidPattern is deliberately loose (RFC 4122 shape, not a strict version
// check): this side only needs to refuse obviously-wrong input, matching
// zod's z.string().uuid() closely enough for that purpose without pulling
// in a UUID library for one validation.
var uuidPattern = regexp.MustCompile(`^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$`)

// StartSessionRequest is POST /sessions's body: byte-for-byte
// remuxStartSessionRequestSchema in
// packages/shared/src/hls-remux-control.ts, "one row per field of
// pqp-remux's own config table" per that file's own doc comment. JSON field
// names match exactly (camelCase, as Zod/TS emits them).
type StartSessionRequest struct {
	// SessionID is pqp-api's idempotency key for this session -- see
	// deriveLlSessionId in hls-remux.ts: a pure function of (channelId,
	// startedAt), so a retried POST (lost response, restart, boot
	// adoption) always names the SAME session, never invents a second one.
	SessionID string `json:"sessionId"`
	// Room is the LiveKit room to subscribe to. Almost always equal to
	// ChannelID in practice (hls-remux.ts's buildStartRequest sets both to
	// the same value, "the LiveKit room name IS the voice channel id
	// everywhere else in this codebase"), but carried as its own field so
	// that stops needing to hold.
	Room string `json:"room"`
	// ChannelID is carried through for this box's own logs and for the R2
	// key layout (internal/r2.ObjectPrefix); not otherwise interpreted by
	// the control contract itself.
	ChannelID string `json:"channelId"`
	// StartedAtMs is pqp-api's own `hls_sessions.started_at`, in Unix
	// milliseconds, and therefore the timestamp the R2 key prefix has to
	// carry (internal/r2.ObjectPrefix). Zero or absent means "an older API
	// that does not send it", and the registry falls back to this box's own
	// clock, which is exactly what it always did.
	//
	// It exists because those two clocks were never the same number. The API
	// built `live/<channel>/<Date.now()>-ll` when it inserted the row; this
	// box built `live/<channel>/<time.Now()>-ll` when it built the session,
	// 24 ms later on the 2026-09-21 broadcast that exposed it. Everything
	// that reads the row to find the objects -- the retention sweep,
	// keep_replay, the replay lookup -- was therefore looking at a prefix
	// with nothing under it, while the real objects sat in the bucket with
	// nothing pointing at them.
	StartedAtMs    int64          `json:"startedAtMs,omitempty"`
	PartMs         int            `json:"partMs"`
	SegmentMs      int            `json:"segmentMs"`
	RingSegments   int            `json:"ringSegments"`
	KeyframePolicy KeyframePolicy `json:"keyframePolicy"`
	PliPaceMs      int            `json:"pliPaceMs"`
	PliGateFactor  float64        `json:"pliGateFactor"`
	// PresenterIdentity is the LiveKit identity (a pqp peer id) whose screen
	// share this session shows, and follows through every republish
	// (internal/subscriber's binder). Empty, which is what an older pqp-api
	// sends, keeps the old rule: the first screen share seen, and then that
	// same person. POST /sessions/:id/rebind changes it mid-session.
	PresenterIdentity string `json:"presenterIdentity,omitempty"`
}

// maxIdentityLen bounds a presenter identity. A pqp peer id is a UUID; this
// is generous and exists only so a caller cannot hand the box an unbounded
// string to log and compare on every screen-share subscription.
const maxIdentityLen = 256

// RebindRequest is POST /sessions/:id/rebind's body: the identity the
// session follows from now on. pqp-api sends it when the same person is
// presenting under a new peer id (a reconnect that could not resume), and
// as a nudge when it sees the presenter's screen track replaced.
type RebindRequest struct {
	PresenterIdentity string `json:"presenterIdentity"`
}

// Validate refuses an empty or oversized identity.
func (r RebindRequest) Validate() error {
	if r.PresenterIdentity == "" {
		return fmt.Errorf("presenterIdentity must not be empty")
	}
	if len(r.PresenterIdentity) > maxIdentityLen {
		return fmt.Errorf("presenterIdentity must be at most %d bytes", maxIdentityLen)
	}
	return nil
}

// RebindResponse is POST /sessions/:id/rebind's 200 body. Result is one of
// "bound" (the presenter's screen track was bound by this call), "unchanged"
// (it already was), "waiting" (the presenter has no screen track in the room
// yet; it is bound the moment one appears, and the picture holds until then)
// or "pending" (the session is between two pipelines of a watchdog restart,
// which binds the named presenter when it comes up).
type RebindResponse struct {
	SessionID         string `json:"sessionId"`
	PresenterIdentity string `json:"presenterIdentity"`
	Result            string `json:"result"`
}

// Validate mirrors remuxStartSessionRequestSchema's own constraints
// (z.string().uuid(), z.number().int().positive(), the keyframePolicy
// enum): a malformed request is refused with 400 before this package ever
// tries to build a pipeline or touch the registry, the same "fail before
// any side effect" shape the signing middleware already gives the request
// as a whole.
func (r StartSessionRequest) Validate() error {
	if !uuidPattern.MatchString(r.SessionID) {
		return fmt.Errorf("sessionId must be a uuid")
	}
	if r.Room == "" {
		return fmt.Errorf("room must not be empty")
	}
	if !uuidPattern.MatchString(r.ChannelID) {
		return fmt.Errorf("channelId must be a uuid")
	}
	// Zero is "not sent" (an older pqp-api); negative is a caller that sent
	// something and got it wrong, which must not silently become an R2 key
	// prefix nothing on the API side can ever match.
	if r.StartedAtMs < 0 {
		return fmt.Errorf("startedAtMs must not be negative")
	}
	if r.PartMs <= 0 {
		return fmt.Errorf("partMs must be a positive integer")
	}
	if exceedsTicksBound(r.PartMs) {
		return fmt.Errorf("partMs=%d converts to more than a uint32 of 90kHz ticks; keep it under about 13.25 hours", r.PartMs)
	}
	if r.SegmentMs <= 0 {
		return fmt.Errorf("segmentMs must be a positive integer")
	}
	if exceedsTicksBound(r.SegmentMs) {
		return fmt.Errorf("segmentMs=%d converts to more than a uint32 of 90kHz ticks; keep it under about 13.25 hours", r.SegmentMs)
	}
	if r.RingSegments < minRingSegments || r.RingSegments > maxRingSegments {
		return fmt.Errorf("ringSegments must be between %d and %d", minRingSegments, maxRingSegments)
	}
	if !r.KeyframePolicy.valid() {
		return fmt.Errorf("keyframePolicy must be %q or %q", KeyframePolicyNatural, KeyframePolicyPLI)
	}
	if r.PliPaceMs <= 0 {
		return fmt.Errorf("pliPaceMs must be a positive integer")
	}
	if r.PliGateFactor <= 0 {
		return fmt.Errorf("pliGateFactor must be a positive number")
	}
	if len(r.PresenterIdentity) > maxIdentityLen {
		return fmt.Errorf("presenterIdentity must be at most %d bytes", maxIdentityLen)
	}
	return nil
}

// SessionState is a human/operator-facing summary of a session's lifecycle,
// not part of remuxSessionInfoSchema today (see control.go's package
// comment on forward compatibility).
type SessionState string

const (
	// StateWaiting: registered, but no part has been produced yet (a
	// freshly started session, or one whose presenter has not begun
	// sharing yet). Distinct from "stalled" on purpose (Farol review, PR
	// #584): the watchdog gives this its own, much longer grace
	// (FirstPartTimeoutMs, default 60s) before treating it as a problem
	// at all -- PART_STUCK_MS's 3s would otherwise demote a session that
	// is legitimately waiting for someone to click "share screen".
	StateWaiting SessionState = "waiting"
	// StateRunning: producing parts.
	StateRunning SessionState = "running"
	// StateDemoted: the watchdog gave up on this session (docs/plans/LL_HLS.md
	// §5's restart-then-demote ladder, or the 3x-segment IDR-gap rule) --
	// terminal until an explicit DELETE removes it. Its pipeline is
	// already closed; it still appears on GET /sessions (with Demoted:true
	// and the last health snapshot this session ever had) so pqp-api can
	// notice and flip the party to conventional, per the task description.
	StateDemoted SessionState = "demoted"
)

// AudioHealth surfaces L1.3's own audio-pipeline health (internal/session's
// Session.Health) into the control-plane response -- "audio-dead
// propagation from L1.3 into session state", the L1.6 task description's
// own words. Video passthrough is unaffected by any of this; see
// internal/session's own doc comments for why.
type AudioHealth struct {
	// Enabled is false until this session's AAC encoder subprocess has
	// actually started (internal/session.Session.EnableAudio succeeding);
	// Dead/Restarts are meaningless while it is false.
	Enabled  bool   `json:"enabled"`
	Dead     bool   `json:"dead"`
	Restarts uint64 `json:"restarts"`
}

// SessionInfo is one session as this box reports it: the first ten fields
// (SessionID through BytesServed) are byte-for-byte remuxSessionInfoSchema
// in packages/shared/src/hls-remux-control.ts; the remainder are additive,
// forward-compatible fields the L1.6 task description asks GET /sessions to
// carry (state, demoted, audio health, last-IDR age) that the TS schema
// has not grown yet -- see control.go's package doc comment for why
// returning them is safe today.
//
// LastPartAtMs/LastIdrAtMs/OpenSegmentMs are absolute Unix milliseconds
// (matching StartedAtMs's own units) or nil, NEVER the elapsed-since-
// session-start values internal/serve's local-test-surface /healthz
// reports for the single-session binary -- see internal/session.Session's
// Started/HasPart/HasIdr/OpenSegmentMs doc comments for why the conversion
// happens once, in this package's pipeline wrapper (remux_pipeline.go), not
// in internal/session itself.
type SessionInfo struct {
	SessionID     string `json:"sessionId"`
	Room          string `json:"room"`
	ChannelID     string `json:"channelId"`
	Subscribed    bool   `json:"subscribed"`
	StartedAtMs   int64  `json:"startedAtMs"`
	LastPartAtMs  *int64 `json:"lastPartAtMs"`
	LastIdrAtMs   *int64 `json:"lastIdrAtMs"`
	OpenSegmentMs *int64 `json:"openSegmentMs"`
	PartsWritten  uint64 `json:"partsWritten"`
	// BytesServed counts bytes actually written to an HTTP response under
	// this session's /s/<id>/... routes -- NOT bytes written into the
	// ring, the same distinction internal/serve.Health's own
	// BytesWritten/"NOT bytes an HTTP client has actually read" doc
	// comment draws for the local test surface. See server.go's
	// countingResponseWriter.
	BytesServed uint64 `json:"bytesServed"`

	// --- additive, not yet in the TS schema (see this type's doc comment) ---

	State         SessionState `json:"state"`
	Demoted       bool         `json:"demoted"`
	DemotedReason string       `json:"demotedReason,omitempty"`
	AudioHealth   AudioHealth  `json:"audioHealth"`
	// LastIdrAgeMs is how long ago (from now, at response-build time) the
	// last IDR arrived -- redundant with LastIdrAtMs for a machine reader
	// that already knows "now", but this is the exact quantity section 5's
	// IDR-gap watchdog rule is stated in terms of ("no IDR within 2x/3x
	// segment target"), so an operator reading a raw response should not
	// have to do that subtraction by hand.
	LastIdrAgeMs *int64 `json:"lastIdrAgeMs"`
	// PresenterIdentity is who the session currently follows ("" when no
	// presenter was ever named and no screen share has been bound yet).
	PresenterIdentity string `json:"presenterIdentity"`
	// VideoRebinds counts screen-share tracks replaced inside this session
	// (a republish, a reconnect), across watchdog restarts.
	VideoRebinds uint64 `json:"videoRebinds"`
}

// ListSessionsResponse is GET /sessions's body: byte-for-byte
// remuxListSessionsResponseSchema.
type ListSessionsResponse struct {
	Sessions []SessionInfo `json:"sessions"`
}

// ErrorResponse is every non-2xx response body: byte-for-byte
// remuxErrorResponseSchema.
type ErrorResponse struct {
	Error string `json:"error"`
}
