package control

import (
	"math"
	"strings"
	"testing"
	"time"
)

// THE 2026-09-15 REGRESSION TEST. A Chrome TAB share of static content
// sends no video frames at all while the page is not repainting, so no
// access unit completes, so no part closes -- and the watchdog restarted
// the session and then demoted the party off the low-latency rung for it.
// A quiet source is not a stalled pipeline and must produce neither.
func TestEvaluateWatchdog_QuietSourceIsNotAStall(t *testing.T) {
	start := time.UnixMilli(0)
	cfg := fixedWatchdogCfg()
	now := start.Add(40 * time.Second)
	quiet := now.Add(-12 * time.Second) // four times PART_STUCK_MS
	h := PipelineHealth{
		PartsWritten:      400,
		LastPartAt:        quiet,
		LastIdrAt:         quiet,
		LastVideoFrameAt:  quiet,
		LastVideoPacketAt: quiet,
	}
	var st watchdogState

	// First tick past the threshold: one log line, naming the case.
	got := evaluateWatchdog(h, testSegmentMs, cfg, start, &st, now)
	if got.action != actionLog {
		t.Fatalf("a quiet source produced %v (%s), want a single log line", got.action, got.reason)
	}
	if got.reason != "video-source-idle" {
		t.Fatalf("reason = %q, want video-source-idle", got.reason)
	}
	if !strings.Contains(got.detail, "lastFrame=12s") || !strings.Contains(got.detail, "lastPkt=12s") {
		t.Fatalf("the idle line does not say what stopped: %q", got.detail)
	}

	// Every tick after that, for as long as the source stays quiet and
	// inside VideoIdleMaxMs, is a no-op: reconnecting to the same room to
	// receive the same silence is not a fix, and demoting hands the
	// audience the same frozen picture off the same source.
	for _, elapsed := range []time.Duration{15 * time.Second, time.Minute, 110 * time.Second} {
		at := quiet.Add(elapsed)
		h.LastPartAt, h.LastIdrAt = quiet, quiet
		got := evaluateWatchdog(h, testSegmentMs, cfg, start, &st, at)
		if got.action != actionNone {
			t.Fatalf("after %s of silence the watchdog did %v (%s), want nothing", elapsed, got.action, got.reason)
		}
	}
	if !st.restartedAt.IsZero() {
		t.Fatal("a quiet source consumed the session's one allowed restart inside the idle bound")
	}
}

// ...but the forgiveness is BOUNDED. "No RTP at all" has two causes that
// look identical from this end: a publisher genuinely sending nothing, and
// our own receive path having died quietly (an ICE/DTLS failure that never
// surfaces as a track-ended event). Only the second is fixed by a restart,
// and forgiving silence forever would turn it into a frozen rendition for
// the rest of the party (Farol review, PR #626).
func TestEvaluateWatchdog_QuietPastTheIdleBoundRunsTheLadder(t *testing.T) {
	start := time.UnixMilli(0)
	cfg := fixedWatchdogCfg()
	var st watchdogState

	quiet := start.Add(30 * time.Second)
	h := PipelineHealth{
		PartsWritten:      400,
		LastPartAt:        quiet,
		LastIdrAt:         quiet,
		LastVideoFrameAt:  quiet,
		LastVideoPacketAt: quiet,
	}

	// Inside the bound: forgiven (one log line, then nothing).
	if got := evaluateWatchdog(h, testSegmentMs, cfg, start, &st, quiet.Add(30*time.Second)); got.action != actionLog {
		t.Fatalf("inside the idle bound the watchdog did %v (%s), want a log line", got.action, got.reason)
	}

	// Past it: one restart, which is the cheap action that rebuilds the
	// subscriber connection and so fixes the dead-receive case.
	past := quiet.Add(time.Duration(cfg.VideoIdleMaxMs)*time.Millisecond + time.Second)
	got := evaluateWatchdog(h, testSegmentMs, cfg, start, &st, past)
	if got.action != actionRestart || got.reason != "source-idle-too-long" {
		t.Fatalf("past the idle bound the watchdog did %v (%s), want a source-idle-too-long restart", got.action, got.reason)
	}
	if !strings.Contains(got.detail, "lastFrame=") || !strings.Contains(got.detail, "lastPkt=") {
		t.Fatalf("the restart carries no detail: %q", got.detail)
	}

	// Still silent, inside the demote window: demote, with its own reason
	// so the log never claims a part stalled when nothing was arriving.
	got = evaluateWatchdog(h, testSegmentMs, cfg, start, &st, past.Add(30*time.Second))
	if got.action != actionDemote || got.reason != "source-idle-too-long-second-stall" {
		t.Fatalf("a second idle episode inside the window did %v (%s), want a demote", got.action, got.reason)
	}
}

// VIDEO_IDLE_MAX_MS=0 is a supported operator choice: forgive a silent
// source forever.
func TestEvaluateWatchdog_IdleBoundOfZeroForgivesForever(t *testing.T) {
	start := time.UnixMilli(0)
	cfg := fixedWatchdogCfg()
	cfg.VideoIdleMaxMs = 0
	var st watchdogState

	quiet := start.Add(30 * time.Second)
	h := PipelineHealth{
		PartsWritten:      400,
		LastPartAt:        quiet,
		LastIdrAt:         quiet,
		LastVideoFrameAt:  quiet,
		LastVideoPacketAt: quiet,
	}
	if got := evaluateWatchdog(h, testSegmentMs, cfg, start, &st, quiet.Add(4*time.Second)); got.action != actionLog {
		t.Fatalf("first quiet tick did %v, want a log line", got.action)
	}
	for _, elapsed := range []time.Duration{time.Minute, time.Hour, 24 * time.Hour} {
		if got := evaluateWatchdog(h, testSegmentMs, cfg, start, &st, quiet.Add(elapsed)); got.action != actionNone {
			t.Fatalf("with the bound disabled, %s of silence did %v (%s)", elapsed, got.action, got.reason)
		}
	}
}

// The source comes back: the idle log arms again for the NEXT quiet
// episode rather than staying silent for the rest of the session.
func TestEvaluateWatchdog_IdleLogRearmsAfterTheSourceResumes(t *testing.T) {
	start := time.UnixMilli(0)
	cfg := fixedWatchdogCfg()
	var st watchdogState

	quietAt := start.Add(20 * time.Second)
	h := PipelineHealth{
		PartsWritten:      100,
		LastPartAt:        quietAt,
		LastIdrAt:         quietAt,
		LastVideoFrameAt:  quietAt,
		LastVideoPacketAt: quietAt,
	}
	if got := evaluateWatchdog(h, testSegmentMs, cfg, start, &st, quietAt.Add(5*time.Second)); got.action != actionLog {
		t.Fatalf("first quiet episode did not log: %v", got.action)
	}

	// Frames resume; everything is healthy again.
	back := quietAt.Add(6 * time.Second)
	healthy := PipelineHealth{
		PartsWritten:      120,
		LastPartAt:        back,
		LastIdrAt:         back,
		LastVideoFrameAt:  back,
		LastVideoPacketAt: back,
	}
	if got := evaluateWatchdog(healthy, testSegmentMs, cfg, start, &st, back.Add(100*time.Millisecond)); got.action != actionNone {
		t.Fatalf("a healthy pipeline produced %v (%s)", got.action, got.reason)
	}

	// A second quiet episode logs again.
	h2 := healthy
	if got := evaluateWatchdog(h2, testSegmentMs, cfg, start, &st, back.Add(9*time.Second)); got.action != actionLog {
		t.Fatalf("the second quiet episode did not log: %v (%s)", got.action, got.reason)
	}
}

// The other side of the same coin, and the reason the idle rule reads BOTH
// clocks: RTP is still arriving and nothing is coming out of the
// depacketizer. That is a real fault and the restart ladder must still run.
func TestEvaluateWatchdog_PacketsWithoutFramesStillRestarts(t *testing.T) {
	start := time.UnixMilli(0)
	cfg := fixedWatchdogCfg()
	now := start.Add(40 * time.Second)
	h := PipelineHealth{
		PartsWritten:         400,
		LastPartAt:           now.Add(-5 * time.Second),
		LastIdrAt:            now.Add(-5 * time.Second),
		LastVideoFrameAt:     now.Add(-5 * time.Second),
		LastVideoPacketAt:    now.Add(-20 * time.Millisecond), // the publisher is still sending
		VideoPacketsSeen:     98000,
		VideoFramesSeen:      1200,
		VideoDepacketizeErrs: 4100,
	}
	var st watchdogState

	got := evaluateWatchdog(h, testSegmentMs, cfg, start, &st, now)
	if got.action != actionRestart || got.reason != "part-stuck" {
		t.Fatalf("packets arriving with no frames produced %v (%s), want a part-stuck restart", got.action, got.reason)
	}
	for _, want := range []string{"lastPkt=20ms", "lastFrame=5s", "pkts=98000", "frames=1200", "drops=4100"} {
		if !strings.Contains(got.detail, want) {
			t.Fatalf("the restart line is missing %q: %q", want, got.detail)
		}
	}
}

// Frames are arriving and no part is being published: a real muxer stall,
// the case the ladder was written for, still restarts then demotes.
func TestEvaluateWatchdog_FramesWithoutPartsStillRestartsThenDemotes(t *testing.T) {
	start := time.UnixMilli(0)
	cfg := fixedWatchdogCfg()
	now := start.Add(40 * time.Second)
	live := now.Add(-20 * time.Millisecond)
	h := PipelineHealth{
		PartsWritten:      400,
		LastPartAt:        now.Add(-5 * time.Second),
		LastIdrAt:         live,
		LastVideoFrameAt:  live,
		LastVideoPacketAt: live,
	}
	var st watchdogState

	got := evaluateWatchdog(h, testSegmentMs, cfg, start, &st, now)
	if got.action != actionRestart || got.reason != "part-stuck" {
		t.Fatalf("frames with no parts produced %v (%s), want a part-stuck restart", got.action, got.reason)
	}

	later := now.Add(30 * time.Second)
	h.LastIdrAt, h.LastVideoFrameAt, h.LastVideoPacketAt = later, later, later
	got = evaluateWatchdog(h, testSegmentMs, cfg, start, &st, later)
	if got.action != actionDemote || got.reason != "part-stuck-second-stall" {
		t.Fatalf("the second stall inside the window produced %v (%s), want a demote", got.action, got.reason)
	}
	if got.detail == "" {
		t.Fatal("the demote carries no detail")
	}
}

// A Pipeline that reports no RTP clocks at all (every fake in this
// package's own tests, and the shape PipelineHealth had before
// 2026-09-15) must be judged exactly as it was: the idle rule is opt-in
// through data, not a behaviour change for anything that does not supply
// it.
func TestEvaluateWatchdog_NoRtpClocksBehavesAsBefore(t *testing.T) {
	start := time.UnixMilli(0)
	cfg := fixedWatchdogCfg()
	now := start.Add(40 * time.Second)
	h := PipelineHealth{
		PartsWritten: 400,
		LastPartAt:   now.Add(-5 * time.Second),
		LastIdrAt:    now.Add(-20 * time.Millisecond),
	}
	var st watchdogState
	got := evaluateWatchdog(h, testSegmentMs, cfg, start, &st, now)
	if got.action != actionRestart || got.reason != "part-stuck" {
		t.Fatalf("a pipeline with no RTP clocks produced %v (%s), want the pre-existing part-stuck restart", got.action, got.reason)
	}
}

// stallDetail is what an operator actually reads at 3am; it must carry
// every clock and counter, and say "never" rather than a misleading age
// for something that has not happened at all.
func TestStallDetail_SaysNeverRatherThanLying(t *testing.T) {
	now := time.UnixMilli(1_000_000)
	d := stallDetail(PipelineHealth{PartsWritten: 3}, now)
	for _, want := range []string{"lastPart=never", "lastFrame=never", "lastPkt=never", "lastIdr=never"} {
		if !strings.Contains(d, want) {
			t.Fatalf("stallDetail is missing %q: %q", want, d)
		}
	}

	full := stallDetail(PipelineHealth{
		LastPartAt:        now.Add(-3 * time.Second),
		LastVideoFrameAt:  now.Add(-3100 * time.Millisecond),
		LastVideoPacketAt: now.Add(-3100 * time.Millisecond),
		LastIdrAt:         now.Add(-4 * time.Second),
		PartsWritten:      412,
		KeepAliveParts:    2,
		AudioPartsWritten: 610,
		VideoPacketsSeen:  54321,
		VideoFramesSeen:   1203,
		PLIsSent:          8,
		PLIsSinceIdr:      2,
		R2Uploaded:        120,
		R2MaxLatencyMs:    940,
		OpenSegmentOK:     true,
		OpenSegmentMs:     3200,
		AudioEnabled:      true,
	}, now)
	for _, want := range []string{
		"lastPart=3s", "lastFrame=3.1s", "lastPkt=3.1s", "lastIdr=4s",
		"parts=412", "keepalive=2", "audioParts=610",
		"pkts=54321", "frames=1203", "pli=8", "unanswered=2",
		"r2 ok=120", "maxMs=940", "openSeg=3200ms", "audioDead=false",
	} {
		if !strings.Contains(full, want) {
			t.Fatalf("stallDetail is missing %q: %q", want, full)
		}
	}
}

// A VIDEO_IDLE_MAX_MS so large it overflows time.Duration must not invert
// the rule it configures. `time.Duration(ms) * time.Millisecond` wraps
// past about 9.2e12 ms, so an absurd value used to produce a tiny or
// negative bound and restart a quiet source on the FIRST quiet tick --
// the exact inverse of "forgive it for a very long time" (Farol review,
// PR #626). msDuration saturates instead.
func TestEvaluateWatchdog_HugeIdleBoundDoesNotWrapIntoAnInstantRestart(t *testing.T) {
	start := time.UnixMilli(0)
	cfg := fixedWatchdogCfg()
	cfg.VideoIdleMaxMs = math.MaxInt64 // the worst an int64 env value can be
	var st watchdogState

	quiet := start.Add(30 * time.Second)
	h := PipelineHealth{
		PartsWritten:      400,
		LastPartAt:        quiet,
		LastIdrAt:         quiet,
		LastVideoFrameAt:  quiet,
		LastVideoPacketAt: quiet,
	}

	if got := evaluateWatchdog(h, testSegmentMs, cfg, start, &st, quiet.Add(4*time.Second)); got.action != actionLog {
		t.Fatalf("first quiet tick under a huge bound did %v (%s), want a log line", got.action, got.reason)
	}
	for _, elapsed := range []time.Duration{time.Minute, time.Hour, 72 * time.Hour} {
		if got := evaluateWatchdog(h, testSegmentMs, cfg, start, &st, quiet.Add(elapsed)); got.action != actionNone {
			t.Fatalf("under a huge bound, %s of silence did %v (%s), want nothing", elapsed, got.action, got.reason)
		}
	}
	if !st.restartedAt.IsZero() {
		t.Fatal("an overflowing idle bound consumed the session's one allowed restart")
	}
}

// msDuration saturates at both ends rather than wrapping.
func TestMsDuration_Saturates(t *testing.T) {
	if got := msDuration(2000); got != 2*time.Second {
		t.Fatalf("msDuration(2000) = %v, want 2s", got)
	}
	if got := msDuration(math.MaxInt64); got != time.Duration(math.MaxInt64) {
		t.Fatalf("msDuration(MaxInt64) = %v, want the maximum Duration", got)
	}
	if got := msDuration(math.MinInt64); got != time.Duration(math.MinInt64) {
		t.Fatalf("msDuration(MinInt64) = %v, want the minimum Duration", got)
	}
	// The boundary itself: one millisecond under the clamp still converts
	// exactly, and is positive.
	if got := msDuration(maxDurationMs - 1); got <= 0 {
		t.Fatalf("msDuration(maxDurationMs-1) = %v, want a large positive duration", got)
	}
}
