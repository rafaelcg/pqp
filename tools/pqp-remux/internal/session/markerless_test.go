package session

import (
	"testing"
	"time"

	"github.com/rafaelcg/pqp/tools/pqp-remux/internal/keyframe"
	"github.com/rafaelcg/pqp/tools/pqp-remux/internal/ring"
)

// Production 2026-09-17, a London box, a real Chrome presenter, and a path
// with nothing wrong with it: lost=0 in every stats window, nackCount 0 and
// retransmittedPacketsSent 0 at the presenter, heldDelayed=+0 and
// resequenced=+0 so the reorder buffer never even engaged. The remux still
// logged eight "RTP timestamp changed before a marker packet closed the
// access unit" in fifteen minutes, each one discarding a whole frame and
// answering it with a PLI. That is a dropped frame and a forced keyframe
// every couple of minutes, self-inflicted.
//
// A missing marker bit is not loss. RFC 6184 section 5.1 makes the marker
// an optimisation for playout buffering, and ffmpeg, GStreamer and pion all
// treat a change of RTP timestamp as the access-unit boundary in its own
// right. This is the end-to-end statement of that: the frame goes out, the
// counter says it happened, and the publisher is NOT asked for a keyframe.
func TestSession_MarkerlessAccessUnitIsDeliveredWithoutAPLI(t *testing.T) {
	r := ring.New(6, 90000)
	s := New(45000, 360000, r, nil)
	clock := time.Unix(1_700_000_000, 0)
	s.now = func() time.Time { return clock }
	pli := &countingPLI{}
	s.SetKeyframeRequester(keyframe.NewRequester(keyframe.Config{Policy: keyframe.PolicyPLI, SegmentTargetMs: 4000}, pli))

	send := func(payload []byte, ts uint32, marker bool) {
		clock = clock.Add(3 * time.Millisecond)
		s.HandleVideoPacket(videoPacket(payload, ts, marker))
	}

	// An IDR to open the session, so there is an init segment and a
	// fragmenter that will accept what follows.
	send(singleNAL(7, realishSPS()[1:]), 0, false)
	send(singleNAL(8, realishPPS()[1:]), 0, false)
	send(singleNAL(5, []byte{0xAA, 0xBB}), 0, true)
	// The requester answers its own opening PLI with that IDR; from here
	// on, any further PLI is one this change would have caused.
	s.keyReq.Load().OnIDR(clock)
	plisBefore := pli.calls
	framesBefore := s.videoFramesSeen.Load()
	partsBefore := s.Stats().PartsWritten

	// A two-packet P frame whose LAST packet does not carry the marker.
	send(singleNAL(1, []byte{0xC0}), frameStep, false)
	send(singleNAL(1, []byte{0xC1}), frameStep, false)

	// The next frame's first packet: new timestamp, next sequence number,
	// nothing lost. It closes the frame in front of it.
	send(singleNAL(1, []byte{0xD0}), 2*frameStep, false)

	if got := s.videoFramesSeen.Load() - framesBefore; got != 1 {
		t.Fatalf("frames delivered = %d, want 1: the markerless access unit was thrown away", got)
	}
	if got := s.videoMarkerlessAUs.Load(); got != 1 {
		t.Fatalf("videoMarkerlessAUs = %d, want 1", got)
	}
	if s.damageOpen.Load() {
		t.Fatal("a markerless boundary opened a damage episode")
	}
	st := s.Stats()
	if st.VideoDamageEpisodes != 0 {
		t.Fatalf("VideoDamageEpisodes = %d, want 0", st.VideoDamageEpisodes)
	}
	if st.VideoDepacketizeErrs != 0 {
		t.Fatalf("VideoDepacketizeErrs = %d, want 0 on a stream with no loss in it", st.VideoDepacketizeErrs)
	}
	if st.VideoPacketsLost != 0 {
		t.Fatalf("VideoPacketsLost = %d, want 0", st.VideoPacketsLost)
	}
	if pli.calls != plisBefore {
		t.Fatalf("PLIs sent = %d, want %d: a missing marker bit must never cost a forced keyframe", pli.calls, plisBefore)
	}

	// And the stream keeps running, on through a part boundary: the next
	// frame closes on its own marker, and the ones after it close parts.
	send(singleNAL(1, []byte{0xD1}), 2*frameStep, true)
	if got := s.videoFramesSeen.Load() - framesBefore; got != 2 {
		t.Fatalf("frames delivered = %d after the following frame closed normally, want 2", got)
	}
	if s.videoMarkerlessAUs.Load() != 1 {
		t.Fatal("a frame closed by its own marker must not count as markerless")
	}
	for i := 3; i <= 24; i++ {
		send(singleNAL(1, []byte{0xE0, byte(i)}), uint32(i)*frameStep, true)
	}
	if s.Stats().PartsWritten <= partsBefore {
		t.Fatal("no part closed after the markerless boundary: the pipeline was wedged by it")
	}
	if pli.calls != plisBefore {
		t.Fatalf("PLIs sent = %d, want %d", pli.calls, plisBefore)
	}
	if s.Stats().VideoMarkerlessAUs != 1 {
		t.Fatalf("VideoMarkerlessAUs = %d on the stats snapshot, want 1", s.Stats().VideoMarkerlessAUs)
	}
}
