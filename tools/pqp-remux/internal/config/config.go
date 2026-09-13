// Package config parses pqp-remux's environment variables and flags into
// one validated Config. Everything named here is documented in the
// README's config table; keep the two in sync.
package config

import (
	"fmt"
	"os"
	"strconv"
	"time"

	"github.com/rafaelcg/pqp/tools/pqp-remux/internal/h264"
	"github.com/rafaelcg/pqp/tools/pqp-remux/internal/keyframe"
)

// Defaults match docs/plans/LL_HLS.md §2/§3/§6: 500ms parts, 4s segments,
// natural keyframe policy (L0.2 has not chosen a branch yet), a 1.5x gate
// factor for whenever PLI mode is turned on, and a 6-segment ring (~24s of
// DVR at the default segment target, section 5's memory budget).
const (
	DefaultPartMS         = 500
	DefaultSegmentMS      = 4000
	DefaultRingSegments   = 6
	DefaultKeyframePolicy = keyframe.PolicyNatural
	DefaultPLIGateFactor  = 1.5
	DefaultListen         = ":8089"
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
}

// PartTicks/SegmentTicks convert PartMS/SegmentMS into the 90kHz RTP clock
// ticks the fragmenter and ring both operate in.
func (c Config) PartTicks() uint32    { return msToTicks(c.PartMS) }
func (c Config) SegmentTicks() uint32 { return msToTicks(c.SegmentMS) }

func msToTicks(ms int) uint32 { return uint32(ms) * h264.ClockRate / 1000 }

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
	if c.RingSegments < 1 {
		return fmt.Errorf("config: RING_SEGMENTS must be at least 1, got %d", c.RingSegments)
	}
	return nil
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
