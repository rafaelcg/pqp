package control

import (
	"fmt"
	"math"
	"strings"
	"time"

	"github.com/rafaelcg/pqp/tools/pqp-remux/internal/session"
)

// WatchdogConfig controls the stall/demote ladder, docs/plans/LL_HLS.md §5.
type WatchdogConfig struct {
	// FirstPartTimeoutMs: no part has EVER been produced (the presenter
	// has not started sharing yet, or the room has not been joined yet)
	// for this long -> demote with reason "no-video". Deliberately its
	// own, much longer timer than PartStuckMs (Farol review, PR #584): a
	// session waiting for someone to click "share screen" is not stalled,
	// and PartStuckMs's 3s would demote it long before a real presenter
	// could ever join. Default DefaultFirstPartTimeoutMs (60s).
	FirstPartTimeoutMs int64
	// PartStuckMs: a part HAS already arrived at least once, and then no
	// new one for this long -> restart the session's pipeline once.
	// Default DefaultPartStuckMs (3000ms, "six parts" per the plan).
	//
	// It is a FLOOR, not the whole answer: partStuckThreshold below is
	// what the ladder actually uses, and it also has to clear the worst
	// legitimate part gap, which depends on PartMs and ReorderHoldMs.
	PartStuckMs int64
	// DemoteWindowMs: a second stall within this many ms of the last
	// restart demotes instead of restarting again. A stall further apart
	// than this is treated as a fresh problem, worth one more restart --
	// see evaluateWatchdog's own doc comment.
	DemoteWindowMs int64
	// VideoIdleMaxMs bounds how long a QUIET source (sourceIdle) is
	// forgiven before the ordinary restart-then-demote ladder is allowed
	// to run on it anyway. 0 means unbounded.
	//
	// It exists because "no RTP at all" has two causes that look
	// identical from this end, and only one of them is benign: the
	// publisher genuinely sending nothing (a static tab share -- forgive
	// it), and OUR OWN receive path having died quietly (an ICE or DTLS
	// failure that never surfaces as a track-ended event, a wedged
	// receiver). The second is precisely the case a restart fixes, since
	// a restart builds a brand new subscriber connection to the same
	// room -- so forgiving silence forever would turn a recoverable
	// transport failure into a frozen rendition for the rest of the
	// party (Farol review, PR #626).
	//
	// The default (DefaultVideoIdleMaxMs, 2 minutes) is far longer than
	// any tab-capture refresh gap and short enough to recover a dead
	// receiver while a party is still worth saving. The restart it
	// eventually allows is also self-correcting for the benign case: a
	// fresh subscription gets a keyframe from the SFU immediately, so a
	// publisher that is merely quiet resumes producing parts on the new
	// pipeline rather than being demoted, while a publisher that really
	// is gone hits the new pipeline's own FirstPartTimeoutMs and demotes
	// with "no-video".
	VideoIdleMaxMs int64

	// PartMs and ReorderHoldMs are not timers of this ladder at all: they
	// are the two numbers the part-stuck threshold has to CLEAR, and they
	// live here so partStuckThreshold can be a pure function of one
	// struct. PartMs is the session's own part target (a per-session
	// field of StartSessionRequest, copied in by newManagedSession);
	// ReorderHoldMs is REORDER_HOLD_MS, this process's video reorder hold.
	// Both zero means "not supplied", which reduces partStuckThreshold to
	// PartStuckMs exactly as it behaved before they existed.
	PartMs        int64
	ReorderHoldMs int64
}

// reorderCheckSlackMs is internal/session's own monitor tick: how long a
// packet that has gone overdue in the reorder buffer can sit before
// anything looks at the buffer again on a source that has fallen silent.
// It is the second term of internal/session's reorderDelayBound.
//
// Taken FROM that package rather than written here as a literal: this
// number is only correct as long as it is the same number the monitor
// actually ticks at, and a duplicated constant is a constant that drifts
// (this package already depends on internal/session, see
// remux_pipeline.go, so there is no new coupling in reading it).
const reorderCheckSlackMs = int64(session.MonitorTick / time.Millisecond)

// partStuckThreshold is how long without a NEW part this ladder waits
// before it calls a session stalled.
//
// THE RELATIONSHIP, STATED. A part boundary is decided by the arrival of
// the next access unit, so the longest a HEALTHY pipeline can go without
// publishing one is: the part target itself (the part currently open),
// plus whatever the video reorder buffer adds on top (at most
// ReorderHoldMs plus one monitor tick -- internal/session's
// reorderDelayBound). Firing below that sum does not detect a stall, it
// manufactures one: on 2026-09-17 a 3000ms threshold met a reorder buffer
// that could serialise its 300ms hold once per hole, part gaps reached
// 3.1s at p90 in loss windows, and the watchdog restarted a perfectly
// healthy session twice in an hour. A restart takes the session out of
// pqp-remuxd's registry, and every viewer's playlist 404s at the edge
// until the replacement registers.
//
// So the threshold is the configured PART_STUCK_MS or TWICE the worst
// legitimate gap, whichever is LARGER:
//
//	worstLegitimateGap = PartMs + ReorderHoldMs + reorderCheckSlackMs
//	threshold          = max(PartStuckMs, 2 x worstLegitimateGap)
//
// Twice, not once, so a stall has to be unambiguous before the ladder
// runs. With the shipped defaults (PART_MS 500, REORDER_HOLD_MS 300) the
// derived floor is 1800ms, comfortably under PART_STUCK_MS's own 3000ms
// default, so this changes nothing about today's production behaviour. It
// bites only when an operator lowers PART_STUCK_MS or raises
// REORDER_HOLD_MS past the point where the two contradict each other --
// which is the whole point: those two knobs can no longer be set to a
// combination that restarts healthy sessions.
func (c WatchdogConfig) partStuckThreshold() time.Duration {
	if c.PartMs <= 0 && c.ReorderHoldMs <= 0 {
		// Neither supplied: nothing is known about the pipeline's own
		// worst gap, so there is no floor to derive and PART_STUCK_MS is
		// the whole answer, exactly as it was before this function.
		return msDuration(c.PartStuckMs)
	}
	derived := 2 * (c.PartMs + c.ReorderHoldMs + reorderCheckSlackMs)
	if derived > c.PartStuckMs {
		return msDuration(derived)
	}
	return msDuration(c.PartStuckMs)
}

// maxDurationMs is the largest millisecond count that still converts to a
// time.Duration without wrapping: a Duration is int64 NANOseconds, so
// anything past this multiplied by time.Millisecond overflows into a
// small or negative value.
const maxDurationMs = int64(math.MaxInt64 / int64(time.Millisecond))

// msDuration converts a millisecond count into a Duration, SATURATING
// instead of wrapping. It is this package's only such conversion:
// remux_pipeline.go's Health uses it for internal/session's
// elapsed-milliseconds convention, and everything below uses it for a
// timer that came from the environment.
//
// Every timer this file reads is an int64 of milliseconds that ultimately
// came from an environment variable, and `time.Duration(ms) *
// time.Millisecond` silently wraps once ms passes about 9.2e12 (roughly
// 292 years). The consequence is the exact inverse of what the operator
// asked for: VIDEO_IDLE_MAX_MS set absurdly high -- a typo, a value in
// nanoseconds, "effectively never" written as a big number instead of the
// 0 this config actually defines for that -- wraps to a tiny or negative
// bound, so `idleFor > idleMax` is true on the first quiet tick and a
// quiet source is restarted IMMEDIATELY rather than forgiven for longer
// (Farol review, PR #626). Saturating means a nonsensically large value
// behaves like a very long one, which is what it reads as.
//
// LoadGlobalConfig refuses values this large outright (see
// maxWatchdogMs), so production never reaches the clamp; this exists so
// evaluateWatchdog is total for ANY WatchdogConfig, including one built
// by hand, rather than correct only because a different file validated
// its inputs.
func msDuration(ms int64) time.Duration {
	if ms >= maxDurationMs {
		return time.Duration(math.MaxInt64)
	}
	if ms <= -maxDurationMs {
		return time.Duration(math.MinInt64)
	}
	return time.Duration(ms) * time.Millisecond
}

// watchdogAction is what one evaluateWatchdog call decides to do.
type watchdogAction int

const (
	actionNone watchdogAction = iota
	// actionLog: nothing to change, but worth one log line (the 2x-segment
	// IDR-gap warning, rate-limited to once per gap).
	actionLog
	actionRestart
	actionDemote
)

// watchdogResult is evaluateWatchdog's return value: what to do, and why
// (for the log line managed_session.go writes either way -- pitfall 15's
// rule, "every state change logged with a reason").
type watchdogResult struct {
	action watchdogAction
	reason string
	// detail is the WHY behind the verdict, in numbers: which clocks had
	// stopped, how long ago, and what the source was doing at the time.
	// It exists because on 2026-09-15 a production session logged
	// `restarting (part-stuck)` and then `demoting
	// (part-stuck-second-stall)` and neither line said anything else at
	// all -- the reason string alone cannot tell "the publisher stopped
	// sending" from "the publisher is sending and nothing comes out"
	// from "frames come out and nothing is published", which are three
	// different bugs with three different fixes. Empty for actionNone.
	detail string
}

// watchdogState is one session's own mutable bookkeeping between ticks,
// held by managed_session.go under its own lock and passed by pointer so
// evaluateWatchdog can update it as part of deciding. Zero value is the
// correct starting state (no restart taken yet, no gap warning logged yet).
type watchdogState struct {
	// restartedAt is when the ONE allowed restart was last taken; zero
	// means none is currently "in the window". See evaluateWatchdog.
	restartedAt time.Time
	// idrWarnLogged rate-limits the 2x-segment informational log line to
	// once per gap, reset the moment the gap closes (a real IDR arrives,
	// or health otherwise recovers) so the next gap logs again -- the same
	// "reset clean on real content" idea internal/keyframe.Requester.OnIDR
	// already uses for its own pacer.
	idrWarnLogged bool
	// idleLogged rate-limits the "the source has gone quiet" line to
	// once per quiet episode, reset the moment frames come back -- the
	// same shape as idrWarnLogged above. Without it a presenter showing
	// a static slide would log twice a second for as long as the slide
	// is up.
	idleLogged bool
	// quiet is true from the first tick of a quiet episode until a real
	// decoded FRAME ends it. Deliberately not idleLogged, which is only
	// a log rate limiter: RTP packets resuming with nothing coming out
	// of the depacketizer is the "packets but no frames" case, a real
	// fault the ladder must still act on, and using the log flag as the
	// episode marker would have let a wedged depacketizer end the
	// episode and buy itself another PART_STUCK_MS of forgiveness
	// (Farol review, PR #629).
	quiet bool
	// idleEndedAt is when the LAST quiet episode ended: the first tick
	// on which a decoded frame arrived again after the source had been
	// idle. Zero until a quiet episode has both begun and ended.
	//
	// WHY THE LADDER NEEDS IT. A part boundary is decided by the arrival
	// of the NEXT access unit, so the first thing a quiet source owes
	// the ladder after it resumes is one frame interval -- and at the
	// 1.4 frames/s a static Chrome tab produces, that is 700ms, on top
	// of however long the silence itself lasted. Production, 2026-09-15
	// 15:23:07 UTC: three seconds of silence were correctly classed idle
	// at 15:23:05, frames came back (`lastFrame=45ms`, a fresh IDR
	// `lastIdr=84ms`), and this watchdog demoted the party two seconds
	// later on `part-stuck-second-stall` because `lastPart` was 4.4s
	// old -- an age accumulated entirely INSIDE the silence it had just
	// forgiven. "Frames present, no part yet" is the normal state
	// immediately after a quiet episode, not a stall, so the part clock
	// (and the IDR clock, for the same reason: a quiet source has no
	// keyframes either) restarts from the end of the silence rather
	// than from whatever happened before it.
	idleEndedAt time.Time
}

// evaluateWatchdog is pure: no clock, no IO, no goroutine. Given a
// pipeline's current health, the segment target (for the IDR-gap rule,
// which is expressed as a multiple of it), this session's own watchdog
// bookkeeping, the wall-clock instant the CURRENT pipeline instance itself
// started, and now, it decides what to do. This is deliberately the whole
// of the watchdog's decision logic, kept separate from
// managed_session.go's goroutine/locking so watchdog_test.go can drive it
// directly with a fake clock, per this task's own "watchdog
// restart-then-demote with a fake pipeline clock" acceptance bar.
//
// Four phases, evaluated in this order:
//
//  1. h.LastPartAt.IsZero() -- NO part has ever been produced. This is
//     "waiting" (SessionState StateWaiting), not "stalled": a session
//     whose presenter has not started sharing yet looks identical, from
//     PartsWritten's point of view, to one whose pipeline is genuinely
//     broken, and PART_STUCK_MS's 3s window would demote the ordinary
//     "nobody has clicked share screen yet" case almost immediately
//     (Farol review, PR #584). FirstPartTimeoutMs is the real bound here,
//     and its ONLY action is demote-with-reason-"no-video" past that
//     bound; there is nothing to restart (the pipeline is already doing
//     the one thing it can -- waiting for a track).
//  2. The source's own liveness (sourceIdle, added 2026-09-15). A
//     publisher that has stopped sending frames stops LastPartAt dead,
//     because a part boundary is decided by the arrival of the NEXT
//     access unit -- and a Chrome TAB share sends none while the page is
//     not repainting. That is not a stall. It sits AHEAD of the IDR-gap
//     rule deliberately: a quiet source has no IDRs either, so leaving it
//     behind would demote a static slide at 3x the segment target. It is
//     bounded, not unconditional -- see VideoIdleMaxMs.
//  3. Once a part has arrived at least once, the IDR-gap check runs next
//     and can demote outright with no restart attempt at all, because
//     restarting the SAME subscription to the SAME room does nothing for
//     a publisher that has simply stopped sending keyframes --
//     docs/plans/LL_HLS.md §5: "never close a segment on a non-IDR
//     boundary... at 3x S with still no IDR, stop the LL rung and
//     demote." internal/pipeline.Fragmenter never emits a fragment before
//     the stream's first IDR (ErrWaitingForIDR), so by this point
//     h.LastIdrAt is never zero in practice; the fallback to h.LastPartAt
//     below exists only so a violation of that invariant fails toward "a
//     small, sane gap" instead of "no IDR since the Unix epoch, demote
//     instantly."
//  4. The part-stuck ladder: no NEW part for PartStuckMs, evaluated only
//     if the IDR-gap check found nothing worth acting on this tick.
//     stallLadder below is that ladder, shared with phase 2's own bound.
func evaluateWatchdog(h PipelineHealth, segmentMs int, cfg WatchdogConfig, pipelineStartedAt time.Time, st *watchdogState, now time.Time) watchdogResult {
	if reason := h.DemoteReason; reason != "" {
		return watchdogResult{actionDemote, reason, stallDetail(h, now)}
	}
	if h.LastPartAt.IsZero() {
		firstPartTimeout := msDuration(cfg.FirstPartTimeoutMs)
		if now.Sub(pipelineStartedAt) > firstPartTimeout {
			return watchdogResult{actionDemote, "no-video", stallDetail(h, now)}
		}
		return watchdogResult{actionNone, "", ""}
	}

	// NOT msDuration(cfg.PartStuckMs) directly: the threshold also has to
	// clear the worst gap a HEALTHY pipeline can produce, which the
	// reorder buffer's hold is part of. See partStuckThreshold.
	stuckThreshold := cfg.partStuckThreshold()

	// PHASE 1.5, AND THE WHOLE POINT OF THIS BLOCK: a source that has
	// gone quiet is not a stalled pipeline.
	//
	// A Chrome TAB share sends NO video frames at all while the page is
	// not repainting -- a paused film, a slide, a scoreboard between
	// goals -- and only a low-rate refresh in between. No frames means
	// no access units, which means no part boundary (every one of those
	// is decided by the arrival of the NEXT access unit, see
	// internal/pipeline), which means LastPartAt stops moving. That is
	// indistinguishable, from PartsWritten alone, from a genuinely
	// wedged muxer, and on 2026-09-15 this watchdog resolved the
	// ambiguity the wrong way twice on one production session: restart,
	// then demote the party off the low-latency rung, for a presenter
	// whose share was working perfectly.
	//
	// The signal that separates them is the RTP stream itself. Frames
	// AND packets both stale means the publisher is not sending, so
	// there is nothing this end could restart that would help --
	// reconnecting to the same room to receive the same silence is not
	// a fix, and demoting hands the audience a conventional ladder
	// showing the SAME frozen picture off the SAME source. Packets
	// arriving with no frames coming out (loss, a wedged access unit) or
	// frames coming out with no parts published (a real muxer bug) both
	// fall through to the ladder below, unchanged.
	//
	// It is deliberately unbounded: this never demotes for idleness, at
	// any length. A session whose publisher has genuinely gone away is
	// ended by the track ending (OnVideoTrackEnded) or by the API's own
	// 60s heartbeat sweep, both of which are about the session existing
	// rather than about it stalling, and neither of which this rule
	// touches.
	if idleFor, ok := sourceIdleFor(h, now, stuckThreshold); ok {
		idleMax := msDuration(cfg.VideoIdleMaxMs)
		if cfg.VideoIdleMaxMs > 0 && idleFor > idleMax {
			// Forgiven long enough. This is where a quietly dead
			// RECEIVE path (see VideoIdleMaxMs) stops being
			// indistinguishable from a quiet publisher: the ladder's
			// restart rebuilds the subscription, which fixes one of
			// them and costs the other a keyframe.
			return stallLadder(h, cfg, st, now, "source-idle-too-long", "source-idle-too-long-second-stall")
		}
		st.quiet = true
		if !st.idleLogged {
			st.idleLogged = true
			return watchdogResult{actionLog, "video-source-idle", stallDetail(h, now)}
		}
		return watchdogResult{actionNone, "", ""}
	}
	st.idleLogged = false
	// A quiet episode ends when a decoded FRAME arrives, not when
	// packets do. Packets back with nothing coming out of the
	// depacketizer is the case the ladder is for, and must keep being
	// judged on its own clocks; only a real access unit means the
	// pipeline owes us a part again, and only then does the part clock
	// restart -- see idleEndedAt and quiet.
	if st.quiet && !h.LastVideoFrameAt.IsZero() && now.Sub(h.LastVideoFrameAt) <= stuckThreshold {
		st.quiet = false
		st.idleEndedAt = now
	}

	idrRef := h.LastIdrAt
	if idrRef.IsZero() {
		idrRef = h.LastPartAt
	}
	if st.idleEndedAt.After(idrRef) {
		idrRef = st.idleEndedAt
	}
	segDur := msDuration(int64(segmentMs))
	idrGap := now.Sub(idrRef)

	switch {
	case idrGap > 3*segDur:
		return watchdogResult{actionDemote, "idr-gap-exceeded", stallDetail(h, now)}
	case idrGap > 2*segDur:
		if !st.idrWarnLogged {
			st.idrWarnLogged = true
			return watchdogResult{actionLog, "idr-gap-warning", stallDetail(h, now)}
		}
		return watchdogResult{actionNone, "", ""}
	default:
		st.idrWarnLogged = false
	}

	partRef := h.LastPartAt
	if st.idleEndedAt.After(partRef) {
		partRef = st.idleEndedAt
	}
	if now.Sub(partRef) <= stuckThreshold {
		return watchdogResult{actionNone, "", ""}
	}

	return stallLadder(h, cfg, st, now, "part-stuck", "part-stuck-second-stall")
}

// stallLadder is docs/plans/LL_HLS.md §5's "one restart, then demote",
// shared by the two things that reach it: no new part while the source IS
// sending (the classic stall), and a source that has been silent past
// VideoIdleMaxMs. Each names its own reasons so the log still says which
// of the two happened.
func stallLadder(h PipelineHealth, cfg WatchdogConfig, st *watchdogState, now time.Time, restartReason, demoteReason string) watchdogResult {
	demoteWindow := msDuration(cfg.DemoteWindowMs)
	if st.restartedAt.IsZero() || now.Sub(st.restartedAt) > demoteWindow {
		// First stall (ever, or the last restart is old enough that this
		// counts as a fresh episode, not "the same" one): use the one
		// allowed restart. Recorded now, before the caller has even
		// attempted it -- see managed_session.go's restart: if the
		// factory call itself fails (e.g. LiveKit unreachable), the next
		// tick still sees a stuck pipeline and, finding restartedAt
		// already set and within the window, demotes rather than
		// retrying the failing restart forever.
		st.restartedAt = now
		return watchdogResult{actionRestart, restartReason, stallDetail(h, now)}
	}
	return watchdogResult{actionDemote, demoteReason, stallDetail(h, now)}
}

// sourceIdleFor reports whether the video track has gone silent -- no
// completed access unit AND no RTP packet at all for longer than the
// part-stuck threshold -- and for how long, which is what the
// VideoIdleMaxMs bound is judged against.
//
// BOTH halves are required, and which half is which matters. Packets with
// no frames is a depacketizer that cannot assemble what is arriving --
// a real fault this watchdog should still act on. Frames with no packets
// cannot happen. Neither stale is the ordinary case. Both stale is a quiet
// source.
//
// A Pipeline that reports neither timestamp (LastVideoFrameAt zero: every
// fake in this package's tests, and any future Pipeline implementation
// that does not track the RTP stream) is never idle by this rule, so it is
// evaluated exactly as it was before this function existed.
func sourceIdleFor(h PipelineHealth, now time.Time, threshold time.Duration) (time.Duration, bool) {
	if h.LastVideoFrameAt.IsZero() {
		return 0, false
	}
	frameGap := now.Sub(h.LastVideoFrameAt)
	if frameGap <= threshold {
		return 0, false
	}
	if h.LastVideoPacketAt.IsZero() {
		return frameGap, true
	}
	packetGap := now.Sub(h.LastVideoPacketAt)
	if packetGap <= threshold {
		return 0, false
	}
	// How long the source has been silent is the SHORTER of the two: the
	// stream is only quiet from the last thing that arrived on it, and
	// that is a packet if any arrived after the last completed frame.
	if packetGap < frameGap {
		return packetGap, true
	}
	return frameGap, true
}

// stallDetail renders every clock and counter a human needs to tell this
// watchdog's verdict apart from the two other things that look like it.
// Read left to right it answers, in order: when did each stage of the
// pipeline last do anything, how much has it done in total, is this
// process asking for keyframes and being answered, and is the upload path
// healthy.
func stallDetail(h PipelineHealth, now time.Time) string {
	var b strings.Builder
	fmt.Fprintf(&b, "lastPart=%s lastFrame=%s lastPkt=%s lastIdr=%s",
		since(now, h.LastPartAt), since(now, h.LastVideoFrameAt),
		since(now, h.LastVideoPacketAt), since(now, h.LastIdrAt))
	fmt.Fprintf(&b, " parts=%d keepalive=%d audioParts=%d segIdx=%d",
		h.PartsWritten, h.KeepAliveParts, h.AudioPartsWritten, h.VideoSegmentIndex)
	fmt.Fprintf(&b, " pkts=%d frames=%d idrs=%d drops=%d",
		h.VideoPacketsSeen, h.VideoFramesSeen, h.VideoKeyframesSeen, h.VideoDepacketizeErrs)
	fmt.Fprintf(&b, " pli=%d unanswered=%d", h.PLIsSent, h.PLIsSinceIdr)
	fmt.Fprintf(&b, " r2 ok=%d fail=%d drop=%d queued=%d inflight=%d lastMs=%d maxMs=%d",
		h.R2Uploaded, h.R2Failed, h.R2Dropped, h.R2Queued, h.R2InFlight, h.R2LastLatencyMs, h.R2MaxLatencyMs)
	if h.OpenSegmentOK {
		fmt.Fprintf(&b, " openSeg=%dms", h.OpenSegmentMs)
	}
	if h.AudioEnabled {
		fmt.Fprintf(&b, " audioDead=%t audioRestarts=%d", h.AudioDead, h.AudioRestarts)
	}
	return b.String()
}

// since renders an age, or "never" for a zero time. "never" is a real and
// load-bearing answer: "lastFrame=never" (nothing was ever depacketized)
// and "lastFrame=12.4s" (it worked and then stopped) are different
// incidents.
func since(now, t time.Time) string {
	if t.IsZero() {
		return "never"
	}
	return now.Sub(t).Round(time.Millisecond).String()
}
