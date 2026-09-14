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
