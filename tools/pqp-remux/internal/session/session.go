// Package session wires the pieces every other internal package built in
// isolation: RTP in from internal/subscriber, through
// internal/h264 (depacketize) and internal/pipeline (fragment), into an
// internal/ring for internal/serve to answer HTTP with. It is the "L1.2"
// glue task 2 in the PR description refers to as one thing, kept in its
// own file so main.go stays a thin bag of flag parsing and Run() calls.
package session

import (
	"log"
	"sync/atomic"
	"time"

	"github.com/pion/rtp"

	"github.com/rafaelcg/pqp/tools/pqp-remux/internal/cmaf"
	"github.com/rafaelcg/pqp/tools/pqp-remux/internal/h264"
	"github.com/rafaelcg/pqp/tools/pqp-remux/internal/keyframe"
	"github.com/rafaelcg/pqp/tools/pqp-remux/internal/pipeline"
	"github.com/rafaelcg/pqp/tools/pqp-remux/internal/ring"
	"github.com/rafaelcg/pqp/tools/pqp-remux/internal/serve"
)

// Session owns the one video track's whole pipeline: depacketize, mux,
// publish into the ring. HandleVideoPacket is meant to be called from a
// single goroutine (the subscriber's own RTP reader for that track), so the
// depacketizer/fragmenter/ring writes below need no lock of their own; the
// atomics exist only because Health() is read concurrently from HTTP
// handler goroutines.
type Session struct {
	dep  *h264.Depacketizer
	frag *pipeline.Fragmenter
	ring *ring.Ring

	// keyReq is an atomic pointer, nil under KEYFRAME_POLICY=natural and
	// under --idr-log (L0.1 result item 4 requires idr-log to stay passive
	// regardless of KEYFRAME_POLICY, which callers get for free by simply
	// never constructing a Requester in that mode — see
	// cmd/pqp-remux/main.go). It is atomic because the caller cannot
	// always construct the Requester before Session starts receiving
	// packets: a Requester needs the subscriber.Session that Connect
	// returns, which in turn needs this Session's bound methods to set up
	// its Handlers, so SetKeyframeRequester is called once, shortly after
	// New, from a different goroutine than HandleVideoPacket runs on.
	keyReq atomic.Pointer[keyframe.Requester]

	started time.Time

	initSet          atomic.Bool
	subscribed       atomic.Bool
	partsWritten     atomic.Uint64
	bytesWritten     atomic.Uint64
	lastPartAtMs     atomic.Int64
	lastIdrAtMs      atomic.Int64
	audioPacketsSeen atomic.Uint64
}

// New builds a Session that writes into r using cfg's part/segment
// durations. keyReq may be nil (see the Session.keyReq doc comment) and
// set later with SetKeyframeRequester.
func New(partTicks, segmentTicks uint32, r *ring.Ring, keyReq *keyframe.Requester) *Session {
	s := &Session{
		dep: h264.NewDepacketizer(),
		frag: pipeline.NewFragmenter(pipeline.Config{
			Timescale:       h264.ClockRate,
			PartDuration:    partTicks,
			SegmentDuration: segmentTicks,
		}),
		ring:    r,
		started: time.Now(),
	}
	if keyReq != nil {
		s.keyReq.Store(keyReq)
	}
	return s
}

// MarkSubscribed flips Health().Subscribed to true; call it once the
// presenter's screen-share video track is actually found (subscriber's
// OnVideoTrackFound), not merely once the room connects.
func (s *Session) MarkSubscribed() { s.subscribed.Store(true) }

// SetKeyframeRequester wires a keyframe.Requester in (or out, with nil)
// after construction. Safe to call concurrently with HandleVideoPacket.
func (s *Session) SetKeyframeRequester(r *keyframe.Requester) { s.keyReq.Store(r) }

// HandleVideoPacket feeds one RTP packet from the subscribed screen-share
// video track through depacketization, CMAF muxing and the ring, in that
// order. A malformed packet is logged and otherwise ignored: one bad
// packet must not take down the whole session (the depacketizer already
// keeps accumulating past it; see internal/h264's doc comment).
func (s *Session) HandleVideoPacket(pkt *rtp.Packet) {
	au, err := s.dep.Push(pkt.Payload, pkt.Timestamp, pkt.Marker)
	if err != nil {
		log.Printf("pqp-remux: h264 depacketize: %v", err)
	}
	if au == nil {
		return
	}

	if au.IsIDR {
		s.lastIdrAtMs.Store(s.elapsedMs())
		if kr := s.keyReq.Load(); kr != nil {
			kr.OnIDR(time.Now())
		}
	}

	if !s.initSet.Load() && len(au.SPS) > 0 && len(au.PPS) > 0 {
		initSeg, err := cmaf.BuildInitSegment(cmaf.InitParams{
			Timescale: h264.ClockRate,
			SPS:       au.SPS,
			PPS:       au.PPS,
		})
		if err != nil {
			log.Printf("pqp-remux: building init segment: %v", err)
		} else {
			s.ring.SetInit(initSeg)
			s.initSet.Store(true)
		}
	}

	frag, err := s.frag.Push(au)
	if err != nil && err != pipeline.ErrWaitingForIDR {
		log.Printf("pqp-remux: fragmenter: %v", err)
	}
	if frag == nil {
		return
	}
	s.ring.Push(frag)
	s.partsWritten.Add(1)
	s.bytesWritten.Add(uint64(len(frag.Bytes)))
	s.lastPartAtMs.Store(s.elapsedMs())
}

// HandleAudioPacket only counts and logs (once) that the presenter's
// screen-share audio track is present: mixing it in is L1.3, per the task
// scope in the plan.
func (s *Session) HandleAudioPacket(pkt *rtp.Packet) {
	if s.audioPacketsSeen.Add(1) == 1 {
		log.Printf("pqp-remux: screen-share audio track present (payload type %d); not mixed yet (L1.3)", pkt.PayloadType)
	}
}

func (s *Session) elapsedMs() int64 { return time.Since(s.started).Milliseconds() }

// Health implements serve.HealthSource.
func (s *Session) Health() serve.Health {
	status := "waiting-for-track"
	if s.subscribed.Load() {
		status = "ok"
	}
	return serve.Health{
		Status:       status,
		Subscribed:   s.subscribed.Load(),
		PartsWritten: s.partsWritten.Load(),
		BytesServed:  s.bytesWritten.Load(),
		LastPartAtMs: s.lastPartAtMs.Load(),
		LastIdrAtMs:  s.lastIdrAtMs.Load(),
	}
}
