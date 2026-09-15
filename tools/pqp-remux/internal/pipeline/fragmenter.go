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

	// pendingPTS is where f.pending's sample is PUBLISHED on this
	// fragmenter's timeline: the instant its tfdt places it, and the
	// instant the next sample's duration is measured from. It is the
	// access unit's own true instant (pendingTruePTS) in every ordinary
	// case, and only differs immediately after an IdleFlush -- see
	// pendingTruePTS.
	pendingPTS int64
	// pendingTruePTS is where f.pending really belongs on the
	// publisher's clock (its PTS plus ptsOffset). The two separate for
	// exactly one sample after an IdleFlush: that flush published media
	// through resumePTS without knowing when the next frame would
	// arrive, so the frame that ends the quiet spell is PUBLISHED at
	// resumePTS (no hole, no rewind) while its TRUE instant is later.
	// Its duration then runs from resumePTS to the following frame's
	// true instant, which pays the difference back instead of erasing
	// it, and the timeline is exactly on the publisher's clock again
	// from that frame on.
	//
	// THIS IS THE 2026-09-15 DRIFT, AND WHY THE DISTINCTION EXISTS. The
	// first version of the keep-alive re-derived ptsOffset on resume
	// (ptsOffset = resumePTS - au.PTS), which slides the WHOLE timeline
	// back so the resumed AU lands on resumePTS. That hides the gap by
	// throwing the gap away: every quiet second published only the
	// ~0.5s the flush had guessed and discarded the rest. Production,
	// 15:10-15:15 UTC that day, on a Chrome tab share at 1.4 frames/s:
	// the video timeline advanced 29.0s of media in 53.8s of wall
	// (ratio 0.54) while audio, which never idles, ran at 0.98. A/V
	// drift apart without bound, the player's buffer accounting breaks,
	// and every blocking playlist reload times out because "the next
	// part" takes a whole wall second to appear. The rule that replaces
	// it: media time is the publisher's clock, ptsOffset never
	// DECREASES, and no interval of wall time is ever dropped from the
	// timeline.
	pendingTruePTS int64
	// ptsOffset is added to every incoming AU's PTS. It is zero for a
	// session whose publisher clock never contradicts what we already
	// published, which is every ordinary session. It is RAISED (never
	// lowered) when an access unit lands before media this fragmenter
	// has already published -- a resume whose RTP timestamp is older
	// than the keep-alive's estimate, or a publisher whose clock jumps
	// backwards -- because a tfdt going backwards is a corrupt stream
	// and no player tolerates it. Raising it shifts the timeline
	// forward by a constant, which costs nothing: media time still
	// advances one second per second, which is the only property that
	// matters. LOWERING it is what stole time, and is what this type no
	// longer does anywhere. See pendingTruePTS.
	ptsOffset int64
	// resumePTS is the fragmenter-timeline instant the last IdleFlush
	// published up to, and therefore where the next part must begin.
	// Meaningful only while pending == nil and haveFirstIDR is true.
	resumePTS int64
}

// minSampleTicks is the shortest duration a sample may carry. A sample of
// zero (or, through uint32 conversion, of four billion) ticks is what an
// access unit whose PTS did not advance would otherwise produce, and
// llstate floors a part at a millisecond for the same reason: a
// degenerate sample must not be able to blank a stream.
const minSampleTicks = 1

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
		f.pendingTruePTS = au.PTS
		return nil, nil
	}

	if f.pending == nil {
		// Resuming after an IdleFlush. That flush published media
		// through resumePTS without being able to know when the next
		// frame would come, so this AU's SAMPLE opens there -- never
		// before it (a tfdt going backwards is a corrupt stream) and
		// never after it (a hole). Its own true instant is normally
		// later than that, and the difference is paid back through
		// this sample's duration when the NEXT frame arrives, not
		// erased by sliding the timeline (see pendingTruePTS).
		//
		// ptsOffset only rises, and only far enough to keep the
		// publisher's clock from landing behind media already
		// published: a frame captured before the flush instant but
		// delivered after it (an ordinary latency spike) or a
		// publisher whose clock jumped backwards.
		if au.PTS+f.ptsOffset < f.resumePTS {
			f.ptsOffset = f.resumePTS - au.PTS
		}
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
		f.pendingTruePTS = au.PTS + f.ptsOffset
		return nil, nil
	}

	pts := au.PTS + f.ptsOffset
	// The timeline never stands still and never rewinds. An access unit
	// whose PTS did not advance past the sample already open (a repeated
	// timestamp, a publisher clock that stepped back) would otherwise
	// produce a zero-tick sample or, through the uint32 conversion
	// below, a four-billion-tick one. Clamping here and NOT touching
	// ptsOffset is deliberate: the clamp is local to this sample, so a
	// publisher whose clock merely stumbled is back on its own timeline
	// as soon as it passes what we published, rather than carrying a
	// permanent shift.
	if pts < f.pendingPTS+minSampleTicks {
		pts = f.pendingPTS + minSampleTicks
	}
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
		f.setPending(au, pts)
		return frag, nil

	case partElapsed >= uint64(f.cfg.PartDuration):
		frag := f.closePart(uint32(partElapsed))
		f.partStart = pts
		f.setPending(au, pts)
		return frag, nil

	default:
		f.setPending(au, pts)
		return nil, nil
	}
}

// setPending holds au as the next sample, published at pts. Off the
// ordinary path the published instant IS the true one: only a resume
// after an IdleFlush separates the two (see pendingTruePTS), and that
// branch sets both itself.
func (f *Fragmenter) setPending(au *h264.AccessUnit, pts int64) {
	f.pending = au
	f.pendingPTS = pts
	f.pendingTruePTS = pts
}

// HasPending reports whether an access unit is currently held, waiting for
// the next one to give it a duration. False before the session's first IDR
// and after an IdleFlush has published the held AU.
func (f *Fragmenter) HasPending() bool { return f.pending != nil }

// IdleFlush publishes the currently open part EARLY, without waiting for
// the next access unit to arrive, stretching the held AU to cover
// heldTicks (how long that AU has been held, measured on the wall clock
// and converted into this fragmenter's timescale by the caller).
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
// IT IS A LAST RESORT, NOT A CADENCE. The caller (internal/session's
// idleTick) waits a whole idle allowance -- two part targets, floored at a
// second -- before it calls this at all, so an ordinary slow source (a
// slide deck, a paused film, the 1.4 frames/s a static Chrome tab
// produces) never reaches it: its parts simply close on the next real
// frame and carry that frame's true duration, which means they may run
// LONGER than PART-TARGET. That is the honest answer and it is the point.
// Publishing on a fixed cadence instead means guessing a duration, and a
// guessed duration is a lie the timeline has to pay for somewhere.
//
// WHAT IT PUBLISHES, AND WHY NOTHING IS LOST. The held AU is emitted once,
// with the duration it really had up to this instant: from where its
// sample was published (pendingPTS) to where the publisher's clock has
// reached (pendingTruePTS + heldTicks). The frame that eventually ends the
// quiet spell opens the next part exactly where this one ended and carries
// the remainder in ITS duration -- see Push's resume branch. So over any
// window the media published equals the wall time that passed, whatever
// the frame rate. Nothing is duplicated and nothing is invented: one
// access unit, published exactly once, and never a second of wall time
// dropped.
//
// It returns nil (does nothing at all) when there is no held AU, before the
// session's first IDR, or when the part target has not been reached -- so a
// caller may tick it as often as it likes.
//
// LIMIT, STATED PLAINLY: this publishes the held AU ONCE per idle episode.
// A freeze much longer than the idle allowance leaves the video timeline
// held at that frame while the audio track (which is paced off the wall
// clock and so never goes idle) keeps producing parts. Publishing more
// video parts than that would mean emitting a coded frame the publisher
// never sent twice, which is only safe for an IDR and is not something
// this fragmenter does. The frame that ends the freeze closes that gap in
// one part, so the timeline is whole again the moment the source speaks.
func (f *Fragmenter) IdleFlush(heldTicks int64) *Fragment {
	if !f.haveFirstIDR || f.pending == nil || heldTicks <= 0 {
		return nil
	}
	// Extrapolate from where the held AU really belongs on the
	// publisher's clock, not from where its sample was published: those
	// differ for exactly one sample after a previous flush (see
	// pendingTruePTS), and measuring from the published instant is how
	// consecutive quiet spells each lost the time between the last
	// flush and the frame that followed it.
	from := f.pendingTruePTS
	if f.pendingPTS > from {
		from = f.pendingPTS
	}
	nowPTS := from + heldTicks
	partElapsed := nowPTS - f.partStart
	if partElapsed < int64(f.cfg.PartDuration) {
		return nil
	}
	sampleTicks := nowPTS - f.pendingPTS
	// A sample duration and a fragment duration are both uint32 ticks, so
	// refuse rather than wrap. Only reachable if the process was
	// suspended for hours between ticks (the caller ticks every 100ms and
	// flushes at the first tick past the idle allowance, so heldTicks is
	// ordinarily an allowance plus a tick). Refusing leaves the access
	// unit held, which is exactly the pre-keep-alive behaviour: the
	// ordinary Push path still gives it its true duration when a frame
	// finally arrives.
	if sampleTicks > maxFragmentTicks || partElapsed > maxFragmentTicks {
		return nil
	}

	// lastDuration is deliberately NOT updated: it is Flush's estimate
	// for a trailing sample with no successor, and the real inter-frame
	// gap is a far better estimate of that than however long this
	// particular freeze happened to last.
	f.partSamples = append(f.partSamples, toSample(f.pending, uint32(sampleTicks)))

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
