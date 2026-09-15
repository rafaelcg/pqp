package pipeline

import "testing"

func TestAudioFragmenterFirstFrameStartsSegment0(t *testing.T) {
	f := NewAudioFragmenter(AudioConfig{Timescale: 48000, SegmentDuration: 4 * 48000})
	frag := f.Push(0, 1024, []byte{1, 2, 3})
	if frag == nil {
		t.Fatal("expected a fragment, got nil")
	}
	if !frag.IsSegmentStart {
		t.Fatal("the first frame must start segment 0")
	}
	if frag.SegmentIndex != 0 {
		t.Fatalf("SegmentIndex = %d, want 0", frag.SegmentIndex)
	}
	if frag.SequenceNumber != 1 {
		t.Fatalf("SequenceNumber = %d, want 1", frag.SequenceNumber)
	}
}

// TestAudioFragmenterSetStartSegmentIndexAppliesToFirstSegment is the
// audio counterpart of the video fragmenter's own regression test (Farol
// review, PR #584): a watchdog restart must continue the audio track's
// segment numbering too, so its R2 object keys never collide with a
// stalled predecessor's.
func TestAudioFragmenterSetStartSegmentIndexAppliesToFirstSegment(t *testing.T) {
	f := NewAudioFragmenter(AudioConfig{Timescale: 48000, SegmentDuration: 4 * 48000})
	f.SetStartSegmentIndex(9)

	frag := f.Push(0, 1024, []byte{1, 2, 3})
	if frag.SegmentIndex != 9 {
		t.Fatalf("SegmentIndex = %d, want 9", frag.SegmentIndex)
	}
	if !frag.IsSegmentStart {
		t.Fatal("the first frame must still be a segment start")
	}
	if got := f.CurrentSegmentIndex(); got != 9 {
		t.Fatalf("expected CurrentSegmentIndex to report 9, got %d", got)
	}
}

func TestAudioFragmenterCutsOnSchedule(t *testing.T) {
	const timescale = 48000
	const frameSamples = 1024
	const segmentDuration = 4 * timescale // 4s

	f := NewAudioFragmenter(AudioConfig{Timescale: timescale, SegmentDuration: segmentDuration})

	var pts int64
	var segmentStarts []int
	for i := 0; i < 400; i++ { // 400*1024/48000 ~= 8.5s, spans 2-3 segments
		frag := f.Push(pts, frameSamples, []byte{byte(i)})
		if frag.IsSegmentStart {
			segmentStarts = append(segmentStarts, i)
		}
		pts += frameSamples
	}

	if len(segmentStarts) < 2 {
		t.Fatalf("expected at least 2 segment starts over 8.5s of audio at a 4s target, got %v", segmentStarts)
	}
	if segmentStarts[0] != 0 {
		t.Fatalf("first segment must start at frame 0, got %d", segmentStarts[0])
	}

	// Each segment boundary after the first must land at or after the 4s
	// target and not absurdly late (within one frame's worth of slack,
	// since frameSamples does not evenly divide segmentDuration).
	for i := 1; i < len(segmentStarts); i++ {
		elapsedFrames := segmentStarts[i] - segmentStarts[i-1]
		elapsedTicks := int64(elapsedFrames) * frameSamples
		if elapsedTicks < segmentDuration {
			t.Fatalf("segment %d closed after only %d ticks, want >= %d", i, elapsedTicks, segmentDuration)
		}
		if elapsedTicks >= segmentDuration+frameSamples {
			t.Fatalf("segment %d closed %d ticks after the target, more than one frame of slack", i, elapsedTicks-segmentDuration)
		}
	}
}

func TestAudioFragmenterSequenceNumbersIncreaseMonotonically(t *testing.T) {
	f := NewAudioFragmenter(AudioConfig{Timescale: 48000, SegmentDuration: 4 * 48000})
	var pts int64
	for i := 0; i < 50; i++ {
		frag := f.Push(pts, 1024, []byte{0})
		if frag.SequenceNumber != uint32(i+1) {
			t.Fatalf("frame %d: SequenceNumber = %d, want %d", i, frag.SequenceNumber, i+1)
		}
		pts += 1024
	}
}

// A resumed pipeline's counters are not at zero, and the first segment's
// anchor must still be set by the first frame -- the anchor test used to
// be "both counters are still at zero", which silently failed for every
// watchdog restart that resumed either one, leaving segmentStart at 0 so
// the very first frame rolled the segment immediately.
func TestAudioFragmenter_ResumedCountersStillAnchorTheFirstSegment(t *testing.T) {
	f := NewAudioFragmenter(AudioConfig{Timescale: 48000, SegmentDuration: 48000}) // 1s segments
	f.SetStartSegmentIndex(7)
	f.SetStartSequence(31)

	const frameTicks = 1024
	basePTS := int64(48000 * 600) // ten minutes in, as a restarted session would be

	first := f.Push(basePTS, frameTicks, []byte{0x01})
	if first.SequenceNumber != 31 {
		t.Fatalf("first resumed part = %d, want 31", first.SequenceNumber)
	}
	if first.SegmentIndex != 7 {
		t.Fatalf("first resumed segment = %d, want 7", first.SegmentIndex)
	}
	// One frame is 1024/48000 s, nowhere near the 1s target: the segment
	// must still be open. Before the anchor fix this had already rolled.
	second := f.Push(basePTS+frameTicks, frameTicks, []byte{0x02})
	if second.SegmentIndex != 7 {
		t.Fatalf("segment rolled after one 21ms frame (index %d): the first segment was never anchored", second.SegmentIndex)
	}
	if second.IsSegmentStart {
		t.Fatal("the second frame must not open a segment")
	}
	if got := f.CurrentSequence(); got != 32 {
		t.Fatalf("CurrentSequence = %d, want 32", got)
	}
}
