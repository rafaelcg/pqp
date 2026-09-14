package control

import "time"

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
			return watchdogResult{actionDemote, "no-video"}
		}
		return watchdogResult{actionNone, ""}
	}

	idrRef := h.LastIdrAt
	if idrRef.IsZero() {
		idrRef = h.LastPartAt
	}
	segDur := time.Duration(segmentMs) * time.Millisecond
	idrGap := now.Sub(idrRef)

	switch {
	case idrGap > 3*segDur:
		return watchdogResult{actionDemote, "idr-gap-exceeded"}
	case idrGap > 2*segDur:
		if !st.idrWarnLogged {
			st.idrWarnLogged = true
			return watchdogResult{actionLog, "idr-gap-warning"}
		}
		return watchdogResult{actionNone, ""}
	default:
		st.idrWarnLogged = false
	}

	stuckThreshold := time.Duration(cfg.PartStuckMs) * time.Millisecond
	if now.Sub(h.LastPartAt) <= stuckThreshold {
		return watchdogResult{actionNone, ""}
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
		return watchdogResult{actionRestart, "part-stuck"}
	}
	return watchdogResult{actionDemote, "part-stuck-second-stall"}
}
