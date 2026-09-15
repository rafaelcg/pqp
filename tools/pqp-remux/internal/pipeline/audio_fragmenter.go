package pipeline

import "github.com/rafaelcg/pqp/tools/pqp-remux/internal/cmaf"

// AudioConfig controls where the audio track's parts and segments are cut.
// Both durations are in Timescale ticks, and both mean exactly what their
// video (Config) twins mean: PartDuration is PART_MS, SegmentDuration is
// SEGMENT_MS, each converted into this track's own clock.
//
// WHY THIS TYPE ONCE HAD NO PartDuration, AND WHAT THAT COST. The original
// reasoning was that audio needs no part target of its own because "the
// audio track's own part cadence is whatever the caller chooses to call
// Push at", and the caller calls Push once per encoded AAC frame. That
// made every AAC frame its own CMAF part: 1024 samples at 48 kHz is
// 21.3 ms, so the audio rendition advertised roughly 48 parts per second
// of about 114 bytes each, against the video rendition's 2. Production,
// 2026-09-15 09:32-09:40 UTC (the first end-to-end LL session behind the
// edge Worker) is what that looks like from outside: `state.json` showed
// the video twin sane -- 6 segments, msn 57..62, 6 parts each, part target
// 500 ms -- beside an audio twin with 69 parts per segment whose preload
// hint was `audio-part-20938.m4s`. The Worker fetched the audio playlist
// 147 times in seven minutes to the video playlist's 38, the player asked
// for `audio-part-14535.m4s` which the ring had already evicted
// (`hlsEdge.llPartMissing`), and hls.js never left "stalled, reconnecting".
//
// docs/plans/LL_HLS.md section 2 always said parts are PART_MS on BOTH
// renditions. "The cadence is whatever the caller pushes at" is not a
// cadence; it is the absence of one.
type AudioConfig struct {
	// Timescale is the audio track's own timescale (aacenc.SampleRate,
	// 48000): distinct from the video Fragmenter's 90kHz RTP clock, see
	// internal/cmaf/audio_init.go's doc comment for why that is fine (a
	// separate CMAF stream, not a second track sharing one moof).
	Timescale uint32
	// PartDuration is the audio part target, in Timescale ticks --
	// ordinarily the same PART_MS the video Fragmenter uses, converted
	// into this track's clock. Frames are batched into one part until
	// this is reached; the cut always lands on a frame boundary, so a
	// part overshoots by less than one AAC frame (21.3 ms at 48 kHz).
	//
	// Zero means "no separate part target": NewAudioFragmenter then uses
	// SegmentDuration, i.e. one part per segment. That is a deliberately
	// dull fallback rather than the old per-frame behaviour, because the
	// failure mode of a forgotten field should be a stream with too few
	// parts (playable, merely not low-latency) and not one with 48 a
	// second (unplayable).
	PartDuration uint32
	// SegmentDuration is the audio segment target, in Timescale ticks.
	// Ordinarily set from the same SEGMENT_MS config value the video
	// Fragmenter uses, converted into the audio track's own timescale.
	SegmentDuration uint32
}

// AudioFragmenter batches AAC frames into CMAF parts of PartDuration and
// decides, per frame, whether the part it just closed also closes the
// segment: whenever the elapsed duration since the segment opened has
// reached SegmentDuration. Every AAC-LC frame is independently decodable
// (no B-frames, no GOP), so unlike video there is no IDR to wait for --
// the segment boundary is simply the first frame boundary at or after the
// target, which is the same "elastic, cut on a real boundary" rule the
// video Fragmenter applies, with a 21 ms granule instead of a GOP.
//
// A segment boundary closes whatever part is open even if that part has
// not reached PartDuration, exactly as Fragmenter's "Branch A" does: a
// part may never straddle two segments.
//
// Not safe for concurrent use; one AudioFragmenter per remux session's
// audio track, fed from the single goroutine that reads the AAC encoder's
// output frames in order (internal/session's readEncoderFrames — a
// different goroutine from the one that paces PCM *into* the encoder).
type AudioFragmenter struct {
	cfg AudioConfig

	seq                uint32
	segmentIndex       int
	nextIsSegmentStart bool

	segmentStart int64
	partStart    int64
	partTicks    uint32
	partSamples  []cmaf.Sample

	nextPTS int64
	// started is false until the first Push -- see Push's own comment on
	// why "have the counters moved" is not the same question.
	started bool
}

// NewAudioFragmenter returns an AudioFragmenter using cfg. The first
// segment emitted is index 0, matching the video Fragmenter's own
// numbering convention (the two are independent counters on independent
// timelines; nothing requires segment N of one to cover the same wall-clock
// window as segment N of the other, though in practice they will be
// close, both being cut against the same SEGMENT_MS target).
//
// A zero cfg.PartDuration is replaced by cfg.SegmentDuration -- see
// AudioConfig.PartDuration for why that, and not "a part per frame", is
// the fallback.
func NewAudioFragmenter(cfg AudioConfig) *AudioFragmenter {
	if cfg.PartDuration == 0 {
		cfg.PartDuration = cfg.SegmentDuration
	}
	return &AudioFragmenter{cfg: cfg, nextIsSegmentStart: true}
}

// SetStartSegmentIndex is the audio counterpart of
// Fragmenter.SetStartSegmentIndex -- see that method's doc comment for why
// L1.6's watchdog restart needs this. Call it, if at all, immediately
// after NewAudioFragmenter and before the first Push.
func (f *AudioFragmenter) SetStartSegmentIndex(index int) { f.segmentIndex = index }

// SetStartSequence is the audio counterpart of
// pipeline.Fragmenter.SetStartSequence -- see that method's doc comment
// for why a replacement pipeline must not hand out part names its
// predecessor already used. Call it, if at all, immediately after
// NewAudioFragmenter and before the first Push.
func (f *AudioFragmenter) SetStartSequence(next uint32) {
	if next > 0 {
		f.seq = next - 1
	}
}

// CurrentSequence returns the sequence number of the LAST part this
// AudioFragmenter emitted (0 before the first one).
func (f *AudioFragmenter) CurrentSequence() uint32 { return f.seq }

// Push feeds one AAC frame (aacenc.SamplesPerFrame samples, already
// stripped of its ADTS header) at pts (in Timescale ticks -- the caller's
// own running sample counter, so consecutive calls are expected to differ
// by exactly durationTicks).
//
// It returns a Fragment whenever this frame closes a part (which may also
// close a segment), and nil while a part is still accumulating. That nil
// is new as of the PART_MS fix: callers that used to treat every Push as
// producing a part must check (internal/session's readEncoderFrames does).
// Unlike the video Fragmenter there is still no "waiting for the first
// IDR" state, so a nil here only ever means "this part is not full yet".
func (f *AudioFragmenter) Push(pts int64, durationTicks uint32, data []byte) *Fragment {
	if !f.started {
		// The first frame anchors the first segment and the first part,
		// whatever the counters say. This used to test
		// `segmentIndex == 0 && seq == 0`, which is only true for a
		// session's FIRST pipeline: after a watchdog restart resumes
		// either counter past zero, the anchor was never set,
		// segmentStart stayed 0, and the replacement's very first frame
		// rolled the segment immediately because `nextPTS - 0` is
		// already past any target.
		f.segmentStart = pts
		f.partStart = pts
		f.started = true
	}

	f.partSamples = append(f.partSamples, cmaf.Sample{Duration: durationTicks, IsSync: true, Data: data})
	f.partTicks += durationTicks
	f.nextPTS = pts + int64(durationTicks)

	segmentElapsed := uint64(f.nextPTS - f.segmentStart)
	if segmentElapsed >= uint64(f.cfg.SegmentDuration) {
		// The segment target wins over the part target: the part closes
		// here whether or not it is full, because a part may not
		// straddle two segments.
		frag := f.closePart()
		f.segmentIndex++
		f.segmentStart = f.nextPTS
		f.nextIsSegmentStart = true
		return frag
	}
	if uint64(f.partTicks) >= uint64(f.cfg.PartDuration) {
		return f.closePart()
	}
	return nil
}

// Flush closes whatever part is still open, if any, and returns it (nil
// when nothing is pending). It is the audio counterpart of
// Fragmenter.Flush and exists for the same reason, which only became a
// reason once parts batched more than one frame: up to PartDuration of
// already-encoded audio now sits inside the fragmenter at any instant, and
// a session that ends without draining it drops that tail. Call it once,
// at end of stream, from the same goroutine that calls Push (or after that
// goroutine has provably finished -- internal/session.Close waits on
// audioReaderDone first).
func (f *AudioFragmenter) Flush() *Fragment {
	if len(f.partSamples) == 0 {
		return nil
	}
	return f.closePart()
}

// CurrentSegmentIndex returns the index of the segment currently open (or
// most recently opened, if nothing has arrived since). Used by
// Session.Close to know which segment the audio track's own end has just
// closed, for the R2 writer (L1.4) -- the same role
// pipeline.Fragmenter.CurrentSegmentIndex plays for video's Finish.
func (f *AudioFragmenter) CurrentSegmentIndex() int { return f.segmentIndex }

func (f *AudioFragmenter) closePart() *Fragment {
	samples := f.partSamples
	duration := f.partTicks
	f.partSamples = nil
	f.partTicks = 0

	f.seq++
	isStart := f.nextIsSegmentStart
	f.nextIsSegmentStart = false

	fragBytes := cmaf.BuildFragment(cmaf.FragmentParams{
		SequenceNumber:      f.seq,
		BaseMediaDecodeTime: uint64(f.partStart),
		Samples:             samples,
	})
	frag := &Fragment{
		SequenceNumber: f.seq,
		SegmentIndex:   f.segmentIndex,
		IsSegmentStart: isStart,
		DurationTicks:  duration,
		Bytes:          fragBytes,
	}
	f.partStart = f.nextPTS
	return frag
}
