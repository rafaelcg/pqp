package pipeline

import "testing"

// The static-source case, end to end at this layer: a source that stops
// sending access units (a Chrome TAB share of a page that is not
// repainting) used to close no further parts at all, because every part
// boundary in Push is decided by the arrival of the NEXT access unit.
// IdleFlush publishes the held one instead.
func TestFragmenter_IdleFlushPublishesTheHeldAccessUnit(t *testing.T) {
	f := NewFragmenter(Config{Timescale: timescale, PartDuration: partDuration, SegmentDuration: segmentDuration})

	if _, err := f.Push(au(0, true)); err != nil {
		t.Fatalf("first IDR: %v", err)
	}
	// Two more frames, still inside the first part.
	for i := int64(1); i <= 2; i++ {
		if frag, err := f.Push(au(i*frameStep, false)); err != nil || frag != nil {
			t.Fatalf("frame %d: frag=%v err=%v", i, frag, err)
		}
	}

	// Nothing has arrived since. Not yet a part's worth of silence.
	if frag := f.IdleFlush(partDuration / 2); frag != nil {
		t.Fatalf("IdleFlush closed a part before the part target elapsed: %+v", frag)
	}
	if !f.HasPending() {
		t.Fatal("the held access unit should still be pending")
	}

	// A full part's worth of silence: publish what we have.
	held := int64(partDuration)
	frag := f.IdleFlush(held)
	if frag == nil {
		t.Fatal("IdleFlush produced no part after a full part target of silence")
	}
	if f.HasPending() {
		t.Fatal("the held access unit should have been published, not still pending")
	}
	// The part spans from the part's start to the moment of the flush:
	// two ordinary frame gaps plus the silence.
	wantDuration := uint32(2*frameStep + held)
	if frag.DurationTicks != wantDuration {
		t.Fatalf("part duration = %d ticks, want %d", frag.DurationTicks, wantDuration)
	}
	if frag.IsSegmentStart != true {
		t.Fatal("the first part of the session's first segment is still a segment start")
	}

	// A second tick with nothing new must not invent a second part: one
	// access unit is published exactly once.
	if again := f.IdleFlush(held); again != nil {
		t.Fatalf("a second IdleFlush with nothing new published another part: %+v", again)
	}
}

// The resume half: the publisher starts sending again. The next part must
// begin exactly where the flushed one ended -- never before it (a tfdt
// going backwards is a corrupt stream) and never after it (a hole).
func TestFragmenter_ResumeAfterIdleFlushIsContinuous(t *testing.T) {
	f := NewFragmenter(Config{Timescale: timescale, PartDuration: partDuration, SegmentDuration: segmentDuration})

	if _, err := f.Push(au(0, true)); err != nil {
		t.Fatalf("first IDR: %v", err)
	}
	const held = int64(partDuration + 7000) // a little past the target, as a real tick would be
	flushed := f.IdleFlush(held)
	if flushed == nil {
		t.Fatal("IdleFlush produced no part")
	}
	flushedEnd := baseMediaDecodeTime(t, flushed.Bytes) + uint64(flushed.DurationTicks)

	// The publisher resumes. Its own RTP clock says the gap was slightly
	// different from our wall-clock estimate (it always will be); the
	// fragmenter must absorb that, not propagate it.
	resumePTS := held - 900 // 10ms of estimate error, in the "we guessed long" direction
	if frag, err := f.Push(au(resumePTS, false)); err != nil || frag != nil {
		t.Fatalf("resume frame: frag=%v err=%v", frag, err)
	}
	// Fill the next part.
	var next *Fragment
	for i := int64(1); next == nil && i < 100; i++ {
		frag, err := f.Push(au(resumePTS+i*frameStep, false))
		if err != nil {
			t.Fatalf("frame %d after resume: %v", i, err)
		}
		next = frag
	}
	if next == nil {
		t.Fatal("no part closed after the source resumed")
	}
	if got := baseMediaDecodeTime(t, next.Bytes); got != flushedEnd {
		t.Fatalf("the part after an idle flush starts at %d, want %d (exactly where the flushed part ended)", got, flushedEnd)
	}
	if next.SequenceNumber != flushed.SequenceNumber+1 {
		t.Fatalf("sequence numbers are not contiguous across an idle flush: %d then %d", flushed.SequenceNumber, next.SequenceNumber)
	}
}

// A source that resumes EARLIER than the wall clock said it would must
// still never rewind the timeline.
func TestFragmenter_ResumeEarlierThanEstimatedDoesNotRewind(t *testing.T) {
	f := NewFragmenter(Config{Timescale: timescale, PartDuration: partDuration, SegmentDuration: segmentDuration})

	if _, err := f.Push(au(0, true)); err != nil {
		t.Fatalf("first IDR: %v", err)
	}
	const held = int64(2 * partDuration)
	flushed := f.IdleFlush(held)
	if flushed == nil {
		t.Fatal("IdleFlush produced no part")
	}
	flushedEnd := baseMediaDecodeTime(t, flushed.Bytes) + uint64(flushed.DurationTicks)

	// The publisher's own clock says only a third of that elapsed.
	if _, err := f.Push(au(held/3, false)); err != nil {
		t.Fatalf("resume frame: %v", err)
	}
	var next *Fragment
	for i := int64(1); next == nil && i < 100; i++ {
		frag, err := f.Push(au(held/3+i*frameStep, false))
		if err != nil {
			t.Fatalf("frame %d after resume: %v", i, err)
		}
		next = frag
	}
	if next == nil {
		t.Fatal("no part closed after the source resumed")
	}
	if got := baseMediaDecodeTime(t, next.Bytes); got != flushedEnd {
		t.Fatalf("tfdt after an early resume = %d, want %d (never behind the published part)", got, flushedEnd)
	}
}

// IdleFlush must be inert before the session's first IDR: there is no
// timeline to hold yet, and nothing before the first keyframe may be
// published at all (ErrWaitingForIDR's own rule).
func TestFragmenter_IdleFlushBeforeFirstIDRIsInert(t *testing.T) {
	f := NewFragmenter(Config{Timescale: timescale, PartDuration: partDuration, SegmentDuration: segmentDuration})

	if _, err := f.Push(au(0, false)); err != ErrWaitingForIDR {
		t.Fatal("expected ErrWaitingForIDR")
	}
	if frag := f.IdleFlush(10 * partDuration); frag != nil {
		t.Fatalf("IdleFlush published a part before the first IDR: %+v", frag)
	}
	if f.HasPending() {
		t.Fatal("nothing is pending before the first IDR")
	}
}

// A segment still closes only on an IDR at or past the segment target,
// even when an idle flush happened in between: the plan's "never close a
// segment on a non-IDR boundary" rule is not softened by this path.
func TestFragmenter_IdleFlushNeverClosesASegment(t *testing.T) {
	f := NewFragmenter(Config{Timescale: timescale, PartDuration: partDuration, SegmentDuration: segmentDuration})

	if _, err := f.Push(au(0, true)); err != nil {
		t.Fatalf("first IDR: %v", err)
	}
	// Idle for well past a whole segment.
	frag := f.IdleFlush(2 * segmentDuration)
	if frag == nil {
		t.Fatal("IdleFlush produced no part")
	}
	if frag.SegmentIndex != 0 {
		t.Fatalf("idle flush advanced the segment index to %d", frag.SegmentIndex)
	}
	if f.CurrentSegmentIndex() != 0 {
		t.Fatalf("segment index is %d after an idle flush, want 0", f.CurrentSegmentIndex())
	}

	// The next IDR, past the segment target, is what closes segment 0.
	resume := int64(2 * segmentDuration)
	if _, err := f.Push(au(resume, false)); err != nil {
		t.Fatalf("resume: %v", err)
	}
	next, err := f.Push(au(resume+segmentDuration, true))
	if err != nil {
		t.Fatalf("IDR past the segment target: %v", err)
	}
	if next == nil {
		t.Fatal("the IDR past the segment target closed no part")
	}
	if f.CurrentSegmentIndex() != 1 {
		t.Fatalf("segment index is %d after the IDR, want 1", f.CurrentSegmentIndex())
	}
}

// A freeze can outlast the segment target. When the frame that ends it is
// an IDR, that IDR starts the next segment -- the ordinary Push branch
// cannot do it, because it judges the access unit AFTER the pending one,
// and waiting for the IDR after the next one is how EXT-X-TARGETDURATION
// creeps upward across a party.
func TestFragmenter_IdrEndingALongFreezeStartsTheNextSegment(t *testing.T) {
	f := NewFragmenter(Config{Timescale: timescale, PartDuration: partDuration, SegmentDuration: segmentDuration})

	if _, err := f.Push(au(0, true)); err != nil {
		t.Fatalf("first IDR: %v", err)
	}
	// Frozen for longer than a whole segment.
	if frag := f.IdleFlush(segmentDuration + partDuration); frag == nil {
		t.Fatal("IdleFlush produced no part")
	}
	if f.CurrentSegmentIndex() != 0 {
		t.Fatalf("the flush itself advanced the segment index to %d", f.CurrentSegmentIndex())
	}

	// The source comes back with a keyframe.
	resume := int64(segmentDuration + partDuration)
	if _, err := f.Push(au(resume, true)); err != nil {
		t.Fatalf("resume IDR: %v", err)
	}
	if f.CurrentSegmentIndex() != 1 {
		t.Fatalf("segment index is %d after an IDR ended a freeze past the segment target, want 1", f.CurrentSegmentIndex())
	}

	var next *Fragment
	for i := int64(1); next == nil && i < 100; i++ {
		frag, err := f.Push(au(resume+i*frameStep, false))
		if err != nil {
			t.Fatalf("frame %d after resume: %v", i, err)
		}
		next = frag
	}
	if next == nil {
		t.Fatal("no part closed after the source resumed")
	}
	if !next.IsSegmentStart {
		t.Fatal("the first part after the resuming IDR does not start its segment")
	}
	if next.SegmentIndex != 1 {
		t.Fatalf("the first part after the resume is in segment %d, want 1", next.SegmentIndex)
	}
	if !firstSampleIsSync(t, next.Bytes) {
		t.Fatal("the segment-starting part's first sample is not a sync sample")
	}

	// A freeze that does NOT reach the segment target leaves the segment
	// where it is, even when an IDR ends it.
	short := NewFragmenter(Config{Timescale: timescale, PartDuration: partDuration, SegmentDuration: segmentDuration})
	if _, err := short.Push(au(0, true)); err != nil {
		t.Fatalf("first IDR: %v", err)
	}
	if frag := short.IdleFlush(partDuration); frag == nil {
		t.Fatal("IdleFlush produced no part")
	}
	if _, err := short.Push(au(partDuration, true)); err != nil {
		t.Fatalf("resume IDR: %v", err)
	}
	if short.CurrentSegmentIndex() != 0 {
		t.Fatalf("a short freeze advanced the segment index to %d", short.CurrentSegmentIndex())
	}
}
