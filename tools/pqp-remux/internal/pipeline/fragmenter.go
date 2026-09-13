// Package pipeline turns a stream of H.264 access units into the CMAF
// fragments a ring/server can publish: it owns the part/segment boundary
// decision (section 3 and section 1 of the plan), cmaf owns the box bytes.
package pipeline

import (
	"errors"

	"github.com/rafaelcg/pqp/tools/pqp-remux/internal/cmaf"
	"github.com/rafaelcg/pqp/tools/pqp-remux/internal/h264"
)

// Config controls where parts and segments are cut. Both durations are in
// Timescale ticks, matching h264.ClockRate so a caller never rescales an
// AccessUnit's PTS before calling Push.
type Config struct {
	Timescale       uint32
	PartDuration    uint32 // e.g. 45000 == 500ms at 90kHz
	SegmentDuration uint32 // e.g. 360000 == 4s at 90kHz
}

// Fragment is one emitted moof+mdat, with enough metadata for the caller
// (the ring/server) to know which segment file it belongs to and whether it
// opens a new one.
type Fragment struct {
	SequenceNumber uint32
	SegmentIndex   int
	IsSegmentStart bool // this fragment is the first part of SegmentIndex, and starts on an IDR
	DurationTicks  uint32
	Bytes          []byte
}

var (
	// ErrWaitingForIDR is returned (not fatal) by Push while the
	// fragmenter has not yet seen the first IDR of the session: nothing
	// before it can start a valid CMAF segment, so those access units are
	// dropped on purpose.
	ErrWaitingForIDR = errors.New("pipeline: waiting for the session's first IDR")
)

// Fragmenter accumulates access units into CMAF parts and decides, per
// section 3's "Branch A, free" rule, when a part is also a segment
// boundary: on the first IDR at or after Config.SegmentDuration since the
// segment opened. Nothing here sends a PLI or knows about
// KEYFRAME_POLICY — that is internal/keyframe's job, upstream of this
// type; the fragmenter only reacts to whichever IDRs actually arrive, which
// is exactly what "elastic segment duration" means.
//
// Not safe for concurrent use; one Fragmenter per subscribed video track.
type Fragmenter struct {
	cfg Config

	seq                uint32
	segmentIndex       int
	nextIsSegmentStart bool

	haveFirstIDR bool
	segmentStart int64
	partStart    int64
	partSamples  []cmaf.Sample

	pending      *h264.AccessUnit
	lastDuration uint32
}

// NewFragmenter returns a Fragmenter using cfg. The first segment emitted
// is index 0.
func NewFragmenter(cfg Config) *Fragmenter {
	return &Fragmenter{cfg: cfg, nextIsSegmentStart: true}
}

// Push feeds the next access unit in PTS order. It returns a Fragment
// whenever this AU's arrival closes a part (which may also close a
// segment), or nil while a part is still open. ErrWaitingForIDR is
// returned (with a nil Fragment) for every AU before the session's first
// IDR; that is expected at startup, not a stream error.
func (f *Fragmenter) Push(au *h264.AccessUnit) (*Fragment, error) {
	if !f.haveFirstIDR {
		if !au.IsIDR {
			return nil, ErrWaitingForIDR
		}
		f.haveFirstIDR = true
		f.segmentStart = au.PTS
		f.partStart = au.PTS
		f.pending = au
		return nil, nil
	}

	prev := f.pending
	duration := uint32(au.PTS - prev.PTS)
	f.lastDuration = duration
	f.partSamples = append(f.partSamples, toSample(prev, duration))

	segmentElapsed := uint64(au.PTS - f.segmentStart)
	partElapsed := uint64(au.PTS - f.partStart)

	switch {
	case au.IsIDR && segmentElapsed >= uint64(f.cfg.SegmentDuration):
		// This fragment's own duration is what elapsed since the *part*
		// (not the segment) opened: segmentElapsed only decided whether
		// the segment target was reached, and can span several prior
		// parts.
		frag := f.closePart(uint32(partElapsed))
		f.segmentIndex++
		f.segmentStart = au.PTS
		f.partStart = au.PTS
		f.nextIsSegmentStart = true
		f.pending = au
		return frag, nil

	case partElapsed >= uint64(f.cfg.PartDuration):
		frag := f.closePart(uint32(partElapsed))
		f.partStart = au.PTS
		f.pending = au
		return frag, nil

	default:
		f.pending = au
		return nil, nil
	}
}

// Flush closes whatever part is still open, using the previous sample's
// duration for the final (still-pending) sample since there is no next AU
// to derive it from. It is a no-op (returns nil, nil) if nothing is
// pending. Call it once, at end of stream.
func (f *Fragmenter) Flush() (*Fragment, error) {
	if f.pending == nil {
		return nil, nil
	}
	duration := f.lastDuration
	if duration == 0 {
		duration = f.cfg.Timescale / 30 // best-effort: assume 30fps
	}
	f.partSamples = append(f.partSamples, toSample(f.pending, duration))
	total := uint32(uint64(f.pending.PTS) + uint64(duration) - uint64(f.partStart))
	frag := f.closePart(total)
	f.pending = nil
	return frag, nil
}

func (f *Fragmenter) closePart(durationTicks uint32) *Fragment {
	samples := f.partSamples
	f.partSamples = nil
	f.seq++

	isStart := f.nextIsSegmentStart
	f.nextIsSegmentStart = false

	fragBytes := cmaf.BuildFragment(cmaf.FragmentParams{
		SequenceNumber:      f.seq,
		BaseMediaDecodeTime: uint64(f.partStart),
		Samples:             samples,
	})

	return &Fragment{
		SequenceNumber: f.seq,
		SegmentIndex:   f.segmentIndex,
		IsSegmentStart: isStart,
		DurationTicks:  durationTicks,
		Bytes:          fragBytes,
	}
}

func toSample(au *h264.AccessUnit, duration uint32) cmaf.Sample {
	return cmaf.Sample{Duration: duration, IsSync: au.IsIDR, Data: au.AVCC}
}
