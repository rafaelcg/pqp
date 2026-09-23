package session

import (
	"bytes"
	"encoding/binary"
	"sort"
	"testing"
	"time"

	"github.com/rafaelcg/pqp/tools/pqp-remux/internal/ring"
)

// partInfo is one published part as a player sees it: where it sits on the
// timeline (from its own tfdt) and which segment lists it.
type partInfo struct {
	StartTicks, EndTicks int64
	SegmentIndex         int
}

func partInfos(t *testing.T, s *Session) map[uint32]partInfo {
	t.Helper()
	out := map[uint32]partInfo{}
	for _, seg := range s.ring.Snapshot().Segments {
		for _, p := range seg.Parts {
			b, ok := s.ring.Part(p.Seq)
			if !ok {
				t.Fatalf("part %d listed but not served", p.Seq)
			}
			start := int64(tfdtOf(t, b))
			out[p.Seq] = partInfo{StartTicks: start, EndTicks: start + int64(p.DurationTicks), SegmentIndex: seg.Index}
		}
	}
	return out
}

// tfdtOf reads a fragment's base media decode time straight out of its
// tfdt box (version 1, 64-bit, which is what internal/cmaf writes).
func tfdtOf(t *testing.T, frag []byte) uint64 {
	t.Helper()
	i := bytes.Index(frag, []byte("tfdt"))
	if i < 0 || len(frag) < i+4+4+8 {
		t.Fatal("fragment has no tfdt box")
	}
	if frag[i+4] == 1 {
		return binary.BigEndian.Uint64(frag[i+8 : i+16])
	}
	return uint64(binary.BigEndian.Uint32(frag[i+8 : i+12]))
}

// sessionRepeater stands in for internal/skipframe at the session level:
// the fragmenter treats a repeat frame as opaque bytes, and skipframe's own
// tests (against ffmpeg) prove the real ones decode. It is installed
// straight onto the fragmenter because the synthetic slices these tests
// send are not ones skipframe would accept, and what is under test here is
// WHEN parts are cut, not what the fill frame contains.
type sessionRepeater struct{ n int }

func (r *sessionRepeater) Observe(avcc []byte, isIDR bool) []byte { return avcc }
func (r *sessionRepeater) Repeat() []byte {
	r.n++
	return []byte{0, 0, 0, 3, 0x41, 0x9A, byte(r.n)}
}

// deadlineSession starts a session on a synthetic clock, sends parameter
// sets and a first IDR at t=0, and arms clock cutting.
func deadlineSession(t *testing.T, grace time.Duration) (*Session, *time.Time, time.Time) {
	t.Helper()
	r := ring.New(60, 90000)
	s := New(45000, 360000, r, nil) // 500ms parts, 4s segments
	s.SetReorderHold(0)
	s.SetPartDeadlineGrace(grace)
	base := time.Unix(1_800_000_000, 0)
	clock := base
	s.now = func() time.Time { return clock }
	s.HandleVideoPacket(videoPacket(singleNAL(7, realishSPS()[1:]), 0, false))
	s.HandleVideoPacket(videoPacket(singleNAL(8, realishPPS()[1:]), 0, false))
	s.HandleVideoPacket(videoPacket(singleNAL(5, []byte{0xAA, 0xBB}), 0, true))
	s.frag.SetRepeater(&sessionRepeater{})
	return s, &clock, base
}

// idleThenBursty is the shape the 2026-09-21 party's presenter produced: a
// normal frame rate, a nearly static tab at about 1.4 frames a second, a
// real freeze, a burst when the picture changes, then an irregular few
// frames a second. Offsets from the session start.
func idleThenBursty() []time.Duration {
	var out []time.Duration
	add := func(from, to, step time.Duration) {
		for at := from; at < to; at += step {
			out = append(out, at)
		}
	}
	add(33*time.Millisecond, 3*time.Second, 33*time.Millisecond)
	add(3*time.Second, 10*time.Second, 714*time.Millisecond)
	// 10s..14s: nothing at all.
	add(14*time.Second, 15*time.Second, 33*time.Millisecond)
	for at, i := 15*time.Second, 0; at < 22*time.Second; i++ {
		out = append(out, at)
		at += []time.Duration{180, 420, 260, 900, 330, 610}[i%6] * time.Millisecond
	}
	return out
}

type latenessRun struct {
	s        *Session
	lateness []time.Duration // per video part, in publish order
}

// runSchedule plays frames (stamped with their capture instant, delivered
// at that same instant plus a constant network delay, so the mapping is
// exact) interleaved with monitor ticks at the production cadence, and
// records each part's publication lateness: the wall instant it was
// published minus the wall instant its end maps to.
func runSchedule(t *testing.T, grace time.Duration, frames []time.Duration, until time.Duration) latenessRun {
	t.Helper()
	s, clock, base := deadlineSession(t, grace)
	const delay = 40 * time.Millisecond
	var partsBefore uint64
	var lateness []time.Duration
	record := func(now time.Time) {
		h := s.Health()
		if h.PartsWritten == partsBefore {
			return
		}
		infos := partInfos(t, s)
		for seq := partsBefore + 1; seq <= h.PartsWritten; seq++ {
			p, ok := infos[uint32(seq)]
			if !ok {
				t.Fatalf("part %d missing from the ring", seq)
			}
			endMedia := time.Duration(p.EndTicks) * time.Second / 90000
			lateness = append(lateness, now.Sub(base.Add(delay+endMedia)))
		}
		partsBefore = h.PartsWritten
	}
	fi := 0
	// Ticks land 37ms off the frame grid, as they do in production.
	for tick := 37 * time.Millisecond; tick <= until; tick += monitorTick {
		for fi < len(frames) && frames[fi]+delay <= tick {
			*clock = base.Add(frames[fi] + delay)
			ts := uint32(frames[fi] * 90000 / time.Second)
			s.HandleVideoPacket(videoPacket(singleNAL(1, []byte{0xAA, 0xBB}), ts, true))
			record(*clock)
			fi++
		}
		*clock = base.Add(tick)
		s.deadlineTick(*clock)
		s.idleTick(*clock)
		record(*clock)
	}
	return latenessRun{s: s, lateness: lateness}
}

func pct(d []time.Duration, p float64) time.Duration {
	c := append([]time.Duration(nil), d...)
	sort.Slice(c, func(i, j int) bool { return c[i] < c[j] })
	return c[int(float64(len(c)-1)*p)]
}

// THE FIX, MEASURED. With the part deadline every part is published within
// the grace plus one monitor tick of the instant its end passes, whatever
// the source does; with the grace at the rollback value the same schedule
// publishes parts up to a second late, which is the 2026-09-21 finding.
func TestDeadline_IdleThenBurstySourcePublishesOnTheBeat(t *testing.T) {
	frames := idleThenBursty()
	after := runSchedule(t, DefaultPartDeadlineGrace, frames, 22*time.Second)
	before := runSchedule(t, time.Second, frames, 22*time.Second)

	t.Logf("before (grace 1000ms, the old timing): parts=%d p50=%s p90=%s max=%s",
		len(before.lateness), pct(before.lateness, .5), pct(before.lateness, .9), pct(before.lateness, 1))
	t.Logf("after  (grace %s): parts=%d p50=%s p90=%s max=%s", DefaultPartDeadlineGrace,
		len(after.lateness), pct(after.lateness, .5), pct(after.lateness, .9), pct(after.lateness, 1))

	bound := DefaultPartDeadlineGrace + monitorTick
	if worst := pct(after.lateness, 1); worst > bound {
		t.Fatalf("worst part lateness %s with the deadline on, want at most grace+tick = %s", worst, bound)
	}
	if worst := pct(before.lateness, 1); worst < 500*time.Millisecond {
		t.Fatalf("the rollback timing published every part within %s; this schedule no longer reproduces the finding", worst)
	}
	st := after.s.Stats()
	if st.PartsLate250 != 0 {
		t.Fatalf("PartsLate250 = %d with the deadline on", st.PartsLate250)
	}
	if before.s.Stats().PartsLate500 == 0 {
		t.Fatal("the lateness counters did not see the rollback's late parts")
	}
	if st.DeadlineParts == 0 {
		t.Fatal("no part was cut by the deadline")
	}
	// Every frame arrived on its own clock, so nothing may have been
	// shifted: a repeat frame never covered an instant a frame was sent for.
	if st.PTSShiftMs != 0 {
		t.Fatalf("PTSShiftMs = %d: the fill landed on media the publisher really sent", st.PTSShiftMs)
	}
	// And media still keeps wall time: published media trails the wall
	// clock by at most the part still open plus the grace and a tick.
	wall := st.Now.Sub(st.VideoMediaAnchor)
	if behind := wall - time.Duration(st.VideoMediaMs)*time.Millisecond; behind > 500*time.Millisecond+bound || behind < -100*time.Millisecond {
		t.Fatalf("video media %dms against %s of wall: the timeline is not keeping time", st.VideoMediaMs, wall)
	}
}

// Every part the deadline cuts is exactly the part target, so PART-TARGET
// and the 85% floor hold, and the parts tile the timeline with no hole.
func TestDeadline_PartsStayWithinPartTargetAndTileTheTimeline(t *testing.T) {
	run := runSchedule(t, DefaultPartDeadlineGrace, idleThenBursty(), 22*time.Second)
	h := run.s.Health()
	infos := partInfos(t, run.s)
	var prevEnd int64 = -1
	for seq := uint32(1); seq <= uint32(h.PartsWritten); seq++ {
		p, ok := infos[seq]
		if !ok {
			t.Fatalf("part %d missing", seq)
		}
		if prevEnd >= 0 && p.StartTicks != prevEnd {
			t.Fatalf("part %d starts at %d, the one before ended at %d", seq, p.StartTicks, prevEnd)
		}
		if p.EndTicks-p.StartTicks > 45000 {
			t.Fatalf("part %d lasts %d ticks, past PART-TARGET", seq, p.EndTicks-p.StartTicks)
		}
		next, hasNext := infos[seq+1]
		terminal := !hasNext || next.SegmentIndex != p.SegmentIndex
		if !terminal && p.EndTicks-p.StartTicks < 45000*85/100 {
			t.Fatalf("non-terminal part %d lasts %d ticks, under the 85%% floor", seq, p.EndTicks-p.StartTicks)
		}
		prevEnd = p.EndTicks
	}
}

// A frame whose first packet has arrived is on its way: the deadline must
// not fill past its timestamp, however long the rest of it takes.
func TestDeadline_WaitsForAFrameAlreadyArriving(t *testing.T) {
	s, clock, base := deadlineSession(t, DefaultPartDeadlineGrace)
	// The first packet of a big frame stamped 400ms in, arriving on time,
	// with the rest of it paced out slowly.
	*clock = base.Add(400 * time.Millisecond)
	s.HandleVideoPacket(videoPacket(singleNAL(1, []byte{0xAA}), 400*90, false))
	for at := 500 * time.Millisecond; at <= 1500*time.Millisecond; at += monitorTick {
		if s.deadlineTick(base.Add(at)) {
			t.Fatalf("the deadline cut a part at %s over a frame still arriving", at)
		}
	}
	// It completes; its own arrival bounds the part as always.
	*clock = base.Add(1500 * time.Millisecond)
	s.HandleVideoPacket(videoPacket(singleNAL(1, []byte{0xBB}), 400*90, true))
	if s.Stats().PTSShiftMs != 0 {
		t.Fatalf("PTSShiftMs = %d", s.Stats().PTSShiftMs)
	}
	// And from there the deadline runs again.
	if !s.deadlineTick(base.Add(2 * time.Second)) {
		t.Fatal("the deadline stayed off after the arriving frame completed")
	}
}

// While the reorder buffer holds packets behind a hole, the missing packet
// may belong to an older frame than any held, so the deadline waits for
// the buffer (at most REORDER_HOLD_MS) instead of guessing.
func TestDeadline_WaitsWhileTheReorderBufferHolds(t *testing.T) {
	s, clock, base := deadlineSession(t, DefaultPartDeadlineGrace)
	s.SetReorderHold(300 * time.Millisecond)
	*clock = base.Add(100 * time.Millisecond)
	s.HandleVideoPacket(videoPacket(singleNAL(1, []byte{0xBB}), 100*90, true))
	testVideoSeq++ // a hole
	*clock = base.Add(600 * time.Millisecond)
	s.HandleVideoPacket(videoPacket(singleNAL(1, []byte{0xCC}), 600*90, true))
	if !s.reorder.holding() {
		t.Fatal("test setup: the reorder buffer is not holding anything")
	}
	if s.deadlineTick(base.Add(800 * time.Millisecond)) {
		t.Fatal("the deadline cut a part while the reorder buffer held packets")
	}
}

// With no repeater (CLOCK_CUT_PARTS off, or a stream skipframe refused)
// the deadline must never fire: the session behaves exactly as before.
func TestDeadline_InertWithoutClockCutting(t *testing.T) {
	s, _, base := deadlineSession(t, DefaultPartDeadlineGrace)
	s.frag.SetRepeater(nil)
	for at := monitorTick; at <= 5*time.Second; at += monitorTick {
		if s.deadlineTick(base.Add(at)) {
			t.Fatalf("the deadline fired at %s with no repeater", at)
		}
	}
}
