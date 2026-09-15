package control

import (
	"fmt"
	"strings"
	"time"
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
	PartStuckMs int64
	// DemoteWindowMs: a second stall within this many ms of the last
	// restart demotes instead of restarting again. A stall further apart
	// than this is treated as a fresh problem, worth one more restart --
	// see evaluateWatchdog's own doc comment.
	DemoteWindowMs int64
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
// Three phases, evaluated in this order:
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
//  2. Once a part has arrived at least once, the IDR-gap check runs next
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
//  3. The part-stuck ladder: no NEW part for PartStuckMs, evaluated only
//     if the IDR-gap check found nothing worth acting on this tick.
func evaluateWatchdog(h PipelineHealth, segmentMs int, cfg WatchdogConfig, pipelineStartedAt time.Time, st *watchdogState, now time.Time) watchdogResult {
	if h.LastPartAt.IsZero() {
		firstPartTimeout := time.Duration(cfg.FirstPartTimeoutMs) * time.Millisecond
		if now.Sub(pipelineStartedAt) > firstPartTimeout {
			return watchdogResult{actionDemote, "no-video", stallDetail(h, now)}
		}
		return watchdogResult{actionNone, "", ""}
	}

	stuckThreshold := time.Duration(cfg.PartStuckMs) * time.Millisecond

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
	if sourceIdle(h, now, stuckThreshold) {
		if !st.idleLogged {
			st.idleLogged = true
			return watchdogResult{actionLog, "video-source-idle", stallDetail(h, now)}
		}
		return watchdogResult{actionNone, "", ""}
	}
	st.idleLogged = false

	idrRef := h.LastIdrAt
	if idrRef.IsZero() {
		idrRef = h.LastPartAt
	}
	segDur := time.Duration(segmentMs) * time.Millisecond
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

	if now.Sub(h.LastPartAt) <= stuckThreshold {
		return watchdogResult{actionNone, "", ""}
	}

	demoteWindow := time.Duration(cfg.DemoteWindowMs) * time.Millisecond
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
		return watchdogResult{actionRestart, "part-stuck", stallDetail(h, now)}
	}
	return watchdogResult{actionDemote, "part-stuck-second-stall", stallDetail(h, now)}
}

// sourceIdle reports whether the publisher has stopped sending on the
// video track: no completed access unit AND no RTP packet at all for
// longer than the part-stuck threshold.
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
func sourceIdle(h PipelineHealth, now time.Time, threshold time.Duration) bool {
	if h.LastVideoFrameAt.IsZero() {
		return false
	}
	if now.Sub(h.LastVideoFrameAt) <= threshold {
		return false
	}
	if h.LastVideoPacketAt.IsZero() {
		return true
	}
	return now.Sub(h.LastVideoPacketAt) > threshold
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
