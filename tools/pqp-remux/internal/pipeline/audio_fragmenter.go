package pipeline

import "github.com/rafaelcg/pqp/tools/pqp-remux/internal/cmaf"

// AudioConfig controls where the audio track's parts and segments are cut.
// Unlike the video Fragmenter's Config, there is only one duration to
// configure the cadence with -- SegmentDuration -- because every AAC-LC
// frame is independently decodable (no B-frames, no GOP), so a segment
// never has to wait for anything the way a video segment waits for an
// IDR: it simply closes on the first frame at or after the target,
// exactly on schedule. PartDuration is not a separate audio concept here:
// the audio track's own "part" cadence is whatever the caller chooses to
// call AudioFragmenter.Push at (see Session's doc comment for why that is
// driven by aacenc.SamplesPerFrame, one call per encoded AAC frame).
type AudioConfig struct {
	// Timescale is the audio track's own timescale (aacenc.SampleRate,
	// 48000): distinct from the video Fragmenter's 90kHz RTP clock, see
	// internal/cmaf/audio_init.go's doc comment for why that is fine (a
	// separate CMAF stream, not a second track sharing one moof).
	Timescale uint32
	// SegmentDuration is the audio segment target, in Timescale ticks.
	// Ordinarily set from the same SEGMENT_MS config value the video
	// Fragmenter uses, converted into the audio track's own timescale.
	SegmentDuration uint32
}

// AudioFragmenter accumulates AAC frames into CMAF parts and decides, once
// per frame, whether this frame also opens a new segment: whenever the
// elapsed duration since the current segment opened has reached
// SegmentDuration. There is no IDR to wait for and no elastic slack (the
// video Fragmenter's "Branch A" does not apply to audio): every frame is
// as good a cut point as any other, so the boundary is exactly on
// schedule.
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
	nextPTS      int64
}

// NewAudioFragmenter returns an AudioFragmenter using cfg. The first
// segment emitted is index 0, matching the video Fragmenter's own
// numbering convention (the two are independent counters on independent
// timelines; nothing requires segment N of one to cover the same wall-clock
// window as segment N of the other, though in practice they will be
// close, both being cut against the same SEGMENT_MS target).
func NewAudioFragmenter(cfg AudioConfig) *AudioFragmenter {
	return &AudioFragmenter{cfg: cfg, nextIsSegmentStart: true}
}

// SetStartSegmentIndex is the audio counterpart of
// Fragmenter.SetStartSegmentIndex -- see that method's doc comment for why
// L1.6's watchdog restart needs this. Call it, if at all, immediately
// after NewAudioFragmenter and before the first Push.
func (f *AudioFragmenter) SetStartSegmentIndex(index int) { f.segmentIndex = index }

// Push feeds one AAC frame (aacenc.SamplesPerFrame samples, already
// stripped of its ADTS header) at pts (in Timescale ticks -- the caller's
// own running sample counter, so consecutive calls are expected to differ
// by exactly durationTicks). It always returns a Fragment: unlike the
// video Fragmenter, there is no "waiting for the first IDR" state to pass
// through first.
func (f *AudioFragmenter) Push(pts int64, durationTicks uint32, data []byte) *Fragment {
	if f.segmentIndex == 0 && f.seq == 0 && f.nextIsSegmentStart {
		f.segmentStart = pts
	}

	f.seq++
	isStart := f.nextIsSegmentStart
	f.nextIsSegmentStart = false

	fragBytes := cmaf.BuildFragment(cmaf.FragmentParams{
		SequenceNumber:      f.seq,
		BaseMediaDecodeTime: uint64(pts),
		Samples:             []cmaf.Sample{{Duration: durationTicks, IsSync: true, Data: data}},
	})

	frag := &Fragment{
		SequenceNumber: f.seq,
		SegmentIndex:   f.segmentIndex,
		IsSegmentStart: isStart,
		DurationTicks:  durationTicks,
		Bytes:          fragBytes,
	}

	f.nextPTS = pts + int64(durationTicks)
	if uint64(f.nextPTS-f.segmentStart) >= uint64(f.cfg.SegmentDuration) {
		f.segmentIndex++
		f.segmentStart = f.nextPTS
		f.nextIsSegmentStart = true
	}

	return frag
}

// CurrentSegmentIndex returns the index of the segment currently open (or
// most recently opened, if nothing has arrived since). Used by
// Session.Close to know which segment the audio track's own end has just
// closed, for the R2 writer (L1.4) -- the same role
// pipeline.Fragmenter.CurrentSegmentIndex plays for video's Finish.
func (f *AudioFragmenter) CurrentSegmentIndex() int { return f.segmentIndex }
