package film

import "math"

// Span is one group's place on its track's RAW clock (the tfdt the box
// wrote), in seconds.
type Span struct {
	Start float64
	End   float64
}

// restartTolerance is how far a group may start before the previous one
// ended and still be the same clock. Parts and segments are cut on frame
// boundaries and the playlist's EXTINF is rounded to milliseconds, so two
// adjacent groups can overlap by a frame or two; a watchdog restart starts
// the clock over from zero, which is minutes or hours backwards.
const restartTolerance = 1.0

// epochs assigns every span an epoch number: the index of the clock it runs
// on. A new epoch starts whenever time goes backwards by more than
// restartTolerance, which is what a watchdog restart does to both tracks
// (internal/r2.VodIndex: "its timestamps restart"). An init change on its
// own (a resolution change) keeps the clock and stays in the same epoch.
func epochs(spans []Span) []int {
	out := make([]int, len(spans))
	epoch := 0
	for i := range spans {
		if i > 0 && spans[i].Start < spans[i-1].End-restartTolerance {
			epoch++
		}
		out[i] = epoch
	}
	return out
}

type epochRange struct {
	start float64
	end   float64
}

func epochRanges(spans []Span, ep []int) []epochRange {
	var out []epochRange
	for i, s := range spans {
		if ep[i] == len(out) {
			out = append(out, epochRange{start: s.Start, end: s.End})
			continue
		}
		r := &out[ep[i]]
		r.start = math.Min(r.start, s.Start)
		r.end = math.Max(r.end, s.End)
	}
	return out
}

// Offsets returns, for each video span and each audio span, the seconds to
// ADD to its raw time to put it on the film's one timeline.
//
// Epoch 0 is left where it is: that is the clock both tracks were anchored to
// at the session's start (the #787 PROGRAM-DATE-TIME work put video on the
// audio's epoch), so the A/V offset it encodes is real and is kept. Every
// later epoch is moved so that its earliest track starts where the previous
// epoch's latest track ended, by ONE shift applied to both tracks, which keeps
// the offset between them inside the new epoch exactly as the box wrote it.
// What that loses is the wall-clock gap the restart itself took, which is a
// second or two of nothing, on both tracks at once.
//
// When the two tracks disagree on how many epochs there were (a restart one
// of them did not see), there is no shared clock to trust, and each track is
// laid end to end on its own instead: in sync up to that point, and off by
// at most the restart gap after it.
func Offsets(video, audio []Span) (videoOff, audioOff []float64) {
	vEp := epochs(video)
	aEp := epochs(audio)
	vR := epochRanges(video, vEp)
	aR := epochRanges(audio, aEp)

	if len(audio) == 0 || len(vR) == len(aR) {
		n := len(vR)
		shift := make([]float64, n)
		for k := 1; k < n; k++ {
			prevEnd := vR[k-1].end + shift[k-1]
			start := vR[k].start
			if len(audio) > 0 {
				prevEnd = math.Max(prevEnd, aR[k-1].end+shift[k-1])
				start = math.Min(start, aR[k].start)
			}
			shift[k] = prevEnd - start
		}
		return perSpan(vEp, shift), perSpan(aEp, shift)
	}
	return perSpan(vEp, soloShifts(vR)), perSpan(aEp, soloShifts(aR))
}

func soloShifts(r []epochRange) []float64 {
	shift := make([]float64, len(r))
	for k := 1; k < len(r); k++ {
		shift[k] = (r[k-1].end + shift[k-1]) - r[k].start
	}
	return shift
}

func perSpan(ep []int, shift []float64) []float64 {
	out := make([]float64, len(ep))
	for i, e := range ep {
		out[i] = shift[e]
	}
	return out
}
