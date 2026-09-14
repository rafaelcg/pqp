package control

import "time"

// WatchdogConfig controls the stall/demote ladder, docs/plans/LL_HLS.md §5.
type WatchdogConfig struct {
	// PartStuckMs: no new part for this long -> restart the session's
	// pipeline once. Default DefaultPartStuckMs (3000ms, "six parts" per
	// the plan).
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
// started (used as the reference point when health has never reported a
// part or an IDR at all -- a pipeline that has been running for
// PartStuckMs with literally nothing yet is exactly as stuck as one that
// stopped producing after a good start), and now, it decides what to do.
// This is deliberately the whole of the watchdog's decision logic, kept
// separate from managed_session.go's goroutine/locking so
// watchdog_test.go can drive it directly with a fake clock, per this
// task's own "watchdog restart-then-demote with a fake pipeline clock"
// acceptance bar.
//
// Precedence: the IDR-gap check runs first and can demote outright with no
// restart attempt at all, because restarting the SAME subscription to the
// SAME room does nothing for a publisher that has simply stopped sending
// keyframes -- docs/plans/LL_HLS.md §5: "never close a segment on a
// non-IDR boundary... at 3x S with still no IDR, stop the LL rung and
// demote." The part-stuck ladder (no NEW part at all, a harder failure
// suggesting the pipeline itself -- not just the publisher's keyframe
// cadence -- has stopped) is evaluated only if the IDR-gap check found
// nothing worth acting on this tick.
func evaluateWatchdog(h PipelineHealth, segmentMs int, cfg WatchdogConfig, pipelineStartedAt time.Time, st *watchdogState, now time.Time) watchdogResult {
	idrRef := h.LastIdrAt
	if idrRef.IsZero() {
		idrRef = pipelineStartedAt
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

	partRef := h.LastPartAt
	if partRef.IsZero() {
		partRef = pipelineStartedAt
	}
	stuckThreshold := time.Duration(cfg.PartStuckMs) * time.Millisecond
	if now.Sub(partRef) <= stuckThreshold {
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
