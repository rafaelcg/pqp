package pipeline

import (
	"testing"
	"time"

	"github.com/rafaelcg/pqp/tools/pqp-remux/internal/aacenc"
)

// THE 2026-09-15 DRIFT. A Chrome tab share of a nearly static page sends
// about 1.4 frames a second. The first keep-alive published the held frame
// on the PART target with a guessed duration and then re-derived ptsOffset
// on resume so the next frame landed on the guess, which silently deleted
// the difference: production's video timeline advanced 29.0s of media in
// 53.8s of wall (ratio 0.54) while audio, which is paced off the wall clock
// and never idles, ran at 0.98. Every blocking playlist reload eventually
// timed out and the player stalled for good.
//
// These tests pin the property that was missing, at the layer that lost it:
// over a minute of wall clock, at ANY frame rate, the media this fragmenter
// publishes must equal the wall time that passed.

// idleAllowance mirrors internal/session's videoIdleAfter -- two part
// targets, floored at a second -- because that is the deadline the real
// caller flushes on, and testing this arithmetic against a different one
// would prove nothing about production (pitfall 12).
func idleAllowance(partTicks int64) time.Duration {
	d := ticks(partTicks)
	if 2*d < time.Second {
		return time.Second
	}
	return 2 * d
}

func ticks(n int64) time.Duration {
	return time.Duration(n) * time.Second / timescale
}

// timelineRun is one fake source driven for wallSpan at fps, through the
// same two entry points production uses: Push for every access unit the
// publisher sends, and IdleFlush on a 100ms monitor tick once the held
// frame has outlived the idle allowance. The publisher's clock is the wall
// clock, which is what a live capture's RTP timestamps are.
type timelineRun struct {
	// mediaTicks is the media published: the sum of every closed part's
	// own duration.
	mediaTicks int64
	// firstFrameAt is where that media starts on the wall clock, and
	// lastPublishAt is where it ends -- the instant the last closed part
	// was published, which is also the instant its own media ends (a
	// part closed by an arriving frame ends at that frame's PTS; a
	// keep-alive ends at the tick that published it). Comparing the
	// media against exactly that span is what makes the ratio a
	// statement about the timeline rather than about the part still
	// open when the run stopped.
	firstFrameAt  time.Duration
	lastPublishAt time.Duration
	keepAlives    int
}

// ratio is media published over wall clock passed. It belongs at 1.00.
func (r timelineRun) ratio() float64 {
	span := (r.lastPublishAt - r.firstFrameAt).Seconds()
	if span <= 0 {
		return 0
	}
	return (float64(r.mediaTicks) / timescale) / span
}

func runTimeline(t *testing.T, fps float64, wallSpan time.Duration, idrEvery time.Duration) timelineRun {
	t.Helper()
	const monitorTick = 100 * time.Millisecond

	f := NewFragmenter(Config{Timescale: timescale, PartDuration: partDuration, SegmentDuration: segmentDuration})
	allowance := idleAllowance(partDuration)
	frameGap := time.Duration(float64(time.Second) / fps)

	var (
		run         timelineRun
		nextFrameAt time.Duration
		lastFrameAt time.Duration
		lastIDRAt   time.Duration
		started     bool
	)
	for wall := time.Duration(0); wall <= wallSpan; wall += monitorTick {
		// Every frame whose capture instant has arrived.
		for nextFrameAt <= wall {
			idr := !started || nextFrameAt-lastIDRAt >= idrEvery
			frag, err := f.Push(au(int64(nextFrameAt)*timescale/int64(time.Second), idr))
			if err != nil && err != ErrWaitingForIDR {
				t.Fatalf("push at %s: %v", nextFrameAt, err)
			}
			if idr {
				lastIDRAt = nextFrameAt
			}
			if !started {
				run.firstFrameAt = nextFrameAt
			}
			if frag != nil {
				run.mediaTicks += int64(frag.DurationTicks)
				run.lastPublishAt = nextFrameAt
			}
			started = true
			lastFrameAt = nextFrameAt
			nextFrameAt += frameGap
		}
		if !started {
			continue
		}
		// The monitor tick: publish the held frame only once it has
		// outlived a whole idle allowance.
		if held := wall - lastFrameAt; held >= allowance && f.HasPending() {
			if frag := f.IdleFlush(int64(held) * timescale / int64(time.Second)); frag != nil {
				run.mediaTicks += int64(frag.DurationTicks)
				run.lastPublishAt = wall
				run.keepAlives++
			}
		}
	}
	return run
}

// Media time must equal wall time at every frame rate a real screen share
// produces, from a slide deck that repaints once every five seconds to an
// ordinary 30fps capture.
func TestFragmenter_MediaTimeTracksWallClockAtAnyFrameRate(t *testing.T) {
	const wallSpan = 60 * time.Second
	for _, tc := range []struct {
		name string
		fps  float64
	}{
		{"a slide that repaints every five seconds", 0.2},
		{"a paused film", 0.5},
		{"one frame a second", 1.0},
		{"a static Chrome tab (the 2026-09-15 source)", 1.4},
		{"a lightly animated page", 5},
		{"an ordinary screen share", 30},
	} {
		t.Run(tc.name, func(t *testing.T) {
			run := runTimeline(t, tc.fps, wallSpan, 4*time.Second)
			if ratio := run.ratio(); ratio < 0.98 || ratio > 1.02 {
				t.Fatalf("published %.2fs of media across %.2fs of wall clock (ratio %.3f, %d keep-alives); the timeline must keep time at any frame rate",
					float64(run.mediaTicks)/timescale, (run.lastPublishAt - run.firstFrameAt).Seconds(), ratio, run.keepAlives)
			}
			// The playlist must still be moving at the end of the run.
			// The most it may owe is the part still open: one frame
			// interval for a source whose frames close its parts, plus
			// the allowance a quiet one waits before publishing early.
			quiet := time.Duration(float64(time.Second)/tc.fps) + idleAllowance(partDuration)
			if run.lastPublishAt < wallSpan-quiet {
				t.Fatalf("the last part was published at %s of a %s run (at most %s should be owed): the playlist stopped advancing", run.lastPublishAt, wallSpan, quiet)
			}
		})
	}
}

// An ordinary 30fps source must never reach the keep-alive at all: its
// parts close on arriving access units, exactly as they did before any of
// this existed.
func TestFragmenter_HealthySourceNeedsNoKeepAlive(t *testing.T) {
	if run := runTimeline(t, 30, 10*time.Second, 4*time.Second); run.keepAlives != 0 {
		t.Fatalf("a 30fps source produced %d keep-alive parts", run.keepAlives)
	}
}

// A source slow enough to sit between the part target and the idle
// allowance -- which is exactly where a static Chrome tab sits -- must
// close its parts on real frames, not on guesses. Before the fix every
// part such a source ever published was a keep-alive (production's own
// watchdog detail read `parts=74 keepalive=74`).
func TestFragmenter_SlowSourceClosesPartsOnRealFrames(t *testing.T) {
	if run := runTimeline(t, 1.4, 30*time.Second, 4*time.Second); run.keepAlives != 0 {
		t.Fatalf("a 1.4 frames/s source produced %d keep-alive parts; its frame gaps are shorter than the idle allowance and must close parts by themselves", run.keepAlives)
	}
}

// The alignment half. Audio is paced off the wall clock and never idles,
// so "video and audio stay aligned" is the same statement as "video keeps
// time" -- but stating it against a real AudioFragmenter, fed for the same
// wall window, is what makes the two tracks comparable rather than two
// separate claims about one of them.
func TestFragmenter_VideoAndAudioPublishTheSameMediaTime(t *testing.T) {
	const wallSpan = 60 * time.Second
	video := runTimeline(t, 1.4, wallSpan, 4*time.Second)
	videoSecs := float64(video.mediaTicks) / timescale

	// One AAC frame is 1024 samples at 48kHz, and the encoder emits them
	// back to back for as long as the session runs.
	const aacFrameSamples = 1024
	audioPart := uint32(uint64(aacenc.SampleRate) * 500 / 1000)
	audioSegment := uint32(uint64(aacenc.SampleRate) * 4000 / 1000)
	af := NewAudioFragmenter(AudioConfig{
		Timescale:       aacenc.SampleRate,
		PartDuration:    audioPart,
		SegmentDuration: audioSegment,
	})
	var (
		audioTicks int64
		pts        int64
	)
	for pts+aacFrameSamples <= int64(wallSpan.Seconds()*aacenc.SampleRate) {
		if frag := af.Push(pts, aacFrameSamples, []byte{0x01}); frag != nil {
			audioTicks += int64(frag.DurationTicks)
		}
		pts += aacFrameSamples
	}
	audioSecs := float64(audioTicks) / aacenc.SampleRate

	// Both tracks trail the live edge by whatever part is still open;
	// what must not happen is one of them running at half the other's
	// speed, which is what production saw (0.54 against 0.98).
	if diff := videoSecs - audioSecs; diff > 1.2 || diff < -1.2 {
		t.Fatalf("video published %.2fs of media and audio %.2fs over %.0fs of wall clock; the two tracks have drifted apart by %.2fs",
			videoSecs, audioSecs, wallSpan.Seconds(), diff)
	}
}

// The mechanism, in isolation: a keep-alive followed by a resume must
// publish the WHOLE gap, not the part of it the flush happened to guess.
// This is the single assertion the old code failed.
func TestFragmenter_ResumeAfterAKeepAlivePaysBackTheWholeGap(t *testing.T) {
	f := NewFragmenter(Config{Timescale: timescale, PartDuration: partDuration, SegmentDuration: segmentDuration})

	if _, err := f.Push(au(0, true)); err != nil {
		t.Fatalf("first IDR: %v", err)
	}
	// Held for a second; the frame that ends the quiet spell is three
	// seconds after the one before it.
	const held = int64(timescale)        // 1s
	const trueGap = int64(3 * timescale) // 3s
	flushed := f.IdleFlush(held)
	if flushed == nil {
		t.Fatal("IdleFlush produced no part")
	}
	total := int64(flushed.DurationTicks)

	if frag, err := f.Push(au(trueGap, false)); err != nil || frag != nil {
		t.Fatalf("resume frame: frag=%v err=%v", frag, err)
	}
	// The frame after it closes the resumed part.
	next, err := f.Push(au(trueGap+partDuration, false))
	if err != nil {
		t.Fatalf("frame after the resume: %v", err)
	}
	if next == nil {
		t.Fatal("no part closed after the resume")
	}
	total += int64(next.DurationTicks)

	// Wall clock from the first frame to the one that closed the part is
	// the true gap plus a part target. Every tick of it must be in the
	// two parts published, whatever the flush guessed in between.
	want := trueGap + partDuration
	if total != want {
		t.Fatalf("published %d ticks of media across a %d-tick gap: %d were dropped by the keep-alive's estimate",
			total, want, want-total)
	}
}

// A keep-alive on a source that has ALREADY been resumed once must
// extrapolate from where the publisher's clock really is, not from where
// the previous flush published to. Measuring from the published instant is
// how consecutive quiet spells each lost the interval between one flush
// and the frame that followed it -- the compounding that turned a 0.5s
// guess into a 0.54x timeline.
func TestFragmenter_ConsecutiveKeepAlivesDoNotCompound(t *testing.T) {
	f := NewFragmenter(Config{Timescale: timescale, PartDuration: partDuration, SegmentDuration: segmentDuration})

	if _, err := f.Push(au(0, true)); err != nil {
		t.Fatalf("first IDR: %v", err)
	}
	const held = int64(timescale)         // flush after 1s of holding
	const frameGap = int64(2 * timescale) // a frame every 2s

	var total int64
	if frag := f.IdleFlush(held); frag != nil {
		total += int64(frag.DurationTicks)
	} else {
		t.Fatal("the first IdleFlush produced no part")
	}
	for i := int64(1); i <= 5; i++ {
		if frag, err := f.Push(au(i*frameGap, false)); err != nil {
			t.Fatalf("frame %d: %v", i, err)
		} else if frag != nil {
			total += int64(frag.DurationTicks)
		}
		if frag := f.IdleFlush(held); frag != nil {
			total += int64(frag.DurationTicks)
		} else {
			t.Fatalf("no keep-alive after frame %d", i)
		}
	}
	// Five frames at two seconds apart, each held a second before its
	// keep-alive: the published timeline ends one second past the last
	// frame.
	want := 5*frameGap + held
	if total != want {
		t.Fatalf("published %d ticks over %d ticks of wall clock (ratio %.2f); consecutive keep-alives are compounding a loss",
			total, want, float64(total)/float64(want))
	}
}
