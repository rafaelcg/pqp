package session

import (
	"testing"
	"time"

	"github.com/pion/rtp"

	"github.com/rafaelcg/pqp/tools/pqp-remux/internal/keyframe"
	"github.com/rafaelcg/pqp/tools/pqp-remux/internal/ring"
)

type countingPLI struct{ calls int }

func (c *countingPLI) RequestKeyframe() { c.calls++ }

// fuAFrames splits rbsp into n FU-A packets for a NAL of the given type.
func fuAFrames(nalType byte, rbsp []byte, n int) [][]byte {
	out := make([][]byte, 0, n)
	chunk := (len(rbsp) + n - 1) / n
	for i := 0; i < n; i++ {
		lo, hi := i*chunk, (i+1)*chunk
		if hi > len(rbsp) {
			hi = len(rbsp)
		}
		hdr := nalType & 0x1f
		if i == 0 {
			hdr |= 0x80
		}
		if i == n-1 {
			hdr |= 0x40
		}
		out = append(out, append([]byte{0x40 | 28, hdr}, rbsp[lo:hi]...))
	}
	return out
}

// Production 2026-09-17: one lossy presenter uplink, a P-slice missing its
// middle fragment, and every web viewer of the LL rung died with
// MEDIA_ERR_DECODE. The session must (1) never forward the damaged access
// unit, (2) ask for an IDR immediately, once per episode, and (3) keep
// forwarding the frames that follow: holding them back stretched one
// sample across the wait and inflated PART-TARGET, which Apple's player
// refuses (see markDamaged).
func TestSession_PacketLossDiscardsTheFrameAndAsksForAnIDR(t *testing.T) {
	r := ring.New(6, 90000)
	s := New(45000, 360000, r, nil)
	clock := time.Unix(1_700_000_000, 0)
	s.now = func() time.Time { return clock }
	pli := &countingPLI{}
	s.SetKeyframeRequester(keyframe.NewRequester(keyframe.Config{Policy: keyframe.PolicyPLI, SegmentTargetMs: 4000}, pli))

	seq := uint16(1000)
	send := func(payload []byte, ts uint32, marker bool) {
		seq++
		clock = clock.Add(3 * time.Millisecond)
		s.HandleVideoPacket(&rtp.Packet{Header: rtp.Header{SequenceNumber: seq, Timestamp: ts, Marker: marker}, Payload: payload})
	}
	frame := int64(0)
	ts := func() uint32 { return uint32(frame * frameStep) }

	send(singleNAL(7, realishSPS()[1:]), 0, false)
	send(singleNAL(8, realishPPS()[1:]), 0, false)
	send(singleNAL(5, []byte{0xAA, 0xBB}), 0, true)
	frame++
	for i := 0; i < 5; i++ {
		send(singleNAL(1, []byte{0xCC, byte(i)}), ts(), true)
		frame++
	}
	framesBefore := s.videoFramesSeen.Load()
	if s.damageOpen.Load() {
		t.Fatal("clean stream must not be flagged damaged")
	}

	// A fragmented P-frame with its middle fragment lost for good: the
	// reorder buffer holds the end fragment for reorderHoldMax, then the
	// next frame's arrival gives the hole up.
	frags := fuAFrames(1, make([]byte, 900), 3)
	send(frags[0], ts(), false)
	seq++ // frags[1] never arrives
	send(frags[2], ts(), true)
	frame++
	if s.damageOpen.Load() {
		t.Fatal("inside the reorder hold nothing is loss yet")
	}
	partsAtLoss := s.Stats().PartsWritten
	clock = clock.Add(reorderHoldMax)
	send(singleNAL(1, []byte{0xDD, 0xFF}), ts(), true) // gives the hole up; forwarded
	frame++

	if !s.damageOpen.Load() {
		t.Fatal("a sequence gap inside an access unit must open a damage episode")
	}
	if pli.calls != 1 {
		t.Fatalf("PLI calls = %d, want 1 immediately on loss", pli.calls)
	}
	if s.damageEpisodes.Load() != 1 {
		t.Fatalf("damageEpisodes = %d, want 1", s.damageEpisodes.Load())
	}
	// The damaged access unit itself is not a frame; the P-frame that gave
	// the hole up is one, and it goes out.
	if got := s.videoFramesSeen.Load(); got != framesBefore+1 {
		t.Fatalf("frames seen %d -> %d, want +1", framesBefore, got)
	}

	// P-frames that follow keep flowing (parts keep being written), and
	// a second gap inside the same episode does not fire another PLI.
	for i := 0; i < 20; i++ {
		send(singleNAL(1, []byte{0xDD, byte(i)}), ts(), true)
		frame++
	}
	if got := s.damagedAUsDropped.Load(); got != 0 {
		t.Fatalf("damagedAUsDropped = %d, want 0: frames after a loss are forwarded", got)
	}
	if s.Stats().PartsWritten <= partsAtLoss {
		t.Fatal("parts must keep being written while the IDR is owed")
	}
	if pli.calls != 1 {
		t.Fatalf("PLI calls = %d, want still 1 (one per episode)", pli.calls)
	}

	// The IDR the PLI asked for closes the episode; a later loss opens a new one.
	send(singleNAL(5, []byte{0xEE}), ts(), true)
	frame++
	if s.damageOpen.Load() {
		t.Fatal("an IDR must close the damage episode")
	}
	frags2 := fuAFrames(1, make([]byte, 900), 3)
	send(frags2[0], ts(), false)
	seq++ // lost again
	send(frags2[2], ts(), true)
	clock = clock.Add(reorderHoldMax)
	send(singleNAL(1, []byte{0xEF}), ts(), true)
	frame++
	if pli.calls != 2 || s.damageEpisodes.Load() != 2 {
		t.Fatalf("second loss after the IDR: pli=%d episodes=%d, want 2 and 2", pli.calls, s.damageEpisodes.Load())
	}
	st := s.Stats()
	if st.VideoPacketsLost != 2 || st.VideoDamageEpisodes != 2 || st.VideoDamagedDropped != 0 {
		t.Fatalf("stats lost=%d damage=%d damagedDropped=%d", st.VideoPacketsLost, st.VideoDamageEpisodes, st.VideoDamagedDropped)
	}
	line := formatStatsLine("s", Stats{}, st, 5e9)
	for _, want := range []string{"lost=+2", "damage=+2", "damagedDropped=+0"} {
		if !contains(line, want) {
			t.Fatalf("stats line lacks %q: %s", want, line)
		}
	}
}

// A tail loss (the marker packet of an AU never arrives) already discarded
// the AU via the timestamp rule; it must ALSO ask for an IDR now.
func TestSession_TailLossAlsoAsksForAnIDR(t *testing.T) {
	r := ring.New(6, 90000)
	s := New(45000, 360000, r, nil)
	clock := time.Unix(1_700_000_000, 0)
	s.now = func() time.Time { return clock }
	pli := &countingPLI{}
	s.SetKeyframeRequester(keyframe.NewRequester(keyframe.Config{Policy: keyframe.PolicyPLI, SegmentTargetMs: 4000}, pli))
	seq := uint16(1)
	send := func(payload []byte, ts uint32, marker bool) {
		seq++
		clock = clock.Add(3 * time.Millisecond)
		s.HandleVideoPacket(&rtp.Packet{Header: rtp.Header{SequenceNumber: seq, Timestamp: ts, Marker: marker}, Payload: payload})
	}
	send(singleNAL(7, realishSPS()[1:]), 0, false)
	send(singleNAL(8, realishPPS()[1:]), 0, false)
	send(singleNAL(5, []byte{0xAA}), 0, true)
	frags := fuAFrames(1, make([]byte, 600), 3)
	send(frags[0], frameStep, false)
	send(frags[1], frameStep, false)
	seq++ // the end fragment (marker) is lost
	send(singleNAL(1, []byte{0xBB}), 2*frameStep, true)
	clock = clock.Add(reorderHoldMax)
	send(singleNAL(1, []byte{0xCC}), 3*frameStep, true)
	if !s.damageOpen.Load() {
		t.Fatal("a lost marker packet must open a damage episode")
	}
	if pli.calls != 1 {
		t.Fatalf("PLI calls = %d, want 1", pli.calls)
	}
}

func contains(s, sub string) bool {
	return len(sub) == 0 || (len(s) >= len(sub) && indexOf(s, sub) >= 0)
}

func indexOf(s, sub string) int {
	for i := 0; i+len(sub) <= len(s); i++ {
		if s[i:i+len(sub)] == sub {
			return i
		}
	}
	return -1
}
