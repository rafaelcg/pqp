package session

import (
	"strings"
	"testing"
	"time"

	"github.com/rafaelcg/pqp/tools/pqp-remux/internal/h264"
	"github.com/rafaelcg/pqp/tools/pqp-remux/internal/ring"
)

// THE 2026-09-15 DRIFT, END TO END. Production, 15:10-15:15 UTC: a Chrome
// tab share of a nearly static page at ~1.4 frames/s published 29.0s of
// video media in 53.8s of wall clock (a ratio of 0.54) while its audio
// track, paced off the wall clock, ran at 0.98. Every video part was a
// keep-alive stamped ~0.589s long against a real gap of about a second, and
// the difference was deleted rather than published. The player's blocking
// playlist reloads timed out and it never recovered.
//
// This drives the real Session -- the real depacketizer, the real
// fragmenter, the real idleTick -- off one synthetic clock, and asks the
// one question the stats line now answers: how much media came out per
// second of wall clock.

// chromeTabSource plays a fake screen share into s for wallSpan, at fps,
// with a keyframe every idrEvery. The RTP timestamps are the wall clock,
// which is what a live capture's are. The monitor's keep-alive tick runs
// throughout, exactly as RunMonitor runs it in production.
func chromeTabSource(t *testing.T, s *Session, base time.Time, clock *time.Time, fps float64, wallSpan, idrEvery time.Duration, silence time.Duration) {
	t.Helper()
	frameGap := time.Duration(float64(time.Second) / fps)

	var (
		nextFrameAt = silence
		lastIDRAt   = time.Duration(-1)
	)
	for elapsed := time.Duration(0); elapsed <= wallSpan; elapsed += monitorTick {
		for nextFrameAt <= elapsed {
			idr := lastIDRAt < 0 || nextFrameAt-lastIDRAt >= idrEvery
			*clock = base.Add(nextFrameAt)
			ts := uint32(nextFrameAt * h264.ClockRate / time.Second)
			s.HandleVideoPacket(videoPacket(singleNAL(nalTypeFor(idr), []byte{0xAA, 0xBB}), ts, true))
			if idr {
				lastIDRAt = nextFrameAt
			}
			nextFrameAt += frameGap
		}
		*clock = base.Add(elapsed)
		s.idleTick(*clock)
	}
}

// A static Chrome tab, for a minute. Media time must equal wall time.
func TestSession_TimelineKeepsTimeOnAQuietSource(t *testing.T) {
	r := ring.New(6, h264.ClockRate)
	s := New(45000, 360000, r, nil) // 500ms parts, 4s segments
	base := time.Now()
	clock := base
	s.now = func() time.Time { return clock }

	// SPS/PPS and the session's first IDR at t=0.
	s.HandleVideoPacket(videoPacket(singleNAL(7, realishSPS()[1:]), 0, false))
	s.HandleVideoPacket(videoPacket(singleNAL(8, realishPPS()[1:]), 0, false))
	s.HandleVideoPacket(videoPacket(singleNAL(5, []byte{0xAA, 0xBB}), 0, true))

	chromeTabSource(t, s, base, &clock, 1.4, 60*time.Second, 4*time.Second, 700*time.Millisecond)

	st := s.Stats()
	if st.VideoMediaAnchor.IsZero() {
		t.Fatal("no part was ever published in a minute of a 1.4 frames/s source")
	}
	wall := st.Now.Sub(st.VideoMediaAnchor).Seconds()
	media := float64(st.VideoMediaMs) / 1000
	ratio := media / wall
	if ratio < 0.98 || ratio > 1.02 {
		t.Fatalf("published %.2fs of media in %.2fs of wall clock (timelineRatio %.3f, parts=%d keepalive=%d); production read 0.54 here",
			media, wall, ratio, st.PartsWritten, st.KeepAlivePartsWrites)
	}
	// And the parts are real ones, closed by arriving frames: at 1.4
	// frames/s the gaps are shorter than the idle allowance, so nothing
	// should have reached the keep-alive at all.
	if st.KeepAlivePartsWrites != 0 {
		t.Fatalf("a 1.4 frames/s source produced %d keep-alive parts of %d total", st.KeepAlivePartsWrites, st.PartsWritten)
	}
}

// The coordinator's case, whole: three seconds of complete silence, then
// frames come back at 1.4/s. The timeline must keep time across the gap,
// and the session must never look stalled to the control plane -- see
// internal/control's TestEvaluateWatchdog_PartClockRestartsWhenTheSourceComesBack
// for the watchdog half of the same episode.
func TestSession_SilenceThenASlowSourceKeepsTime(t *testing.T) {
	r := ring.New(6, h264.ClockRate)
	s := New(45000, 360000, r, nil)
	base := time.Now()
	clock := base
	s.now = func() time.Time { return clock }

	s.HandleVideoPacket(videoPacket(singleNAL(7, realishSPS()[1:]), 0, false))
	s.HandleVideoPacket(videoPacket(singleNAL(8, realishPPS()[1:]), 0, false))
	s.HandleVideoPacket(videoPacket(singleNAL(5, []byte{0xAA, 0xBB}), 0, true))

	// Three seconds of nothing at all: the keep-alive publishes the held
	// frame once, and then there is nothing left to publish.
	for elapsed := monitorTick; elapsed <= 3*time.Second; elapsed += monitorTick {
		clock = base.Add(elapsed)
		s.idleTick(clock)
	}
	if got := s.Stats().KeepAlivePartsWrites; got != 1 {
		t.Fatalf("three seconds of silence produced %d keep-alive parts, want exactly one", got)
	}
	if !s.Stats().VideoIdle {
		t.Fatal("the session does not know its source went quiet")
	}

	// Then a minute of the static tab.
	chromeTabSource(t, s, base, &clock, 1.4, 63*time.Second, 4*time.Second, 3*time.Second)

	st := s.Stats()
	if st.VideoIdle {
		t.Fatal("the session still reports its source idle after a minute of frames")
	}
	wall := st.Now.Sub(st.VideoMediaAnchor).Seconds()
	media := float64(st.VideoMediaMs) / 1000
	if ratio := media / wall; ratio < 0.98 || ratio > 1.02 {
		t.Fatalf("published %.2fs of media in %.2fs of wall clock (timelineRatio %.3f) across a silence and a slow source",
			media, wall, ratio)
	}
	// The silence itself is in the timeline, not deleted from it: the
	// keep-alive covered its first second and the frame that ended it
	// carries the rest.
	if media < 60 {
		t.Fatalf("only %.2fs of media covers a %.2fs run: the quiet spell was dropped rather than published", media, wall)
	}
}

// The ratio is on the stats line whether or not anyone is looking for it:
// a timeline running slow is invisible in counts and obvious in one
// number.
func TestFormatStatsLine_CarriesTheTimelineRatio(t *testing.T) {
	now := time.Now()
	prev := Stats{Now: now.Add(-5 * time.Second)}
	cur := Stats{
		Now:              now,
		VideoMediaMs:     10000,
		VideoMediaAnchor: now.Add(-10 * time.Second),
		AudioEnabled:     true,
		AudioMediaMs:     5400,
		AudioMediaAnchor: now.Add(-10 * time.Second),
	}
	line := formatStatsLine("sess", prev, cur, 5*time.Second)
	if !strings.Contains(line, "timelineRatio=1.00") {
		t.Fatalf("the video half carries no healthy timelineRatio: %q", line)
	}
	if !strings.Contains(line, "timelineRatio=0.54") {
		t.Fatalf("the audio half carries no timelineRatio: %q", line)
	}

	// Before the first part there is no timeline to report on.
	if line := formatStatsLine("sess", Stats{}, Stats{Now: now}, time.Second); !strings.Contains(line, "timelineRatio=n/a") {
		t.Fatalf("a session with no parts yet reports a ratio anyway: %q", line)
	}
}
