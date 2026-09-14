package config

import (
	"testing"

	"github.com/rafaelcg/pqp/tools/pqp-remux/internal/keyframe"
)

func withEnv(t *testing.T, kv map[string]string, fn func()) {
	t.Helper()
	for k, v := range kv {
		t.Setenv(k, v)
	}
	fn()
}

func baseEnv() map[string]string {
	return map[string]string{
		"LIVEKIT_URL":        "wss://sfu.example.test",
		"LIVEKIT_API_KEY":    "key",
		"LIVEKIT_API_SECRET": "secret",
		"ROOM":               "room-1",
	}
}

func TestFromEnv_Defaults(t *testing.T) {
	var c Config
	var err error
	withEnv(t, baseEnv(), func() { c, err = FromEnv() })
	if err != nil {
		t.Fatalf("FromEnv: %v", err)
	}
	if c.PartMS != DefaultPartMS || c.SegmentMS != DefaultSegmentMS {
		t.Fatalf("unexpected defaults: PartMS=%d SegmentMS=%d", c.PartMS, c.SegmentMS)
	}
	if c.RingSegments != DefaultRingSegments {
		t.Fatalf("RingSegments = %d, want %d", c.RingSegments, DefaultRingSegments)
	}
	if c.KeyframePolicy != keyframe.PolicyNatural {
		t.Fatalf("KeyframePolicy = %q, want natural", c.KeyframePolicy)
	}
	if c.Listen != DefaultListen {
		t.Fatalf("Listen = %q, want %q", c.Listen, DefaultListen)
	}
}

func TestFromEnv_MissingRequiredFields(t *testing.T) {
	if _, err := FromEnv(); err == nil {
		t.Fatal("expected an error with no env set at all")
	}
}

func TestFromEnv_PartTicksAndSegmentTicks(t *testing.T) {
	var c Config
	env := baseEnv()
	env["PART_MS"] = "500"
	env["SEGMENT_MS"] = "4000"
	withEnv(t, env, func() { c, _ = FromEnv() })

	if got := c.PartTicks(); got != 45000 {
		t.Fatalf("PartTicks() = %d, want 45000 (500ms @ 90kHz)", got)
	}
	if got := c.SegmentTicks(); got != 360000 {
		t.Fatalf("SegmentTicks() = %d, want 360000 (4000ms @ 90kHz)", got)
	}
}

func TestFromEnv_RejectsSegmentShorterThanPart(t *testing.T) {
	env := baseEnv()
	env["PART_MS"] = "5000"
	env["SEGMENT_MS"] = "1000"
	var err error
	withEnv(t, env, func() { _, err = FromEnv() })
	if err == nil {
		t.Fatal("expected an error when SEGMENT_MS < PART_MS")
	}
}

func TestFromEnv_RejectsBadKeyframePolicy(t *testing.T) {
	env := baseEnv()
	env["KEYFRAME_POLICY"] = "aggressive"
	var err error
	withEnv(t, env, func() { _, err = FromEnv() })
	if err == nil {
		t.Fatal("expected an error for an unrecognized KEYFRAME_POLICY")
	}
}

func TestFromEnv_AcceptsPLIPolicyAndGateFactor(t *testing.T) {
	env := baseEnv()
	env["KEYFRAME_POLICY"] = "pli"
	env["PLI_GATE_FACTOR"] = "2.0"
	env["PLI_PACE_MS"] = "1000"
	var c Config
	var err error
	withEnv(t, env, func() { c, err = FromEnv() })
	if err != nil {
		t.Fatalf("FromEnv: %v", err)
	}
	if c.KeyframePolicy != keyframe.PolicyPLI {
		t.Fatalf("KeyframePolicy = %q, want pli", c.KeyframePolicy)
	}
	if c.PLIGateFactor != 2.0 {
		t.Fatalf("PLIGateFactor = %v, want 2.0", c.PLIGateFactor)
	}
	kc := c.KeyframeConfig()
	if kc.Policy != keyframe.PolicyPLI || kc.SegmentTargetMs != c.SegmentMS || kc.GateFactor != 2.0 || kc.PaceMs != 1000 {
		t.Fatalf("KeyframeConfig() = %+v", kc)
	}
}

func TestFromEnv_RejectsNonPositivePLIGateFactor(t *testing.T) {
	env := baseEnv()
	env["PLI_GATE_FACTOR"] = "0"
	var err error
	withEnv(t, env, func() { _, err = FromEnv() })
	if err == nil {
		t.Fatal("expected an error for a non-positive PLI_GATE_FACTOR")
	}
}

// TestFromEnv_PartTicksDoesNotOverflow is the regression test for the bug
// Farol caught: msToTicks used to multiply in uint32 before dividing, so
// SEGMENT_MS=60000 (a full minute, a value Validate happily accepted)
// wrapped 5.4 billion ticks down to a small, wrong duration instead of the
// correct 5 400 000 ticks.
func TestFromEnv_PartTicksDoesNotOverflow(t *testing.T) {
	env := baseEnv()
	env["SEGMENT_MS"] = "60000"
	env["PART_MS"] = "500"
	var c Config
	var err error
	withEnv(t, env, func() { c, err = FromEnv() })
	if err != nil {
		t.Fatalf("FromEnv: %v", err)
	}
	if got, want := c.SegmentTicks(), uint32(5_400_000); got != want {
		t.Fatalf("SegmentTicks() = %d, want %d (60000ms @ 90kHz)", got, want)
	}
}

// TestFromEnv_RejectsExtremeDurationThatWouldOverflowTheBoundsCheckItself
// is the regression test for the second overflow Farol caught: the first
// fix compared msToTicks(ms) against math.MaxUint32, but msToTicks itself
// multiplies ms by 90000 in uint64, which silently wraps for a
// sufficiently large (still-valid-int64) ms — so a large enough SEGMENT_MS
// could wrap all the way back down to a small tick count and pass
// validation, exactly the class of bug the check exists to catch.
func TestFromEnv_RejectsExtremeDurationThatWouldOverflowTheBoundsCheckItself(t *testing.T) {
	env := baseEnv()
	// Chosen so that ms * 90000 overflows uint64 (uint64 max ~1.8e19;
	// this ms is ~2e17, so ms*90000 ~= 1.8e22, wrapping many times over).
	env["SEGMENT_MS"] = "200000000000000000"
	var err error
	withEnv(t, env, func() { _, err = FromEnv() })
	if err == nil {
		t.Fatal("expected an error for a SEGMENT_MS large enough to overflow the tick conversion itself, not just its result")
	}
}

func TestFromEnv_RejectsDurationTooLargeToFitTicksInUint32(t *testing.T) {
	env := baseEnv()
	// math.MaxUint32 ticks / 90000 * 1000 ~= 47721000ms; go one segment
	// past it so the converted tick count exceeds uint32.
	env["SEGMENT_MS"] = "50000000"
	var err error
	withEnv(t, env, func() { _, err = FromEnv() })
	if err == nil {
		t.Fatal("expected an error when SEGMENT_MS converts to more ticks than fit in a uint32")
	}
}

func TestFromEnv_RejectsNonIntegerEnv(t *testing.T) {
	env := baseEnv()
	env["RING_SEGMENTS"] = "six"
	var err error
	withEnv(t, env, func() { _, err = FromEnv() })
	if err == nil {
		t.Fatal("expected an error for a non-integer RING_SEGMENTS")
	}
}
