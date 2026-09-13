package keyframe

import (
	"context"
	"time"
)

// PLISender is the one thing Requester needs from the subscriber: write an
// RTCP PLI for the subscribed video track. *subscriber.Session.RequestKeyframe
// satisfies this; a fake satisfies it in tests.
type PLISender interface {
	RequestKeyframe()
}

// Requester runs the ticking loop around Gater: on every IDR (OnIDR) it
// resets its idea of "how long has it been", and on a fixed poll interval
// it asks the Gater whether enough time has passed with no IDR to justify
// asking the publisher for one.
//
// Under --idr-log (see internal/idrlog), Requester is simply never
// constructed: that mode is passive by construction (docs/plans/LL_HLS.md
// L0.1 result item 4), not passive because of a runtime flag on this type.
type Requester struct {
	gater *Gater
	send  PLISender
	now   func() time.Time

	lastIDR time.Time
	lastPLI time.Time
}

// NewRequester returns a Requester. cfg.Policy must be PolicyPLI for it to
// ever call send; a PolicyNatural Requester is safe to run (it simply never
// fires, via Gater.ShouldSendPLI), but the caller should prefer not to
// start the loop at all under PolicyNatural.
func NewRequester(cfg Config, send PLISender) *Requester {
	return &Requester{gater: NewGater(cfg), send: send, now: time.Now}
}

// OnIDR records that an IDR arrived at t, resetting the pace timer: the
// next PLI (if any) is judged against a fresh gate window from this IDR,
// not from whenever the last PLI happened to be sent.
func (r *Requester) OnIDR(t time.Time) {
	r.lastIDR = t
	r.lastPLI = time.Time{}
}

// tick evaluates the gate once at the current time and sends a PLI if due,
// recording it. Exported as a method for tests; Run calls it on a fixed
// interval.
func (r *Requester) tick() {
	now := r.now()
	if r.gater.ShouldSendPLI(now, r.lastIDR, r.lastPLI) {
		r.send.RequestKeyframe()
		r.lastPLI = now
	}
}

// pollInterval is how often Run wakes up to re-evaluate the gate. It only
// needs to be finer than the pace floor (500ms, see minPaceMs) so a due
// PLI is never delayed by more than one poll.
const pollInterval = 200 * time.Millisecond

// Run blocks, ticking the gate every pollInterval, until ctx is done. Call
// it in its own goroutine.
func (r *Requester) Run(ctx context.Context) {
	t := time.NewTicker(pollInterval)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			r.tick()
		}
	}
}
