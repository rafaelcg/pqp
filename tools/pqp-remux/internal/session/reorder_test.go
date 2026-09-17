package session

import (
	"testing"
	"time"

	"github.com/pion/rtp"

	"github.com/rafaelcg/pqp/tools/pqp-remux/internal/keyframe"
	"github.com/rafaelcg/pqp/tools/pqp-remux/internal/ring"
)

func seqPkt(seq uint16) *rtp.Packet {
	return &rtp.Packet{Header: rtp.Header{SequenceNumber: seq}}
}

func seqTsPkt(seq uint16, ts uint32) *rtp.Packet {
	return &rtp.Packet{Header: rtp.Header{SequenceNumber: seq, Timestamp: ts}}
}

func seqs(ps []*rtp.Packet) []uint16 {
	out := make([]uint16, 0, len(ps))
	for _, p := range ps {
		out = append(out, p.SequenceNumber)
	}
	return out
}

func equalSeqs(a []uint16, b ...uint16) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}

func TestReorderBuffer_InOrderPassesThrough(t *testing.T) {
	r := newReorderBuffer(reorderHoldMax)
	t0 := time.Unix(0, 0)
	for i := uint16(10); i < 14; i++ {
		if got := seqs(r.push(seqPkt(i), t0)); !equalSeqs(got, i) {
			t.Fatalf("seq %d: got %v", i, got)
		}
	}
	if r.late != 0 || r.skipped != 0 || r.heldDelayed != 0 || r.resequenced != 0 {
		t.Fatalf("counters late=%d skipped=%d heldDelayed=%d resequenced=%d", r.late, r.skipped, r.heldDelayed, r.resequenced)
	}
	if r.maxDelay != 0 {
		t.Fatalf("maxDelay = %s, want 0 for a stream that never waited", r.maxDelay)
	}
}

// The production shape: 11 arrives before 10, then 10 comes ~50 ms later
// (the SFU's retransmission). Nothing is lost, nothing reordered on the
// way out, and the two that waited count as RESEQUENCED, not delayed --
// the split `held` used to hide.
func TestReorderBuffer_RetransmissionFillsTheHole(t *testing.T) {
	r := newReorderBuffer(reorderHoldMax)
	t0 := time.Unix(0, 0)
	r.push(seqPkt(9), t0)
	if got := r.push(seqPkt(11), t0); got != nil {
		t.Fatalf("11 ahead of 10 must wait, got %v", seqs(got))
	}
	if got := r.push(seqPkt(12), t0.Add(3*time.Millisecond)); got != nil {
		t.Fatalf("12 must wait too, got %v", seqs(got))
	}
	got := seqs(r.push(seqPkt(10), t0.Add(50*time.Millisecond)))
	if !equalSeqs(got, 10, 11, 12) {
		t.Fatalf("after the retransmission: got %v, want 10 11 12", got)
	}
	if r.skipped != 0 || r.resequenced != 2 || r.heldDelayed != 0 || r.late != 0 {
		t.Fatalf("counters late=%d skipped=%d heldDelayed=%d resequenced=%d", r.late, r.skipped, r.heldDelayed, r.resequenced)
	}
	if r.maxDelay != 50*time.Millisecond {
		t.Fatalf("maxDelay = %s, want 50ms (11 arrived at t0 and went out at t0+50ms)", r.maxDelay)
	}
	if got := seqs(r.push(seqPkt(13), t0.Add(60*time.Millisecond))); !equalSeqs(got, 13) {
		t.Fatalf("back in order: got %v", got)
	}
}

func TestReorderBuffer_GivesUpAfterHoldMax(t *testing.T) {
	r := newReorderBuffer(reorderHoldMax)
	t0 := time.Unix(0, 0)
	r.push(seqPkt(1), t0)
	r.push(seqPkt(3), t0)
	if got := r.push(seqPkt(4), t0.Add(reorderHoldMax-time.Millisecond)); got != nil {
		t.Fatalf("still inside the hold: got %v", seqs(got))
	}
	got := seqs(r.push(seqPkt(5), t0.Add(reorderHoldMax)))
	if !equalSeqs(got, 3, 4, 5) {
		t.Fatalf("after holdMax the hole is skipped: got %v", got)
	}
	if r.skipped != 1 {
		t.Fatalf("skipped = %d", r.skipped)
	}
	// The retransmission that comes after we gave up is late, and dropped.
	if got := r.push(seqPkt(2), t0.Add(reorderHoldMax+time.Millisecond)); got != nil || r.late != 1 {
		t.Fatalf("late 2: got %v late=%d", seqs(got), r.late)
	}
	if got := seqs(r.push(seqPkt(6), t0.Add(reorderHoldMax+2*time.Millisecond))); !equalSeqs(got, 6) {
		t.Fatalf("6: got %v", got)
	}
}

func TestReorderBuffer_GivesUpAfterMaxPending(t *testing.T) {
	r := newReorderBuffer(reorderHoldMax)
	t0 := time.Unix(0, 0)
	r.push(seqPkt(100), t0)
	var got []*rtp.Packet
	for i := 0; i < reorderMaxPending; i++ {
		got = r.push(seqPkt(uint16(102+i)), t0)
	}
	if len(got) != reorderMaxPending || got[0].SequenceNumber != 102 {
		t.Fatalf("after maxPending: %d packets, first %d", len(got), got[0].SequenceNumber)
	}
	if len(r.pending) != 0 {
		t.Fatalf("pending not drained: %d", len(r.pending))
	}
}

func TestReorderBuffer_TwoHolesAndWrap(t *testing.T) {
	r := newReorderBuffer(reorderHoldMax)
	t0 := time.Unix(0, 0)
	r.push(seqPkt(65533), t0)
	r.push(seqPkt(65535), t0) // 65534 missing
	r.push(seqPkt(1), t0)     // 0 missing too
	got := seqs(r.push(seqPkt(65534), t0.Add(10*time.Millisecond)))
	if !equalSeqs(got, 65534, 65535) {
		t.Fatalf("first hole filled: got %v", got)
	}
	got = seqs(r.push(seqPkt(0), t0.Add(20*time.Millisecond)))
	if !equalSeqs(got, 0, 1) {
		t.Fatalf("second hole filled across the wrap: got %v", got)
	}
}

func TestReorderBuffer_FlushOverdue(t *testing.T) {
	r := newReorderBuffer(reorderHoldMax)
	t0 := time.Unix(0, 0)
	r.push(seqPkt(1), t0)
	r.push(seqPkt(3), t0)
	if got := r.flushOverdue(t0.Add(100 * time.Millisecond)); got != nil {
		t.Fatalf("not overdue yet: %v", seqs(got))
	}
	if got := seqs(r.flushOverdue(t0.Add(reorderHoldMax))); !equalSeqs(got, 3) {
		t.Fatalf("overdue flush: got %v", got)
	}
}

// THE REGRESSION THIS FILE'S REWRITE EXISTS FOR (production 2026-09-17,
// session 54e01974). Five holes open while the source is sending; under
// the old one-deadline-per-hole rule the first give-up delivered ONE
// packet and stamped a fresh 300 ms clock on the next hole, so the fifth
// packet went out 1.5 s after it arrived and `lastPart` crossed the
// control plane's 3 s part-stuck threshold. One deadline per PACKET means
// all five go in a single drain, and `skipped` still counts five holes
// because the depacketizer will see five gaps.
func TestReorderBuffer_ConsecutiveHolesShareOneDeadline(t *testing.T) {
	r := newReorderBuffer(reorderHoldMax)
	t0 := time.Unix(0, 0)
	r.push(seqPkt(1), t0) // next = 2
	// 3, 5, 7, 9, 11 arrive; 2, 4, 6, 8, 10 never do.
	for _, seq := range []uint16{3, 5, 7, 9, 11} {
		if got := r.push(seqPkt(seq), t0); got != nil {
			t.Fatalf("seq %d must wait, got %v", seq, seqs(got))
		}
	}
	// One check at the deadline releases every one of them.
	got := seqs(r.flushOverdue(t0.Add(reorderHoldMax)))
	if !equalSeqs(got, 3, 5, 7, 9, 11) {
		t.Fatalf("one drain must release all five: got %v", got)
	}
	if r.skipped != 5 {
		t.Fatalf("skipped = %d, want 5 (one per hole)", r.skipped)
	}
	if r.maxDelay != reorderHoldMax {
		t.Fatalf("maxDelay = %s, want exactly the hold (%s); anything longer is a serial hold", r.maxDelay, reorderHoldMax)
	}
	if len(r.pending) != 0 {
		t.Fatalf("pending = %d, want empty", len(r.pending))
	}
}

// reorderDelayProbe drives one loss pattern and reports the worst delay
// any delivered packet suffered, measured from ITS OWN arrival.
type reorderDelayProbe struct {
	arrived map[uint16]time.Time
	worst   time.Duration
	worstOf uint16
}

func (p *reorderDelayProbe) deliver(out []*rtp.Packet, now time.Time) {
	for _, pkt := range out {
		at, ok := p.arrived[pkt.SequenceNumber]
		if !ok {
			continue
		}
		if d := now.Sub(at); d > p.worst {
			p.worst, p.worstOf = d, pkt.SequenceNumber
		}
	}
}

// THE BOUND, ASSERTED. Every other packet missing for three seconds at
// 30 pkt/s -- the shape production measured during the loss windows that
// restarted the session -- and no delivered packet may wait more than
// reorderDelayBound (300 ms hold plus one check interval). 400 ms is the
// number the watchdog is sized against: see
// WatchdogConfig.partStuckThreshold in internal/control.
//
// Run twice on purpose. With ADVANCING RTP timestamps (a real screen
// share) the media-span trigger fires and cuts the wait short; with
// CONSTANT ones (several packets of one big frame) only the per-packet
// deadline is left, which is the true worst case and the one the bound
// has to survive.
func TestReorderBuffer_PathologicalLossBoundsDelay(t *testing.T) {
	const (
		rate      = 30 // packets per second actually arriving
		seconds   = 3
		interval  = time.Second / rate
		checkTick = MonitorTick // what RunMonitor actually ticks at
	)
	// The ceiling the whole design is sized against: the hold, plus the
	// longest a packet that has gone overdue can sit before anything
	// looks at the buffer again. While packets are still arriving that
	// second term is the inter-arrival gap (33ms here); once the source
	// goes quiet it is the monitor tick.
	bound := reorderDelayBound(reorderHoldMax, checkTick)
	if bound > 400*time.Millisecond {
		t.Fatalf("the stated bound is %s; this test asserts a measured worst under 400ms", bound)
	}

	for _, tc := range []struct {
		name   string
		tsStep uint32
	}{
		{"advancing timestamps (30fps screen share)", 3000},
		{"constant timestamp (one big frame, many packets)", 0},
	} {
		t.Run(tc.name, func(t *testing.T) {
			r := newReorderBuffer(reorderHoldMax)
			probe := &reorderDelayProbe{arrived: map[uint16]time.Time{}}
			t0 := time.Unix(1_700_000_000, 0)

			var seq uint16 = 1000
			var ts uint32
			r.push(seqTsPkt(seq, ts), t0)

			now := t0
			nextCheck := t0.Add(checkTick)
			for i := 0; i < rate*seconds; i++ {
				now = now.Add(interval)
				// The monitor's own tick, which is what bounds a packet
				// that goes overdue between two arrivals.
				for !nextCheck.After(now) {
					probe.deliver(r.flushOverdue(nextCheck), nextCheck)
					nextCheck = nextCheck.Add(checkTick)
				}
				seq += 2 // every other one is lost
				ts += tc.tsStep
				probe.arrived[seq] = now
				probe.deliver(r.push(seqTsPkt(seq, ts), now), now)
			}
			// The source goes quiet: the monitor tick has to finish the
			// job, on the same cadence it runs at in RunMonitor.
			for i := 0; i < 10; i++ {
				probe.deliver(r.flushOverdue(nextCheck), nextCheck)
				nextCheck = nextCheck.Add(checkTick)
			}

			if len(r.pending) != 0 {
				t.Fatalf("pending = %d after the source went quiet; the buffer must not hold media indefinitely", len(r.pending))
			}
			if probe.worst >= 400*time.Millisecond {
				t.Fatalf("worst delay %s (seq %d) reached 400ms; the reorder buffer can stall the pipeline past the watchdog", probe.worst, probe.worstOf)
			}
			if probe.worst > bound {
				t.Fatalf("worst delay %s (seq %d) is past the stated bound %s (reorderDelayBound)", probe.worst, probe.worstOf, bound)
			}
			if r.heldDelayed == 0 {
				t.Fatal("nothing was counted as heldDelayed; the pattern did not exercise a give-up")
			}
			t.Logf("worst delay %s (bound %s), skipped=%d heldDelayed=%d resequenced=%d", probe.worst, bound, r.skipped, r.heldDelayed, r.resequenced)
		})
	}
}

// The "the source rate has collapsed" give-up: only a handful of packets
// are pending (nowhere near maxPending) but the media they carry already
// spans more than the hold, so waiting the rest of it out can only make
// the pipeline later. Released without waiting for the per-packet
// deadline.
func TestReorderBuffer_GivesUpWhenPendingSpansMoreThanTheHold(t *testing.T) {
	r := newReorderBuffer(reorderHoldMax)
	t0 := time.Unix(0, 0)
	r.push(seqTsPkt(1, 0), t0) // next = 2
	// 3 and 4 are one hold apart in MEDIA time but arrive 20ms apart.
	if got := r.push(seqTsPkt(3, 0), t0); got != nil {
		t.Fatalf("3 must wait: %v", seqs(got))
	}
	spanning := uint32(ticksForHold(reorderHoldMax)) + 90
	got := seqs(r.push(seqTsPkt(4, spanning), t0.Add(20*time.Millisecond)))
	if !equalSeqs(got, 3, 4) {
		t.Fatalf("a pending set wider than the hold must go at once: got %v", got)
	}
	if r.maxDelay > 20*time.Millisecond {
		t.Fatalf("maxDelay = %s; the span trigger must not wait out the hold", r.maxDelay)
	}
	if r.skipped != 1 {
		t.Fatalf("skipped = %d, want 1", r.skipped)
	}
}

// REORDER_HOLD_MS=0 is the rollback switch: no holding at all, the gap
// goes straight to the depacketizer exactly as it did before this buffer
// existed.
func TestReorderBuffer_HoldDisabled(t *testing.T) {
	r := newReorderBuffer(0)
	t0 := time.Unix(0, 0)
	r.push(seqPkt(1), t0)
	got := seqs(r.push(seqPkt(3), t0))
	if !equalSeqs(got, 3) {
		t.Fatalf("with holding off, 3 goes straight through: got %v", got)
	}
	if len(r.pending) != 0 {
		t.Fatalf("nothing may be pending with holding off: %d", len(r.pending))
	}
	if r.skipped != 1 || r.heldDelayed != 0 || r.resequenced != 0 {
		t.Fatalf("counters skipped=%d heldDelayed=%d resequenced=%d", r.skipped, r.heldDelayed, r.resequenced)
	}
	if got := seqs(r.push(seqPkt(4), t0)); !equalSeqs(got, 4) {
		t.Fatalf("4: got %v", got)
	}
	if got := r.push(seqPkt(2), t0); got != nil || r.late != 1 {
		t.Fatalf("2 is late once we moved past it: got %v late=%d", seqs(got), r.late)
	}
}

// flushOverdue EXISTED AND NOTHING CALLED IT. Until this change the
// reorder buffer was only ever looked at by an arriving packet, so the
// tail of a loss episode that ended in silence -- exactly what a screen
// share does when the presenter's uplink drops out -- sat in the map for
// as long as the source stayed quiet, holding the pipeline with it. The
// monitor tick calls it now, and this test is what keeps it called
// (repo pitfall 13's dead-reaper lesson).
func TestSession_ReorderTickReleasesAQuietSourcesHeldPackets(t *testing.T) {
	r := ring.New(6, 90000)
	s := New(45000, 360000, r, nil)
	defer s.Close()
	clock := time.Unix(1_700_000_000, 0)
	s.now = func() time.Time { return clock }
	pli := &countingPLI{}
	s.SetKeyframeRequester(keyframe.NewRequester(keyframe.Config{Policy: keyframe.PolicyPLI, SegmentTargetMs: 4000}, pli))
	at := func(n uint16, p []byte, ts uint32, marker bool, d time.Duration) {
		clock = clock.Add(d)
		s.HandleVideoPacket(&rtp.Packet{Header: rtp.Header{SequenceNumber: n, Timestamp: ts, Marker: marker}, Payload: p})
	}
	at(1, singleNAL(7, realishSPS()[1:]), 0, false, 0)
	at(2, singleNAL(8, realishPPS()[1:]), 0, false, 0)
	at(3, singleNAL(5, []byte{0xAA}), 0, true, 0)

	// 4 never arrives; 5 does, and then the source goes silent.
	at(5, singleNAL(1, []byte{0xBB}), frameStep, true, 33*time.Millisecond)
	if s.damageOpen.Load() {
		t.Fatal("the hole is still inside its hold; nothing should have been declared lost yet")
	}

	// No further packet ever arrives. Only the monitor tick can end this.
	clock = clock.Add(reorderHoldMax)
	s.reorderTick(clock)
	if !s.damageOpen.Load() {
		t.Fatal("the monitor tick must release a held packet on a source that has gone quiet")
	}
	if s.takeReorderMaxDelayMs() < reorderHoldMax.Milliseconds() {
		t.Fatal("the released packet's delay must be recorded")
	}
}

// End to end through the session: a retransmission that lands inside the
// hold must not arm drop-until-IDR or send a PLI at all.
func TestSession_RetransmissionInsideHoldIsNotLoss(t *testing.T) {
	r := ring.New(6, 90000)
	s := New(45000, 360000, r, nil)
	clock := time.Unix(1_700_000_000, 0)
	s.now = func() time.Time { return clock }
	pli := &countingPLI{}
	s.SetKeyframeRequester(keyframe.NewRequester(keyframe.Config{Policy: keyframe.PolicyPLI, SegmentTargetMs: 4000}, pli))
	at := func(n uint16, p []byte, ts uint32, marker bool, d time.Duration) {
		clock = clock.Add(d)
		s.HandleVideoPacket(&rtp.Packet{Header: rtp.Header{SequenceNumber: n, Timestamp: ts, Marker: marker}, Payload: p})
	}
	at(1, singleNAL(7, realishSPS()[1:]), 0, false, 0)
	at(2, singleNAL(8, realishPPS()[1:]), 0, false, 0)
	at(3, singleNAL(5, []byte{0xAA}), 0, true, 0)
	frags := fuAFrames(1, make([]byte, 900), 3)
	at(4, frags[0], frameStep, false, 33*time.Millisecond)
	at(6, frags[2], frameStep, true, 2*time.Millisecond)   // arrives before the middle one
	at(5, frags[1], frameStep, false, 40*time.Millisecond) // the retransmission
	if s.damageOpen.Load() {
		t.Fatal("a hole filled inside the hold must not count as damage")
	}
	if pli.calls != 0 {
		t.Fatalf("PLI calls = %d, want 0", pli.calls)
	}
	if s.damageEpisodes.Load() != 0 {
		t.Fatalf("damageEpisodes = %d", s.damageEpisodes.Load())
	}
	st := s.Stats()
	if st.VideoReorderResequenced != 1 || st.VideoReorderHeldDelayed != 0 {
		t.Fatalf("resequenced = %d heldDelayed = %d, want 1 and 0", st.VideoReorderResequenced, st.VideoReorderHeldDelayed)
	}
	if got := s.videoFramesSeen.Load(); got != 2 {
		t.Fatalf("frames seen = %d, want 2 (IDR + the reassembled P-frame)", got)
	}
	// The same hole left open past the hold IS loss.
	at(7, singleNAL(1, []byte{0xBB}), 2*frameStep, true, 33*time.Millisecond)
	at(9, singleNAL(1, []byte{0xCC}), 3*frameStep, true, 33*time.Millisecond)
	at(10, singleNAL(1, []byte{0xDD}), 4*frameStep, true, reorderHoldMax)
	if !s.damageOpen.Load() || pli.calls != 1 {
		t.Fatalf("a hole past the hold must be loss: damaged=%t pli=%d", s.damageOpen.Load(), pli.calls)
	}
	if s.takeReorderMaxDelayMs() == 0 {
		t.Fatal("the windowed max delay must be non-zero after a packet waited")
	}
	if again := s.takeReorderMaxDelayMs(); again != 0 {
		t.Fatalf("the windowed max delay must reset when taken, got %d", again)
	}
}
