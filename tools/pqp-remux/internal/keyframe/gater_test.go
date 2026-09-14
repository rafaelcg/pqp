package keyframe

import (
	"testing"
	"time"
)

var epoch = time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)

func at(ms int) time.Time { return epoch.Add(time.Duration(ms) * time.Millisecond) }

func TestGater_NaturalPolicyNeverSendsPLI(t *testing.T) {
	g := NewGater(Config{Policy: PolicyNatural, SegmentTargetMs: 4000})
	// Even with an extremely stale IDR and no prior PLI, natural policy
	// must never fire.
	if g.ShouldSendPLI(at(1_000_000), at(0), time.Time{}) {
		t.Fatal("PolicyNatural must never request a keyframe")
	}
}

func TestGater_PLIPolicy_WaitsForGateWindow(t *testing.T) {
	g := NewGater(Config{Policy: PolicyPLI, SegmentTargetMs: 4000, GateFactor: 1.5}) // gate = 6000ms
	lastIDR := at(0)

	if g.ShouldSendPLI(at(5999), lastIDR, time.Time{}) {
		t.Fatal("must not fire before the gate window elapses")
	}
	if !g.ShouldSendPLI(at(6000), lastIDR, time.Time{}) {
		t.Fatal("must fire exactly at the gate window")
	}
	if !g.ShouldSendPLI(at(9000), lastIDR, time.Time{}) {
		t.Fatal("must fire well past the gate window")
	}
}

func TestGater_PLIPolicy_PacesRepeatedRequests(t *testing.T) {
	g := NewGater(Config{Policy: PolicyPLI, SegmentTargetMs: 4000, GateFactor: 1.5, PaceMs: 2000})
	lastIDR := at(0)
	firstPLI := at(6000) // gate window just elapsed, PLI sent

	if g.ShouldSendPLI(at(6500), lastIDR, firstPLI) {
		t.Fatal("must not re-fire before the pace interval elapses")
	}
	if !g.ShouldSendPLI(at(8000), lastIDR, firstPLI) {
		t.Fatal("must fire again once the pace interval elapses")
	}
}

func TestGater_PaceIsFlooredAtSFUThrottle(t *testing.T) {
	// L0.1: rtc.pli_throttle's Low tier defaults to 500ms; asking for a
	// pace faster than that must not change behavior.
	g := NewGater(Config{Policy: PolicyPLI, SegmentTargetMs: 4000, GateFactor: 1.5, PaceMs: 10})
	lastIDR := at(0)
	firstPLI := at(6000)

	if g.ShouldSendPLI(at(6400), lastIDR, firstPLI) {
		t.Fatal("pace must be floored at 500ms even if PaceMs asks for less")
	}
	if !g.ShouldSendPLI(at(6500), lastIDR, firstPLI) {
		t.Fatal("500ms after the last PLI, a new one is due")
	}
}

func TestGater_ResetsCleanOnFreshIDR(t *testing.T) {
	g := NewGater(Config{Policy: PolicyPLI, SegmentTargetMs: 4000, GateFactor: 1.5})
	// An IDR arrived recently: even if a PLI was sent a long time ago (by
	// the caller's convention, lastPLI is reset to zero on every IDR), the
	// gate must not fire until the window has elapsed AGAIN from the new
	// IDR.
	freshIDR := at(100000)
	if g.ShouldSendPLI(at(100001), freshIDR, time.Time{}) {
		t.Fatal("must not fire right after a fresh IDR")
	}
}

func TestConfig_GateWindowAndPaceDefaults(t *testing.T) {
	c := Config{SegmentTargetMs: 4000} // GateFactor and PaceMs both zero
	if got := c.GateWindow(); got != 6000*time.Millisecond {
		t.Fatalf("GateWindow() = %v, want 6000ms (default 1.5x)", got)
	}
	if got := c.Pace(); got != 500*time.Millisecond {
		t.Fatalf("Pace() = %v, want the 500ms floor", got)
	}
}
