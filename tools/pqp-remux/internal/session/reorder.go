package session

import (
	"math"
	"sort"
	"time"

	"github.com/pion/rtp"

	"github.com/rafaelcg/pqp/tools/pqp-remux/internal/h264"
)

// reorderBuffer hands video RTP packets to the depacketizer in sequence
// order, holding out-of-order arrivals for a short while so a NACKed
// retransmission can fill the hole before anything is declared lost.
//
// Measured 2026-09-17 on the first session with sequence checking (PR 700):
// every "lost" packet was followed, within the same 5 s stats window, by
// exactly one "late" one, i.e. the SFU's retransmission. Declaring the gap
// the instant the next packet arrived discarded a whole GOP for nothing,
// and while the remux waited for the keyframe it asked for, no part was
// written for long enough (3.3 s) that the control plane's part-stuck
// watchdog restarted the session. That restart is what viewers saw as a
// 404 on the playlist and a choppy first minute.
//
// ONE DEADLINE PER PACKET, NOT ONE PER HOLE. The first version of this
// buffer kept a single `holeSince` stamp and, every time it gave up on a
// hole, set that stamp to `now` for whatever hole was uncovered next. A
// loss episode with N holes therefore cost N SERIAL holds, and during a
// real episode the source rate collapses to ~30 pkt/s so the packet-count
// bound (maxPending, 96) is never reached and every one of those holds ran
// the full length. Measured in production on 2026-09-17 (session
// 54e01974, 20:48 to 21:42Z): parts every 0.47 s in clean windows, 3.1 s
// at p90 in windows that carried loss, which is past the control plane's
// 3 s part-stuck watchdog. It restarted the session at 21:05:40Z and again
// at 21:13:56Z; a restarted session leaves pqp-remuxd's registry, and
// every viewer's playlist request 404s at the edge until the replacement
// registers. The reorder buffer, added to stop loss hurting viewers, was
// converting loss into an outage.
//
// So the rule now is a property of a PACKET, not of a hole: nothing waits
// in here longer than holdMax after ITS OWN arrival. When that deadline
// passes the buffer gives up on every hole in front of the overdue packet
// in ONE drain, and the holes it uncovers on the way do not start a new
// clock, because the packets behind them are being timed from their own
// arrivals too. Two further triggers give up EARLY, when the hole can no
// longer be filled in time to be worth anything: maxPending packets piled
// up behind it, and a pending set that already spans more than holdMax of
// MEDIA time (the "the source rate collapsed" case -- few packets, but the
// media they carry is already older than the wait could ever be worth).
//
// The bound that comes out of it, and that reorderDelayBound states in one
// expression: a packet is delivered at most holdMax after it arrived, plus
// however long until the next time the buffer is looked at (the next
// packet, or internal/session's monitor tick, whichever is sooner). See
// TestReorderBuffer_PathologicalLossBoundsDelay, which drives the worst
// shape found in production -- every other packet missing for 3 s at
// 30 pkt/s -- and asserts the measured maximum stays under 400 ms.
//
// The depacketizer's own sequence check (h264.Depacketizer.PushRTP) still
// sees every gap this buffer gives up on and runs its drop-until-marker
// path; this buffer only makes that the exception.
type reorderBuffer struct {
	have    bool
	next    uint16
	pending map[uint16]pendingPacket

	holdMax    time.Duration
	maxPending int

	late    uint64 // behind next, or a duplicate of something pending
	skipped uint64 // holes given up on
	// heldDelayed and resequenced are the two halves of what used to be
	// one `held` counter, which conflated them and made the production
	// numbers unreadable (a window could read `lost=1 held=136` and mean
	// "one hole, and 136 packets that were merely out of order").
	//
	//	resequenced: a packet that waited in pending and went out because
	//	the hole IN FRONT OF IT WAS FILLED. This is the buffer doing the
	//	job it exists for: a retransmission landed inside the hold and
	//	nothing was declared lost.
	//
	//	heldDelayed: a packet that waited in pending and went out because
	//	the buffer GAVE UP on the hole in front of it. This is the cost
	//	side: media that was delayed and then delivered behind a gap the
	//	depacketizer is about to act on.
	//
	// Their sum is the old `held`.
	heldDelayed uint64
	resequenced uint64
	// maxDelay is the longest any delivered packet waited in here, since
	// the last takeReorderMaxDelayMs. Windowed rather than cumulative on
	// purpose: a session max would be pinned by one bad minute and say
	// nothing about the minute an operator is looking at.
	maxDelay time.Duration
}

// pendingPacket is one held packet and the instant IT arrived -- the whole
// point of the per-packet deadline above.
type pendingPacket struct {
	pkt *rtp.Packet
	at  time.Time
}

const (
	// reorderHoldMax is the default REORDER_HOLD_MS: how much extra
	// latency a retransmission is given. Publisher to SFU is a
	// transatlantic hop for most presenters (UK to BR measured at
	// ~200 ms), and the SFU NACKs the publisher, so the retransmission
	// lands roughly one RTT after the loss.
	reorderHoldMax = 300 * time.Millisecond
	// reorderMaxPending is the packet-count bound on the same wait: at
	// ~300 packets/s of 720p screen share it is about the same 300 ms.
	// It is NOT a substitute for the per-packet deadline -- during the
	// loss episodes that matter the source drops to ~30 pkt/s and this
	// is never reached, which is exactly how the serial-hold bug stayed
	// invisible.
	reorderMaxPending = 96
)

func newReorderBuffer(holdMax time.Duration) *reorderBuffer {
	if holdMax < 0 {
		holdMax = 0
	}
	return &reorderBuffer{pending: make(map[uint16]pendingPacket), holdMax: holdMax, maxPending: reorderMaxPending}
}

// holding reports whether any packet is waiting behind a hole. While one
// is, the frame the hole belongs to is unknown and could be older than
// every packet held, which is why the part deadline (deadlineTick) does
// not fill the timeline past it.
func (r *reorderBuffer) holding() bool { return len(r.pending) > 0 }

// reorderDelayBound is the worst-case delay this buffer can add to the
// pipeline, in one expression: the hold itself, plus the longest a packet
// that has already gone overdue can sit before anything looks at the
// buffer again. Nothing calls push while the source is silent, so that
// second term is internal/session's monitor tick (which calls
// flushOverdue), and it is shorter than that whenever packets are still
// arriving.
//
// internal/control's watchdog is sized against this: see
// WatchdogConfig.partStuckThreshold.
func reorderDelayBound(holdMax, checkEvery time.Duration) time.Duration {
	if holdMax <= 0 {
		return 0
	}
	return holdMax + checkEvery
}

// push takes one arrived packet and returns the packets now deliverable in
// order (possibly none, possibly several).
func (r *reorderBuffer) push(p *rtp.Packet, now time.Time) []*rtp.Packet {
	if !r.have {
		r.have = true
		r.next = p.SequenceNumber + 1
		return []*rtp.Packet{p}
	}
	d := int16(p.SequenceNumber - r.next)
	switch {
	case d == 0:
		r.next++
		out := r.drainContiguous([]*rtp.Packet{p}, now, &r.resequenced)
		// A hole further ahead may already be overdue on its own clock:
		// filling this one does not buy the ones behind it more time.
		return r.releaseOverdue(out, now)
	case d < 0:
		r.late++
		return nil
	}
	if _, dup := r.pending[p.SequenceNumber]; dup {
		r.late++
		return nil
	}
	if r.holdMax <= 0 {
		// REORDER_HOLD_MS=0: no holding at all. The gap is handed to the
		// depacketizer the instant it is seen, which is exactly what this
		// code did before the buffer existed -- the rollback switch.
		r.skipped++
		r.next = p.SequenceNumber + 1
		return []*rtp.Packet{p}
	}
	r.pending[p.SequenceNumber] = pendingPacket{pkt: p, at: now}
	return r.releaseOverdue(nil, now)
}

// flushOverdue is for a stream that went quiet with packets still pending:
// a packet that has waited out its own hold is delivered even though no
// new packet arrived to trigger the check. internal/session's monitor
// calls it on every tick (reorderTick), which is what bounds the delay of
// the last packets of a loss episode that ends in silence -- without it
// those sit in the map until the source speaks again, which on a static
// tab share can be seconds.
func (r *reorderBuffer) flushOverdue(now time.Time) []*rtp.Packet {
	if len(r.pending) == 0 {
		return nil
	}
	return r.releaseOverdue(nil, now)
}

// releaseOverdue gives up on holes until no give-up trigger fires. Each
// iteration removes at least one pending packet, so it terminates.
func (r *reorderBuffer) releaseOverdue(out []*rtp.Packet, now time.Time) []*rtp.Packet {
	for len(r.pending) > 0 {
		limit, ok := r.forcedLimit(now)
		if !ok {
			return out
		}
		out = r.releaseThrough(out, limit, now)
		out = r.drainContiguous(out, now, &r.heldDelayed)
	}
	return out
}

// pendingEntry is one pending packet flattened for ordering: delta is its
// distance ahead of next, wrap-safe.
type pendingEntry struct {
	delta int32
	seq   uint16
	at    time.Time
	ts    uint32
}

func (r *reorderBuffer) pendingSorted() []pendingEntry {
	out := make([]pendingEntry, 0, len(r.pending))
	for seq, pp := range r.pending {
		out = append(out, pendingEntry{
			delta: int32(int16(seq - r.next)),
			seq:   seq,
			at:    pp.at,
			ts:    pp.pkt.Timestamp,
		})
	}
	sort.Slice(out, func(i, j int) bool { return out[i].delta < out[j].delta })
	return out
}

// forcedLimit answers "is the buffer required to give up right now, and if
// so, through which sequence number". Three triggers, in the order they
// are cheapest to reason about:
//
//  1. maxPending packets are piled up behind the hole. Release everything:
//     whatever is missing is not coming.
//  2. The pending packets already span more than holdMax of MEDIA time.
//     This is the "the source rate has collapsed" case in the only form
//     the buffer can actually observe: few packets, but the oldest of them
//     is carrying a picture already older than the wait is worth. Waiting
//     the rest of the hold out cannot make the pipeline any less late, it
//     can only make it later.
//  3. The oldest pending packet has waited out its own holdMax. Release
//     through the FURTHEST overdue packet, so every hole in front of it
//     goes in one drain rather than one per hold.
//
// The returned sequence number is always one that is currently pending, so
// releaseThrough always removes at least one entry.
func (r *reorderBuffer) forcedLimit(now time.Time) (uint16, bool) {
	ents := r.pendingSorted()
	if len(ents) == 0 {
		return 0, false
	}
	newest := ents[len(ents)-1].seq

	if len(ents) >= r.maxPending {
		return newest, true
	}
	if span := int32(ents[len(ents)-1].ts - ents[0].ts); span > 0 && span > ticksForHold(r.holdMax) {
		return newest, true
	}

	deadline := now.Add(-r.holdMax)
	limit, ok := uint16(0), false
	for _, e := range ents {
		if !e.at.After(deadline) {
			limit, ok = e.seq, true
		}
	}
	return limit, ok
}

// ticksForHold converts a hold into 90 kHz media ticks. Milliseconds
// first, so the multiplication cannot overflow for any hold a config
// accepts.
func ticksForHold(d time.Duration) int32 {
	ms := d.Milliseconds()
	const maxMs = int64(math.MaxInt32) / int64(h264.ClockRate/1000)
	if ms > maxMs {
		return math.MaxInt32
	}
	return int32(ms * int64(h264.ClockRate/1000))
}

// releaseThrough delivers every pending packet up to and including limit,
// in sequence order, jumping next over the holes between them. Each
// distinct hole counts once in skipped -- the depacketizer will see each
// of them as its own ErrPacketsLost.
func (r *reorderBuffer) releaseThrough(out []*rtp.Packet, limit uint16, now time.Time) []*rtp.Packet {
	ents := r.pendingSorted()
	lim := int32(int16(limit - r.next))
	for _, e := range ents {
		if e.delta > lim {
			break
		}
		if e.seq != r.next {
			r.skipped++
		}
		pp := r.pending[e.seq]
		delete(r.pending, e.seq)
		r.heldDelayed++
		r.noteDelay(now.Sub(pp.at))
		out = append(out, pp.pkt)
		r.next = e.seq + 1
	}
	return out
}

// drainContiguous delivers the unbroken run of pending packets starting at
// next. counter says WHY they were waiting: resequenced when an arriving
// packet filled the hole in front of them, heldDelayed when the buffer
// gave up on it.
func (r *reorderBuffer) drainContiguous(out []*rtp.Packet, now time.Time, counter *uint64) []*rtp.Packet {
	for {
		pp, ok := r.pending[r.next]
		if !ok {
			return out
		}
		delete(r.pending, r.next)
		*counter++
		r.noteDelay(now.Sub(pp.at))
		out = append(out, pp.pkt)
		r.next++
	}
}

func (r *reorderBuffer) noteDelay(d time.Duration) {
	if d > r.maxDelay {
		r.maxDelay = d
	}
}

// reorderLate / reorderHeldDelayed / reorderResequenced read the buffer's
// counters under videoMu for the stats line.
func (s *Session) reorderLate() uint64 {
	s.videoMu.Lock()
	defer s.videoMu.Unlock()
	if s.reorder == nil {
		return 0
	}
	return s.reorder.late
}

func (s *Session) reorderHeldDelayed() uint64 {
	s.videoMu.Lock()
	defer s.videoMu.Unlock()
	if s.reorder == nil {
		return 0
	}
	return s.reorder.heldDelayed
}

func (s *Session) reorderResequenced() uint64 {
	s.videoMu.Lock()
	defer s.videoMu.Unlock()
	if s.reorder == nil {
		return 0
	}
	return s.reorder.resequenced
}

// takeReorderMaxDelayMs reads AND RESETS the windowed maximum reorder
// delay. Only RunMonitor calls it, once per stats line: Stats() must stay
// side-effect free because internal/control's watchdog reads it every
// 100 ms and would otherwise keep clearing the number the log line is
// about to print.
func (s *Session) takeReorderMaxDelayMs() int64 {
	s.videoMu.Lock()
	defer s.videoMu.Unlock()
	if s.reorder == nil {
		return 0
	}
	d := s.reorder.maxDelay
	s.reorder.maxDelay = 0
	return d.Milliseconds()
}

// reorderTick is the monitor's half of flushOverdue: it delivers whatever
// has waited out its hold on a source that has gone quiet. Called on every
// monitor tick, which is what makes reorderDelayBound's second term the
// tick interval rather than "until the source speaks again".
func (s *Session) reorderTick(now time.Time) {
	s.videoMu.Lock()
	defer s.videoMu.Unlock()
	if s.reorder == nil || s.videoStopped {
		return
	}
	for _, ordered := range s.reorder.flushOverdue(now) {
		s.handleOrderedVideoPacket(ordered, now)
	}
}
