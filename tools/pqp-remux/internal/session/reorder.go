package session

import (
	"time"

	"github.com/pion/rtp"
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
// So: a packet ahead of the one expected waits in pending. The hole is
// given up on when it has stood for holdMax, or when maxPending packets
// have piled up behind it, whichever first. The depacketizer's own
// sequence check (h264.Depacketizer.PushRTP) still sees the jump and runs
// the drop-until-IDR path; this buffer only makes that the exception.
type reorderBuffer struct {
	have    bool
	next    uint16
	pending map[uint16]*rtp.Packet
	// holeSince is when the current hole at next was first waited on.
	holeSince time.Time

	holdMax    time.Duration
	maxPending int

	late    uint64 // behind next, or a duplicate of something pending
	skipped uint64 // holes given up on
	held    uint64 // packets that waited in pending and were delivered
}

const (
	// reorderHoldMax bounds the extra latency a retransmission is given.
	// Publisher to SFU is a transatlantic hop for most presenters (UK to
	// BR measured at ~200 ms), and the SFU NACKs the publisher, so the
	// retransmission lands roughly one RTT after the loss.
	reorderHoldMax = 300 * time.Millisecond
	// reorderMaxPending is the packet-count bound on the same wait: at
	// ~300 packets/s of 720p screen share it is about the same 300 ms.
	reorderMaxPending = 96
)

func newReorderBuffer() *reorderBuffer {
	return &reorderBuffer{pending: make(map[uint16]*rtp.Packet), holdMax: reorderHoldMax, maxPending: reorderMaxPending}
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
		return r.drain([]*rtp.Packet{p}, now)
	case d < 0:
		r.late++
		return nil
	}
	if _, dup := r.pending[p.SequenceNumber]; dup {
		r.late++
		return nil
	}
	r.pending[p.SequenceNumber] = p
	if r.holeSince.IsZero() {
		r.holeSince = now
	}
	if len(r.pending) >= r.maxPending || now.Sub(r.holeSince) >= r.holdMax {
		return r.giveUp(now)
	}
	return nil
}

// giveUp abandons the hole at next: the expected sequence jumps to the
// oldest pending packet, so the depacketizer sees the gap.
func (r *reorderBuffer) giveUp(now time.Time) []*rtp.Packet {
	r.skipped++
	r.next = r.oldestPending()
	return r.drain(nil, now)
}

func (r *reorderBuffer) oldestPending() uint16 {
	var best uint16
	bestDelta := int32(1 << 16)
	for seq := range r.pending {
		delta := int32(int16(seq - r.next))
		if delta < bestDelta {
			bestDelta = delta
			best = seq
		}
	}
	return best
}

func (r *reorderBuffer) drain(out []*rtp.Packet, now time.Time) []*rtp.Packet {
	for {
		p, ok := r.pending[r.next]
		if !ok {
			break
		}
		delete(r.pending, r.next)
		r.held++
		out = append(out, p)
		r.next++
	}
	if len(r.pending) == 0 {
		r.holeSince = time.Time{}
	} else {
		// A new hole opens at next; its clock starts now.
		r.holeSince = now
	}
	return out
}

// flushOverdue is for a stream that went quiet with packets still
// pending: a hole that has stood for holdMax is given up on even though
// no new packet arrived to trigger the check.
func (r *reorderBuffer) flushOverdue(now time.Time) []*rtp.Packet {
	if len(r.pending) == 0 || r.holeSince.IsZero() || now.Sub(r.holeSince) < r.holdMax {
		return nil
	}
	return r.giveUp(now)
}

// reorderLate / reorderHeld read the buffer's counters under videoMu for
// the stats line.
func (s *Session) reorderLate() uint64 {
	s.videoMu.Lock()
	defer s.videoMu.Unlock()
	if s.reorder == nil {
		return 0
	}
	return s.reorder.late
}

func (s *Session) reorderHeld() uint64 {
	s.videoMu.Lock()
	defer s.videoMu.Unlock()
	if s.reorder == nil {
		return 0
	}
	return s.reorder.held
}
