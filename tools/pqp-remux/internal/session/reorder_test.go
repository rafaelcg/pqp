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
	r := newReorderBuffer()
	t0 := time.Unix(0, 0)
	for i := uint16(10); i < 14; i++ {
		if got := seqs(r.push(seqPkt(i), t0)); !equalSeqs(got, i) {
			t.Fatalf("seq %d: got %v", i, got)
		}
	}
	if r.late != 0 || r.skipped != 0 || r.held != 0 {
		t.Fatalf("counters late=%d skipped=%d held=%d", r.late, r.skipped, r.held)
	}
}

// The production shape: 11 arrives before 10, then 10 comes ~50 ms later
// (the SFU's retransmission). Nothing is lost, nothing reordered on the
// way out.
func TestReorderBuffer_RetransmissionFillsTheHole(t *testing.T) {
	r := newReorderBuffer()
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
	if r.skipped != 0 || r.held != 2 || r.late != 0 {
		t.Fatalf("counters late=%d skipped=%d held=%d", r.late, r.skipped, r.held)
	}
	if got := seqs(r.push(seqPkt(13), t0.Add(60*time.Millisecond))); !equalSeqs(got, 13) {
		t.Fatalf("back in order: got %v", got)
	}
}

func TestReorderBuffer_GivesUpAfterHoldMax(t *testing.T) {
	r := newReorderBuffer()
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
	r := newReorderBuffer()
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
	r := newReorderBuffer()
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
	r := newReorderBuffer()
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
	if s.droppingDamaged.Load() {
		t.Fatal("a hole filled inside the hold must not count as damage")
	}
	if pli.calls != 0 {
		t.Fatalf("PLI calls = %d, want 0", pli.calls)
	}
	if s.damageEpisodes.Load() != 0 {
		t.Fatalf("damageEpisodes = %d", s.damageEpisodes.Load())
	}
	if got := s.Stats().VideoReorderHeld; got != 1 {
		t.Fatalf("held = %d, want 1", got)
	}
	if got := s.videoFramesSeen.Load(); got != 2 {
		t.Fatalf("frames seen = %d, want 2 (IDR + the reassembled P-frame)", got)
	}
	// The same hole left open past the hold IS loss.
	at(7, singleNAL(1, []byte{0xBB}), 2*frameStep, true, 33*time.Millisecond)
	at(9, singleNAL(1, []byte{0xCC}), 3*frameStep, true, 33*time.Millisecond)
	at(10, singleNAL(1, []byte{0xDD}), 4*frameStep, true, reorderHoldMax)
	if !s.droppingDamaged.Load() || pli.calls != 1 {
		t.Fatalf("a hole past the hold must be loss: damaged=%t pli=%d", s.droppingDamaged.Load(), pli.calls)
	}
}
