// Package config parses pqp-remux's environment variables and flags into
// one validated Config. Everything named here is documented in the
// README's config table; keep the two in sync.
package config

import (
	"fmt"
	"math"
	"os"
	"strconv"
	"time"

	"github.com/rafaelcg/pqp/tools/pqp-remux/internal/h264"
	"github.com/rafaelcg/pqp/tools/pqp-remux/internal/keyframe"
)

// Defaults match docs/plans/LL_HLS.md §2/§3/§6: 500ms parts, 4s segments,
// natural keyframe policy (L0.2 has not chosen a branch yet), a 1x gate
// factor for whenever PLI mode is turned on (see
// keyframe.defaultGateFactor for why it is no longer 1.5), and a
// 6-segment ring (~24s of DVR at the default segment target, section 5's
// memory budget).
const (
	DefaultPartMS         = 500
	DefaultSegmentMS      = 4000
	DefaultRingSegments   = 6
	DefaultKeyframePolicy = keyframe.PolicyNatural
	DefaultPLIGateFactor  = 1.0
	// DefaultListen binds loopback only: internal/serve is an
	// unauthenticated local testing surface (see its package doc comment),
	// and defaulting to every interface would turn a forgotten `LISTEN`
	// override into an unauthenticated media disclosure endpoint the
	// moment the box has a routable address. Set LISTEN explicitly to
	// serve beyond localhost, and put a real access-control layer in
	// front of it first — see the README's "Not yet".
	DefaultListen = "127.0.0.1:8089"

	// DefaultAACBitrateKbps matches internal/aacenc.Config's own default;
	// repeated here (rather than importing aacenc just for the constant)
	// so config stays a leaf package with no dependency on the pipeline
	// stages it configures.
	DefaultAACBitrateKbps = 128
	// DefaultRung is what an LL-HLS rendition's `hls_sessions.rung` column
	// is meant to hold once L1.5 writes that row (docs/plans/LL_HLS.md
	// section 4/6: "its hls_sessions row carries rung = 'll'"). Used today
	// only to compute the R2 key prefix (r2.ObjectPrefix) ahead of L1.5
	// existing.
	DefaultRung = "ll"
	// DefaultR2QueueDepth/DefaultR2MaxRetries mirror
	// r2.DefaultQueueDepth/r2.DefaultMaxRetries; repeated for the same
	// leaf-package reason as DefaultAACBitrateKbps above.
	DefaultR2QueueDepth = 64
	DefaultR2MaxRetries = 3

	// DefaultReorderHoldMS / MaxReorderHoldMS mirror
	// internal/control.DefaultReorderHoldMs / maxReorderHoldMs and
	// internal/session's own reorderHoldMax. Repeated as literals rather
	// than imported for the same leaf-package reason as
	// DefaultAACBitrateKbps above.
	DefaultReorderHoldMS = 300
	MaxReorderHoldMS     = 1000

	// DefaultPartDeadlineGraceMS / MaxPartDeadlineGraceMS mirror
	// internal/control's pair, for the same leaf-package reason.
	DefaultPartDeadlineGraceMS = 150
	MaxPartDeadlineGraceMS     = 10000
)

// Config is everything the binary needs, already validated.
type Config struct {
	LiveKitURL    string
	LiveKitAPIKey string
	LiveKitAPISec string
	Room          string

	Listen string

	PartMS    int
	SegmentMS int

	RingSegments int

	KeyframePolicy keyframe.Policy
	PLIGateFactor  float64
	PLIPaceMS      int

	// IDRLogPath and Duration select L0.2's passive logging mode
	// (--idr-log <path>, --duration <dur>) instead of the normal serving
	// mode. IDRLogPath empty means: run normally.
	IDRLogPath string
	Duration   time.Duration

	// AACBitrateKbps is internal/aacenc's target AAC bitrate.
	AACBitrateKbps int
	// FFmpegPath overrides the ffmpeg binary internal/aacenc shells out
	// to; empty resolves "ffmpeg" via PATH.
	FFmpegPath string

	// ChannelID/StartedAtMs/Rung are what r2.ObjectPrefix needs to write
	// under the same key layout hls-egress.ts uses
	// (live/<channelId>/<startedAt>-<rung>). ChannelID defaults to Room:
	// server/src/voice/hls-egress.ts's own roomName IS the channel id
	// (LiveKit rooms are created one per voice channel), so ROOM already
	// carries this value and CHANNEL_ID exists only to override it in a
	// test or a future topology where that stops being true.
	// StartedAtMs defaults to this process's own start time, a stand-in
	// for the `hls_sessions.started_at` L1.5's API control plane will
	// eventually own and pass in; Rung defaults to DefaultRung ("ll").
	ChannelID   string
	StartedAtMs int64
	Rung        string

	// LiveHlsS3* name the LIVE_HLS_S3_* bucket exactly like
	// server/src/voice/hls-egress.ts's liveHlsStorageConfig(): same
	// endpoint, same bucket, same credentials, same path-style switch.
	// Empty Endpoint/Bucket/AccessKeyID/SecretAccessKey means R2 writing
	// is off (see r2.Config.Configured), the same "not configured, not an
	// error" shape as every other optional bucket in this repo.
	LiveHlsS3Endpoint        string
	LiveHlsS3Bucket          string
	LiveHlsS3Region          string
	LiveHlsS3AccessKeyID     string
	LiveHlsS3SecretAccessKey string
	LiveHlsS3ForcePathStyle  bool

	// R2UploadQueueDepth/R2UploadMaxRetries tune internal/r2.Writer.
	R2UploadQueueDepth int
	R2UploadMaxRetries int

	// ClockCutParts is CLOCK_CUT_PARTS: cut every part at exactly the
	// part target and fill the rest of a long frame gap with synthesized
	// frames that repeat the picture already on screen, instead of
	// letting a part run as long as the frame it holds.
	//
	// DEFAULT OFF, AND DEPLOYING THE BINARY CHANGES NOTHING UNTIL IT IS
	// SET. On, a presenter whose encoder pauses no longer produces a 2.25
	// second part -- which Apple's player treats as a fatal playlist
	// parse error ("Partial Segment duration exceeds PART-TARGET"), and
	// which inflates hls.js's hold-back for everyone else. See
	// pipeline.Fragmenter.SetRepeater and internal/skipframe. The
	// synthesizer refuses streams it cannot write a correct slice for, so
	// this is a request, not a promise; the stats line's repeats/cuts
	// counters say whether it is doing anything.
	ClockCutParts bool

	// ReorderHoldMS is REORDER_HOLD_MS: how long internal/session's video
	// reorder buffer holds a packet waiting for the one in front of it
	// before the gap is handed to the depacketizer. DefaultReorderHoldMS
	// (300) is roughly one publisher-to-SFU round trip, which is when a
	// NACKed retransmission lands; 0 turns holding off entirely, which is
	// the rollback to the behaviour before the buffer existed.
	//
	// internal/control.GlobalConfig reads the SAME name for pqp-remuxd.
	// Production runs that binary, so a knob only this package read would
	// be inert on the box that matters (repo pitfall 12).
	ReorderHoldMS int

	// PartDeadlineGraceMS is PART_DEADLINE_GRACE_MS: with clock-cut parts
	// on, how long past the wall instant a part's end maps to the monitor
	// waits for a frame before cutting the part with repeat frames. See
	// internal/session.Session.SetPartDeadlineGrace. 1000 (at or above
	// the idle allowance) is the exact pre-deadline behaviour. Read by
	// BOTH binaries, like REORDER_HOLD_MS.
	PartDeadlineGraceMS int
}

// PartTicks/SegmentTicks convert PartMS/SegmentMS into the 90kHz RTP clock
// ticks the fragmenter and ring both operate in. Validate rejects any
// configuration whose converted tick count would not fit in uint32, so
// these are safe to call unchecked once a Config has passed Validate.
func (c Config) PartTicks() uint32    { return uint32(msToTicks(c.PartMS)) }
func (c Config) SegmentTicks() uint32 { return uint32(msToTicks(c.SegmentMS)) }

// msToTicks multiplies in uint64 before dividing: PART_MS/SEGMENT_MS are
// user-configured, and multiplying in uint32 first (ms * ClockRate) wraps
// for any ms value at or above roughly 47721 (2^32 / 90 000), silently
// cutting segments at the wrong times instead of failing loudly.
//
// This alone is not sufficient for an arbitrarily large ms: on a 64-bit
// platform strconv.Atoi accepts values up to roughly 9.2e18, and
// multiplying that by 90000 overflows uint64 too (uint64's own max is
// about 1.8e19), silently wrapping again — Farol caught exactly this on
// the first fix. maxTicksSafeMs (below) is checked by Validate BEFORE this
// function ever multiplies, so by the time PartTicks/SegmentTicks call it
// unchecked, ms is already known small enough that uint64(ms)*ClockRate
// cannot overflow.
func msToTicks(ms int) uint64 { return uint64(ms) * uint64(h264.ClockRate) / 1000 }

// maxTicksSafeMs is the largest millisecond value whose conversion to
// 90kHz ticks still fits in a uint32, computed so that computing the bound
// itself cannot overflow: math.MaxUint32 (~4.3e9) times 1000 is ~4.3e12,
// far inside uint64's ~1.8e19 range, unlike ms*ClockRate for an
// attacker-chosen ms.
var maxTicksSafeMs = uint64(math.MaxUint32) * 1000 / uint64(h264.ClockRate)

// exceedsTicksBound reports whether ms would overflow a uint32 once
// converted to ticks — checked against the ms value directly, never
// against msToTicks's own (potentially already-wrapped) result.
func exceedsTicksBound(ms int) bool {
	return ms < 0 || uint64(ms) > maxTicksSafeMs
}

// FromEnv reads LIVEKIT_URL, LIVEKIT_API_KEY, LIVEKIT_API_SECRET, ROOM,
// LISTEN, PART_MS, SEGMENT_MS, RING_SEGMENTS, KEYFRAME_POLICY,
// PLI_GATE_FACTOR and PLI_PACE_MS, applying the defaults above for
// whichever are unset, then validates the result.
func FromEnv() (Config, error) {
	c := Config{
		LiveKitURL:     os.Getenv("LIVEKIT_URL"),
		LiveKitAPIKey:  os.Getenv("LIVEKIT_API_KEY"),
		LiveKitAPISec:  os.Getenv("LIVEKIT_API_SECRET"),
		Room:           os.Getenv("ROOM"),
		Listen:         envOr("LISTEN", DefaultListen),
		PartMS:         DefaultPartMS,
		SegmentMS:      DefaultSegmentMS,
		RingSegments:   DefaultRingSegments,
		KeyframePolicy: DefaultKeyframePolicy,
		PLIGateFactor:  DefaultPLIGateFactor,
	}

	var err error
	if c.PartMS, err = envIntOr("PART_MS", DefaultPartMS); err != nil {
		return Config{}, err
	}
	if c.SegmentMS, err = envIntOr("SEGMENT_MS", DefaultSegmentMS); err != nil {
		return Config{}, err
	}
	if c.RingSegments, err = envIntOr("RING_SEGMENTS", DefaultRingSegments); err != nil {
		return Config{}, err
	}
	if v := os.Getenv("KEYFRAME_POLICY"); v != "" {
		switch keyframe.Policy(v) {
		case keyframe.PolicyNatural, keyframe.PolicyPLI:
			c.KeyframePolicy = keyframe.Policy(v)
		default:
			return Config{}, fmt.Errorf("config: KEYFRAME_POLICY=%q must be %q or %q", v, keyframe.PolicyNatural, keyframe.PolicyPLI)
		}
	}
	if v := os.Getenv("PLI_GATE_FACTOR"); v != "" {
		f, err := strconv.ParseFloat(v, 64)
		if err != nil || f <= 0 {
			return Config{}, fmt.Errorf("config: PLI_GATE_FACTOR=%q must be a positive number", v)
		}
		c.PLIGateFactor = f
	}
	if c.PLIPaceMS, err = envIntOr("PLI_PACE_MS", 0); err != nil {
		return Config{}, err
	}
	c.ClockCutParts = os.Getenv("CLOCK_CUT_PARTS") == "true"
	if c.ReorderHoldMS, err = envIntOr("REORDER_HOLD_MS", DefaultReorderHoldMS); err != nil {
		return Config{}, err
	}
	if c.PartDeadlineGraceMS, err = envIntOr("PART_DEADLINE_GRACE_MS", DefaultPartDeadlineGraceMS); err != nil {
		return Config{}, err
	}

	if c.AACBitrateKbps, err = envIntOr("AAC_BITRATE_KBPS", DefaultAACBitrateKbps); err != nil {
		return Config{}, err
	}
	c.FFmpegPath = os.Getenv("FFMPEG_PATH")

	c.ChannelID = envOr("CHANNEL_ID", c.Room)
	c.Rung = envOr("RUNG", DefaultRung)
	startedAt := time.Now().UnixMilli()
	if v := os.Getenv("STARTED_AT_MS"); v != "" {
		n, err := strconv.ParseInt(v, 10, 64)
		if err != nil {
			return Config{}, fmt.Errorf("config: STARTED_AT_MS=%q is not an integer", v)
		}
		startedAt = n
	}
	c.StartedAtMs = startedAt

	c.LiveHlsS3Endpoint = os.Getenv("LIVE_HLS_S3_ENDPOINT")
	c.LiveHlsS3Bucket = os.Getenv("LIVE_HLS_S3_BUCKET")
	// Defaults to r2.DefaultRegion's own value ("auto", R2's convention):
	// repeated as a literal, not imported, to keep this a leaf package
	// (see DefaultAACBitrateKbps's comment above for the same reasoning).
	// r2.Config.SigningRegion() applies the identical fallback on its own
	// if this ever changes without a matching update here.
	c.LiveHlsS3Region = envOr("LIVE_HLS_S3_REGION", "auto")
	c.LiveHlsS3AccessKeyID = os.Getenv("LIVE_HLS_S3_ACCESS_KEY_ID")
	c.LiveHlsS3SecretAccessKey = os.Getenv("LIVE_HLS_S3_SECRET_ACCESS_KEY")
	c.LiveHlsS3ForcePathStyle = os.Getenv("LIVE_HLS_S3_FORCE_PATH_STYLE") == "true"

	if c.R2UploadQueueDepth, err = envIntOr("R2_UPLOAD_QUEUE_DEPTH", DefaultR2QueueDepth); err != nil {
		return Config{}, err
	}
	if c.R2UploadMaxRetries, err = envIntOr("R2_UPLOAD_MAX_RETRIES", DefaultR2MaxRetries); err != nil {
		return Config{}, err
	}

	return c, c.Validate()
}

// Validate checks the required fields and every numeric bound the README's
// config table documents. It does not clamp PLIPaceMS to the SFU's 500ms
// throttle floor — internal/keyframe.Config does that at the point of use,
// so a misconfigured PLI_PACE_MS is silently harmless (extra RTCP the SFU
// coalesces away) rather than a reason to refuse to start.
func (c Config) Validate() error {
	if c.LiveKitURL == "" || c.LiveKitAPIKey == "" || c.LiveKitAPISec == "" || c.Room == "" {
		return fmt.Errorf("config: LIVEKIT_URL, LIVEKIT_API_KEY, LIVEKIT_API_SECRET and ROOM are all required")
	}
	if c.PartMS <= 0 {
		return fmt.Errorf("config: PART_MS must be positive, got %d", c.PartMS)
	}
	if c.SegmentMS <= 0 {
		return fmt.Errorf("config: SEGMENT_MS must be positive, got %d", c.SegmentMS)
	}
	if c.SegmentMS < c.PartMS {
		return fmt.Errorf("config: SEGMENT_MS (%d) must be >= PART_MS (%d)", c.SegmentMS, c.PartMS)
	}
	if exceedsTicksBound(c.PartMS) {
		return fmt.Errorf("config: PART_MS=%d converts to more than a uint32 of 90kHz ticks; keep it under about 13.25 hours", c.PartMS)
	}
	if exceedsTicksBound(c.SegmentMS) {
		return fmt.Errorf("config: SEGMENT_MS=%d converts to more than a uint32 of 90kHz ticks; keep it under about 13.25 hours", c.SegmentMS)
	}
	if c.RingSegments < 1 {
		return fmt.Errorf("config: RING_SEGMENTS must be at least 1, got %d", c.RingSegments)
	}
	if c.AACBitrateKbps <= 0 {
		return fmt.Errorf("config: AAC_BITRATE_KBPS must be positive, got %d", c.AACBitrateKbps)
	}
	if c.R2UploadQueueDepth < 1 {
		return fmt.Errorf("config: R2_UPLOAD_QUEUE_DEPTH must be at least 1, got %d", c.R2UploadQueueDepth)
	}
	if c.R2UploadMaxRetries < 0 {
		return fmt.Errorf("config: R2_UPLOAD_MAX_RETRIES must not be negative, got %d", c.R2UploadMaxRetries)
	}
	// Zero is meaningful ("hold nothing") and is the documented rollback.
	// Negative is not a shorter hold, and a hold past MaxReorderHoldMS is
	// a jitter buffer wearing this knob's name.
	if c.ReorderHoldMS < 0 || c.ReorderHoldMS > MaxReorderHoldMS {
		return fmt.Errorf("config: REORDER_HOLD_MS must be between 0 and %d, got %d", MaxReorderHoldMS, c.ReorderHoldMS)
	}
	if c.PartDeadlineGraceMS < 0 || c.PartDeadlineGraceMS > MaxPartDeadlineGraceMS {
		return fmt.Errorf("config: PART_DEADLINE_GRACE_MS must be between 0 and %d, got %d", MaxPartDeadlineGraceMS, c.PartDeadlineGraceMS)
	}
	return nil
}

// LiveHlsS3Configured reports whether every LIVE_HLS_S3_* field the R2
// writer needs is present. Matches the "not configured means off, not an
// error" shape server/src/voice/hls-egress.ts's own
// liveHlsStorageConfig()/Configured() use for the identical env set.
func (c Config) LiveHlsS3Configured() bool {
	return c.LiveHlsS3Endpoint != "" && c.LiveHlsS3Bucket != "" &&
		c.LiveHlsS3AccessKeyID != "" && c.LiveHlsS3SecretAccessKey != ""
}

// KeyframeConfig builds internal/keyframe.Config from this Config, for the
// caller to hand to keyframe.NewRequester.
func (c Config) KeyframeConfig() keyframe.Config {
	return keyframe.Config{
		Policy:          c.KeyframePolicy,
		SegmentTargetMs: c.SegmentMS,
		GateFactor:      c.PLIGateFactor,
		PaceMs:          c.PLIPaceMS,
	}
}

func envOr(key, def string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return def
}

func envIntOr(key string, def int) (int, error) {
	v := os.Getenv(key)
	if v == "" {
		return def, nil
	}
	n, err := strconv.Atoi(v)
	if err != nil {
		return 0, fmt.Errorf("config: %s=%q is not an integer", key, v)
	}
	return n, nil
}
