package pipeline

import (
	"testing"
	"time"

	"github.com/rafaelcg/pqp/tools/pqp-remux/internal/h264"
)

// WHAT THESE TESTS PIN, AND WHY IT IS WORTH PINNING. A low-latency
// playlist promises PART-TARGET in advance, and Apple's player treats two
// breaches of that promise as FATAL PLAYLIST PARSE ERRORS rather than as
// stalls: a partial segment longer than PART-TARGET, and a NON-TERMINAL
// one shorter than 85% of it. Measured against pqp's live stream with
// AVPlayer on 2026-09-17, both fired, because a part lasted exactly as
// long as the frame it held and a presenter's encoder sends nothing at
// all while the screen is still.
//
// So: with a repeater set, every part this fragmenter emits must land in
// [0.85, 1.0] x PartDuration unless it is the last part of its segment,
// no matter what the source does -- and the timeline must stay whole
// while that is true, which is the property internal/pipeline's timeline
// tests already defend and these must not trade away.

// fakeRepeater stands in for internal/skipframe: the fragmenter only ever
// treats a repeat frame as opaque bytes, and skipframe's own tests (and
// its bitstream test, against ffmpeg) are what prove those bytes decode.
// Observe here also proves the fragmenter routes every real access unit
// through the repeater, which is what keeps frame_num gapless in
// production.
type fakeRepeater struct {
	frames   int
	observed int
	// unavailable makes Repeat return nil, which is how skipframe
	// reports a stream it cannot synthesize into.
	unavailable bool
}

func (r *fakeRepeater) Observe(avcc []byte, isIDR bool) []byte {
	r.observed++
	return avcc
}

func (r *fakeRepeater) Repeat() []byte {
	if r.unavailable {
		return nil
	}
	r.frames++
	return []byte{0, 0, 0, 4, 0x41, 0x9A, 0x00, byte(r.frames)}
}

func clockCutFragmenter() (*Fragmenter, *fakeRepeater) {
	f := NewFragmenter(Config{Timescale: timescale, PartDuration: partDuration, SegmentDuration: segmentDuration})
	r := &fakeRepeater{}
	f.SetRepeater(r)
	return f, r
}

// timeline checks the one property a part list must never lose: each
// part starts exactly where the one before it ended.
type timelineCheck struct {
	t        *testing.T
	nextTfdt uint64
	started  bool
	total    uint64
}

func (c *timelineCheck) add(frag *Fragment) {
	c.t.Helper()
	tfdt := baseMediaDecodeTime(c.t, frag.Bytes)
	if c.started && tfdt != c.nextTfdt {
		c.t.Fatalf("part %d starts at tfdt %d, but the part before it ended at %d: %s",
			frag.SequenceNumber, tfdt, c.nextTfdt, holeOrOverlap(tfdt, c.nextTfdt))
	}
	c.started = true
	c.nextTfdt = tfdt + uint64(frag.DurationTicks)
	c.total += uint64(frag.DurationTicks)
}

func holeOrOverlap(got, want uint64) string {
	if got > want {
		return "a hole in the media timeline"
	}
	return "an overlap: the timeline went backwards"
}

// checkPartBounds asserts Apple's two rules over a run of parts: nothing
// longer than the target, and nothing shorter than 85% of it unless it is
// the last part of its segment.
func checkPartBounds(t *testing.T, frags []*Fragment) {
	t.Helper()
	const floor = partDuration * 85 / 100
	for i, frag := range frags {
		if frag.DurationTicks > partDuration {
			t.Fatalf("part %d (seq %d) lasts %d ticks, past the %d-tick target: AVPlayer refuses the playlist for this",
				i, frag.SequenceNumber, frag.DurationTicks, partDuration)
		}
		terminal := i == len(frags)-1 || frags[i+1].SegmentIndex != frag.SegmentIndex
		if terminal {
			continue
		}
		if frag.DurationTicks < floor {
			t.Fatalf("non-terminal part %d (seq %d) lasts %d ticks, under the %d-tick 85%% floor",
				i, frag.SequenceNumber, frag.DurationTicks, floor)
		}
	}
}

// A source that stalls for two seconds mid-part is the exact shape that
// produced the 2.25s part measured in production.
func TestClockCut_AStalledSourceStillProducesBoundedParts(t *testing.T) {
	f, rep := clockCutFragmenter()
	tl := &timelineCheck{t: t}
	var frags []*Fragment

	push := func(pts int64, idr bool) {
		t.Helper()
		out, err := f.Push(au(pts, idr))
		if err != nil {
			t.Fatalf("push at %d: %v", pts, err)
		}
		for _, frag := range out {
			tl.add(frag)
			frags = append(frags, frag)
		}
	}

	pts := int64(0)
	push(pts, true)
	// A second of ordinary 30fps video, then a two-second gap with no
	// frame at all, then another second of video.
	for i := 0; i < 30; i++ {
		pts += frameStep
		push(pts, false)
	}
	pts += 2 * timescale // the stall
	push(pts, false)
	for i := 0; i < 30; i++ {
		pts += frameStep
		push(pts, false)
	}

	if len(frags) < 6 {
		t.Fatalf("expected at least 6 parts across 4 seconds of wall clock, got %d", len(frags))
	}
	checkPartBounds(t, frags)
	if rep.frames == 0 {
		t.Fatal("no repeat frame was synthesized, so the stall was published as one long part")
	}
	if got, want := tl.total, uint64(pts); got != want {
		t.Fatalf("published %d ticks of media across a %d-tick span: the stall was not covered exactly", got, want)
	}
}

// The same stall arriving through the keep-alive path, which is what
// production actually hits: a frozen source sends nothing, so there is no
// access unit to close a part with.
func TestClockCut_AFrozenSourceKeepsProducingPartsOnTheClock(t *testing.T) {
	f, rep := clockCutFragmenter()
	tl := &timelineCheck{t: t}
	var frags []*Fragment

	if _, err := f.Push(au(0, true)); err != nil {
		t.Fatalf("first IDR: %v", err)
	}
	// Nothing else ever arrives. The caller ticks every 100ms and flushes
	// once the held frame has outlived the idle allowance, exactly as
	// internal/session's idleTick does.
	allowance := idleAllowance(partDuration)
	for wall := 100 * time.Millisecond; wall <= 5*time.Second; wall += 100 * time.Millisecond {
		if wall < allowance {
			continue
		}
		held := int64(wall) * timescale / int64(time.Second)
		for _, frag := range f.IdleFlush(held) {
			tl.add(frag)
			frags = append(frags, frag)
		}
	}

	if len(frags) < 8 {
		t.Fatalf("a five second freeze produced %d parts; the playlist stops advancing at that rate", len(frags))
	}
	checkPartBounds(t, frags)
	if rep.frames < len(frags)-1 {
		t.Fatalf("%d parts but only %d repeat frames: some part carries no picture of its own", len(frags), rep.frames)
	}
	// Every part is exactly the target, and together they cover the wall
	// clock from the first frame to the last boundary with no hole.
	if tl.total%partDuration != 0 {
		t.Fatalf("published %d ticks, which is not a whole number of %d-tick parts", tl.total, partDuration)
	}
}

// The frame that ends a freeze may carry a timestamp older than media the
// keep-alive already published (our clock ran, theirs did not). The
// timeline must not rewind for it.
func TestClockCut_TheFrameThatEndsAFreezeNeverRewindsTheTimeline(t *testing.T) {
	f, _ := clockCutFragmenter()
	tl := &timelineCheck{t: t}

	if _, err := f.Push(au(0, true)); err != nil {
		t.Fatalf("first IDR: %v", err)
	}
	for _, frag := range f.IdleFlush(3 * timescale) {
		tl.add(frag)
	}
	published := tl.nextTfdt

	// The publisher's clock only advanced 100ms while three seconds of
	// wall clock passed here.
	out, err := f.Push(au(timescale/10, false))
	if err != nil {
		t.Fatalf("resume: %v", err)
	}
	for _, frag := range out {
		tl.add(frag)
	}
	// Push the stream on so the resumed sample actually closes a part and
	// its tfdt can be read.
	for i := int64(1); i <= 30; i++ {
		out, err := f.Push(au(timescale/10+i*frameStep, false))
		if err != nil {
			t.Fatalf("frame %d: %v", i, err)
		}
		for _, frag := range out {
			tl.add(frag)
		}
	}
	if tl.nextTfdt <= published {
		t.Fatalf("media ends at %d, no later than the %d already published before the resume", tl.nextTfdt, published)
	}
}

// A stream internal/skipframe refuses (CABAC, several reference frames,
// and the rest of New's refusals) must behave exactly as this fragmenter
// did before clock cutting existed: long parts, whole timeline, no hole.
func TestClockCut_FallsBackToLongPartsWhenTheStreamCannotBeRepeated(t *testing.T) {
	f := NewFragmenter(Config{Timescale: timescale, PartDuration: partDuration, SegmentDuration: segmentDuration})
	f.SetRepeater(&fakeRepeater{unavailable: true})
	tl := &timelineCheck{t: t}

	if _, err := f.Push(au(0, true)); err != nil {
		t.Fatalf("first IDR: %v", err)
	}
	out, err := f.Push(au(2*timescale, false))
	if err != nil {
		t.Fatalf("after the stall: %v", err)
	}
	if len(out) != 1 {
		t.Fatalf("expected the one long part the pre-clock-cut fragmenter emits, got %d", len(out))
	}
	tl.add(out[0])
	if out[0].DurationTicks != 2*timescale {
		t.Fatalf("part lasts %d ticks, want the honest %d: a stream that cannot be repeated must not be cut", out[0].DurationTicks, 2*timescale)
	}
}

// Every real access unit has to pass through the repeater, because that
// is where frame_num is renumbered around the frames it inserted -- skip
// it for one access unit and the decoder sees a gap.
func TestClockCut_EveryAccessUnitPassesThroughTheRepeater(t *testing.T) {
	f, rep := clockCutFragmenter()
	const frames = 40
	for i := int64(0); i < frames; i++ {
		if _, err := f.Push(au(i*frameStep, i == 0)); err != nil {
			t.Fatalf("frame %d: %v", i, err)
		}
	}
	if rep.observed != frames {
		t.Fatalf("the repeater saw %d of %d access units", rep.observed, frames)
	}
}

// Sequence numbers are the ring's and the edge cache's identity for a
// part, so several parts closed by one access unit must still be numbered
// one after another, in the order they are returned.
func TestClockCut_PartsFromOneAccessUnitAreNumberedInOrder(t *testing.T) {
	f, _ := clockCutFragmenter()
	if _, err := f.Push(au(0, true)); err != nil {
		t.Fatalf("first IDR: %v", err)
	}
	out, err := f.Push(au(3*partDuration, false))
	if err != nil {
		t.Fatalf("after the stall: %v", err)
	}
	if len(out) != 3 {
		t.Fatalf("a gap of three part targets closed %d parts, want 3", len(out))
	}
	for i, frag := range out {
		if i > 0 && frag.SequenceNumber != out[i-1].SequenceNumber+1 {
			t.Fatalf("part %d carries sequence %d after %d", i, frag.SequenceNumber, out[i-1].SequenceNumber)
		}
		if frag.Independent && i > 0 {
			t.Fatalf("part %d opens on a repeat frame, which is not a sync sample, yet claims to be independent", i)
		}
	}
}

// Media time must still equal wall time with clock cutting on: the whole
// point is to move WHERE a part is cut, never how much media exists.
func TestClockCut_MediaTimeStillTracksTheWallClock(t *testing.T) {
	const wallSpan = 60 * time.Second
	for _, fps := range []float64{0.2, 1.4, 30} {
		run := runClockCutTimeline(t, fps, wallSpan)
		if r := run.ratio(); r < 0.98 || r > 1.02 {
			t.Fatalf("at %.1f fps the timeline ran at %.2fx wall clock (media %.1fs over %.1fs)",
				fps, r, float64(run.mediaTicks)/timescale, (run.lastPublishAt - run.firstFrameAt).Seconds())
		}
	}
}

// runClockCutTimeline is runTimeline (fragmenter_timeline_test.go) with a
// repeater set: same fake source, same two entry points, same arithmetic.
func runClockCutTimeline(t *testing.T, fps float64, wallSpan time.Duration) timelineRun {
	t.Helper()
	const monitorTick = 100 * time.Millisecond

	f, _ := clockCutFragmenter()
	allowance := idleAllowance(partDuration)
	frameGap := time.Duration(float64(time.Second) / fps)

	var (
		run         timelineRun
		nextFrameAt time.Duration
		lastFrameAt time.Duration
		lastIDRAt   time.Duration
		started     bool
		frags       []*Fragment
	)
	for wall := time.Duration(0); wall <= wallSpan; wall += monitorTick {
		for nextFrameAt <= wall {
			idr := !started || nextFrameAt-lastIDRAt >= 4*time.Second
			out, err := f.Push(au(int64(nextFrameAt)*timescale/int64(time.Second), idr))
			if err != nil && err != ErrWaitingForIDR {
				t.Fatalf("push at %s: %v", nextFrameAt, err)
			}
			if idr {
				lastIDRAt = nextFrameAt
			}
			if !started {
				run.firstFrameAt = nextFrameAt
			}
			for _, frag := range out {
				run.mediaTicks += int64(frag.DurationTicks)
				run.lastPublishAt = nextFrameAt
				frags = append(frags, frag)
			}
			started = true
			lastFrameAt = nextFrameAt
			nextFrameAt += frameGap
		}
		if !started {
			continue
		}
		if held := wall - lastFrameAt; held >= allowance && f.HasPending() {
			for _, frag := range f.IdleFlush(int64(held) * timescale / int64(time.Second)) {
				run.mediaTicks += int64(frag.DurationTicks)
				run.lastPublishAt = wall
				run.keepAlives++
				frags = append(frags, frag)
			}
		}
	}
	checkPartBounds(t, frags)
	return run
}

// A fragmenter with no repeater is the default, and must be byte-for-byte
// the fragmenter this package had before clock cutting: same parts, same
// sequence numbers, same durations.
func TestClockCut_OffByDefault(t *testing.T) {
	plain := NewFragmenter(Config{Timescale: timescale, PartDuration: partDuration, SegmentDuration: segmentDuration})
	if plain.clockCutting() {
		t.Fatal("a fragmenter with no repeater is cutting on the clock")
	}
	var got []*Fragment
	for i := int64(0); i < 60; i++ {
		out, err := plain.Push(au(i*frameStep, i == 0))
		if err != nil {
			t.Fatalf("frame %d: %v", i, err)
		}
		if len(out) > 1 {
			t.Fatalf("frame %d closed %d parts with no repeater set", i, len(out))
		}
		got = append(got, out...)
	}
	if len(got) == 0 {
		t.Fatal("no parts at all")
	}
	if plain.RepeatFrames() != 0 || plain.ClockCuts() != 0 {
		t.Fatalf("counters moved with no repeater: repeats=%d cuts=%d", plain.RepeatFrames(), plain.ClockCuts())
	}
}

var _ Repeater = (*fakeRepeater)(nil)

var _ = h264.AccessUnit{}
