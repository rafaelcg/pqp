package control

import (
	"context"
	"os/exec"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

// TestRegistry_CancelDuringConstructionLeavesNoChildProcess is the
// acceptance test named in Farol's review on PR #584 ("pipeline startup
// uses an independent background context and can outlive the HTTP request
// and registry shutdown"): cancel the supervisor's own context while a
// session's Pipeline is still being built, and confirm no goroutine or
// child process is left running.
//
// NewRemuxPipeline itself cannot be driven in a unit test -- it needs a
// live LiveKit room, the same constraint restart_r2_test.go's own doc
// comment already documents -- so this test exercises the actual
// mechanism the fix depends on (a context.Context threaded from
// cmd/pqp-remuxd/main.go through Registry into every PipelineFactory call,
// see PipelineFactory's own doc comment) against a factory that spawns a
// REAL short-lived subprocess via exec.CommandContext(ctx, ...), exactly
// the way internal/aacenc.Encoder spawns ffmpeg (exec.CommandContext(ctx,
// bin, ...) in aacenc.New) and exactly what makes that subprocess die the
// moment ctx is cancelled, construction-in-progress or not.
func TestRegistry_CancelDuringConstructionLeavesNoChildProcess(t *testing.T) {
	supervisorCtx, supervisorCancel := context.WithCancel(context.Background())

	factoryStarted := make(chan struct{})
	var procMu sync.Mutex
	var proc *exec.Cmd
	var factoryObservedDone atomic.Bool

	factory := func(ctx context.Context, cfg PipelineConfig) (Pipeline, error) {
		// Stand-in for aacenc.New's ffmpeg subprocess: exec.CommandContext
		// ties this process's lifetime directly to ctx, the same
		// mechanism the real audio encoder relies on.
		cmd := exec.CommandContext(ctx, "sleep", "30")
		if err := cmd.Start(); err != nil {
			t.Fatalf("failed to start stand-in child process: %v", err)
		}
		procMu.Lock()
		proc = cmd
		procMu.Unlock()
		close(factoryStarted)

		// Stand-in for subscriber.Connect's blocking network dial, which
		// this fix cannot itself interrupt (see NewRemuxPipeline's own
		// doc comment on that limitation) -- but a WELL-BEHAVED wait
		// like this one, and the ffmpeg-equivalent subprocess above,
		// both react to ctx exactly the way this fix depends on. The
		// 10s ceiling means a regression (ctx not actually threaded
		// through) fails this test on ITS OWN timeout rather than
		// hanging the whole suite.
		select {
		case <-ctx.Done():
			factoryObservedDone.Store(true)
		case <-time.After(10 * time.Second):
		}

		_ = cmd.Wait() // reap so ProcessState is populated below
		return nil, ctx.Err()
	}

	registry := NewRegistry(supervisorCtx, factory, GlobalConfig{}, fixedWatchdogCfg(), nil)

	done := make(chan struct{})
	go func() {
		defer close(done)
		_, _, _ = registry.StartOrGet(testStartReq(sessA, chanA, chanA))
	}()

	select {
	case <-factoryStarted:
	case <-time.After(2 * time.Second):
		t.Fatal("factory never started its stand-in child process")
	}

	// The case under test: the supervisor begins shutting down while
	// construction is still genuinely in flight (the child process is
	// running, StartOrGet has not returned).
	supervisorCancel()

	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("StartOrGet did not return within 2s of the supervisor context being cancelled during construction -- ctx is not reaching the in-flight factory call")
	}

	if !factoryObservedDone.Load() {
		t.Fatal("the in-flight factory call never observed ctx.Done() -- the supervisor's context is not threaded through to a session still under construction")
	}

	procMu.Lock()
	p := proc
	procMu.Unlock()
	if p == nil || p.ProcessState == nil {
		t.Fatal("expected the stand-in child process to have been reaped (ProcessState populated) once the supervisor context was cancelled")
	}
	if p.ProcessState.Success() {
		t.Fatal("expected the stand-in child process to have been killed by context cancellation, not to have exited successfully on its own -- \"no ffmpeg child remains\" means killed, not merely eventually exited")
	}

	if sessions := registry.List(); len(sessions) != 0 {
		t.Fatalf("expected no session registered after a start cancelled mid-construction, got %d", len(sessions))
	}
}
