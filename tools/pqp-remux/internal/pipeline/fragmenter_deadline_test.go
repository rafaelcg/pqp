package pipeline

import "testing"

// DeadlineCut is the part cadence for a quiet source: it closes a part as
// soon as the caller says the wall clock has passed the part's end, rather
// than on the next frame or the idle allowance. These pin what it may and
// may not do to the timeline.

// Without a repeater there is no honest short part, so DeadlineCut must do
// nothing at all and leave the stream to Push and IdleFlush, exactly as
// before it existed.
func TestDeadlineCut_InertWithoutARepeater(t *testing.T) {
	f := NewFragmenter(Config{Timescale: timescale, PartDuration: partDuration, SegmentDuration: segmentDuration})
	if _, err := pushOne(f, au(0, true)); err != nil {
		t.Fatal(err)
	}
	if out := f.DeadlineCut(10*partDuration, 0, false); out != nil {
		t.Fatalf("DeadlineCut published %d parts with no repeater", len(out))
	}
	if !f.HasPending() {
		t.Fatal("DeadlineCut emptied the fragmenter with no repeater")
	}
}

// Before the part's end nothing happens; past it, exactly one part per
// passed boundary, each exactly PartDuration, each starting where the
// previous one ended, and the fragmenter keeps holding a repeat frame.
func TestDeadlineCut_CutsEveryPassedBoundaryAtExactlyTheTarget(t *testing.T) {
	f, rep := clockCutFragmenter()
	if _, err := pushOne(f, au(0, true)); err != nil {
		t.Fatal(err)
	}
	if out := f.DeadlineCut(partDuration-1, 0, false); out != nil {
		t.Fatalf("cut %d parts before the part's end had passed", len(out))
	}

	tl := &timelineCheck{t: t}
	out := f.DeadlineCut(partDuration, 0, false)
	if len(out) != 1 {
		t.Fatalf("want one part at the first boundary, got %d", len(out))
	}
	tl.add(out[0])
	all := out
	out = f.DeadlineCut(3*partDuration+partDuration/2, 0, false)
	if len(out) != 2 {
		t.Fatalf("want the two parts whose ends have passed, got %d", len(out))
	}
	for _, frag := range out {
		tl.add(frag)
	}
	all = append(all, out...)
	for i, frag := range all {
		if frag.DurationTicks != partDuration {
			t.Fatalf("part %d lasts %d ticks, want exactly %d", i, frag.DurationTicks, partDuration)
		}
	}
	if !f.HasPending() {
		t.Fatal("the fragmenter should go on holding the last repeat frame")
	}
	if rep.frames != 3 {
		t.Fatalf("repeat frames = %d, want one opening each of the 3 parts after the first", rep.frames)
	}
	if out[1].StartTicks != 2*partDuration || out[1].StartTicks+int64(out[1].DurationTicks) != 3*partDuration {
		t.Fatalf("StartTicks/duration do not describe the part: start=%d dur=%d", out[1].StartTicks, out[1].DurationTicks)
	}

	// The frame that ends the gap arrives on its own clock, after what was
	// published: no shift, and its part starts where the last cut ended.
	next, err := f.Push(au(3*partDuration+partDuration/2+1000, false))
	if err != nil {
		t.Fatal(err)
	}
	if len(next) != 0 {
		t.Fatalf("the resuming frame closed %d parts mid-part", len(next))
	}
	if f.PTSOffset() != 0 {
		t.Fatalf("PTSOffset = %d after a frame that landed after the fill; the timeline was shifted for nothing", f.PTSOffset())
	}
	for pts := int64(3*partDuration + partDuration/2 + 1000 + frameStep); pts < 6*partDuration; pts += frameStep {
		frags, err := f.Push(au(pts, false))
		if err != nil {
			t.Fatal(err)
		}
		for _, frag := range frags {
			tl.add(frag)
		}
	}
}

// An access unit already being reassembled bounds the fill: nothing may
// be published at or past its timestamp, because that frame is on its way
// and would otherwise land behind media already published.
func TestDeadlineCut_StopsShortOfAFrameAlreadyArriving(t *testing.T) {
	f, _ := clockCutFragmenter()
	if _, err := pushOne(f, au(0, true)); err != nil {
		t.Fatal(err)
	}
	// Wall says two parts have passed, but a frame stamped 0.4s in is
	// mid-reassembly: not even the first boundary may be cut.
	if out := f.DeadlineCut(2*partDuration, partDuration*4/5, true); out != nil {
		t.Fatalf("cut %d parts past a frame that is still arriving", len(out))
	}
	// A frame stamped exactly ON the boundary is that frame's to close.
	if out := f.DeadlineCut(2*partDuration, partDuration, true); out != nil {
		t.Fatalf("cut %d parts up to a frame stamped on the boundary", len(out))
	}
	// A frame stamped past the first boundary lets that one go now.
	out := f.DeadlineCut(2*partDuration, partDuration+partDuration/2, true)
	if len(out) != 1 {
		t.Fatalf("want the one boundary before the arriving frame cut, got %d", len(out))
	}

	// And the arriving frame then lands on its own clock.
	if _, err := f.Push(au(partDuration+partDuration/2, false)); err != nil {
		t.Fatal(err)
	}
	if f.PTSOffset() != 0 {
		t.Fatalf("PTSOffset = %d: the fill covered the instant of a frame it was told about", f.PTSOffset())
	}
}

// When the grace is not enough (a frame delivered later than every bound
// the caller could see), the timeline still never rewinds: the frame is
// raised to just after what was published. This is the cost DeadlineCut's
// bounds exist to keep rare, and it must stay a shift, never corruption.
func TestDeadlineCut_ALateFrameShiftsTheTimelineRatherThanRewindingIt(t *testing.T) {
	f, _ := clockCutFragmenter()
	tl := &timelineCheck{t: t}
	if _, err := pushOne(f, au(0, true)); err != nil {
		t.Fatal(err)
	}
	for _, frag := range f.DeadlineCut(partDuration+partDuration/5, 0, false) {
		tl.add(frag)
	}
	late := int64(partDuration - 900) // captured 10ms before the cut boundary
	frags, err := f.Push(au(late, false))
	if err != nil {
		t.Fatal(err)
	}
	for _, frag := range frags {
		tl.add(frag)
	}
	if got, want := f.PTSOffset(), int64(partDuration)+minSampleTicks-late; got != want {
		t.Fatalf("PTSOffset = %d, want %d (the frame raised to just after the fill)", got, want)
	}
	for pts := late + frameStep; pts < 4*partDuration; pts += frameStep {
		frags, err := f.Push(au(pts, false))
		if err != nil {
			t.Fatal(err)
		}
		for _, frag := range frags {
			tl.add(frag)
		}
	}
}

// DeadlineCut must never close a segment: segments close only on an IDR.
func TestDeadlineCut_NeverClosesASegment(t *testing.T) {
	f, _ := clockCutFragmenter()
	if _, err := pushOne(f, au(0, true)); err != nil {
		t.Fatal(err)
	}
	out := f.DeadlineCut(3*segmentDuration, 0, false)
	if len(out) == 0 {
		t.Fatal("no parts cut across a long freeze")
	}
	for _, frag := range out {
		if frag.SegmentIndex != 0 {
			t.Fatalf("a deadline cut advanced the segment index to %d", frag.SegmentIndex)
		}
	}
}
