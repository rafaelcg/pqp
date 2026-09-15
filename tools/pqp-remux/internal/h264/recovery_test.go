package h264

import (
	"bytes"
	"testing"

	"github.com/rafaelcg/pqp/tools/pqp-remux/internal/nal"
)

// The other half of the keyframe path, and hypothesis (b) of the
// 2026-09-15 investigation: after real packet loss, does the depacketizer
// recover when the publisher finally answers a PLI with a fresh IDR, or
// does it stay wedged forever?
//
// It recovers, and this pins that it does. The loss here is the shape the
// production log actually showed -- a fragmented frame whose tail never
// arrived, so no marker packet ever closed it, and then the next frame's
// timestamp turning up instead ("RTP timestamp changed before a marker
// packet closed the access unit"). Fourteen of those in five minutes was
// the entire evidence the incident left.
func TestDepacketizer_RecoversOnTheNextIDRAfterLoss(t *testing.T) {
	d := NewDepacketizer()

	// A clean IDR first, so the session has a keyframe before the loss.
	sps := []byte{0x42, 0x00, 0x1F}
	pps := []byte{0xAA}
	if au, err := d.Push(stapA(
		singleNALPacket(nal.TypeSPS, 3, sps),
		singleNALPacket(nal.TypePPS, 3, pps),
	), 1000, false); err != nil || au != nil {
		t.Fatalf("SPS/PPS: au=%v err=%v", au, err)
	}
	first, err := d.Push(singleNALPacket(nal.TypeIDR, 3, []byte{0x01, 0x02}), 1000, true)
	if err != nil || first == nil || !first.IsIDR {
		t.Fatalf("the first IDR did not come out: au=%v err=%v", first, err)
	}

	// Now lose the tail of a fragmented frame: the first two of four FU-A
	// packets arrive, the last two (including the one carrying the RTP
	// marker) never do.
	frags := fuA(nal.TypeSlice, 2, bytes.Repeat([]byte{0x33}, 400), 4)
	for _, p := range frags[:2] {
		if au, err := d.Push(p, 4000, false); err != nil || au != nil {
			t.Fatalf("mid-loss fragment: au=%v err=%v", au, err)
		}
	}

	// The next frame turns up with a new timestamp. The half-assembled
	// access unit is discarded, loudly, and never merged into this one.
	au, err := d.Push(singleNALPacket(nal.TypeSlice, 2, []byte{0x44}), 7000, true)
	if err != errTimestampChangedMidAU {
		t.Fatalf("expected the lost-marker error, got %v", err)
	}
	if au == nil {
		t.Fatal("the frame that followed the loss was itself dropped")
	}
	if au.IsIDR {
		t.Fatal("a non-IDR frame was reported as a keyframe")
	}
	if bytes.Contains(au.AVCC, bytes.Repeat([]byte{0x33}, 8)) {
		t.Fatal("the discarded access unit's bytes leaked into the next one")
	}

	// And the keyframe the PLI asks for comes through whole, with its
	// SPS/PPS still available for the init segment -- which is what
	// "recovers" has to mean for a muxer, not merely "stops erroring".
	idrPayload := []byte{0x09, 0x08, 0x07}
	recovered, err := d.Push(stapA(
		singleNALPacket(nal.TypeSPS, 3, sps),
		singleNALPacket(nal.TypePPS, 3, pps),
		singleNALPacket(nal.TypeIDR, 3, idrPayload),
	), 10000, true)
	if err != nil {
		t.Fatalf("the recovery IDR errored: %v", err)
	}
	if recovered == nil {
		t.Fatal("the recovery IDR produced no access unit")
	}
	if !recovered.IsIDR {
		t.Fatal("the recovery access unit is not marked as a keyframe")
	}
	if !bytes.Contains(recovered.AVCC, idrPayload) {
		t.Fatal("the recovery IDR's own bytes are missing from the access unit")
	}
	if len(recovered.SPS) == 0 || len(recovered.PPS) == 0 {
		t.Fatal("the recovery IDR carries no SPS/PPS, so no init segment could be built from it")
	}
	if recovered.PTS <= au.PTS {
		t.Fatalf("PTS did not advance across the recovery: %d then %d", au.PTS, recovered.PTS)
	}
}
