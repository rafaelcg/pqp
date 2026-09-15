package control

import (
	"testing"
	"time"
)

// THE 2026-09-15 15:23 UTC DEMOTION. #626 taught this watchdog that a
// quiet source is not a stalled pipeline, and half an hour later it
// demoted a party anyway -- on the tick AFTER the silence ended. The two
// control lines, two seconds apart:
//
//	15:23:05 video-source-idle: lastPart=2.448s lastFrame=3.006s parts=74 keepalive=74
//	15:23:07 demoting (part-stuck-second-stall): lastPart=4.448s lastFrame=45ms lastIdr=84ms
//
// Frames were back (45ms ago, with a fresh keyframe 84ms ago) and the
// ladder ran regardless, because `lastPart` was 4.4s old -- an age
// accumulated entirely inside the three seconds of silence this watchdog
// had just decided to forgive. A part boundary is decided by the arrival
// of the NEXT access unit, so "frames present, no part yet" is the normal
// state for one frame interval after every quiet episode, and at the 1.4
// frames/s a static Chrome tab produces that is 700ms on top of the
// silence itself.
func TestEvaluateWatchdog_PartClockRestartsWhenTheSourceComesBack(t *testing.T) {
	start := time.UnixMilli(0)
	cfg := fixedWatchdogCfg()
	var st watchdogState

	// A healthy session, then three seconds of complete silence. The
	// last part was published half a second before the last frame (the
	// keep-alive), exactly as production's own numbers show.
	quietFrom := start.Add(40 * time.Second)
	h := PipelineHealth{
		PartsWritten:      74,
		KeepAliveParts:    74,
		LastPartAt:        quietFrom.Add(-500 * time.Millisecond),
		LastIdrAt:         quietFrom,
		LastVideoFrameAt:  quietFrom,
		LastVideoPacketAt: quietFrom,
	}
	idleAt := quietFrom.Add(3006 * time.Millisecond) // production's own lastFrame=3.006s
	if got := evaluateWatchdog(h, testSegmentMs, cfg, start, &st, idleAt); got.action != actionLog || got.reason != "video-source-idle" {
		t.Fatalf("three seconds of silence produced %v (%s), want the idle log line", got.action, got.reason)
	}

	// The source comes back: a frame and a fresh keyframe, tens of
	// milliseconds ago. No new part yet -- there cannot be one until the
	// frame AFTER this one arrives.
	resumeAt := idleAt.Add(2 * time.Second)
	h.LastVideoFrameAt = resumeAt.Add(-45 * time.Millisecond)
	h.LastVideoPacketAt = resumeAt.Add(-45 * time.Millisecond)
	h.LastIdrAt = resumeAt.Add(-84 * time.Millisecond)
	// lastPart is now 4.4s old, every millisecond of it inside the
	// silence.
	if got := evaluateWatchdog(h, testSegmentMs, cfg, start, &st, resumeAt); got.action != actionNone {
		t.Fatalf("the tick after a quiet episode ended did %v (%s); a part cannot close until the next frame arrives", got.action, got.reason)
	}
	if !st.restartedAt.IsZero() {
		t.Fatal("resuming from silence consumed the session's one allowed restart")
	}

	// A frame interval later, still no part: still not a stall.
	at := resumeAt.Add(700 * time.Millisecond)
	if got := evaluateWatchdog(h, testSegmentMs, cfg, start, &st, at); got.action != actionNone {
		t.Fatalf("700ms after the source resumed the watchdog did %v (%s), want nothing", got.action, got.reason)
	}

	// But the forgiveness is a restart of the clock, not an exemption: a
	// source that is genuinely sending and genuinely publishing nothing
	// still reaches the ladder, measured from the end of the silence.
	stuck := resumeAt.Add(time.Duration(cfg.PartStuckMs)*time.Millisecond + time.Second)
	h.LastVideoFrameAt = stuck.Add(-45 * time.Millisecond)
	h.LastVideoPacketAt = stuck.Add(-45 * time.Millisecond)
	h.LastIdrAt = stuck.Add(-84 * time.Millisecond)
	got := evaluateWatchdog(h, testSegmentMs, cfg, start, &st, stuck)
	if got.action != actionRestart || got.reason != "part-stuck" {
		t.Fatalf("a genuinely stuck pipeline after a quiet episode did %v (%s), want a part-stuck restart", got.action, got.reason)
	}
}

// The FIRST rung of the ladder has the same shape as the second, and
// production took both on the same session that day. A fresh watchdog
// state (no restart taken yet) must not spend its one restart on a source
// that has merely come back from being quiet.
func TestEvaluateWatchdog_FirstRungAlsoWaitsAfterAQuietEpisode(t *testing.T) {
	start := time.UnixMilli(0)
	cfg := fixedWatchdogCfg()
	var st watchdogState

	quietFrom := start.Add(20 * time.Second)
	h := PipelineHealth{
		PartsWritten:      40,
		KeepAliveParts:    40,
		LastPartAt:        quietFrom.Add(-500 * time.Millisecond),
		LastIdrAt:         quietFrom,
		LastVideoFrameAt:  quietFrom,
		LastVideoPacketAt: quietFrom,
	}
	// Ten seconds of silence, forgiven throughout.
	for _, d := range []time.Duration{4 * time.Second, 6 * time.Second, 10 * time.Second} {
		at := quietFrom.Add(d)
		got := evaluateWatchdog(h, testSegmentMs, cfg, start, &st, at)
		if got.action == actionRestart || got.action == actionDemote {
			t.Fatalf("after %s of silence the watchdog did %v (%s)", d, got.action, got.reason)
		}
	}

	// Frames resume. lastPart is now more than ten seconds old, which is
	// also past the IDR-gap rule's own 2x and 3x segment thresholds --
	// and a quiet source has no keyframes either, so that clock restarts
	// from the end of the silence for exactly the same reason.
	resumeAt := quietFrom.Add(10 * time.Second)
	h.LastVideoFrameAt = resumeAt.Add(-30 * time.Millisecond)
	h.LastVideoPacketAt = resumeAt.Add(-30 * time.Millisecond)
	h.LastIdrAt = resumeAt.Add(-60 * time.Millisecond)
	if got := evaluateWatchdog(h, testSegmentMs, cfg, start, &st, resumeAt); got.action != actionNone {
		t.Fatalf("the first tick after a ten-second quiet episode did %v (%s), want nothing", got.action, got.reason)
	}
	if !st.restartedAt.IsZero() {
		t.Fatal("the session's one allowed restart was spent on a source that had simply gone quiet")
	}
}

// A pipeline that stalls WITHOUT any quiet episode is untouched: the
// clocks it is judged against are still its own.
func TestEvaluateWatchdog_StallWithNoQuietEpisodeStillRestarts(t *testing.T) {
	start := time.UnixMilli(0)
	cfg := fixedWatchdogCfg()
	var st watchdogState

	now := start.Add(30 * time.Second)
	h := PipelineHealth{
		PartsWritten: 200,
		// Frames and packets are arriving; nothing is coming out.
		LastPartAt:        now.Add(-5 * time.Second),
		LastIdrAt:         now.Add(-100 * time.Millisecond),
		LastVideoFrameAt:  now.Add(-50 * time.Millisecond),
		LastVideoPacketAt: now.Add(-10 * time.Millisecond),
	}
	got := evaluateWatchdog(h, testSegmentMs, cfg, start, &st, now)
	if got.action != actionRestart || got.reason != "part-stuck" {
		t.Fatalf("a real stall produced %v (%s), want a part-stuck restart", got.action, got.reason)
	}
}

// Packets coming back with NOTHING coming out of the depacketizer is not
// the end of a quiet episode -- it is the case the ladder exists for.
// Using the log rate limiter as the episode marker would have let a
// wedged depacketizer end the episode and buy itself another
// PART_STUCK_MS of forgiveness on every tick (Farol review, PR #629).
func TestEvaluateWatchdog_PacketsWithoutFramesDoNotEndAQuietEpisode(t *testing.T) {
	start := time.UnixMilli(0)
	cfg := fixedWatchdogCfg()
	var st watchdogState

	quietFrom := start.Add(30 * time.Second)
	h := PipelineHealth{
		PartsWritten:      100,
		LastPartAt:        quietFrom.Add(-500 * time.Millisecond),
		LastIdrAt:         quietFrom,
		LastVideoFrameAt:  quietFrom,
		LastVideoPacketAt: quietFrom,
	}
	idleAt := quietFrom.Add(3500 * time.Millisecond)
	if got := evaluateWatchdog(h, testSegmentMs, cfg, start, &st, idleAt); got.action != actionLog {
		t.Fatalf("silence produced %v (%s), want the idle log line", got.action, got.reason)
	}

	// RTP is flowing again. No access unit has come out of it, and the
	// last frame is still the one from before the silence.
	at := idleAt.Add(time.Second)
	h.LastVideoPacketAt = at.Add(-20 * time.Millisecond)
	got := evaluateWatchdog(h, testSegmentMs, cfg, start, &st, at)
	if got.action != actionRestart || got.reason != "part-stuck" {
		t.Fatalf("packets with no frames did %v (%s), want the ladder to run on its own clocks", got.action, got.reason)
	}
	if !st.idleEndedAt.IsZero() {
		t.Fatal("packets alone ended the quiet episode and restarted the part clock")
	}
}
