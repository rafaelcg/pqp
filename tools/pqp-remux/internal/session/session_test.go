package session

import (
	"testing"

	"github.com/pion/rtp"

	"github.com/rafaelcg/pqp/tools/pqp-remux/internal/ring"
)

// singleNAL builds a single-NAL-unit RTP packet payload (RFC 6184 §5.6):
// just the NAL header byte followed by its RBSP, no RTP-level framing.
func singleNAL(naluType byte, rbsp []byte) []byte {
	return append([]byte{naluType}, rbsp...)
}

func videoPacket(payload []byte, ts uint32, marker bool) *rtp.Packet {
	return &rtp.Packet{
		Header:  rtp.Header{Timestamp: ts, Marker: marker},
		Payload: payload,
	}
}

// realishSPS/realishPPS reuse the exact minimal-but-valid SPS shape the
// cmaf package's own tests build (1280x720 baseline), so BuildInitSegment
// actually succeeds here instead of exercising only its error path.
func realishSPS() []byte {
	// profile_idc=66, constraints=0, level_idc=31, sps_id=0, log2 fields,
	// 1280x720, frame_mbs_only=1, no cropping, then rbsp stop bit + pad.
	// (Same bit layout as internal/cmaf's buildTestSPS helper.)
	return []byte{0x07, 0x42, 0x00, 0x1F, 0x8C, 0x8D, 0x40, 0x50, 0x1E, 0xD0, 0x80, 0x00, 0x00, 0x00}
}

func realishPPS() []byte { return []byte{0x08, 0xAA} }

const frameStep = 3000 // ~33ms at 90kHz

func TestSession_BuildsInitSegmentOnFirstIDR(t *testing.T) {
	r := ring.New(6, 90000)
	s := New(45000, 360000, r, nil)

	s.HandleVideoPacket(videoPacket(singleNAL(7, realishSPS()[1:]), 0, false))        // NAL type 7 = SPS
	s.HandleVideoPacket(videoPacket(singleNAL(8, realishPPS()[1:]), 0, false))        // NAL type 8 = PPS
	s.HandleVideoPacket(videoPacket(singleNAL(5, []byte{0xAA, 0xBB, 0xCC}), 0, true)) // IDR, marker closes the AU

	if _, ok := r.Init(); !ok {
		t.Fatal("expected the init segment to be built once SPS+PPS+IDR have all arrived")
	}
	h := s.Health()
	if h.LastIdrAtMs < 0 {
		t.Fatalf("expected LastIdrAtMs to be set, got %d", h.LastIdrAtMs)
	}
}

func TestSession_PartsReachTheRing(t *testing.T) {
	r := ring.New(6, 90000)
	s := New(45000, 360000, r, nil) // 500ms parts, 4s segments @ 90kHz

	frameIdx := int64(0)
	sendFrame := func(idr bool) {
		nalType := byte(1)
		if idr {
			nalType = 5
		}
		s.HandleVideoPacket(videoPacket(singleNAL(nalType, []byte{0xAA, 0xBB}), uint32(frameIdx*frameStep), true))
		frameIdx++
	}

	// SPS/PPS once, then the first IDR, then enough P-frames to cross a
	// part boundary (500ms = 45000 ticks = 15 frames at 3000/frame).
	s.HandleVideoPacket(videoPacket(singleNAL(7, realishSPS()[1:]), 0, false))
	s.HandleVideoPacket(videoPacket(singleNAL(8, realishPPS()[1:]), 0, false))
	sendFrame(true)
	for i := 0; i < 20; i++ {
		sendFrame(false)
	}

	h := s.Health()
	if h.PartsWritten == 0 {
		t.Fatal("expected at least one part to reach the ring")
	}
	if h.BytesServed == 0 {
		t.Fatal("expected BytesServed to reflect the written fragment bytes")
	}
	if _, ok := r.Segment(0); !ok {
		t.Fatal("expected segment 0 to exist in the ring")
	}
}

func TestSession_HealthReflectsSubscription(t *testing.T) {
	r := ring.New(6, 90000)
	s := New(45000, 360000, r, nil)

	if h := s.Health(); h.Subscribed || h.Status != "waiting-for-track" {
		t.Fatalf("expected an unsubscribed starting state, got %+v", h)
	}
	s.MarkSubscribed()
	if h := s.Health(); !h.Subscribed || h.Status != "ok" {
		t.Fatalf("expected subscribed/ok after MarkSubscribed, got %+v", h)
	}
}

func TestSession_AudioPacketsAreCountedNotMuxed(t *testing.T) {
	r := ring.New(6, 90000)
	s := New(45000, 360000, r, nil)
	s.HandleAudioPacket(&rtp.Packet{Header: rtp.Header{PayloadType: 111}})
	s.HandleAudioPacket(&rtp.Packet{Header: rtp.Header{PayloadType: 111}})
	if s.audioPacketsSeen.Load() != 2 {
		t.Fatalf("audioPacketsSeen = %d, want 2", s.audioPacketsSeen.Load())
	}
}
