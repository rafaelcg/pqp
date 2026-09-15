package session

import (
	"strings"
	"testing"
	"time"

	"github.com/rafaelcg/pqp/tools/pqp-remux/internal/keyframe"
	"github.com/rafaelcg/pqp/tools/pqp-remux/internal/ring"
)

// A Chrome TAB share of a page that is not repainting, reproduced: one
// frame every five seconds, a tenth of the part target's own cadence.
// Before the keep-alive this published NOTHING between frames -- every
// part boundary in internal/pipeline is decided by the arrival of the NEXT
// access unit -- so LastPartAt stood still for five seconds at a time and
// the control plane's 3s PART_STUCK_MS watchdog restarted, then demoted,
// a perfectly healthy session.
func TestSession_StaticSourceKeepsPublishingParts(t *testing.T) {
	r := ring.New(6, 90000)
	s := New(45000, 360000, r, nil) // 500ms parts, 4s segments
	now := time.Now()
	s.now = func() time.Time { return now }

	s.HandleVideoPacket(videoPacket(singleNAL(7, realishSPS()[1:]), 0, false))
	s.HandleVideoPacket(videoPacket(singleNAL(8, realishPPS()[1:]), 0, false))
	s.HandleVideoPacket(videoPacket(singleNAL(5, []byte{0xAA, 0xBB}), 0, true))

	if s.Health().PartsWritten != 0 {
		t.Fatal("the session's first access unit should not have closed a part yet")
	}

	// Five seconds of nothing. The monitor ticks throughout; only the
	// first tick past the part target publishes.
	published := 0
	for elapsed := monitorTick; elapsed <= 5*time.Second; elapsed += monitorTick {
		if s.idleTick(now.Add(elapsed)) {
			published++
		}
	}
	if published != 1 {
		t.Fatalf("expected exactly one keep-alive part across a five-second freeze, got %d", published)
	}

	h := s.Health()
	if h.PartsWritten != 1 {
		t.Fatalf("PartsWritten = %d after the keep-alive, want 1", h.PartsWritten)
	}
	st := s.Stats()
	if st.KeepAlivePartsWrites != 1 {
		t.Fatalf("KeepAlivePartsWrites = %d, want 1", st.KeepAlivePartsWrites)
	}
	if !st.VideoIdle {
		t.Fatal("the session should know its source has gone quiet")
	}

	// The part covers the freeze: a player's buffer now ends five
	// seconds later than the frozen frame's own instant, which is the
	// whole point.
	if _, ok := r.Part(1); !ok {
		t.Fatal("the keep-alive part is not in the ring")
	}

	// The source comes back. The next frames resume ordinary part
	// cutting, and the session reports itself no longer idle.
	resumeTS := uint32(5 * 90000)
	resumeAt := now.Add(5 * time.Second)
	for i := 0; i < 40; i++ {
		now = resumeAt.Add(time.Duration(i) * 33 * time.Millisecond)
		s.HandleVideoPacket(videoPacket(singleNAL(1, []byte{0xAA, 0xBB}), resumeTS+uint32(i*frameStep), true))
	}
	if s.Stats().VideoIdle {
		t.Fatal("the session still reports its source idle after frames resumed")
	}
	if got := s.Health().PartsWritten; got < 2 {
		t.Fatalf("PartsWritten = %d after the source resumed, want the keep-alive plus ordinary parts", got)
	}
	if s.Stats().KeepAlivePartsWrites != 1 {
		t.Fatal("ordinary parts were miscounted as keep-alives")
	}
}

// The ordinary case must be untouched: a source sending at a normal frame
// rate never reaches the keep-alive at all, so no part is ever published
// by anything but an arriving access unit.
func TestSession_HealthySourceNeverPublishesAKeepAlive(t *testing.T) {
	r := ring.New(6, 90000)
	s := New(45000, 360000, r, nil)
	base := time.Now()
	clock := base
	s.now = func() time.Time { return clock }

	s.HandleVideoPacket(videoPacket(singleNAL(7, realishSPS()[1:]), 0, false))
	s.HandleVideoPacket(videoPacket(singleNAL(8, realishPPS()[1:]), 0, false))

	for i := 0; i < 60; i++ { // 2s of 30fps, one clock for frames and ticks
		clock = base.Add(time.Duration(i) * 33 * time.Millisecond)
		s.HandleVideoPacket(videoPacket(singleNAL(nalTypeFor(i == 0), []byte{0xAA, 0xBB}), uint32(i*frameStep), true))
		// The monitor is ticking the whole time, as it does in
		// production: several ticks per frame interval.
		for k := 0; k < 5; k++ {
			if s.idleTick(clock.Add(time.Duration(k) * 6 * time.Millisecond)) {
				t.Fatalf("keep-alive fired on a healthy 30fps source at frame %d", i)
			}
		}
	}
	if s.Stats().KeepAlivePartsWrites != 0 {
		t.Fatal("a healthy source produced keep-alive parts")
	}
	if s.Stats().VideoIdle {
		t.Fatal("a healthy source was reported idle")
	}
	if s.Health().PartsWritten == 0 {
		t.Fatal("a healthy source published no parts at all")
	}
}

func nalTypeFor(idr bool) byte {
	if idr {
		return 5
	}
	return 1
}

// Nothing may be published before the session's first IDR, keep-alive
// included: there is no init segment and no segment to start.
func TestSession_KeepAliveIsInertBeforeTheFirstIDR(t *testing.T) {
	r := ring.New(6, 90000)
	s := New(45000, 360000, r, nil)

	now := time.Now()
	s.now = func() time.Time { return now }
	s.HandleVideoPacket(videoPacket(singleNAL(1, []byte{0xAA, 0xBB}), 0, true)) // a P-frame, no IDR yet
	for elapsed := monitorTick; elapsed <= 3*time.Second; elapsed += monitorTick {
		if s.idleTick(now.Add(elapsed)) {
			t.Fatal("the keep-alive published a part before the session's first IDR")
		}
	}
	if s.Health().PartsWritten != 0 {
		t.Fatalf("PartsWritten = %d before the first IDR", s.Health().PartsWritten)
	}
}

// Stats carries the counters that separate the four explanations the
// 2026-09-15 log could not: packets, frames, keyframes, drops, and the
// three "when did this last happen" clocks.
func TestSession_StatsSeparatesPacketsFromFrames(t *testing.T) {
	r := ring.New(6, 90000)
	s := New(45000, 360000, r, nil)

	s.HandleVideoPacket(videoPacket(singleNAL(7, realishSPS()[1:]), 0, false))
	s.HandleVideoPacket(videoPacket(singleNAL(8, realishPPS()[1:]), 0, false))
	s.HandleVideoPacket(videoPacket(singleNAL(5, []byte{0xAA, 0xBB}), 0, true))
	// A packet whose timestamp jumps with no marker having closed the
	// previous access unit: the lost-marker recovery path, which is the
	// shape packet loss takes here.
	s.HandleVideoPacket(videoPacket(singleNAL(1, []byte{0xCC}), frameStep, false))
	s.HandleVideoPacket(videoPacket(singleNAL(1, []byte{0xDD}), 2*frameStep, true))

	st := s.Stats()
	if st.VideoPacketsSeen != 5 {
		t.Fatalf("VideoPacketsSeen = %d, want 5", st.VideoPacketsSeen)
	}
	if st.VideoFramesSeen != 2 {
		t.Fatalf("VideoFramesSeen = %d, want 2 (the IDR and the recovered frame)", st.VideoFramesSeen)
	}
	if st.VideoKeyframesSeen != 1 {
		t.Fatalf("VideoKeyframesSeen = %d, want 1", st.VideoKeyframesSeen)
	}
	if st.VideoDepacketizeErrs == 0 {
		t.Fatal("the lost-marker recovery was not counted as a depacketizer drop")
	}
	if st.LastVideoPacket.IsZero() || st.LastVideoFrame.IsZero() || st.LastIdr.IsZero() {
		t.Fatalf("a clock is unset: pkt=%v frame=%v idr=%v", st.LastVideoPacket, st.LastVideoFrame, st.LastIdr)
	}
}

// The periodic line is the deliverable, so assert on the line itself:
// every field a reader needs to tell hypotheses (a) through (d) apart has
// to be on it, with rates, not just totals.
func TestFormatStatsLine_CarriesEveryDiagnosticField(t *testing.T) {
	now := time.Now()
	prev := Stats{}
	cur := Stats{
		Subscribed:           true,
		VideoPacketsSeen:     1200,
		VideoFramesSeen:      150,
		VideoKeyframesSeen:   2,
		VideoDepacketizeErrs: 7,
		PartsWritten:         10,
		VideoSegmentsWritten: 1,
		KeepAlivePartsWrites: 3,
		VideoIdle:            true,
		AudioEnabled:         true,
		AudioPacketsSeen:     250,
		AudioFramesSeen:      234,
		AudioPartsWritten:    10,
		Keyframe:             keyframe.Stats{PLIsSent: 4, PLIsSinceIDR: 2, LastPLIAt: now.Add(-500 * time.Millisecond)},
		R2Enabled:            true,
		R2Uploaded:           11,
		R2LastLatencyMs:      87,
		R2MaxLatencyMs:       940,
		Now:                  now,
		LastVideoPacket:      now.Add(-12 * time.Second),
		LastVideoFrame:       now.Add(-12 * time.Second),
		LastPart:             now.Add(-11500 * time.Millisecond),
		OpenSegmentMs:        3200,
		OpenSegmentValid:     true,
	}
	line := formatStatsLine("session=abc", prev, cur, 5*time.Second)

	for _, want := range []string{
		"session=abc", "window=5s", "subscribed=true",
		"pkts=+1200", "frames=+150", "idr=+2", "drops=+7",
		"parts=+10", "segs=+1", "keepalive=+3", "idle=true",
		"lastPkt=12s", "lastFrame=12s", "lastIdr=never", "lastPart=11.5s",
		"openSeg=3200ms",
		"audio pkts=+250", "frames=+234", "parts=+10",
		"pli sent=+4", "total=4", "unanswered=2", "lastPli=500ms",
		"r2 ok=+11", "lastMs=87", "maxMs=940",
	} {
		if !strings.Contains(line, want) {
			t.Fatalf("stats line is missing %q:\n%s", want, line)
		}
	}
	// Rates, not just totals: 150 frames in a 5s window is 30/s.
	if !strings.Contains(line, "(30.0/s)") {
		t.Fatalf("stats line carries no frame rate:\n%s", line)
	}
}
