package control

import (
	"testing"
	"time"
)

const testSegmentMs = 4000 // matches config.DefaultSegmentMS

func fixedWatchdogCfg() WatchdogConfig {
	return WatchdogConfig{
		FirstPartTimeoutMs: DefaultFirstPartTimeoutMs,
		PartStuckMs:        DefaultPartStuckMs,
		DemoteWindowMs:     DefaultDemoteWindowMs,
		VideoIdleMaxMs:     DefaultVideoIdleMaxMs,
	}
}

func TestEvaluateWatchdog_HealthyIsNoop(t *testing.T) {
	start := time.UnixMilli(0)
	now := start.Add(30 * time.Second)
	h := PipelineHealth{
		LastPartAt: now.Add(-100 * time.Millisecond),
		LastIdrAt:  now.Add(-500 * time.Millisecond),
	}
	var st watchdogState
	got := evaluateWatchdog(h, testSegmentMs, fixedWatchdogCfg(), start, &st, now)
	if got.action != actionNone {
		t.Fatalf("expected actionNone for healthy pipeline, got %v (%s)", got.action, got.reason)
	}
}

func TestEvaluateWatchdog_NoPartYet_IsWaitingNotStalled(t *testing.T) {
	// No part has ever arrived: this is StateWaiting (a presenter who has
	// not clicked "share screen" yet, or a room just joined), NOT a stall
	// -- PART_STUCK_MS (3s by default) must NOT govern this phase at all
	// (Farol review, PR #584). Well past PartStuckMs, but nowhere near
	// FirstPartTimeoutMs, must still be a no-op.
	start := time.UnixMilli(0)
	cfg := fixedWatchdogCfg()
	now := start.Add(10 * time.Duration(cfg.PartStuckMs) * time.Millisecond)
	// Nothing has arrived, video or audio -- even a "recent IDR" fixture
	// would be nonsensical here (internal/pipeline.Fragmenter never emits
	// a part before its first IDR, so "an IDR but no part" cannot happen
	// in practice); PipelineHealth{} is the honest fixture.
	h := PipelineHealth{}
	var st watchdogState

	got := evaluateWatchdog(h, testSegmentMs, cfg, start, &st, now)
	if got.action != actionNone {
		t.Fatalf("expected actionNone while waiting for a first part (well under FirstPartTimeoutMs), got %v (%s)", got.action, got.reason)
	}
}

func TestEvaluateWatchdog_NoPartEverArrives_DemotesAsNoVideo(t *testing.T) {
	// Past FirstPartTimeoutMs with still nothing at all: demote, reason
	// "no-video" -- distinct from the part-stuck ladder's own reasons, and
	// with no restart attempt recorded (there is nothing to restart INTO;
	// the pipeline is already doing the one thing it can, waiting for a
	// track).
	start := time.UnixMilli(0)
	cfg := fixedWatchdogCfg()
	now := start.Add(time.Duration(cfg.FirstPartTimeoutMs)*time.Millisecond + time.Millisecond)
	h := PipelineHealth{}
	var st watchdogState

	got := evaluateWatchdog(h, testSegmentMs, cfg, start, &st, now)
	if got.action != actionDemote || got.reason != "no-video" {
		t.Fatalf("expected actionDemote with reason %q, got %v (%s)", "no-video", got.action, got.reason)
	}
	if !st.restartedAt.IsZero() {
		t.Fatal("expected the no-video demote path to never touch the part-stuck restart bookkeeping")
	}
}

func TestEvaluateWatchdog_RestartThenDemoteWithinWindow(t *testing.T) {
	start := time.UnixMilli(0)
	cfg := fixedWatchdogCfg()
	stuck := time.Duration(cfg.PartStuckMs) * time.Millisecond

	var st watchdogState
	lastPart := start
	tick1 := start.Add(stuck + time.Millisecond)
	h1 := PipelineHealth{LastPartAt: lastPart, LastIdrAt: tick1.Add(-time.Second)}
	got1 := evaluateWatchdog(h1, testSegmentMs, cfg, start, &st, tick1)
	if got1.action != actionRestart {
		t.Fatalf("first stall: expected actionRestart, got %v (%s)", got1.action, got1.reason)
	}
	if st.restartedAt != tick1 {
		t.Fatalf("expected restartedAt to be recorded at %v, got %v", tick1, st.restartedAt)
	}

	// A second stall shortly after the restart (well within
	// DemoteWindowMs), with no new part since (the restarted pipeline is
	// ALSO stuck): must demote, not restart again.
	tick2 := tick1.Add(stuck + time.Millisecond)
	h2 := PipelineHealth{LastPartAt: lastPart, LastIdrAt: tick2.Add(-time.Second)}
	got2 := evaluateWatchdog(h2, testSegmentMs, cfg, start, &st, tick2)
	if got2.action != actionDemote {
		t.Fatalf("second stall within window: expected actionDemote, got %v (%s)", got2.action, got2.reason)
	}
	if got2.reason != "part-stuck-second-stall" {
		t.Fatalf("expected reason %q, got %q", "part-stuck-second-stall", got2.reason)
	}
}

func TestEvaluateWatchdog_RecoveryThenLateStallRestartsAgain(t *testing.T) {
	// A stall long after the demote window has elapsed from the last
	// restart is a FRESH episode (the pipeline was healthy for a long
	// stretch in between), and gets its own restart, not an immediate
	// demote.
	start := time.UnixMilli(0)
	cfg := fixedWatchdogCfg()
	stuck := time.Duration(cfg.PartStuckMs) * time.Millisecond
	window := time.Duration(cfg.DemoteWindowMs) * time.Millisecond

	var st watchdogState
	tick1 := start.Add(stuck + time.Millisecond)
	h1 := PipelineHealth{LastPartAt: start, LastIdrAt: tick1.Add(-time.Second)}
	if got := evaluateWatchdog(h1, testSegmentMs, cfg, start, &st, tick1); got.action != actionRestart {
		t.Fatalf("expected the first stall to restart, got %v", got.action)
	}

	// The pipeline recovers: parts keep arriving right up to a point well
	// past the demote window.
	recoveredUntil := tick1.Add(window + time.Hour)
	healthy := PipelineHealth{LastPartAt: recoveredUntil, LastIdrAt: recoveredUntil}
	if got := evaluateWatchdog(healthy, testSegmentMs, cfg, start, &st, recoveredUntil); got.action != actionNone {
		t.Fatalf("expected a healthy tick mid-recovery to be a no-op, got %v", got.action)
	}

	// Now it stalls again, long after the first restart.
	tick2 := recoveredUntil.Add(stuck + time.Millisecond)
	h2 := PipelineHealth{LastPartAt: recoveredUntil, LastIdrAt: tick2.Add(-time.Second)}
	got2 := evaluateWatchdog(h2, testSegmentMs, cfg, start, &st, tick2)
	if got2.action != actionRestart {
		t.Fatalf("expected a stall long after the demote window to restart again (fresh episode), got %v (%s)", got2.action, got2.reason)
	}
}

func TestEvaluateWatchdog_IdrGapWarningLogsOncePerGap(t *testing.T) {
	start := time.UnixMilli(0)
	cfg := fixedWatchdogCfg()
	segDur := time.Duration(testSegmentMs) * time.Millisecond
	var st watchdogState

	lastIdr := start
	// Just past 2x the segment target: a warning, once.
	tick1 := start.Add(2*segDur + time.Millisecond)
	h := PipelineHealth{LastPartAt: tick1, LastIdrAt: lastIdr}
	got1 := evaluateWatchdog(h, testSegmentMs, cfg, start, &st, tick1)
	if got1.action != actionLog || got1.reason != "idr-gap-warning" {
		t.Fatalf("expected one idr-gap-warning log, got %v (%s)", got1.action, got1.reason)
	}

	// A second tick, still in the 2x-3x band, no new IDR: must NOT log
	// again (rate-limited to once per gap).
	tick2 := tick1.Add(time.Second)
	got2 := evaluateWatchdog(h, testSegmentMs, cfg, start, &st, tick2)
	if got2.action != actionNone {
		t.Fatalf("expected the warning to be rate-limited to once per gap, got %v (%s)", got2.action, got2.reason)
	}

	// The gap closes (a fresh IDR arrives): idrWarnLogged resets, so the
	// NEXT time the gap reopens past 2x, it logs again.
	tick3 := tick2.Add(time.Millisecond)
	recovered := PipelineHealth{LastPartAt: tick3, LastIdrAt: tick3}
	if got3 := evaluateWatchdog(recovered, testSegmentMs, cfg, start, &st, tick3); got3.action != actionNone {
		t.Fatalf("expected a fresh IDR to clear the warning state as a no-op tick, got %v", got3.action)
	}
	if st.idrWarnLogged {
		t.Fatal("expected idrWarnLogged to reset once the gap closed")
	}

	tick4 := tick3.Add(2*segDur + time.Millisecond)
	stale := PipelineHealth{LastPartAt: tick4, LastIdrAt: tick3}
	got4 := evaluateWatchdog(stale, testSegmentMs, cfg, start, &st, tick4)
	if got4.action != actionLog || got4.reason != "idr-gap-warning" {
		t.Fatalf("expected the warning to log again for a fresh gap, got %v (%s)", got4.action, got4.reason)
	}
}

func TestEvaluateWatchdog_IdrGapExceededDemotesOutright(t *testing.T) {
	// Past 3x the segment target with no IDR: demote immediately, with NO
	// restart attempt at all -- restarting the same subscription to the
	// same room does nothing for a publisher that stopped sending
	// keyframes (docs/plans/LL_HLS.md §5).
	start := time.UnixMilli(0)
	cfg := fixedWatchdogCfg()
	segDur := time.Duration(testSegmentMs) * time.Millisecond
	var st watchdogState

	now := start.Add(3*segDur + time.Millisecond)
	// Parts are still flowing fine (a part needs no IDR) -- only the IDR
	// clock is stuck. This also proves precedence: the part-stuck ladder
	// alone would not fire here at all (LastPartAt is "now"), yet the
	// result must still be actionDemote.
	h := PipelineHealth{LastPartAt: now, LastIdrAt: start}
	got := evaluateWatchdog(h, testSegmentMs, cfg, start, &st, now)
	if got.action != actionDemote {
		t.Fatalf("expected actionDemote for an exceeded IDR gap, got %v (%s)", got.action, got.reason)
	}
	if got.reason != "idr-gap-exceeded" {
		t.Fatalf("expected reason %q, got %q", "idr-gap-exceeded", got.reason)
	}
	if !st.restartedAt.IsZero() {
		t.Fatal("expected the IDR-gap demote path to never touch the part-stuck restart bookkeeping")
	}
}

// TestEvaluateWatchdog_PartWithNoRecordedIdr_DefensiveFallback covers a
// combination internal/pipeline.Fragmenter's own invariant makes
// impossible in practice (it never emits a fragment before the stream's
// first IDR -- ErrWaitingForIDR -- so PartsWritten > 0 already implies an
// IDR has been seen): a part has arrived, but LastIdrAt is still zero.
// evaluateWatchdog falls back to h.LastPartAt for the IDR reference in
// that case (watchdog.go), which makes the "gap" zero rather than
// "however many years since the Unix epoch" -- fail toward a harmless
// no-op if this invariant is ever violated by a future change, not toward
// an instant, surprising demote.
func TestEvaluateWatchdog_PartWithNoRecordedIdr_DefensiveFallback(t *testing.T) {
	start := time.UnixMilli(0)
	cfg := fixedWatchdogCfg()
	segDur := time.Duration(testSegmentMs) * time.Millisecond
	var st watchdogState

	now := start.Add(3*segDur + time.Millisecond)
	h := PipelineHealth{LastPartAt: now} // a part just arrived; LastIdrAt is (impossibly) still zero
	got := evaluateWatchdog(h, testSegmentMs, cfg, start, &st, now)
	if got.action != actionNone {
		t.Fatalf("expected the defensive IDR fallback to treat this as a healthy tick, got %v (%s)", got.action, got.reason)
	}
}
