package control

import (
	"testing"
	"time"
)

// A REBIND'S KEYFRAME WAIT MUST NOT COST THE SESSION. The presenter
// republished; the new source sends packets and frames, and every frame is
// dropped until its first IDR, so no part is published and the last IDR
// recedes. Before this rule the watchdog restarted at PART_STUCK_MS and
// demoted at 3x the segment target (12 s): a publisher that took longer
// than that to answer the keyframe request lost the party its LL session.
func TestEvaluateWatchdog_RebindKeyframeWaitNeverRestartsOrDemotes(t *testing.T) {
	start := time.UnixMilli(0)
	cfg := fixedWatchdogCfg()
	bound := start.Add(40 * time.Second)
	var st watchdogState
	logged := 0
	// 20 s of waiting, ticking every 500 ms like the real watchdog, with
	// the new source's packets and (dropped) frames arriving throughout.
	for at := bound; at.Before(bound.Add(20 * time.Second)); at = at.Add(watchdogTick) {
		h := PipelineHealth{
			PartsWritten:       400,
			LastPartAt:         bound.Add(-200 * time.Millisecond),
			LastIdrAt:          bound.Add(-3 * time.Second),
			LastVideoFrameAt:   at.Add(-30 * time.Millisecond),
			LastVideoPacketAt:  at.Add(-5 * time.Millisecond),
			RebindWaitingSince: bound,
		}
		got := evaluateWatchdog(h, testSegmentMs, cfg, start, &st, at)
		switch got.action {
		case actionNone:
		case actionLog:
			logged++
			if got.reason != "rebind-awaiting-keyframe" {
				t.Fatalf("logged %q while a rebind waited, want rebind-awaiting-keyframe", got.reason)
			}
		default:
			t.Fatalf("%s into a rebind's keyframe wait the watchdog did %v (%s)", at.Sub(bound), got.action, got.reason)
		}
	}
	if logged != 1 {
		t.Fatalf("logged the wait %d times, want once", logged)
	}
	if !st.restartedAt.IsZero() {
		t.Fatal("the keyframe wait used up the session's one restart")
	}

	// The keyframe arrives 20 s in. Both clocks start again from here: the
	// 23 s since the last OLD IDR is not an IDR gap, and one tick later with
	// parts flowing nothing happens at all.
	idr := bound.Add(20 * time.Second)
	h := PipelineHealth{
		PartsWritten:      401,
		LastPartAt:        bound.Add(-200 * time.Millisecond),
		LastIdrAt:         idr,
		LastVideoFrameAt:  idr,
		LastVideoPacketAt: idr,
	}
	if got := evaluateWatchdog(h, testSegmentMs, cfg, start, &st, idr); got.action != actionNone {
		t.Fatalf("the tick the keyframe arrived did %v (%s)", got.action, got.reason)
	}
	h.LastPartAt = idr.Add(400 * time.Millisecond)
	if got := evaluateWatchdog(h, testSegmentMs, cfg, start, &st, idr.Add(watchdogTick)); got.action != actionNone {
		t.Fatalf("a healthy tick after the rebind did %v (%s)", got.action, got.reason)
	}

	// And the ladder is intact afterwards: a genuine stall still restarts.
	stall := idr.Add(4 * time.Second)
	h.LastVideoFrameAt, h.LastVideoPacketAt = stall, stall
	if got := evaluateWatchdog(h, testSegmentMs, cfg, start, &st, stall); got.action != actionRestart {
		t.Fatalf("a real stall after the rebind did %v (%s), want a restart", got.action, got.reason)
	}
}

// A keyframe that never comes is bounded like a first part that never
// comes, and says which it was.
func TestEvaluateWatchdog_RebindWithNoKeyframeEverIsBounded(t *testing.T) {
	start := time.UnixMilli(0)
	cfg := fixedWatchdogCfg()
	bound := start.Add(40 * time.Second)
	var st watchdogState
	at := bound.Add(msDuration(cfg.FirstPartTimeoutMs) + time.Second)
	h := PipelineHealth{
		PartsWritten:       400,
		LastPartAt:         bound,
		LastIdrAt:          bound,
		LastVideoFrameAt:   at,
		LastVideoPacketAt:  at,
		RebindWaitingSince: bound,
	}
	got := evaluateWatchdog(h, testSegmentMs, cfg, start, &st, at)
	if got.action != actionDemote || got.reason != "rebind-no-keyframe" {
		t.Fatalf("got %v (%s), want a demotion with reason rebind-no-keyframe", got.action, got.reason)
	}
}

// Through the managed session, the way production ticks it: a 16 s keyframe
// wait leaves the session running, not demoted, and on its first pipeline.
func TestManagedSession_RebindKeyframeWaitIsNotAStall(t *testing.T) {
	spy := &pipelineSpy{}
	reg := newTestRegistry(t, spy.factory())
	if _, _, err := reg.StartOrGet(testStartReq(sessA, chanA, chanA)); err != nil {
		t.Fatal(err)
	}
	ms, _ := reg.Get(sessA)
	base := time.Now()
	bound := base.Add(-time.Second)
	p := spy.last()
	for at := base; at.Before(base.Add(16 * time.Second)); at = at.Add(watchdogTick) {
		p.setHealth(PipelineHealth{
			PartsWritten:       400,
			LastPartAt:         bound.Add(-200 * time.Millisecond),
			LastIdrAt:          bound.Add(-3 * time.Second),
			LastVideoFrameAt:   at,
			LastVideoPacketAt:  at,
			RebindWaitingSince: bound,
		})
		ms.evaluateTick(at)
	}
	if ms.demoted.Load() {
		t.Fatal("a rebind's keyframe wait demoted the session")
	}
	if spy.count() != 1 {
		t.Fatalf("a rebind's keyframe wait rebuilt the pipeline (%d built)", spy.count())
	}
}
