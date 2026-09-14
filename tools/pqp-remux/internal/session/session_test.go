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
	if h.BytesWritten == 0 {
		t.Fatal("expected BytesWritten to reflect the written fragment bytes")
	}
	if _, ok := r.Segment(0); !ok {
		t.Fatal("expected segment 0 to exist in the ring")
	}
}

// TestSession_FinishFlushesTrailingFragment is the regression test for the
// bug Farol caught: when the RTP track ends between part boundaries, the
// accumulated-but-not-yet-closed tail used to be silently dropped because
// nothing ever called the fragmenter's Flush. Finish (wired to
// subscriber.Handlers.OnVideoTrackEnded in main.go) must publish it.
func TestSession_FinishFlushesTrailingFragment(t *testing.T) {
	r := ring.New(6, 90000)
	s := New(45000, 360000, r, nil)

	s.HandleVideoPacket(videoPacket(singleNAL(7, realishSPS()[1:]), 0, false))
	s.HandleVideoPacket(videoPacket(singleNAL(8, realishPPS()[1:]), 0, false))
	// Just an IDR and two P-frames: nowhere near a 45000-tick part
	// boundary, so nothing has reached the ring yet.
	s.HandleVideoPacket(videoPacket(singleNAL(5, []byte{0xAA}), 0, true))
	s.HandleVideoPacket(videoPacket(singleNAL(1, []byte{0xBB}), frameStep, true))
	s.HandleVideoPacket(videoPacket(singleNAL(1, []byte{0xCC}), 2*frameStep, true))

	if h := s.Health(); h.PartsWritten != 0 {
		t.Fatalf("expected nothing published before Finish, got PartsWritten=%d", h.PartsWritten)
	}

	s.Finish()

	h := s.Health()
	if h.PartsWritten != 1 {
		t.Fatalf("expected Finish to publish exactly the trailing partial fragment, got PartsWritten=%d", h.PartsWritten)
	}
	if _, ok := r.Segment(0); !ok {
		t.Fatal("expected the flushed trailing fragment to land in segment 0")
	}

	// A second Finish with nothing pending must be a harmless no-op.
	s.Finish()
	if h := s.Health(); h.PartsWritten != 1 {
		t.Fatalf("a second Finish must not publish anything new, got PartsWritten=%d", h.PartsWritten)
	}
}

// TestSession_NoFragmentsPublishedBeforeInitSegmentExists is the
// regression test for the bug Farol caught: fragments used to reach the
// ring even when BuildInitSegment had never succeeded, so a client could
// see segments/parts listed with no way to initialize a decoder for them.
func TestSession_NoFragmentsPublishedBeforeInitSegmentExists(t *testing.T) {
	r := ring.New(6, 90000)
	s := New(45000, 360000, r, nil)

	// An IDR with NO SPS/PPS ever provided: initSet can never become true.
	frameIdx := int64(0)
	for i := 0; i < 20; i++ {
		nalType := byte(1)
		if i == 0 {
			nalType = 5
		}
		s.HandleVideoPacket(videoPacket(singleNAL(nalType, []byte{0xAA}), uint32(frameIdx*frameStep), true))
		frameIdx++
	}
	s.Finish()

	if _, ok := r.Init(); ok {
		t.Fatal("no SPS/PPS was ever seen; init segment must not exist")
	}
	if h := s.Health(); h.PartsWritten != 0 {
		t.Fatalf("no fragment should ever publish without a valid init segment, got PartsWritten=%d", h.PartsWritten)
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

// TestSession_SetStartSegmentIndex is L1.6's own regression test (Farol
// review, PR #584): internal/control's watchdog restart calls this,
// before the first packet, to continue a replacement session's video
// segment numbering (and therefore its R2 object keys) past a stalled
// predecessor's, rather than starting back at 0 and silently overwriting
// objects the predecessor already uploaded.
func TestSession_SetStartSegmentIndex(t *testing.T) {
	r := ring.New(6, 90000)
	s := New(45000, 360000, r, nil)
	s.SetStartSegmentIndex(12)

	if got := s.CurrentVideoSegmentIndex(); got != 12 {
		t.Fatalf("expected CurrentVideoSegmentIndex to report the overridden start index before any packet, got %d", got)
	}

	s.HandleVideoPacket(videoPacket(singleNAL(7, realishSPS()[1:]), 0, false))
	s.HandleVideoPacket(videoPacket(singleNAL(8, realishPPS()[1:]), 0, false))
	s.HandleVideoPacket(videoPacket(singleNAL(5, []byte{0xAA, 0xBB, 0xCC}), 0, true))
	s.Finish()

	if _, ok := r.Segment(12); !ok {
		t.Fatal("expected the first (and only) segment to be uploaded/stored under the overridden index 12, not 0")
	}
	if _, ok := r.Segment(0); ok {
		t.Fatal("expected segment 0 to never have been produced once a start index was set")
	}
}

// TestSession_CurrentAudioSegmentIndexIsZeroBeforeEnableAudio guards the
// nil-audioFrag branch CurrentAudioSegmentIndex must take before
// EnableAudio has ever run -- internal/control reads this on every
// session, including ones whose audio pipeline failed to start (a
// non-fatal condition -- see EnableAudio's own doc comment).
func TestSession_CurrentAudioSegmentIndexIsZeroBeforeEnableAudio(t *testing.T) {
	r := ring.New(6, 90000)
	s := New(45000, 360000, r, nil)
	if got := s.CurrentAudioSegmentIndex(); got != 0 {
		t.Fatalf("expected 0 before EnableAudio, got %d", got)
	}
}
