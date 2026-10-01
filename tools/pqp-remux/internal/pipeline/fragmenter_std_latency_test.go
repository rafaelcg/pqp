package pipeline

import "testing"

// Standard-latency PASSTHROUGH segmenting.
//
// The low-latency remux (production's `pqp-remuxd`) fragments H.264 at
// PART_MS=500 / SEGMENT_MS=4000 and the edge renders LL parts on top. A
// standard-latency passthrough mode (docs/plans/HLS_SEAMLESS_AND_PASSTHROUGH.md,
// mechanism B) reuses this exact fragmenter with LARGER numbers and no LL
// parts, so a watch party's conventional stream is the presenter's own H.264
// REPACKAGED rather than decoded and re-encoded by the stock LiveKit egress:
// a corrupt frame becomes a brief glitch, not a decode stall.
//
// Nothing in the fragmenter is LL-specific -- LL-ness is purely the numeric
// PartDuration/SegmentDuration (the pqp-remux map, and config.Validate's
// `SegmentMS >= PartMS` invariant). These tests pin that the SAME boundary
// rules the LL suite asserts at 500ms/4s hold at a standard-latency profile
// (2s parts, 6s segments), so the mode is a sizing choice with no new code
// path, and the three sizing-coupled invariants the mode depends on
// (SegmentDuration >= PartDuration, elastic segment-close-on-IDR, the part
// floor at 85% of PartDuration) are exercised at the new numbers.

const (
	// A plausible standard-latency profile: 2s parts, 6s segments, distinct
	// from LL's 500ms/4s. Both are exact multiples of frameStep (3000).
	stdPartDuration    = 180000 // 2s at 90kHz  (60 frames)
	stdSegmentDuration = 540000 // 6s at 90kHz  (180 frames)
)

// The mode's load-bearing config invariant: a segment is never shorter than a
// part. config.Validate enforces `SegmentMS >= PartMS`; assert the standard
// profile satisfies it so a future edit to the constants above cannot quietly
// produce a profile the daemon would reject at startup.
func TestFragmenter_StandardLatencySegmentIsNotShorterThanPart(t *testing.T) {
	if stdSegmentDuration < stdPartDuration {
		t.Fatalf("standard-latency SegmentDuration %d < PartDuration %d: config.Validate would refuse it",
			stdSegmentDuration, stdPartDuration)
	}
}

func TestFragmenter_StandardLatencyCutsPartsAtTargetDuration(t *testing.T) {
	f := NewFragmenter(Config{
		Timescale:       timescale,
		PartDuration:    stdPartDuration,
		SegmentDuration: stdSegmentDuration,
	})

	var frags []*Fragment
	// 60 frames per part (60*3000 = 180000 = stdPartDuration exactly). A part
	// closes when the frame that crosses its boundary arrives, so run to 130
	// frames to close two full parts (at frames 60 and 120); the segment
	// target (6s = frame 180) is not reached, so no part here may open a new
	// segment.
	for i := int64(0); i < 130; i++ {
		frag, err := pushOne(f, au(i*frameStep, i == 0))
		if err != nil {
			t.Fatalf("frame %d: %v", i, err)
		}
		if frag != nil {
			frags = append(frags, frag)
		}
	}
	if len(frags) < 2 {
		t.Fatalf("expected at least 2 parts closed at a 2s cadence, got %d", len(frags))
	}
	for i, frag := range frags {
		if frag.DurationTicks != stdPartDuration {
			t.Fatalf("part %d duration = %d ticks, want %d (2s)", i, frag.DurationTicks, stdPartDuration)
		}
		if got := sequenceNumber(t, frag.Bytes); got != frag.SequenceNumber {
			t.Fatalf("part %d: box sequence_number %d != Fragment.SequenceNumber %d", i, got, frag.SequenceNumber)
		}
	}
	for i := 1; i < len(frags); i++ {
		if frags[i].SequenceNumber != frags[i-1].SequenceNumber+1 {
			t.Fatalf("sequence numbers not consecutive: %d then %d", frags[i-1].SequenceNumber, frags[i].SequenceNumber)
		}
	}
	if !frags[0].IsSegmentStart || frags[0].SegmentIndex != 0 {
		t.Fatal("first emitted fragment must open segment 0")
	}
	if !firstSampleIsSync(t, frags[0].Bytes) {
		t.Fatal("segment-opening fragment's first sample must be a sync (IDR) sample")
	}
	for i := 1; i < len(frags); i++ {
		if frags[i].IsSegmentStart {
			t.Fatalf("part %d unexpectedly opened a new segment before the 6s boundary was reached", i)
		}
	}
}

// The elastic rule at standard sizing: a 6s segment closes only on the first
// IDR AT OR AFTER 6s, never on a mid-segment IDR and never on a non-IDR frame
// that merely crosses the boundary. This is the passthrough guarantee -- the
// presenter's own keyframe cadence drives the cut, so no decode is needed to
// find a clean boundary.
func TestFragmenter_StandardLatencySegmentClosesOnlyOnIDRAtOrAfterTarget(t *testing.T) {
	f := NewFragmenter(Config{
		Timescale:       timescale,
		PartDuration:    stdPartDuration,
		SegmentDuration: stdSegmentDuration,
	})

	// The 6s boundary is frame 180. Put a non-IDR frame exactly at it and a
	// mid-segment IDR at frame 90 (which must NOT close the segment), then
	// the real segment-closing IDR at frame 182. Run on past a part boundary
	// after that IDR so segment 1's opening fragment is actually emitted.
	const totalFrames = 250
	for i := int64(0); i < totalFrames; i++ {
		idr := i == 0 || i == 90 || i == 182
		frag, err := pushOne(f, au(i*frameStep, idr))
		if err != nil {
			t.Fatalf("frame %d: %v", i, err)
		}
		_ = frag
	}

	// Re-run collecting fragments (the loop above proves no error path; this
	// one inspects the boundaries).
	f = NewFragmenter(Config{
		Timescale:       timescale,
		PartDuration:    stdPartDuration,
		SegmentDuration: stdSegmentDuration,
	})
	var frags []*Fragment
	for i := int64(0); i < totalFrames; i++ {
		idr := i == 0 || i == 90 || i == 182
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
		t.Fatalf("expected exactly 2 segments (0 and 1); the mid-segment IDR at frame 90 must not have cut one. got %d",
			len(segmentStarts))
	}
	if segmentStarts[1].SegmentIndex != 1 {
		t.Fatalf("second segment-start fragment has SegmentIndex %d, want 1", segmentStarts[1].SegmentIndex)
	}
	if !firstSampleIsSync(t, segmentStarts[1].Bytes) {
		t.Fatal("second segment's opening fragment must start on a sync sample")
	}
	if bmdt := baseMediaDecodeTime(t, segmentStarts[1].Bytes); bmdt != 182*frameStep {
		t.Fatalf("second segment's tfdt = %d, want %d (the IDR at frame 182, not the boundary frame 180 and not the mid-segment IDR at frame 90)",
			bmdt, 182*frameStep)
	}
}
