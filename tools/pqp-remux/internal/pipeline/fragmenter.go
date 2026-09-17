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

// Repeater is what a Fragmenter needs from internal/skipframe to cut a
// part in the middle of a frame gap: a way to turn every real access unit
// into the bytes that should be stored for it (renumbered, once anything
// has been inserted), and a way to mint one more frame repeating the last
// picture.
type Repeater interface {
	// Observe takes each real access unit as it becomes a sample and
	// returns the sample bytes to store.
	Observe(avcc []byte, isIDR bool) []byte
	// Repeat returns one synthesized access unit repeating the last
	// observed picture, or nil when this stream cannot be repeated --
	// in which case the fragmenter keeps its pre-clock-cut behaviour.
	Repeat() []byte
}

// Fragment is one emitted moof+mdat, with enough metadata for the caller
// (the ring/server) to know which segment file it belongs to and whether it
// opens a new one.
type Fragment struct {
	SequenceNumber uint32
	SegmentIndex   int
	IsSegmentStart bool // this fragment is the first part of SegmentIndex, and starts on an IDR
	// Independent is true when the fragment's first sample is an IDR (or
	// otherwise sync), so a player may begin decoding on this part. It is
	// a superset of IsSegmentStart: a mid-segment part that happens to
	// open on an IDR is still independent even though it does not open a
	// new seg-<n>.m4s.
	Independent   bool
	DurationTicks uint32
	Bytes         []byte
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
	// forceSegmentBoundary, when set, makes the next IDR close the open
	// segment even if Config.SegmentDuration has not been reached. Set
	// by ForceSegmentBoundary after a parameter-set change; cleared the
	// moment that IDR is consumed.
	forceSegmentBoundary bool

	// repeat mints the frames that fill a clock-cut gap, and is the ONE
	// switch for the whole behaviour: nil (the default, and what a
	// repeater that refuses this stream amounts to) means every part
	// closes on an access unit, exactly as before clock cutting existed.
	// See SetRepeater.
	repeat Repeater
	// anchorPTS is where the last REAL access unit sits on the
	// publisher's clock, and the only thing IdleFlush extrapolates from.
	// It deliberately does not move for a synthesized frame: heldTicks is
	// measured from the last real frame's ARRIVAL, so measuring the media
	// instant from anything else would double-count the gap on every tick
	// of a long freeze.
	anchorPTS int64
	// synthAhead says the timeline has been published past where the
	// publisher's clock had reached when we last heard from it, because a
	// keep-alive filled the gap with repeat frames. The frame that ends
	// the freeze may then carry an OLDER timestamp than media already
	// published, which is a rewind, which no player tolerates -- so
	// ptsOffset rises to absorb it, exactly as the resume branch does for
	// the pre-clock-cut keep-alive.
	synthAhead bool

	repeatFrames uint64
	clockCuts    uint64
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

// SetRepeater turns CLOCK CUTTING on, by giving this Fragmenter a source
// of frames that repeat the last picture (internal/skipframe). With one
// set, a part closes at exactly Config.PartDuration rather than on
// whichever access unit happens to arrive after the target has passed,
// and the rest of the gap is filled by repeat frames so the timeline
// still has no hole. With none -- the default -- nothing here changes at
// all.
//
// WHY A PART'S LENGTH IS WORTH THIS MUCH MACHINERY. A part's duration is
// the one thing a low-latency playlist states in advance: PART-TARGET.
// Apple's player refuses such a playlist outright -- a fatal parse
// error, not a stall -- when any partial segment runs longer than that,
// or when a NON-terminal one is shorter than 85% of it. Measured against
// the live stream on 2026-09-17: parts were mostly 0.5s but occasionally
// 0.667, 1.1 and 2.25s, because that is how long the presenter's encoder
// went without sending a frame, and PART-TARGET is the session's peak.
// One long part poisons the whole session for iOS and inflates hls.js's
// hold-back for everyone else. Cutting on the clock bounds every part,
// at the cost of publishing frames the publisher never sent -- which is
// only safe because a repeat frame is, by construction, the picture
// already on screen.
//
// Call it whenever the publisher's parameter sets are (re)published: a
// repeat frame is only valid for the parameter sets it was built
// against. Passing nil stops cutting immediately, without losing the
// open part.
func (f *Fragmenter) SetRepeater(r Repeater) { f.repeat = r }

// clockCutting reports whether this Push may cut a part on the clock:
// the flag is on, a repeater is set, and the part target is a real
// duration. Whether the repeater can actually serve THIS stream is asked
// one frame at a time, by Repeat returning nil.
func (f *Fragmenter) clockCutting() bool {
	return f.repeat != nil && f.cfg.PartDuration > 0
}

// RepeatFrames and ClockCuts are the two counters a stats line wants:
// frames synthesized to fill a gap, and parts closed on the clock rather
// than on an access unit. Both stay at zero for a session whose source
// never goes quiet, and for every session with the flag off.
func (f *Fragmenter) RepeatFrames() uint64 { return f.repeatFrames }
func (f *Fragmenter) ClockCuts() uint64    { return f.clockCuts }

// Push feeds the next access unit in PTS order. It returns the fragments
// this AU's arrival closed -- none while a part is still open, one in the
// ordinary case, and several when clock cutting fills a long frame gap
// with repeat frames. ErrWaitingForIDR is returned (with no fragments)
// for every AU before the session's first IDR; that is expected at
// startup, not a stream error.
func (f *Fragmenter) Push(au *h264.AccessUnit) ([]*Fragment, error) {
	if !f.haveFirstIDR {
		if !au.IsIDR {
			return nil, ErrWaitingForIDR
		}
		f.haveFirstIDR = true
		f.segmentStart = au.PTS
		f.partStart = au.PTS
		f.setPending(au, au.PTS)
		return nil, nil
	}

	if f.pending == nil {
		// Resuming after an IdleFlush that published the held AU and
		// left nothing behind. Clock cutting never gets here: it always
		// leaves a repeat frame pending, so the gap is already covered
		// and this branch's whole job (reopen the timeline at
		// resumePTS) is already done.
		//
		// That flush published media through resumePTS without being
		// able to know when the next frame would come, so this AU's
		// SAMPLE opens there -- never before it (a tfdt going backwards
		// is a corrupt stream) and never after it (a hole). Its own true
		// instant is normally later than that, and the difference is
		// paid back through this sample's duration when the NEXT frame
		// arrives, not erased by sliding the timeline (see
		// pendingTruePTS).
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
		if au.IsIDR && (f.forceSegmentBoundary || f.resumePTS-f.segmentStart >= int64(f.cfg.SegmentDuration)) {
			f.forceSegmentBoundary = false
			f.segmentIndex++
			f.segmentStart = f.resumePTS
			f.nextIsSegmentStart = true
		}
		f.setPending(au, f.resumePTS)
		f.pendingTruePTS = au.PTS + f.ptsOffset
		f.anchorPTS = f.pendingTruePTS
		return nil, nil
	}

	pts := au.PTS + f.ptsOffset
	if f.synthAhead {
		// Repeat frames have carried the timeline past the last instant
		// the publisher's clock reached. This AU is the first word from
		// that clock since, and it may well be older than media already
		// published -- the freeze is measured in wall time on our side
		// and in capture time on theirs. Raise the offset so it lands
		// just after what we published: the timeline never rewinds, and
		// (as everywhere else in this file) the offset only ever rises,
		// so no interval of wall time is lost.
		if pts < f.pendingPTS+minSampleTicks {
			f.ptsOffset += f.pendingPTS + minSampleTicks - pts
			pts = f.pendingPTS + minSampleTicks
		}
		f.synthAhead = false
	}
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

	// Close every whole part that fits between the open part's start and
	// this AU, filling the remainder of the gap with repeat frames. Off
	// the clock-cut path (and whenever the stream cannot be repeated)
	// this does nothing at all and the switch below sees exactly what it
	// always saw.
	var out []*Fragment
	cutOnThisAU := false
	if f.clockCutting() {
		out, cutOnThisAU = f.cutToBoundaries(pts, false)
	}
	if !cutOnThisAU {
		duration := uint32(pts - f.pendingPTS)
		f.lastDuration = duration
		f.partSamples = append(f.partSamples, toSample(f.pending, duration))
	}

	segmentElapsed := uint64(pts - f.segmentStart)
	partElapsed := uint64(pts - f.partStart)

	switch {
	case au.IsIDR && (f.forceSegmentBoundary || segmentElapsed >= uint64(f.cfg.SegmentDuration)):
		// This fragment's own duration is what elapsed since the *part*
		// (not the segment) opened: segmentElapsed only decided whether
		// the segment target was reached, and can span several prior
		// parts. forceSegmentBoundary is set by ForceSegmentBoundary
		// when the publisher's SPS/PPS changed: the segment must close
		// on this IDR even if the target has not been reached, so no
		// sample after the new init is ever listed against the old one.
		f.forceSegmentBoundary = false
		if !cutOnThisAU {
			// cutOnThisAU means a part boundary landed exactly on this
			// AU and the part is already closed; closing again here
			// would emit an empty fragment.
			out = append(out, f.closePart(uint32(partElapsed)))
		}
		f.segmentIndex++
		f.segmentStart = pts
		f.partStart = pts
		f.nextIsSegmentStart = true
		f.setPending(au, pts)
		return out, nil

	case !cutOnThisAU && partElapsed >= uint64(f.cfg.PartDuration):
		out = append(out, f.closePart(uint32(partElapsed)))
		f.partStart = pts
		f.setPending(au, pts)
		return out, nil

	default:
		f.setPending(au, pts)
		return out, nil
	}
}

// cutToBoundaries closes every whole part that fits between the open
// part's start and target, so no part this fragmenter emits is ever
// longer than Config.PartDuration. The held sample is truncated at each
// boundary and a synthesized frame repeating it opens the next part, so
// the timeline has no hole: media time still advances exactly one second
// per second, which is the property internal/pipeline's timeline tests
// exist to defend.
//
// It reports whether it consumed the held sample outright, which happens
// when a boundary falls exactly on target: the caller must then NOT give
// that sample a duration of its own.
//
// fillAtTarget makes it take a repeat frame even for that exact-hit case,
// so the fragmenter is left holding something. Push passes false (the
// arriving access unit becomes the held sample a moment later);
// IdleFlush passes true, because nothing is arriving.
//
// The first Repeat that returns nil ends the cutting: a stream this
// pipeline cannot synthesize into (see skipframe.New's refusals) keeps
// the long, honest part it has always produced rather than getting a
// hole. When that happens on the FIRST boundary nothing has been touched
// at all; when it happens partway through a gap (the synthesizer
// disabled itself mid-session, which only a parameter-set change or an
// unmodelled slice does) the parts already closed stand and the
// remainder of the gap goes into one long part, which is the same
// trade-off in a smaller place: the timeline is whole either way.
func (f *Fragmenter) cutToBoundaries(target int64, fillAtTarget bool) ([]*Fragment, bool) {
	var out []*Fragment
	partDur := int64(f.cfg.PartDuration)
	for target >= f.partStart+partDur {
		boundary := f.partStart + partDur
		var rep []byte
		if target > boundary || fillAtTarget {
			if rep = f.repeat.Repeat(); rep == nil {
				return out, false
			}
		}
		f.partSamples = append(f.partSamples, toSample(f.pending, uint32(boundary-f.pendingPTS)))
		out = append(out, f.closePart(uint32(partDur)))
		f.clockCuts++
		f.partStart = boundary
		if rep == nil {
			return out, true
		}
		f.pending = &h264.AccessUnit{PTS: boundary, AVCC: rep}
		f.pendingPTS = boundary
		f.pendingTruePTS = boundary
		f.repeatFrames++
	}
	return out, false
}

// setPending holds au as the next sample, published at pts, after giving
// the repeater (if any) its chance to renumber the slices -- which it has
// to do for every real access unit that follows an inserted frame, or the
// decoder sees a gap in frame_num. Off the ordinary path the published
// instant IS the true one: only a resume after an IdleFlush separates the
// two (see pendingTruePTS), and that branch sets both itself.
func (f *Fragmenter) setPending(au *h264.AccessUnit, pts int64) {
	if f.repeat != nil {
		held := *au
		held.AVCC = f.repeat.Observe(au.AVCC, au.IsIDR)
		held.Units = nil // the parsed mirror would be stale after a rewrite
		au = &held
	}
	f.pending = au
	f.pendingPTS = pts
	f.pendingTruePTS = pts
	f.anchorPTS = pts
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
// LIMIT, STATED PLAINLY, WITH NO REPEATER SET: this publishes
// the held AU ONCE per idle episode. A freeze much longer than the idle
// allowance leaves the video timeline held at that frame while the audio
// track (which is paced off the wall clock and so never goes idle) keeps
// producing parts. Publishing more video parts than that would mean
// emitting a coded frame the publisher never sent twice, which is only
// safe for an IDR. The frame that ends the freeze closes that gap in one
// part, so the timeline is whole again the moment the source speaks.
//
// WITH CLOCK CUTTING ON, that limit is gone, because the thing it was
// waiting for now exists: internal/skipframe writes a frame that says
// "the picture did not change", which is neither a guess nor a
// duplicate of a coded frame the publisher sent. A freeze then produces
// one part per part target for as long as it lasts, each exactly
// PART-TARGET long, and the fragmenter keeps holding the last repeat
// rather than emptying itself.
func (f *Fragmenter) IdleFlush(heldTicks int64) []*Fragment {
	if !f.haveFirstIDR || f.pending == nil || heldTicks <= 0 {
		return nil
	}
	// Extrapolate from where the last REAL access unit belongs on the
	// publisher's clock, not from where the held sample was published:
	// those differ for one sample after a previous flush (see
	// pendingTruePTS) and for every synthesized frame (see anchorPTS),
	// and measuring from the published instant is how consecutive quiet
	// spells each lost the time between the last flush and the frame
	// that followed it.
	nowPTS := f.anchorPTS + heldTicks
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

	if f.clockCutting() {
		// Publish one bounded part per part target that has passed, each
		// opening on a frame that repeats the picture already on screen,
		// and go on holding the last of them. This is what lifts the
		// documented "one part per idle episode" limit: a source frozen
		// for a minute now keeps producing parts for a minute, instead
		// of holding the video timeline while audio runs on, and every
		// one of those parts is exactly PART-TARGET long.
		if out, _ := f.cutToBoundaries(nowPTS, true); len(out) > 0 {
			f.synthAhead = true
			return out
		}
		// The stream cannot be repeated (skipframe refused it, or the
		// parameter sets changed under it). Fall through to the honest
		// single-part flush below, which is what this fragmenter did
		// before clock cutting existed.
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
	return []*Fragment{frag}
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
	if f.clockCutting() {
		// The last part of a stream is terminal, so it may be SHORT --
		// but "exceeds PART-TARGET" is fatal for a partial segment
		// wherever it sits, so an estimate is not allowed to push this
		// one past the target the rest of the session held to.
		if room := int64(f.cfg.PartDuration) - (f.pendingPTS - f.partStart); room >= minSampleTicks && int64(duration) > room {
			duration = uint32(room)
		}
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

// ForceSegmentBoundary arms the next IDR to close the currently open
// segment regardless of Config.SegmentDuration. Call it when the
// publisher's SPS/PPS have changed and the AU about to be Push'd is the
// IDR that carries the new sets: Push then seals the old segment cleanly
// (timeline continues — no rewind) and opens the next one on that IDR.
//
// It is a no-op before the session's first IDR (there is no open segment
// to close). It does not itself emit a Fragment.
func (f *Fragmenter) ForceSegmentBoundary() {
	if f.haveFirstIDR {
		f.forceSegmentBoundary = true
	}
}

func (f *Fragmenter) closePart(durationTicks uint32) *Fragment {
	samples := f.partSamples
	f.partSamples = nil
	f.seq++

	isStart := f.nextIsSegmentStart
	f.nextIsSegmentStart = false

	independent := isStart
	if len(samples) > 0 && samples[0].IsSync {
		independent = true
	}

	fragBytes := cmaf.BuildFragment(cmaf.FragmentParams{
		SequenceNumber:      f.seq,
		BaseMediaDecodeTime: uint64(f.partStart),
		Samples:             samples,
	})

	return &Fragment{
		SequenceNumber: f.seq,
		SegmentIndex:   f.segmentIndex,
		IsSegmentStart: isStart,
		Independent:    independent,
		DurationTicks:  durationTicks,
		Bytes:          fragBytes,
	}
}

func toSample(au *h264.AccessUnit, duration uint32) cmaf.Sample {
	return cmaf.Sample{Duration: duration, IsSync: au.IsIDR, Data: au.AVCC}
}
