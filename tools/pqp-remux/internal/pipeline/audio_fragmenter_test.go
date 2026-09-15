package pipeline

import "testing"

const (
	audioTimescale = 48000
	// aacFrameTicks is aacenc.SamplesPerFrame: one AAC-LC frame is 1024
	// samples, 21.33ms at 48kHz. Repeated here rather than imported to
	// keep pipeline a leaf package.
	aacFrameTicks = 1024
)

func msTicks(ms int) uint32 { return uint32(ms * audioTimescale / 1000) }

func ceilDiv(a, b int) int { return (a + b - 1) / b }

func TestAudioFragmenterFirstFrameOpensSegment0WithoutClosingAPart(t *testing.T) {
	f := NewAudioFragmenter(AudioConfig{Timescale: audioTimescale, PartDuration: msTicks(500), SegmentDuration: msTicks(4000)})
	if frag := f.Push(0, aacFrameTicks, []byte{1, 2, 3}); frag != nil {
		t.Fatalf("one 21ms frame closed a part against a 500ms target: %+v", frag)
	}
	if got := f.CurrentSequence(); got != 0 {
		t.Fatalf("CurrentSequence = %d, want 0 before any part is closed", got)
	}
	if got := f.CurrentSegmentIndex(); got != 0 {
		t.Fatalf("CurrentSegmentIndex = %d, want 0", got)
	}
}

func TestAudioFragmenterFirstClosedPartStartsSegment0(t *testing.T) {
	f := NewAudioFragmenter(AudioConfig{Timescale: audioTimescale, PartDuration: msTicks(500), SegmentDuration: msTicks(4000)})
	var frag *Fragment
	var pts int64
	for i := 0; i < 64 && frag == nil; i++ {
		frag = f.Push(pts, aacFrameTicks, []byte{byte(i)})
		pts += aacFrameTicks
	}
	if frag == nil {
		t.Fatal("no part closed within 64 frames of a 500ms target")
	}
	if !frag.IsSegmentStart {
		t.Fatal("the first part must start segment 0")
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
	f := NewAudioFragmenter(AudioConfig{Timescale: audioTimescale, PartDuration: aacFrameTicks, SegmentDuration: msTicks(4000)})
	f.SetStartSegmentIndex(9)

	frag := f.Push(0, aacFrameTicks, []byte{1, 2, 3})
	if frag == nil {
		t.Fatal("a one-frame part target must close a part on the first frame")
	}
	if frag.SegmentIndex != 9 {
		t.Fatalf("SegmentIndex = %d, want 9", frag.SegmentIndex)
	}
	if !frag.IsSegmentStart {
		t.Fatal("the first part must still be a segment start")
	}
	if got := f.CurrentSegmentIndex(); got != 9 {
		t.Fatalf("expected CurrentSegmentIndex to report 9, got %d", got)
	}
}

// TestAudioFragmenterPartsAreSizedByPartTarget is the regression test for
// the 2026-09-15 production incident (see AudioConfig's doc comment): the
// audio rendition advertised one part per AAC frame, ~48 a second, and
// hls.js never left "stalled, reconnecting". It is a table because the
// cadence has to hold at more than one PART_MS -- 200ms is the other
// value docs/plans/LL_HLS.md contemplates -- and because the interesting
// arithmetic (a 21.33ms granule divides neither 500ms nor 200ms evenly)
// is the same shape at both.
func TestAudioFragmenterPartsAreSizedByPartTarget(t *testing.T) {
	cases := []struct {
		name      string
		partMs    int
		segmentMs int
		// wantPartsPerSecond is what the rendition's part numbering must
		// advance at, within a part of slack for the frame granule.
		wantPartsPerSecond float64
	}{
		{name: "500ms parts, 4s segments", partMs: 500, segmentMs: 4000, wantPartsPerSecond: 2},
		{name: "200ms parts, 4s segments", partMs: 200, segmentMs: 4000, wantPartsPerSecond: 5},
		{name: "500ms parts, 2s segments", partMs: 500, segmentMs: 2000, wantPartsPerSecond: 2},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			partTicks := msTicks(tc.partMs)
			segmentTicks := msTicks(tc.segmentMs)
			f := NewAudioFragmenter(AudioConfig{Timescale: audioTimescale, PartDuration: partTicks, SegmentDuration: segmentTicks})

			// Ten seconds of audio.
			const seconds = 10
			totalFrames := seconds * audioTimescale / aacFrameTicks

			var pts int64
			var parts []*Fragment
			for i := 0; i < totalFrames; i++ {
				if frag := f.Push(pts, aacFrameTicks, []byte{byte(i)}); frag != nil {
					parts = append(parts, frag)
				}
				pts += aacFrameTicks
			}

			if len(parts) == 0 {
				t.Fatal("no parts at all")
			}

			gotPerSecond := float64(len(parts)) / float64(seconds)
			if gotPerSecond < tc.wantPartsPerSecond*0.8 || gotPerSecond > tc.wantPartsPerSecond*1.25 {
				t.Fatalf("%.2f parts/s, want about %.2f (per-AAC-frame parts would be ~46.9)", gotPerSecond, tc.wantPartsPerSecond)
			}

			// Every part is cut on a frame boundary and never runs more
			// than one frame past the target -- except a part the
			// SEGMENT boundary closed early, which is legal and
			// deliberate (a part may not straddle two segments).
			for i, p := range parts {
				if p.DurationTicks%aacFrameTicks != 0 {
					t.Fatalf("part %d duration %d ticks is not a whole number of AAC frames", i, p.DurationTicks)
				}
				endsSegment := i+1 < len(parts) && parts[i+1].IsSegmentStart
				if endsSegment {
					continue
				}
				if p.DurationTicks < partTicks {
					t.Fatalf("part %d is %d ticks, under the %d-tick target without closing a segment", i, p.DurationTicks, partTicks)
				}
				if uint64(p.DurationTicks) >= uint64(partTicks)+aacFrameTicks {
					t.Fatalf("part %d is %d ticks, more than one frame past the %d-tick target", i, p.DurationTicks, partTicks)
				}
			}

			// Parts never straddle a segment, and a segment holds the
			// number of parts its own duration implies -- the same
			// order of magnitude as the video rendition's, which is the
			// property the incident violated (69 audio parts per
			// segment against video's 6).
			perSegment := map[int]int{}
			for _, p := range parts {
				perSegment[p.SegmentIndex]++
			}
			// The expected count is arithmetic on the real granule, not
			// on the nominal targets: a part is ceil(partTicks/1024)
			// frames long and a segment ceil(segmentTicks/1024), so a
			// 200ms part is really 213ms and a 4s segment really holds
			// 19 of them, not 20.
			partFrames := ceilDiv(int(partTicks), aacFrameTicks)
			segmentFrames := ceilDiv(int(segmentTicks), aacFrameTicks)
			wantPerSegment := ceilDiv(segmentFrames, partFrames)
			for idx, n := range perSegment {
				if idx == parts[0].SegmentIndex || idx == parts[len(parts)-1].SegmentIndex {
					continue // partial segments at either end of the window
				}
				if n < wantPerSegment-1 || n > wantPerSegment+1 {
					t.Fatalf("segment %d holds %d parts, want about %d", idx, n, wantPerSegment)
				}
			}
		})
	}
}

// A segment boundary closes the open part even when it is not full: a
// part may never straddle two segments, which is the rule the video
// fragmenter's "Branch A" already applies.
func TestAudioFragmenterSegmentBoundaryClosesAnUnfullPart(t *testing.T) {
	partTicks := msTicks(500)
	segmentTicks := msTicks(4000)
	f := NewAudioFragmenter(AudioConfig{Timescale: audioTimescale, PartDuration: partTicks, SegmentDuration: segmentTicks})

	var pts int64
	var parts []*Fragment
	for i := 0; i < 400; i++ {
		if frag := f.Push(pts, aacFrameTicks, []byte{byte(i)}); frag != nil {
			parts = append(parts, frag)
		}
		pts += aacFrameTicks
	}

	var starts []int
	for i, p := range parts {
		if p.IsSegmentStart {
			starts = append(starts, i)
		}
	}
	if len(starts) < 2 {
		t.Fatalf("expected at least 2 segment starts over 8.5s at a 4s target, got %v", starts)
	}
	for i := 1; i < len(starts); i++ {
		var ticks uint64
		for _, p := range parts[starts[i-1]:starts[i]] {
			ticks += uint64(p.DurationTicks)
		}
		if ticks < uint64(segmentTicks) {
			t.Fatalf("segment %d closed after only %d ticks, want >= %d", i, ticks, segmentTicks)
		}
		if ticks >= uint64(segmentTicks)+aacFrameTicks {
			t.Fatalf("segment %d closed %d ticks past the target, more than one frame of slack", i, ticks-uint64(segmentTicks))
		}
	}
}

func TestAudioFragmenterSequenceNumbersIncreaseMonotonically(t *testing.T) {
	f := NewAudioFragmenter(AudioConfig{Timescale: audioTimescale, PartDuration: msTicks(500), SegmentDuration: msTicks(4000)})
	var pts int64
	var want uint32
	for i := 0; i < 2000; i++ {
		frag := f.Push(pts, aacFrameTicks, []byte{0})
		pts += aacFrameTicks
		if frag == nil {
			continue
		}
		want++
		if frag.SequenceNumber != want {
			t.Fatalf("part %d: SequenceNumber = %d, want %d", i, frag.SequenceNumber, want)
		}
	}
	if want == 0 {
		t.Fatal("no parts closed")
	}
}

// #621's rule, now that parts batch: a replacement pipeline must not hand
// out part names its predecessor already used, because the edge Worker
// caches `audio-part-<seq>.m4s` by path alone.
func TestAudioFragmenterPartNumberingIsMonotonicAcrossARestart(t *testing.T) {
	cfg := AudioConfig{Timescale: audioTimescale, PartDuration: msTicks(500), SegmentDuration: msTicks(4000)}

	first := NewAudioFragmenter(cfg)
	var pts int64
	for i := 0; i < 300; i++ {
		first.Push(pts, aacFrameTicks, []byte{byte(i)})
		pts += aacFrameTicks
	}
	// The tail the watchdog would otherwise lose: Flush is what makes it
	// part of the record, and it must still take the next number.
	lastBeforeRestart := first.CurrentSequence()
	if flushed := first.Flush(); flushed != nil {
		if flushed.SequenceNumber != lastBeforeRestart+1 {
			t.Fatalf("flushed part = %d, want %d", flushed.SequenceNumber, lastBeforeRestart+1)
		}
		lastBeforeRestart = flushed.SequenceNumber
	}
	if first.Flush() != nil {
		t.Fatal("a second Flush produced a second part out of nothing")
	}

	second := NewAudioFragmenter(cfg)
	second.SetStartSegmentIndex(first.CurrentSegmentIndex())
	second.SetStartSequence(lastBeforeRestart + 1)

	// Resumed ten minutes in, exactly as a real restart would be.
	pts = int64(audioTimescale) * 600
	var resumed *Fragment
	for i := 0; i < 64 && resumed == nil; i++ {
		resumed = second.Push(pts, aacFrameTicks, []byte{byte(i)})
		pts += aacFrameTicks
	}
	if resumed == nil {
		t.Fatal("the replacement closed no part")
	}
	if resumed.SequenceNumber != lastBeforeRestart+1 {
		t.Fatalf("replacement's first part = %d, want %d (a reused name is served from the predecessor's cache entry)", resumed.SequenceNumber, lastBeforeRestart+1)
	}
	if resumed.SegmentIndex != first.CurrentSegmentIndex() {
		t.Fatalf("replacement's first segment = %d, want %d", resumed.SegmentIndex, first.CurrentSegmentIndex())
	}
}

// A resumed pipeline's counters are not at zero, and the first segment's
// anchor must still be set by the first frame -- the anchor test used to
// be "both counters are still at zero", which silently failed for every
// watchdog restart that resumed either one, leaving segmentStart at 0 so
// the very first frame rolled the segment immediately.
func TestAudioFragmenter_ResumedCountersStillAnchorTheFirstSegment(t *testing.T) {
	f := NewAudioFragmenter(AudioConfig{Timescale: audioTimescale, PartDuration: aacFrameTicks, SegmentDuration: audioTimescale}) // 1s segments, one frame per part
	f.SetStartSegmentIndex(7)
	f.SetStartSequence(31)

	basePTS := int64(audioTimescale * 600) // ten minutes in, as a restarted session would be

	firstPart := f.Push(basePTS, aacFrameTicks, []byte{0x01})
	if firstPart.SequenceNumber != 31 {
		t.Fatalf("first resumed part = %d, want 31", firstPart.SequenceNumber)
	}
	if firstPart.SegmentIndex != 7 {
		t.Fatalf("first resumed segment = %d, want 7", firstPart.SegmentIndex)
	}
	// One frame is 1024/48000 s, nowhere near the 1s target: the segment
	// must still be open. Before the anchor fix this had already rolled.
	second := f.Push(basePTS+aacFrameTicks, aacFrameTicks, []byte{0x02})
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

// A zero PartDuration must not mean "a part per frame" -- that is exactly
// the shape the incident had. One part per segment is dull and playable.
func TestAudioFragmenterZeroPartTargetFallsBackToTheSegmentTarget(t *testing.T) {
	segmentTicks := msTicks(4000)
	f := NewAudioFragmenter(AudioConfig{Timescale: audioTimescale, SegmentDuration: segmentTicks})

	var pts int64
	var parts []*Fragment
	for i := 0; i < 400; i++ {
		if frag := f.Push(pts, aacFrameTicks, []byte{byte(i)}); frag != nil {
			parts = append(parts, frag)
		}
		pts += aacFrameTicks
	}
	if len(parts) == 0 {
		t.Fatal("no parts at all")
	}
	if len(parts) > 3 {
		t.Fatalf("%d parts over 8.5s at a 4s fallback target: the zero value did not fall back", len(parts))
	}
	for _, p := range parts {
		if !p.IsSegmentStart {
			t.Fatal("with one part per segment, every part opens its segment")
		}
	}
}

// Flush drains the part still accumulating. Without it, up to PART_MS of
// already-encoded audio dies with the session -- a tail that simply did
// not exist while every frame was its own part.
func TestAudioFragmenterFlushEmitsThePendingPart(t *testing.T) {
	f := NewAudioFragmenter(AudioConfig{Timescale: audioTimescale, PartDuration: msTicks(500), SegmentDuration: msTicks(4000)})
	if f.Flush() != nil {
		t.Fatal("Flush on an untouched fragmenter produced a part")
	}

	var pts int64
	for i := 0; i < 5; i++ { // ~107ms, well under the 500ms target
		if frag := f.Push(pts, aacFrameTicks, []byte{byte(i)}); frag != nil {
			t.Fatal("a part closed early")
		}
		pts += aacFrameTicks
	}

	frag := f.Flush()
	if frag == nil {
		t.Fatal("Flush dropped five buffered frames")
	}
	if frag.DurationTicks != 5*aacFrameTicks {
		t.Fatalf("flushed part is %d ticks, want %d", frag.DurationTicks, 5*aacFrameTicks)
	}
	if !frag.IsSegmentStart {
		t.Fatal("the session's first part opens segment 0 even when it is a flush")
	}
	if f.Flush() != nil {
		t.Fatal("a second Flush produced a second part")
	}
}
