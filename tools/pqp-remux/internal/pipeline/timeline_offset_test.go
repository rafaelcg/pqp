package pipeline

import "testing"

// SetTimelineOffset moves where video media time starts (the session's
// shared epoch), before anything is published, and only then. It is an
// anchor, not a correction, so PTSOffset does not report it.
func TestSetTimelineOffsetPlacesTheFirstPartAndIsNotAShift(t *testing.T) {
	f := NewFragmenter(Config{Timescale: timescale, PartDuration: partDuration, SegmentDuration: segmentDuration})
	const off = 153000 // 1.7s
	f.SetTimelineOffset(off)
	var first *Fragment
	for pts := int64(0); first == nil; pts += frameStep {
		frag, err := pushOne(f, au(pts, pts == 0))
		if err != nil {
			t.Fatal(err)
		}
		first = frag
	}
	if got := baseMediaDecodeTime(t, first.Bytes); got != off {
		t.Fatalf("first part tfdt %d, want the offset %d", got, off)
	}
	if first.StartTicks != off {
		t.Fatalf("StartTicks %d, want %d", first.StartTicks, off)
	}
	if f.PTSOffset() != 0 {
		t.Fatalf("PTSOffset %d: the anchor was reported as a shift", f.PTSOffset())
	}
	f.SetTimelineOffset(999999)
	next, err := f.Push(au(100*frameStep, false))
	if err != nil {
		t.Fatal(err)
	}
	for _, frag := range next {
		if frag.StartTicks > off+100*frameStep {
			t.Fatal("a late SetTimelineOffset moved a published timeline")
		}
	}
}
