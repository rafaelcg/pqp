package keyframe

import (
	"context"
	"log"
	"sync"
	"sync/atomic"
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

	// plisSent is the session total, read from other goroutines (the
	// stats line and the watchdog's stall detail), hence an atomic
	// rather than a field under mu.
	plisSent atomic.Uint64

	mu      sync.Mutex
	lastIDR time.Time
	lastPLI time.Time
	// plisSinceIDR, firstPLISinceIDR and lastPLILoggedAt exist ONLY for
	// the log line. Until 2026-09-15 nothing recorded whether a PLI was
	// ever written or whether an IDR ever came back, so the production
	// stall that day could not be told apart from "the browser sent
	// nothing and we never asked" -- hypothesis (b) of that
	// investigation, unanswerable from the log it left. See tick and
	// OnIDR.
	plisSinceIDR     uint64
	firstPLISinceIDR time.Time
	// lastLossPLI paces OnLoss: a burst of gaps inside one damaged GOP
	// must not become a PLI storm, one request per lossPLIMinInterval is
	// plenty since the publisher answers in ~300ms.
	lastLossPLI time.Time
	lossPLIs    uint64
	// awaitingIDR is set by OnLoss and cleared by OnIDR: while true, tick
	// re-sends a PLI every lossRetryInterval instead of waiting for the
	// periodic gate. Measured 2026-09-17: the SFU throttles PLIs to the
	// publisher (LiveKit default 1 s per layer), so a loss PLI sent within
	// a second of the previous keyframe was swallowed and nothing asked
	// again for 4 s, long enough for the part-stuck watchdog to restart
	// the session.
	awaitingIDR     bool
	lastPLILoggedAt time.Time
	// logf is log.Printf in production; a test substitutes a collector.
	logf func(format string, args ...any)
}

// NewRequester returns a Requester. cfg.Policy must be PolicyPLI for it to
// ever call send; a PolicyNatural Requester is safe to run (it simply never
// fires, via Gater.ShouldSendPLI), but the caller should prefer not to
// start the loop at all under PolicyNatural.
func NewRequester(cfg Config, send PLISender) *Requester {
	return &Requester{gater: NewGater(cfg), send: send, now: time.Now, logf: log.Printf}
}

// pliLogInterval throttles the "still asking" line inside one episode (a
// run of PLIs with no IDR answering them). The FIRST PLI of an episode
// and the IDR that ends it are always logged; everything in between is
// capped at one line per interval, so a publisher that has genuinely
// stopped answering produces a steady, readable trail rather than two
// lines a second (PLI_PACE_MS's floor is 500ms).
const pliLogInterval = 5 * time.Second

// Stats is what a caller reports about this requester on the periodic
// session stats line and in the watchdog's stall detail: how many PLIs
// this session has written in total, how many of them are still
// unanswered, and when the last one went out.
type Stats struct {
	PLIsSent     uint64
	LossPLIs     uint64
	PLIsSinceIDR uint64
	LastPLIAt    time.Time
	LastIDRAt    time.Time
}

// Stats reports this requester's counters. Safe to call from any
// goroutine.
func (r *Requester) Stats() Stats {
	if r == nil {
		return Stats{}
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	return Stats{
		PLIsSent:     r.plisSent.Load(),
		LossPLIs:     r.lossPLIs,
		PLIsSinceIDR: r.plisSinceIDR,
		LastPLIAt:    r.lastPLI,
		LastIDRAt:    r.lastIDR,
	}
}

// OnIDR records that an IDR arrived at t, resetting the pace timer: the
// next PLI (if any) is judged against a fresh gate window from this IDR,
// not from whenever the last PLI happened to be sent.
func (r *Requester) OnIDR(t time.Time) {
	r.mu.Lock()
	asked := r.plisSinceIDR
	firstAsk := r.firstPLISinceIDR
	r.lastIDR = t
	r.lastPLI = time.Time{}
	r.awaitingIDR = false
	r.plisSinceIDR = 0
	r.firstPLISinceIDR = time.Time{}
	r.resetPLILogThrottle()
	r.mu.Unlock()

	// The other half of the PLI path, and the half that was invisible:
	// an IDR arriving after we asked for one is the proof the request
	// reached the publisher AND that it answered. Logged once per
	// episode, never for the ordinary case where the publisher's own
	// cadence supplied the keyframe with nobody asking.
	if asked > 0 {
		r.logf("pqp-remux: keyframe: IDR after %d PLI(s), %s after the first request", asked, t.Sub(firstAsk).Round(time.Millisecond))
	}
}

// resetPLILogThrottle clears the in-episode throttle so the next episode's
// first PLI always logs. Called with mu held.
func (r *Requester) resetPLILogThrottle() { r.lastPLILoggedAt = time.Time{} }

// lossPLIMinInterval paces the loss-triggered PLI below.
const lossPLIMinInterval = 300 * time.Millisecond

// lossRetryInterval is how often tick re-asks while awaitingIDR. Just over
// the SFU's 1 s PLI throttle so the retry is never the one it drops.
const lossRetryInterval = 1100 * time.Millisecond

// OnLoss asks for a keyframe NOW because the session just threw media away
// (an RTP sequence gap, a discarded access unit): every frame until the
// next IDR is being dropped, so the picture is frozen until one arrives,
// and the periodic gate (no IDR for a whole segment) is far too slow for
// that. Paced to one PLI per lossPLIMinInterval. Reports whether a PLI
// went out.
func (r *Requester) OnLoss(now time.Time) bool {
	if r == nil {
		return false
	}
	r.mu.Lock()
	if !r.lastLossPLI.IsZero() && now.Sub(r.lastLossPLI) < lossPLIMinInterval {
		r.mu.Unlock()
		return false
	}
	r.lastLossPLI = now
	r.lastPLI = now
	r.awaitingIDR = true
	r.plisSinceIDR++
	if r.firstPLISinceIDR.IsZero() {
		r.firstPLISinceIDR = now
	}
	r.plisSent.Add(1)
	r.lossPLIs++
	r.mu.Unlock()
	r.send.RequestKeyframe()
	return true
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
	lossRetry := false
	if !due && r.awaitingIDR && !lastPLI.IsZero() && now.Sub(lastPLI) >= lossRetryInterval {
		due = true
		lossRetry = true
	}
	var episodeCount uint64
	var shouldLog bool
	if due {
		r.lastPLI = now
		r.plisSinceIDR++
		episodeCount = r.plisSinceIDR
		if r.firstPLISinceIDR.IsZero() {
			r.firstPLISinceIDR = now
		}
		shouldLog = r.lastPLILoggedAt.IsZero() || now.Sub(r.lastPLILoggedAt) >= pliLogInterval
		if shouldLog {
			r.lastPLILoggedAt = now
		}
		r.plisSent.Add(1)
		if lossRetry {
			r.lossPLIs++
		}
	}
	r.mu.Unlock()

	if due {
		r.send.RequestKeyframe()
		if lossRetry {
			// Always logged: each one is a keyframe request the SFU or the
			// publisher swallowed, and the picture is frozen meanwhile.
			r.logf("pqp-remux: keyframe: PLI re-sent after loss (no IDR for %s, %d in this episode, %d this session)",
				now.Sub(lastIDR).Round(time.Millisecond), episodeCount, r.plisSent.Load())
		} else if shouldLog {
			gap := "never"
			if !lastIDR.IsZero() {
				gap = now.Sub(lastIDR).Round(time.Millisecond).String()
			}
			r.logf("pqp-remux: keyframe: PLI sent (no IDR for %s, gate %s, %d in this episode, %d this session)",
				gap, r.gater.cfg.GateWindow().Round(time.Millisecond), episodeCount, r.plisSent.Load())
		}
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
