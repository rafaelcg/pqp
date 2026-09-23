package main

// Paced publishing: the fixed-rate file track (lksdk.NewLocalFileTrack)
// cannot reproduce the source that stalls LL viewers, because what matters
// is WHEN frames arrive, not how many. A Chrome tab share of a mostly
// static page sends a frame every 0.3 to 1 s, nothing at all while the
// page is still, and a burst when it repaints; on 2026-09-21 that is the
// shape under which pqp-remux published parts up to a second late.
//
// Each frame is written with its RTP duration equal to the wall-clock gap
// to the next one, and sent at its scheduled instant, so the RTP clock and
// the wall clock agree the way they do for a real capture.

import (
	"errors"
	"io"
	"math/rand"
	"os"
	"time"

	lksdk "github.com/livekit/server-sdk-go/v2"
	"github.com/pion/webrtc/v4/pkg/media"
	"github.com/pion/webrtc/v4/pkg/media/h264reader"
)

// phase is a stretch of the schedule: frames every `gaps` (cycled) for
// `length`. An empty gaps list is a freeze: no frames at all.
type phase struct {
	length time.Duration
	gaps   []time.Duration
}

func ms(v ...int) []time.Duration {
	out := make([]time.Duration, len(v))
	for i, n := range v {
		out[i] = time.Duration(n) * time.Millisecond
	}
	return out
}

// schedule is a named pacing: the frame send offsets over a total, and the
// wall-clock keyframe cadence that stands in for the PLIs a real encoder
// answers (see idrEvery).
type schedule struct {
	times    func(total time.Duration) []time.Duration
	idrEvery time.Duration
}

// schedules, by PACE name.
//
// idle-bursty is a fixed twenty second cycle. static and mixed follow the
// shape the 2026-09-21 investigation derived from that party's remux stats
// (~/.config/pqp/hls-investigation lab, gen-idle.py): about 24 fps when the
// page moves, and when it does not, gaps drawn from an exponential with a
// one second mean clamped to 0.3..3 s, keyframes only when the remux's PLI
// gate (4.1 s) asks. Seeded, so every run of a scenario sends the same
// frames.
var schedules = map[string]schedule{
	"idle-bursty": {times: func(total time.Duration) []time.Duration { return frameTimes(phases["idle-bursty"], total) }, idrEvery: 2 * time.Second},
	"steady":      {times: func(total time.Duration) []time.Duration { return frameTimes(phases["steady"], total) }, idrEvery: 2 * time.Second},
	"static": {times: func(total time.Duration) []time.Duration {
		r := rand.New(rand.NewSource(42))
		out := activeTimes(r, nil, 0, 3*time.Second)
		return staticTimes(r, out, 3*time.Second, total)
	}, idrEvery: 4100 * time.Millisecond},
	"mixed": {times: func(total time.Duration) []time.Duration {
		r := rand.New(rand.NewSource(42))
		var out []time.Duration
		for at := time.Duration(0); at < total; at += 75 * time.Second {
			out = activeTimes(r, out, at, min(at+45*time.Second, total))
			out = staticTimes(r, out, at+45*time.Second, min(at+75*time.Second, total))
		}
		return out
	}, idrEvery: 4100 * time.Millisecond},
}

func activeTimes(r *rand.Rand, out []time.Duration, from, to time.Duration) []time.Duration {
	for at := from; at < to; {
		out = append(out, at)
		gap := time.Duration((1.0/24 + r.NormFloat64()*0.006) * float64(time.Second))
		at += max(gap, 10*time.Millisecond)
	}
	return out
}

func staticTimes(r *rand.Rand, out []time.Duration, from, to time.Duration) []time.Duration {
	for at := from; at < to; {
		out = append(out, at)
		gap := min(3.0, max(0.3, r.ExpFloat64()*1.0))
		at += time.Duration(gap * float64(time.Second))
	}
	return out
}

// phases are the fixed-cycle schedules. Each repeats until PACE_SECONDS
// runs out.
var phases = map[string][]phase{
	// idle-bursty: 30 fps, a nearly static tab (about 1.4 frames a
	// second), a four second freeze, a one second burst, then an
	// irregular few frames a second. Twenty seconds per cycle.
	"idle-bursty": {
		{3 * time.Second, ms(33)},
		{7 * time.Second, ms(714)},
		{4 * time.Second, nil},
		{1 * time.Second, ms(33)},
		{5 * time.Second, ms(180, 420, 260, 900, 330, 610)},
	},
	// steady: plain 30 fps, the control.
	"steady": {{20 * time.Second, ms(33)}},
}

// frameTimes expands a schedule into frame send offsets over total.
func frameTimes(schedule []phase, total time.Duration) []time.Duration {
	var out []time.Duration
	at := time.Duration(0)
	for at < total {
		for _, p := range schedule {
			end := at + p.length
			if len(p.gaps) == 0 {
				at = end
				continue
			}
			for i := 0; at < end && at < total; i++ {
				out = append(out, at)
				at += p.gaps[i%len(p.gaps)]
			}
			at = end
		}
	}
	return out
}

// accessUnits reads an Annex-B file into access units, one per coded
// slice, each carrying whatever parameter sets / SEI preceded it.
func accessUnits(path string) ([][][]byte, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	r, err := h264reader.NewReader(f)
	if err != nil {
		return nil, err
	}
	var aus [][][]byte
	var cur [][]byte
	for {
		nal, err := r.NextNAL()
		if errors.Is(err, io.EOF) {
			return aus, nil
		}
		if err != nil {
			return nil, err
		}
		cur = append(cur, append([]byte(nil), nal.Data...))
		if nal.UnitType == h264reader.NalUnitTypeCodedSliceIdr || nal.UnitType == h264reader.NalUnitTypeCodedSliceNonIdr {
			aus = append(aus, cur)
			cur = nil
		}
	}
}

// idrEvery (per schedule) is how often, in WALL time, the paced publisher
// sends a keyframe. A file's keyframes are every N frames, and at a frame a second
// that would be one every half a minute: segments would run that long,
// EXT-X-TARGETDURATION with them, and hls.js would sit tens of seconds
// behind the live edge where part timing cannot matter. A real presenter's
// encoder answers the remux's PLIs (KEYFRAME_POLICY=pli, a request after
// SEGMENT_MS without one), which this file-backed publisher cannot hear, so
// it keeps a wall-clock keyframe cadence of its own instead.

func isIDR(au [][]byte) bool {
	for _, n := range au {
		if len(n) > 0 && n[0]&0x1f == 5 {
			return true
		}
	}
	return false
}

// publishPaced sends the file's access units on the schedule, looping the
// file if the schedule outlasts it. When a keyframe is due it skips ahead
// to the file's next IDR, which is always a valid place to resume
// decoding.
func publishPaced(track *lksdk.LocalTrack, path string, sched schedule, total time.Duration) error {
	aus, err := accessUnits(path)
	if err != nil {
		return err
	}
	if len(aus) == 0 || !isIDR(aus[0]) {
		return errors.New("rampub: " + path + " must start with an IDR")
	}
	times := sched.times(total)
	start := time.Now()
	cursor := 0
	var lastIDR time.Time
	for i, at := range times {
		if d := time.Until(start.Add(at)); d > 0 {
			time.Sleep(d)
		}
		gap := 33 * time.Millisecond
		if i+1 < len(times) {
			gap = times[i+1] - at
		}
		if time.Since(lastIDR) >= sched.idrEvery {
			for !isIDR(aus[cursor%len(aus)]) {
				cursor++
			}
		}
		au := aus[cursor%len(aus)]
		cursor++
		if isIDR(au) {
			lastIDR = time.Now()
		}
		// Parameter sets and SEI advance nothing; the slice carries the
		// gap to the next frame, which is what the RTP timestamp of that
		// next frame is computed from.
		for j, nal := range au {
			d := time.Duration(0)
			if j == len(au)-1 {
				d = gap
			}
			if err := track.WriteSample(media.Sample{Data: nal, Duration: d}, nil); err != nil {
				return err
			}
		}
	}
	return nil
}
