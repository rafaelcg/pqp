package control

import (
	"context"
	"testing"
	"time"
)

func waitFor(t *testing.T, timeout time.Duration, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		if cond() {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatalf("condition not met within %s", timeout)
}

// TestManagedSession_WatchdogRestartsThenDemotes_Integration drives the
// REAL watchdog goroutine (runWatchdog/evaluateTick/restart/demote), not
// just the pure evaluateWatchdog function watchdog_test.go already covers
// in isolation: a session whose pipeline produced one part and then never
// progressed again must be restarted once and then demoted, entirely on
// its own, within a few real ticks -- this is this task's own acceptance
// bar ("stopping the remux container mid-party demotes inside 5s with no
// player rebuild") exercised end to end with a fake pipeline clock
// standing in for a real stalled subscription.
//
// Every generation's pipeline is primed with a recent LastPartAt/LastIdrAt
// at construction (factoryWithHealth) rather than left at the zero value:
// with FirstPartTimeoutMs/PartStuckMs both now real phases (Farol review,
// PR #584), a pipeline that has NEVER produced a part is "waiting", not
// "stalled", and is governed by FirstPartTimeoutMs (its own test,
// TestEvaluateWatchdog_NoPartEverArrives_DemotesAsNoVideo) -- this test is
// specifically about the part-stuck ladder, which only applies once a part
// has already arrived at least once.
func TestManagedSession_WatchdogRestartsThenDemotes_Integration(t *testing.T) {
	spy := &pipelineSpy{}
	// A small PartStuckMs (well under watchdogTick's own 500ms interval)
	// so both the restart and the demote happen within the first couple
	// of ticks; a wide FirstPartTimeoutMs/DemoteWindowMs so neither the
	// waiting phase nor the demote-window boundary interferes.
	wd := WatchdogConfig{FirstPartTimeoutMs: 60_000, PartStuckMs: 50, DemoteWindowMs: 60_000}
	reg := NewRegistry(context.Background(), spy.factoryWithHealth(PipelineHealth{LastPartAt: time.Now(), LastIdrAt: time.Now()}), GlobalConfig{}, wd, nil)
	t.Cleanup(reg.StopAll)

	req := testStartReq(sessA, chanA, chanA)
	if _, _, err := reg.StartOrGet(req); err != nil {
		t.Fatalf("unexpected error starting session: %v", err)
	}

	// Every pipeline this factory ever builds starts with a frozen "just
	// produced a part" snapshot and is never touched again, so it reads as
	// progressively staler on every subsequent tick: the first pipeline
	// stalls and is restarted once, and the brand-new (also frozen, also
	// never touched) replacement stalls again and is demoted.
	waitFor(t, 5*time.Second, func() bool { return spy.count() >= 2 })
	waitFor(t, 5*time.Second, func() bool {
		ms, ok := reg.Get(sessA)
		return ok && ms.Info().Demoted
	})

	ms, ok := reg.Get(sessA)
	if !ok {
		t.Fatal("expected a demoted session to remain registered (reported, not removed) until an explicit Stop")
	}
	info := ms.Info()
	if info.State != StateDemoted {
		t.Fatalf("expected state %q, got %q", StateDemoted, info.State)
	}
	if info.DemotedReason == "" {
		t.Fatal("expected a non-empty demotedReason")
	}
	if !spy.at(0).isClosed() {
		t.Fatal("expected the first (stalled) pipeline to have been closed by the restart")
	}
	if !spy.at(1).isClosed() {
		t.Fatal("expected the second (also stalled) pipeline to have been closed by demotion")
	}

	// A killed API (nobody polling this process at all) must never
	// spontaneously reap or otherwise disturb an already-demoted session
	// on its own -- demotion is terminal until an explicit Stop.
	time.Sleep(3 * watchdogTick)
	info2 := ms.Info()
	if !info2.Demoted || info2.State != StateDemoted {
		t.Fatalf("expected a demoted session to stay demoted with no further action, got %+v", info2)
	}
}

// TestManagedSession_StopClosesActivePipeline covers Stop's own contract
// directly (registry_test.go's TestRegistry_Stop_IsIdempotent exercises it
// through the registry; this pins ManagedSession.Stop itself, including
// that its watchdog goroutine has genuinely exited before Stop returns).
func TestManagedSession_StopClosesActivePipeline(t *testing.T) {
	spy := &pipelineSpy{}
	reg := NewRegistry(context.Background(), spy.factory(), GlobalConfig{}, fixedWatchdogCfg(), nil)
	t.Cleanup(reg.StopAll)

	req := testStartReq(sessA, chanA, chanA)
	if _, _, err := reg.StartOrGet(req); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	ms, ok := reg.Get(sessA)
	if !ok {
		t.Fatal("expected the session to be registered")
	}

	ms.Stop()
	select {
	case <-ms.wdDone:
	default:
		t.Fatal("expected Stop to wait for the watchdog goroutine to exit")
	}
	if !spy.last().isClosed() {
		t.Fatal("expected Stop to close the active pipeline")
	}

	// A second Stop must not panic or double-close.
	ms.Stop()
}
