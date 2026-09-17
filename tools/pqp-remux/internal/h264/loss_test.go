package h264

import (
	"bytes"
	"errors"
	"testing"

	"github.com/rafaelcg/pqp/tools/pqp-remux/internal/nal"
)

// Production 2026-09-17: a lossy presenter uplink lost the MIDDLE fragment
// of a P-slice. The end fragment (marker) still arrived, so nothing tripped
// the timestamp rule, pion glued the surviving fragments together, and a
// slice with a hole in it went out to every viewer. ffmpeg: "P sub_mb_type
// out of range"; VideoToolbox: -12909; hls.js: MEDIA_ERR_DECODE.
func TestDepacketizer_PushRTP_MiddleFragmentLossDiscardsTheAccessUnit(t *testing.T) {
	d := NewDepacketizer()
	seq := uint16(100)
	push := func(p []byte, ts uint32, marker bool) (*AccessUnit, error) {
		seq++
		return pushRTPOne(d, p, seq, ts, marker)
	}

	if au, err := push(stapA(
		singleNALPacket(nal.TypeSPS, 3, []byte{0x42, 0x00, 0x1F}),
		singleNALPacket(nal.TypePPS, 3, []byte{0xAA}),
	), 1000, false); err != nil || au != nil {
		t.Fatalf("SPS/PPS: au=%v err=%v", au, err)
	}
	if au, err := push(singleNALPacket(nal.TypeIDR, 3, []byte{0x01, 0x02}), 1000, true); err != nil || au == nil || !au.IsIDR {
		t.Fatalf("IDR: au=%v err=%v", au, err)
	}

	frags := fuA(nal.TypeSlice, 2, bytes.Repeat([]byte{0x33}, 400), 4)
	if au, err := push(frags[0], 4000, false); err != nil || au != nil {
		t.Fatalf("frag 0: au=%v err=%v", au, err)
	}
	if au, err := push(frags[1], 4000, false); err != nil || au != nil {
		t.Fatalf("frag 1: au=%v err=%v", au, err)
	}
	seq++ // frags[2] never arrives
	au, err := push(frags[3], 4000, true)
	if !errors.Is(err, ErrPacketsLost) {
		t.Fatalf("end fragment after a gap: err=%v, want ErrPacketsLost", err)
	}
	if au != nil {
		t.Fatalf("a slice with a hole in it was emitted: %d bytes", len(au.AVCC))
	}
	if !IsDamage(err) {
		t.Fatal("ErrPacketsLost must count as damage")
	}
	if got := d.LostPackets(); got != 1 {
		t.Fatalf("LostPackets = %d, want 1", got)
	}

	// The next access unit is whole and comes out clean.
	next, err := push(singleNALPacket(nal.TypeSlice, 2, []byte{0x44, 0x55}), 7000, true)
	if err != nil || next == nil {
		t.Fatalf("next AU: au=%v err=%v", next, err)
	}
	if len(next.Units) != 1 || bytes.Contains(next.AVCC, []byte{0x33, 0x33, 0x33, 0x33}) {
		t.Fatalf("stale fragment bytes leaked into the next AU: units=%d", len(next.Units))
	}
}

// A gap whose first surviving packet is NOT the marker: the rest of that
// damaged AU (up to the marker) must be skipped too, since a fragment with
// no START bit has nothing to attach to.
func TestDepacketizer_PushRTP_GapMidAUSkipsTheRestOfThatAU(t *testing.T) {
	d := NewDepacketizer()
	seq := uint16(7)
	push := func(p []byte, ts uint32, marker bool) (*AccessUnit, error) {
		seq++
		return pushRTPOne(d, p, seq, ts, marker)
	}
	if au, err := push(singleNALPacket(nal.TypeIDR, 3, []byte{0x01}), 1000, true); err != nil || au == nil {
		t.Fatalf("IDR: au=%v err=%v", au, err)
	}
	frags := fuA(nal.TypeSlice, 2, bytes.Repeat([]byte{0x33}, 600), 6)
	if _, err := push(frags[0], 4000, false); err != nil {
		t.Fatal(err)
	}
	seq += 2 // frags[1], frags[2] lost
	if au, err := push(frags[3], 4000, false); !errors.Is(err, ErrPacketsLost) || au != nil {
		t.Fatalf("frag 3: au=%v err=%v", au, err)
	}
	if au, err := push(frags[4], 4000, false); err != nil || au != nil {
		t.Fatalf("frag 4 (skipped): au=%v err=%v", au, err)
	}
	if au, err := push(frags[5], 4000, true); err != nil || au != nil {
		t.Fatalf("frag 5 (skipped marker): au=%v err=%v", au, err)
	}
	if got := d.LostPackets(); got != 2 {
		t.Fatalf("LostPackets = %d, want 2", got)
	}
	next, err := push(singleNALPacket(nal.TypeSlice, 2, []byte{0x44}), 7000, true)
	if err != nil || next == nil || len(next.Units) != 1 {
		t.Fatalf("next AU: au=%v err=%v", next, err)
	}
}

func TestDepacketizer_PushRTP_LateAndDuplicatePacketsAreIgnored(t *testing.T) {
	d := NewDepacketizer()
	if au, err := pushRTPOne(d, singleNALPacket(nal.TypeIDR, 3, []byte{0x01}), 10, 1000, true); err != nil || au == nil {
		t.Fatalf("IDR: au=%v err=%v", au, err)
	}
	if _, err := pushRTPOne(d, singleNALPacket(nal.TypeSlice, 2, []byte{0x02}), 10, 1000, true); !errors.Is(err, ErrLatePacket) {
		t.Fatalf("duplicate: err=%v, want ErrLatePacket", err)
	}
	if _, err := pushRTPOne(d, singleNALPacket(nal.TypeSlice, 2, []byte{0x02}), 9, 1000, true); !errors.Is(err, ErrLatePacket) {
		t.Fatalf("late: err=%v, want ErrLatePacket", err)
	}
	if IsDamage(ErrLatePacket) {
		t.Fatal("a late packet is not damage")
	}
	if au, err := pushRTPOne(d, singleNALPacket(nal.TypeSlice, 2, []byte{0x03}), 11, 4000, true); err != nil || au == nil {
		t.Fatalf("next in order: au=%v err=%v", au, err)
	}
	if d.LostPackets() != 0 {
		t.Fatalf("LostPackets = %d, want 0", d.LostPackets())
	}
}

// Sequence numbers wrap at 65535; a wrap is not a gap.
func TestDepacketizer_PushRTP_WrapIsNotAGap(t *testing.T) {
	d := NewDepacketizer()
	if _, err := pushRTPOne(d, singleNALPacket(nal.TypeIDR, 3, []byte{0x01}), 65535, 1000, true); err != nil {
		t.Fatal(err)
	}
	if au, err := pushRTPOne(d, singleNALPacket(nal.TypeSlice, 2, []byte{0x02}), 0, 4000, true); err != nil || au == nil {
		t.Fatalf("wrap: au=%v err=%v", au, err)
	}
}
