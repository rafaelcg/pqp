package keyframe

import (
	"context"
	"sync"
	"time"
)

// PLISender is the one thing Requester needs from the subscriber: write an
// RTCP PLI for the subscribed video track. *subscriber.Session.RequestKeyframe
// satisfies this; a fake satisfies it in tests.
//
// It intentionally returns nothing. server-sdk-go's own
// RemoteParticipant.WritePLI is `func(ssrc webrtc.SSRC)` — void — because
// an RTCP packet is fire-and-forget UDP signaling, not a request with a
// reply; the SDK itself has no success/failure result to hand back. tick
// (below) therefore records a PLI as sent the moment it calls
// RequestKeyframe, which is optimistic for the case where the write
// itself fails at the transport, but there is no lower-level signal this
// package could act on instead, and the alternative — never advancing
// lastPLI — would make a persistently failing send retry every poll
// interval rather than back off at all.
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
//
// OnIDR is called from the depacketizer's goroutine and tick from Run's own
// ticker goroutine; mu guards the two fields both touch so a concurrent
// fresh IDR is never lost or read half-updated (Farol caught this as a
// real data race, confirmed under `go test -race`).
type Requester struct {
	gater *Gater
	send  PLISender
	now   func() time.Time

	mu      sync.Mutex
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
	r.mu.Lock()
	r.lastIDR = t
	r.lastPLI = time.Time{}
	r.mu.Unlock()
}

// tick evaluates the gate once at the current time and sends a PLI if due,
// recording it. Exported as a method for tests; Run calls it on a fixed
// interval.
//
// The PLI itself is sent outside the lock: PLISender.RequestKeyframe
// ultimately writes RTCP over the network, and holding mu across that
// would block a concurrent OnIDR (a real IDR arriving) behind an
// in-flight, possibly slow, send.
func (r *Requester) tick() {
	now := r.now()

	r.mu.Lock()
	lastIDR, lastPLI := r.lastIDR, r.lastPLI
	due := r.gater.ShouldSendPLI(now, lastIDR, lastPLI)
	if due {
		r.lastPLI = now
	}
	r.mu.Unlock()

	if due {
		r.send.RequestKeyframe()
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
