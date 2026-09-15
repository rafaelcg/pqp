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

// maxFragmentTicks is the largest tick count a Fragment's own duration
// fields (uint32, 90 kHz) can carry: about 13.25 hours.
const maxFragmentTicks = int64(^uint32(0))

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

	// pendingPTS is f.pending's PTS ON THIS FRAGMENTER'S OWN TIMELINE,
	// which is the incoming AU's PTS plus ptsOffset. It exists because
	// IdleFlush publishes a part whose media time was derived from the
	// WALL clock rather than from a next access unit that has not
	// arrived, and the resumed AU afterwards has to be placed exactly
	// where that published part ended -- see ptsOffset.
	pendingPTS int64
	// ptsOffset is added to every incoming AU's PTS. It is zero for a
	// session that never goes idle (the overwhelmingly common case, and
	// the one every pre-existing test exercises), and is re-derived on
	// the first access unit after an IdleFlush so that AU lands exactly
	// on resumePTS: the flush already published media up to that
	// instant, and the publisher's own RTP clock has no idea we did
	// that. Without the re-derivation the resumed AU would either
	// overlap the published part (tfdt going backwards, which no player
	// tolerates) or leave a hole in the timeline.
	ptsOffset int64
	// resumePTS is the fragmenter-timeline instant the last IdleFlush
	// published up to, and therefore where the next part must begin.
	// Meaningful only while pending == nil and haveFirstIDR is true.
	resumePTS int64
}

// NewFragmenter returns a Fragmenter using cfg. The first segment emitted
// is index 0.
func NewFragmenter(cfg Config) *Fragmenter {
	return &Fragmenter{cfg: cfg, nextIsSegmentStart: true}
}

// SetStartSegmentIndex overrides the index the FIRST segment this
// Fragmenter ever closes will carry (0 by default, see NewFragmenter).
// Call it, if at all, immediately after NewFragmenter and before the
// first Push -- L1.6's control-plane watchdog restart uses this
// (internal/session.Session.SetStartSegmentIndex) so a replacement
// pipeline's segment numbering (and therefore its R2 object keys)
// continues from where a stalled predecessor left off, rather than
// starting back at 0 and silently overwriting objects the predecessor
// already uploaded (Farol review, PR #584).
func (f *Fragmenter) SetStartSegmentIndex(index int) { f.segmentIndex = index }

// SetStartSequence makes the NEXT part this Fragmenter emits carry
// sequence number next, instead of 1. It is the part-level counterpart of
// SetStartSegmentIndex and exists for the same reason, one layer down: a
// watchdog restart (internal/control's ManagedSession.restart) replaces
// the pipeline while the SESSION, and therefore its URL space, survives.
// Segment indices were already carried across so a replacement never
// re-PUTs an R2 key its predecessor wrote; part sequence numbers were not,
// because until state.json (internal/llstate) nothing outside this process
// ever saw a part's name. Now the edge Worker advertises
// "part-<seq>.m4s" to players and its own cache keys that path WITHOUT the
// token, deliberately and immutably -- so a replacement pipeline starting
// back at 1 would hand out names whose bytes are already cached from the
// pipeline before it, and a player would be served the predecessor's media
// for the life of that cache entry (Farol review, PR #621).
//
// Call it, if at all, immediately after NewFragmenter and before the first
// Push. next == 0 is a no-op: there is no part zero (closePart increments
// BEFORE using the counter, so the first part of a fresh session is 1), so
// zero means "no predecessor", which is exactly the default.
func (f *Fragmenter) SetStartSequence(next uint32) {
	if next > 0 {
		f.seq = next - 1
	}
}

// CurrentSequence returns the sequence number of the LAST part this
// Fragmenter emitted (0 before the first one). Read after Close, it is
// what a replacement pipeline's SetStartSequence resumes past -- the same
// role CurrentSegmentIndex plays for segments.
func (f *Fragmenter) CurrentSequence() uint32 { return f.seq }

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
		f.pendingPTS = au.PTS
		return nil, nil
	}

	if f.pending == nil {
		// Resuming after an IdleFlush: that flush already published
		// media through resumePTS, so this AU opens the next part
		// exactly there. Re-derive ptsOffset rather than trusting the
		// publisher's clock, which knows nothing about the part we
		// synthesized -- see the ptsOffset field's doc comment.
		f.ptsOffset = f.resumePTS - au.PTS
		f.partStart = f.resumePTS
		// A quiet source also spends real time inside the open segment,
		// so the segment target can pass while nothing is arriving. If
		// the frame that ends the silence is itself an IDR, it starts
		// the next segment here -- the ordinary branch below can never
		// do it for this AU, since that branch judges the AU AFTER the
		// pending one. Without this, a freeze longer than the segment
		// target pushed the boundary out to the IDR after the next one,
		// which is how EXT-X-TARGETDURATION creeps.
		if au.IsIDR && f.resumePTS-f.segmentStart >= int64(f.cfg.SegmentDuration) {
			f.segmentIndex++
			f.segmentStart = f.resumePTS
			f.nextIsSegmentStart = true
		}
		f.pending = au
		f.pendingPTS = f.resumePTS
		return nil, nil
	}

	pts := au.PTS + f.ptsOffset
	prev := f.pending
	duration := uint32(pts - f.pendingPTS)
	f.lastDuration = duration
	f.partSamples = append(f.partSamples, toSample(prev, duration))

	segmentElapsed := uint64(pts - f.segmentStart)
	partElapsed := uint64(pts - f.partStart)

	switch {
	case au.IsIDR && segmentElapsed >= uint64(f.cfg.SegmentDuration):
		// This fragment's own duration is what elapsed since the *part*
		// (not the segment) opened: segmentElapsed only decided whether
		// the segment target was reached, and can span several prior
		// parts.
		frag := f.closePart(uint32(partElapsed))
		f.segmentIndex++
		f.segmentStart = pts
		f.partStart = pts
		f.nextIsSegmentStart = true
		f.pending = au
		f.pendingPTS = pts
		return frag, nil

	case partElapsed >= uint64(f.cfg.PartDuration):
		frag := f.closePart(uint32(partElapsed))
		f.partStart = pts
		f.pending = au
		f.pendingPTS = pts
		return frag, nil

	default:
		f.pending = au
		f.pendingPTS = pts
		return nil, nil
	}
}

// HasPending reports whether an access unit is currently held, waiting for
// the next one to give it a duration. False before the session's first IDR
// and after an IdleFlush has published the held AU.
func (f *Fragmenter) HasPending() bool { return f.pending != nil }

// IdleFlush publishes the currently open part EARLY, without waiting for
// the next access unit to arrive, stretching the held AU to cover heldTicks
// (how long that AU has been held, measured on the wall clock and converted
// into this fragmenter's timescale by the caller).
//
// WHY THIS EXISTS. Everything else in this file is access-unit driven: a
// part closes when an AU arrives past the part target, because only the NEXT
// AU can say how long the previous one lasted. A Chrome TAB share of static
// content sends no new frames at all while nothing on the page changes, so
// there is no next AU, so no part closes, so the playlist stops advancing
// and the viewer's video buffer runs dry at the last published part. On
// 2026-09-15 that also tripped the control plane's PART_STUCK_MS watchdog
// (3s) twice on one production session, which restarted the pipeline and
// then demoted the party off the low-latency rung -- for a source that was
// behaving perfectly normally.
//
// The content it publishes is EXACTLY what the ordinary path would have
// published anyway: `Push` gives the held AU a duration of `next.PTS -
// held.PTS`, which for a five-second freeze is a five-second sample. This
// only emits it sooner, so a player's buffer covers the freeze instead of
// ending at its start. Nothing is duplicated and nothing is invented: one
// access unit is published exactly once, with the duration it really had.
//
// It returns nil (does nothing at all) when there is no held AU, before the
// session's first IDR, or when heldTicks has not yet reached the part
// target -- so a caller may tick it as often as it likes.
//
// LIMIT, STATED PLAINLY: this publishes the held AU ONCE per idle episode.
// A freeze much longer than the part target leaves the video timeline
// held at that frame while the audio track (which is paced off the wall
// clock and so never goes idle) keeps producing parts. Publishing more
// video parts than that would mean emitting a coded frame the publisher
// never sent twice, which is only safe for an IDR and is not something
// this fragmenter does.
func (f *Fragmenter) IdleFlush(heldTicks int64) *Fragment {
	if !f.haveFirstIDR || f.pending == nil || heldTicks <= 0 {
		return nil
	}
	nowPTS := f.pendingPTS + heldTicks
	partElapsed := nowPTS - f.partStart
	if partElapsed < int64(f.cfg.PartDuration) {
		return nil
	}
	// A sample duration and a fragment duration are both uint32 ticks, so
	// refuse rather than wrap. Only reachable if the process was
	// suspended for hours between ticks (the caller ticks every 100ms and
	// flushes at the first tick past the part target, so heldTicks is
	// ordinarily a part target plus a tick). Refusing leaves the access
	// unit held, which is exactly the pre-keep-alive behaviour: the
	// ordinary Push path still gives it its true duration when a frame
	// finally arrives.
	if heldTicks > maxFragmentTicks || partElapsed > maxFragmentTicks {
		return nil
	}

	// lastDuration is deliberately NOT updated: it is Flush's estimate
	// for a trailing sample with no successor, and the real inter-frame
	// gap is a far better estimate of that than however long this
	// particular freeze happened to last.
	f.partSamples = append(f.partSamples, toSample(f.pending, uint32(heldTicks)))

	frag := f.closePart(uint32(partElapsed))
	f.partStart = nowPTS
	f.resumePTS = nowPTS
	f.pending = nil
	return frag
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
	total := uint32(uint64(f.pendingPTS) + uint64(duration) - uint64(f.partStart))
	frag := f.closePart(total)
	f.pending = nil
	return frag, nil
}

// CurrentSegmentIndex returns the index of the segment currently open (or
// most recently opened, if nothing has arrived since). Used by
// Session.Finish (internal/session) to know which segment the stream
// ending has just closed, for the R2 writer (L1.4).
func (f *Fragmenter) CurrentSegmentIndex() int { return f.segmentIndex }

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
