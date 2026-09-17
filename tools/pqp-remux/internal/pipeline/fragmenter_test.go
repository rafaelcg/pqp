package pipeline

import (
	"encoding/binary"
	"testing"

	"github.com/rafaelcg/pqp/tools/pqp-remux/internal/h264"
)

// Local, minimal ISOBMFF box walker: enough to inspect a fragment's mfhd
// sequence number, tfdt base decode time and trun's first sample's
// sample_flags, which is what proves "every segment starts on an IDR" at
// the box level rather than trusting the fragmenter's own bookkeeping.
type box struct {
	Type string
	Body []byte
}

func parseBoxes(t *testing.T, buf []byte) []box {
	t.Helper()
	var out []box
	for len(buf) > 0 {
		if len(buf) < 8 {
			t.Fatalf("trailing %d bytes too short for a box header", len(buf))
		}
		size := binary.BigEndian.Uint32(buf[0:4])
		typ := string(buf[4:8])
		if size < 8 || uint64(size) > uint64(len(buf)) {
			t.Fatalf("box %q has bad size %d (%d bytes remain)", typ, size, len(buf))
		}
		out = append(out, box{Type: typ, Body: buf[8:size]})
		buf = buf[size:]
	}
	return out
}

func find(boxes []box, typ string) box {
	for _, b := range boxes {
		if b.Type == typ {
			return b
		}
	}
	return box{}
}

func fullBoxRest(body []byte) []byte { return body[4:] }

// firstSampleIsSync reports whether a fragment's first trun sample entry
// carries the IDR ("sync sample") flags word.
func firstSampleIsSync(t *testing.T, fragBytes []byte) bool {
	t.Helper()
	top := parseBoxes(t, fragBytes)
	moof := find(top, "moof")
	moofChildren := parseBoxes(t, moof.Body)
	traf := find(moofChildren, "traf")
	trafChildren := parseBoxes(t, traf.Body)
	trun := find(trafChildren, "trun")
	rest := fullBoxRest(trun.Body)
	// sample_count(4) + data_offset(4), then each entry is
	// duration(4)+size(4)+flags(4).
	flags := binary.BigEndian.Uint32(rest[8+8 : 8+12])
	const sampleFlagsSync = 0x02000000
	return flags == sampleFlagsSync
}

func sequenceNumber(t *testing.T, fragBytes []byte) uint32 {
	t.Helper()
	top := parseBoxes(t, fragBytes)
	moof := find(top, "moof")
	moofChildren := parseBoxes(t, moof.Body)
	mfhd := find(moofChildren, "mfhd")
	return binary.BigEndian.Uint32(fullBoxRest(mfhd.Body))
}

func baseMediaDecodeTime(t *testing.T, fragBytes []byte) uint64 {
	t.Helper()
	top := parseBoxes(t, fragBytes)
	moof := find(top, "moof")
	moofChildren := parseBoxes(t, moof.Body)
	traf := find(moofChildren, "traf")
	trafChildren := parseBoxes(t, traf.Body)
	tfdt := find(trafChildren, "tfdt")
	return binary.BigEndian.Uint64(fullBoxRest(tfdt.Body))
}

func au(pts int64, idr bool) *h264.AccessUnit {
	return &h264.AccessUnit{PTS: pts, IsIDR: idr, AVCC: []byte{0, 0, 0, 4, 0x65, 0xAA, 0xBB, 0xCC}}
}

const (
	timescale       = 90000
	partDuration    = 45000  // 500ms
	segmentDuration = 360000 // 4s
	frameStep       = 3000   // 33.3ms, ~30fps
)

func TestFragmenter_DropsAccessUnitsBeforeFirstIDR(t *testing.T) {
	f := NewFragmenter(Config{Timescale: timescale, PartDuration: partDuration, SegmentDuration: segmentDuration})

	if _, err := pushOne(f, au(0, false)); err != ErrWaitingForIDR {
		t.Fatalf("expected ErrWaitingForIDR, got %v", err)
	}
	if _, err := pushOne(f, au(frameStep, false)); err != ErrWaitingForIDR {
		t.Fatalf("expected ErrWaitingForIDR, got %v", err)
	}
	if frag, err := pushOne(f, au(2*frameStep, true)); err != nil || frag != nil {
		t.Fatalf("first IDR should be accepted with no fragment yet: frag=%v err=%v", frag, err)
	}
}

func TestFragmenter_CutsPartsAtTargetDuration(t *testing.T) {
	f := NewFragmenter(Config{Timescale: timescale, PartDuration: partDuration, SegmentDuration: segmentDuration})

	var frags []*Fragment
	// 15 frames per part (15*3000 = 45000 = partDuration exactly).
	for i := int64(0); i < 45; i++ {
		idr := i == 0
		frag, err := pushOne(f, au(i*frameStep, idr))
		if err != nil {
			t.Fatalf("frame %d: %v", i, err)
		}
		if frag != nil {
			frags = append(frags, frag)
		}
	}
	if len(frags) < 2 {
		t.Fatalf("expected at least 2 parts closed, got %d", len(frags))
	}
	for i, frag := range frags {
		if frag.DurationTicks != partDuration {
			t.Fatalf("part %d duration = %d ticks, want %d", i, frag.DurationTicks, partDuration)
		}
		if got := sequenceNumber(t, frag.Bytes); got != frag.SequenceNumber {
			t.Fatalf("part %d: box sequence_number %d != Fragment.SequenceNumber %d", i, got, frag.SequenceNumber)
		}
	}
	// Sequence numbers strictly increase by 1 across every fragment the
	// session emits (mfhd requires this across the whole session, not just
	// within one segment).
	for i := 1; i < len(frags); i++ {
		if frags[i].SequenceNumber != frags[i-1].SequenceNumber+1 {
			t.Fatalf("sequence numbers not consecutive: %d then %d", frags[i-1].SequenceNumber, frags[i].SequenceNumber)
		}
	}
	if !frags[0].IsSegmentStart || frags[0].SegmentIndex != 0 {
		t.Fatalf("first emitted fragment must open segment 0")
	}
	if !firstSampleIsSync(t, frags[0].Bytes) {
		t.Fatal("segment-opening fragment's first sample must be a sync (IDR) sample")
	}
	for i := 1; i < len(frags); i++ {
		if frags[i].IsSegmentStart {
			t.Fatalf("part %d unexpectedly opens a new segment (no IDR reached %ds boundary yet)", i, segmentDuration)
		}
	}
}

func TestFragmenter_SegmentClosesOnlyOnIDRAtOrAfterTarget(t *testing.T) {
	f := NewFragmenter(Config{Timescale: timescale, PartDuration: partDuration, SegmentDuration: segmentDuration})

	var frags []*Fragment
	// Run past the 4s segment target (360000 ticks = 120 frames at 3000/frame).
	// Put a non-IDR frame exactly AT the boundary (frame 120) and the next
	// IDR two frames later (frame 122, PTS=366000): branch A says the
	// segment must NOT close at frame 120 and must close at frame 122. Run
	// on to frame 145 so the part following that IDR actually closes (a
	// part boundary at PTS 411000 = frame 137) and segment 1's opening
	// fragment is really emitted, not just pending.
	const totalFrames = 145
	for i := int64(0); i < totalFrames; i++ {
		idr := i == 0 || i == 122
		frag, err := pushOne(f, au(i*frameStep, idr))
		if err != nil {
			t.Fatalf("frame %d: %v", i, err)
		}
		if frag != nil {
			frags = append(frags, frag)
		}
	}

	var segmentStarts []*Fragment
	for _, frag := range frags {
		if frag.IsSegmentStart {
			segmentStarts = append(segmentStarts, frag)
		}
	}
	if len(segmentStarts) != 2 {
		t.Fatalf("expected exactly 2 segments (index 0 and 1), got %d segment-start fragments", len(segmentStarts))
	}
	if segmentStarts[1].SegmentIndex != 1 {
		t.Fatalf("second segment-start fragment has SegmentIndex %d, want 1", segmentStarts[1].SegmentIndex)
	}
	if !firstSampleIsSync(t, segmentStarts[1].Bytes) {
		t.Fatal("second segment's opening fragment must start on a sync sample")
	}
	if bmdt := baseMediaDecodeTime(t, segmentStarts[1].Bytes); bmdt != 122*frameStep {
		t.Fatalf("second segment's tfdt base decode time = %d, want %d (the IDR at frame 122, not frame 120)", bmdt, 122*frameStep)
	}
}

func TestFragmenter_TfdtNeverDecreasesAcrossFragments(t *testing.T) {
	f := NewFragmenter(Config{Timescale: timescale, PartDuration: partDuration, SegmentDuration: segmentDuration})

	var prev uint64
	first := true
	for i := int64(0); i < 200; i++ {
		idr := i == 0 || i%137 == 0 // irregular IDR cadence, on purpose
		frag, err := pushOne(f, au(i*frameStep, idr))
		if err != nil {
			t.Fatalf("frame %d: %v", i, err)
		}
		if frag == nil {
			continue
		}
		bmdt := baseMediaDecodeTime(t, frag.Bytes)
		if !first && bmdt < prev {
			t.Fatalf("tfdt went backwards: %d then %d", prev, bmdt)
		}
		prev, first = bmdt, false
	}
}

func TestFragmenter_FlushClosesTrailingPart(t *testing.T) {
	f := NewFragmenter(Config{Timescale: timescale, PartDuration: partDuration, SegmentDuration: segmentDuration})

	for i := int64(0); i < 5; i++ {
		if _, err := pushOne(f, au(i*frameStep, i == 0)); err != nil {
			t.Fatalf("frame %d: %v", i, err)
		}
	}
	frag, err := f.Flush()
	if err != nil {
		t.Fatalf("Flush: %v", err)
	}
	if frag == nil {
		t.Fatal("expected Flush to close the trailing part")
	}
	if !frag.IsSegmentStart {
		t.Fatal("the only fragment in a short session must still open segment 0")
	}

	// A second Flush with nothing pending must be a no-op, not a panic or
	// an empty fragment.
	frag2, err := f.Flush()
	if err != nil || frag2 != nil {
		t.Fatalf("second Flush should be a no-op: frag=%v err=%v", frag2, err)
	}
}

// TestFragmenter_SetStartSegmentIndexAppliesToFirstSegment is L1.6's own
// regression test (Farol review, PR #584): a watchdog restart must
// continue a session's video segment numbering (and therefore its R2
// object keys) from where a stalled predecessor left off, not reset to 0.
func TestFragmenter_SetStartSegmentIndexAppliesToFirstSegment(t *testing.T) {
	f := NewFragmenter(Config{Timescale: timescale, PartDuration: partDuration, SegmentDuration: segmentDuration})
	f.SetStartSegmentIndex(7)

	frag, err := pushOne(f, au(0, true))
	if err != nil {
		t.Fatalf("first IDR should be accepted: %v", err)
	}
	if frag != nil {
		t.Fatal("expected no fragment yet on the very first AU")
	}

	closed, err := f.Flush()
	if err != nil {
		t.Fatalf("Flush: %v", err)
	}
	if closed == nil {
		t.Fatal("expected Flush to close the trailing part")
	}
	if closed.SegmentIndex != 7 {
		t.Fatalf("expected the first segment to carry the overridden start index 7, got %d", closed.SegmentIndex)
	}
	if !closed.IsSegmentStart {
		t.Fatal("expected the first fragment to still be a segment start")
	}
	if got := f.CurrentSegmentIndex(); got != 7 {
		t.Fatalf("expected CurrentSegmentIndex to report 7 before any rollover, got %d", got)
	}
}

// A watchdog restart replaces the pipeline but not the session, and the
// edge Worker caches part bytes by their path alone -- so a replacement
// must never hand out a part name its predecessor already used. See
// SetStartSequence's own doc comment.
func TestFragmenter_SetStartSequenceResumesNumbering(t *testing.T) {
	f := NewFragmenter(Config{Timescale: 90000, PartDuration: 45000, SegmentDuration: 360000})
	if got := f.CurrentSequence(); got != 0 {
		t.Fatalf("a fresh fragmenter has emitted nothing: got %d", got)
	}
	f.SetStartSequence(164)

	var seqs []uint32
	for i := 0; i < 40; i++ {
		frag, _ := pushOne(f, &h264.AccessUnit{PTS: int64(i) * 3000, IsIDR: true})
		if frag != nil {
			seqs = append(seqs, frag.SequenceNumber)
		}
	}
	if len(seqs) == 0 {
		t.Fatal("no fragment emitted")
	}
	if seqs[0] != 164 {
		t.Fatalf("first resumed part = %d, want 164", seqs[0])
	}
	for i := 1; i < len(seqs); i++ {
		if seqs[i] != seqs[i-1]+1 {
			t.Fatalf("sequence numbers not contiguous: %v", seqs)
		}
	}
	if got := f.CurrentSequence(); got != seqs[len(seqs)-1] {
		t.Fatalf("CurrentSequence = %d, want the last emitted %d", got, seqs[len(seqs)-1])
	}
}

// Zero means "no predecessor", which is the default -- never "number the
// first part 0", since there is no part zero.
func TestFragmenter_SetStartSequenceZeroIsANoop(t *testing.T) {
	f := NewFragmenter(Config{Timescale: 90000, PartDuration: 45000, SegmentDuration: 360000})
	f.SetStartSequence(0)
	var first uint32
	for i := 0; i < 40 && first == 0; i++ {
		if frag, _ := pushOne(f, &h264.AccessUnit{PTS: int64(i) * 3000, IsIDR: true}); frag != nil {
			first = frag.SequenceNumber
		}
	}
	if first != 1 {
		t.Fatalf("first part = %d, want 1", first)
	}
}

// pushOne and flushOne are Push and IdleFlush as they read for a
// fragmenter with NO repeater set: one access unit in, at most one
// fragment out. Every test that predates clock cutting uses them, and
// they panic rather than silently drop a fragment if a fragmenter ever
// does cut more than one part in a call -- which only a test that sets a
// repeater can provoke, and those tests take the slices directly.
func pushOne(f *Fragmenter, au *h264.AccessUnit) (*Fragment, error) {
	frags, err := f.Push(au)
	return onlyFragment(frags), err
}

func flushOne(f *Fragmenter, heldTicks int64) *Fragment {
	return onlyFragment(f.IdleFlush(heldTicks))
}

func onlyFragment(frags []*Fragment) *Fragment {
	switch len(frags) {
	case 0:
		return nil
	case 1:
		return frags[0]
	default:
		panic("pipeline test: the fragmenter closed more than one part in a single call")
	}
}
