package cmaf

// Sample is one CMAF sample: exactly one access unit's AVCC bytes (the
// depacketizer's AccessUnit.AVCC, unmodified — H.264 passthrough means this
// muxer never rewrites a NAL byte). Duration is in the fragment's
// timescale units (h264.ClockRate, so no rescaling from the RTP clock).
//
// PTS/DTS are assumed equal: WebRTC real-time encoders (Chromium's screen
// share included) do not reorder frames, so there are no B-slices and no
// composition-time offset to carry. If that ever stops being true for some
// publisher, trun's sample-composition-time-offsets-present flag is where
// it would be added; nothing else in this file would need to change.
type Sample struct {
	Duration uint32
	IsSync   bool
	Data     []byte
}

// sampleFlagsSync / sampleFlagsNonSync are ISO/IEC 14496-12 §8.8.3.1
// sample_flags words. These two values (sample_depends_on=2 for a sync
// sample with no dependents-of-its-own marked, sample_depends_on=1 plus
// sample_is_non_sync_sample=1 otherwise) are what every fMP4 muxer emits
// for this exact case; there is no third case in a passthrough stream with
// no B-slices.
const (
	sampleFlagsSync    uint32 = 0x02000000
	sampleFlagsNonSync uint32 = 0x01010000
)

// FragmentParams describes one CMAF fragment: a `moof` plus its `mdat`.
// This is used for both an LL-HLS *part* (one or more fragments per
// segment, only the first of which must start on an IDR) and a
// conventional *segment* boundary (section 1/3 of the plan): the caller
// (internal/pipeline) decides which fragments start a new segment file and
// which are appended into the currently-open one; BuildFragment itself has
// no notion of "segment", only "these samples, this sequence number, this
// base decode time".
type FragmentParams struct {
	// SequenceNumber is `mfhd`'s sequence_number: strictly increasing by 1
	// across every fragment this session ever emits (init segment does not
	// count), regardless of which segment file the fragment lands in.
	SequenceNumber uint32
	// BaseMediaDecodeTime is `tfdt`'s base decode time, in Timescale units:
	// the decode timestamp of this fragment's first sample. Must be
	// monotonically non-decreasing fragment over fragment.
	BaseMediaDecodeTime uint64
	Samples             []Sample
}

// BuildFragment renders one moof+mdat pair. It panics if Samples is empty:
// an empty fragment is a caller bug (the pipeline should never close a part
// with nothing in it), not a runtime condition to plumb an error return
// through.
func BuildFragment(p FragmentParams) []byte {
	if len(p.Samples) == 0 {
		panic("cmaf: BuildFragment called with zero samples")
	}

	// moof's own length does not depend on the data_offset value we choose
	// (it is a fixed-width field), so build once with a placeholder to
	// learn the length, then rebuild with the true offset. This avoids
	// hardcoding the byte position of trun's data_offset field, which
	// would silently go stale if tfhd/tfdt/trun's flags ever change.
	placeholder := buildMoof(p, 0)
	dataOffset := uint32(len(placeholder) + 8) // + mdat's own box header
	moof := buildMoof(p, dataOffset)

	mdat := box("mdat", concatSamples(p.Samples))
	return concat(moof, mdat)
}

func concatSamples(samples []Sample) []byte {
	n := 0
	for _, s := range samples {
		n += len(s.Data)
	}
	out := make([]byte, 0, n)
	for _, s := range samples {
		out = append(out, s.Data...)
	}
	return out
}

func buildMoof(p FragmentParams, dataOffset uint32) []byte {
	mfhd := fullBox("mfhd", 0, 0, u32(p.SequenceNumber))
	traf := box("traf", concat(
		buildTfhd(),
		buildTfdt(p.BaseMediaDecodeTime),
		buildTrun(p.Samples, dataOffset),
	))
	return box("moof", concat(mfhd, traf))
}

func buildTfhd() []byte {
	const flagsDefaultBaseIsMoof = 0x020000
	return fullBox("tfhd", 0, flagsDefaultBaseIsMoof, u32(TrackID))
}

func buildTfdt(baseMediaDecodeTime uint64) []byte {
	// Version 1 (64-bit) throughout: a 32-bit baseMediaDecodeTime in the
	// 90 kHz RTP clock wraps after about 13.25 hours, well inside a single
	// all-day stream's lifetime.
	return fullBox("tfdt", 1, 0, u64(baseMediaDecodeTime))
}

func buildTrun(samples []Sample, dataOffset uint32) []byte {
	const flagsDataOffsetPresent = 0x000001
	const flagsSampleDurationPresent = 0x000100
	const flagsSampleSizePresent = 0x000200
	const flagsSampleFlagsPresent = 0x000400
	flags := uint32(flagsDataOffsetPresent | flagsSampleDurationPresent | flagsSampleSizePresent | flagsSampleFlagsPresent)

	body := concat(u32(uint32(len(samples))), u32(dataOffset))
	for _, s := range samples {
		flagsWord := sampleFlagsNonSync
		if s.IsSync {
			flagsWord = sampleFlagsSync
		}
		body = append(body, u32(s.Duration)...)
		body = append(body, u32(uint32(len(s.Data)))...)
		body = append(body, u32(flagsWord)...)
	}
	return fullBox("trun", 0, flags, body)
}
