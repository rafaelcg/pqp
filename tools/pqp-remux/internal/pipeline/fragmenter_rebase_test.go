package pipeline

import "testing"

// A NEW PUBLISHER CLOCK, MID-SESSION. The presenter republished their screen:
// the next access units carry PTS from a fresh depacketizer, counting from
// zero again. RebaseSource puts that clock where it belongs on the session
// timeline, and the fragmenter carries on: same part numbering, the next IDR
// opens a new segment, the timeline neither rewinds nor gains a hole.

func TestFragmenter_RebaseSourceContinuesTheTimeline(t *testing.T) {
	for _, tc := range []struct {
		name string
		// where the new source's PTS zero lands, relative to where the old
		// source's last frame was
		landAfter int64
	}{
		{"new clock lands after the old one (the ordinary gap)", 90000},
		{"new clock lands BEHIND published media (must not rewind)", -60000},
	} {
		t.Run(tc.name, func(t *testing.T) {
			f := NewFragmenter(Config{Timescale: timescale, PartDuration: partDuration, SegmentDuration: segmentDuration})
			f.SetTimelineOffset(1000)
			var out []*Fragment
			push := func(pts int64, idr bool) {
				frags, err := f.Push(au(pts, idr))
				if err != nil && err != ErrWaitingForIDR {
					t.Fatal(err)
				}
				out = append(out, frags...)
			}
			// Old source: 5 s, IDR every second.
			var last int64
			for i := 0; i < 150; i++ {
				last = int64(i * frameStep)
				push(last, i%30 == 0)
			}
			segBefore := f.CurrentSegmentIndex()
			seqBefore := f.CurrentSequence()

			// New source: its raw clock starts at 0 again.
			f.RebaseSource(1000 + last + tc.landAfter)
			for i := 0; i < 90; i++ {
				push(int64(i*frameStep), i%30 == 0)
			}

			if f.CurrentSequence() <= seqBefore {
				t.Fatal("no part after the rebase")
			}
			for i := 1; i < len(out); i++ {
				if out[i].SequenceNumber != out[i-1].SequenceNumber+1 {
					t.Fatalf("part numbering jumps %d -> %d", out[i-1].SequenceNumber, out[i].SequenceNumber)
				}
				end := out[i-1].StartTicks + int64(out[i-1].DurationTicks)
				if out[i].StartTicks != end {
					t.Fatalf("part %d starts at %d, the one before ended at %d", out[i].SequenceNumber, out[i].StartTicks, end)
				}
			}
			// The first part after the rebase opens a new segment on the new
			// source's keyframe.
			for _, fr := range out {
				if fr.SequenceNumber == seqBefore+2 {
					if !fr.IsSegmentStart || fr.SegmentIndex != segBefore+1 || !fr.Independent {
						t.Fatalf("new source's first part: %+v, want a segment start at %d on a keyframe", fr, segBefore+1)
					}
				}
			}
		})
	}
}
