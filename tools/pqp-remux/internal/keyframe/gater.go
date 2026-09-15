// Package keyframe decides when to ask the presenter for a keyframe. It
// owns no RTCP and no timer: Gater is pure decision logic (testable without
// a clock or a network), and Requester (requester.go) is the thin loop that
// calls it and does the actual PLI write via subscriber.Session.
//
// L0.1 (docs/plans/LL_HLS.md, "L0.1 result", PR #577) verified the only
// lever that exists: server-sdk-go's RemoteParticipant.WritePLI, which
// writes an RTCP PictureLossIndication on the subscriber's own peer
// connection. There is no publisher-side GOP control and no
// RoomServiceClient keyframe RPC, so this package's whole job is deciding
// *when* to pull that one lever, not choosing among several.
package keyframe

import "time"

// Policy mirrors KEYFRAME_POLICY. L0.2 (not yet run) decides which one
// production uses; this package supports both so that decision is a config
// change, not a code change.
type Policy string

const (
	// PolicyNatural never sends a PLI: the publisher's own keyframe
	// cadence is trusted, and the fragmenter's elastic segment boundary
	// (internal/pipeline, "Branch A") absorbs whatever cadence that is.
	PolicyNatural Policy = "natural"
	// PolicyPLI sends a paced, gated PLI when no IDR has arrived recently
	// enough to hit the segment target ("Branch B").
	PolicyPLI Policy = "pli"
)

// minPaceMs is the floor L0.1 found on the SFU side: `rtc.pli_throttle`'s
// Low tier defaults to 500ms for a single-layer publish (our screen share
// is always single-layer), and the SFU coalesces anything asked for
// faster than that into a single forwarded PLI. Configuring pace below
// this doesn't get more keyframes, it just wastes RTCP.
const minPaceMs = 500

// defaultGateFactor is PLI_GATE_FACTOR's default: ask for a keyframe once
// the segment target itself has passed with no IDR.
//
// It was 1.5 -- section 3's "Branch B" as first written, one PLI only
// after 1.5xS with no IDR. Production on 2026-09-15 showed what that costs
// when the browser genuinely never sends an unrequested IDR: the
// fragmenter closes a segment on the first IDR at or AFTER SEGMENT_MS, and
// the gate meant the earliest IDR it could possibly see was already at
// 1.5xS, so 4 second segments came out 7 to 11 seconds long and
// #EXT-X-TARGETDURATION read 11. A factor of 1 asks at the moment the
// segment would like to close, so the IDR lands one round trip later and
// segments land just past the target instead of half again past it.
//
// This does not ask for more keyframes than a stream needs: the gate only
// ever fires when no IDR has arrived within the whole window, which is
// exactly the case where a segment cannot close without one. A publisher
// whose own cadence is shorter than SEGMENT_MS never triggers it at all.
const defaultGateFactor = 1.0

// Config controls Gater. SegmentTargetMs is SEGMENT_MS; GateFactor is
// PLI_GATE_FACTOR (<=0 uses defaultGateFactor); PaceMs is PLI_PACE_MS
// (clamped up to minPaceMs, never down: the SFU throttle makes a lower
// value a no-op, not a faster one).
type Config struct {
	Policy          Policy
	SegmentTargetMs int
	GateFactor      float64
	PaceMs          int
}

func (c Config) normalized() Config {
	if c.GateFactor <= 0 {
		c.GateFactor = defaultGateFactor
	}
	if c.PaceMs < minPaceMs {
		c.PaceMs = minPaceMs
	}
	return c
}

// GateWindow returns how long the gate waits, with no IDR, before it will
// allow a PLI.
func (c Config) GateWindow() time.Duration {
	c = c.normalized()
	return time.Duration(float64(c.SegmentTargetMs)*c.GateFactor) * time.Millisecond
}

// Pace returns the minimum spacing between two PLIs while still waiting
// for an IDR, floored at minPaceMs.
func (c Config) Pace() time.Duration {
	return time.Duration(c.normalized().PaceMs) * time.Millisecond
}

// Gater decides, at a given instant, whether a PLI should be sent. It
// holds no state of its own — the caller supplies lastIDR/lastPLI — so it
// needs no clock and is trivial to test with fixed timestamps.
type Gater struct {
	cfg Config
}

// NewGater returns a Gater for cfg, normalizing PaceMs and GateFactor per
// their documented rules.
func NewGater(cfg Config) *Gater {
	return &Gater{cfg: cfg.normalized()}
}

// ShouldSendPLI reports whether, at time now, a PLI should be written,
// given when the last IDR was seen (lastIDR) and when the last PLI was
// sent (lastPLI; zero value if none sent since the last IDR — the caller
// resets it to zero on every IDR, which is what "back off until the next
// IDR" means: the pace timer restarts clean each time the gate is actually
// satisfied by real content instead of by us).
//
// PolicyNatural always returns false: it is the caller's responsibility to
// never even construct a ticking loop under that policy, but ShouldSendPLI
// stays safe to call regardless, so a policy flip is one config value.
func (g *Gater) ShouldSendPLI(now, lastIDR, lastPLI time.Time) bool {
	if g.cfg.Policy != PolicyPLI {
		return false
	}
	if now.Sub(lastIDR) < g.cfg.GateWindow() {
		return false
	}
	if !lastPLI.IsZero() && now.Sub(lastPLI) < g.cfg.Pace() {
		return false
	}
	return true
}
