package h264

import (
	"bytes"
	"testing"

	"github.com/rafaelcg/pqp/tools/pqp-remux/internal/nal"
)

// singleNALPacket builds one RTP-payload-shaped byte slice carrying a
// single (non-fragmented) NAL unit: the RFC 6184 §5.6 "single NAL unit
// packet" case, which is a NAL header byte followed by its RBSP with no
// RTP-level framing of its own.
func singleNALPacket(naluType nal.Type, refIdc uint8, rbsp []byte) []byte {
	header := byte(naluType) | (refIdc << 5)
	return append([]byte{header}, rbsp...)
}

// stapA packs several NAL units (as fed to singleNALPacket, minus the RTP
// framing) into one STAP-A aggregation packet (RFC 6184 §5.7.1).
func stapA(nalus ...[]byte) []byte {
	out := []byte{24} // STAP-A header, F=0 NRI=00 type=24
	for _, n := range nalus {
		out = append(out, byte(len(n)>>8), byte(len(n)))
		out = append(out, n...)
	}
	return out
}

// fuA fragments one NAL unit's payload across n FU-A packets (RFC 6184
// §5.8), returning each packet's payload in order.
func fuA(naluType nal.Type, refIdc uint8, rbsp []byte, n int) [][]byte {
	if n < 2 {
		panic("fuA needs at least 2 fragments")
	}
	chunk := (len(rbsp) + n - 1) / n
	var packets [][]byte
	for i := 0; i < n; i++ {
		start := i * chunk
		if start > len(rbsp) {
			start = len(rbsp)
		}
		end := start + chunk
		if end > len(rbsp) {
			end = len(rbsp)
		}
		fuIndicator := byte(28) | (refIdc << 5) // FU-A, type 28
		fuHeader := byte(naluType)
		if i == 0 {
			fuHeader |= 0x80 // start bit
		}
		if i == n-1 {
			fuHeader |= 0x40 // end bit
		}
		packets = append(packets, append([]byte{fuIndicator, fuHeader}, rbsp[start:end]...))
	}
	return packets
}

func mustParseUnits(t *testing.T, avcc []byte) []nal.Unit {
	t.Helper()
	units, err := nal.ParseAVCC(avcc)
	if err != nil {
		t.Fatalf("ParseAVCC: %v", err)
	}
	return units
}

func TestDepacketizer_SingleNALPerPacket(t *testing.T) {
	d := NewDepacketizer()

	sps := []byte{0x01, 0x02, 0x03}
	pps := []byte{0x04, 0x05}
	idr := bytes.Repeat([]byte{0xAB}, 20)

	// SPS and PPS each arrive as their own packet with no marker, the IDR
	// slice closes the access unit.
	if au, err := pushOne(d, singleNALPacket(nal.TypeSPS, 3, sps), 1000, false); err != nil || au != nil {
		t.Fatalf("sps packet: au=%v err=%v", au, err)
	}
	if au, err := pushOne(d, singleNALPacket(nal.TypePPS, 3, pps), 1000, false); err != nil || au != nil {
		t.Fatalf("pps packet: au=%v err=%v", au, err)
	}
	au, err := pushOne(d, singleNALPacket(nal.TypeIDR, 3, idr), 1000, true)
	if err != nil {
		t.Fatalf("idr packet: %v", err)
	}
	if au == nil {
		t.Fatal("expected a completed access unit on the marker packet")
	}
	if !au.IsIDR {
		t.Fatal("expected IsIDR")
	}
	if au.PTS != 0 {
		t.Fatalf("first AU should be PTS 0, got %d", au.PTS)
	}

	units := mustParseUnits(t, au.AVCC)
	if len(units) != 3 {
		t.Fatalf("expected 3 NAL units (sps, pps, idr), got %d", len(units))
	}
	if !units[0].IsSPS() || !units[1].IsPPS() || !units[2].IsIDR() {
		t.Fatalf("unexpected NAL type sequence: %v %v %v", units[0].Type, units[1].Type, units[2].Type)
	}
	if !bytes.Equal(units[2].Payload[1:], idr) {
		t.Fatal("IDR payload bytes were not preserved byte for byte through depacketization")
	}
	if !bytes.Equal(au.SPS[1:], sps) || !bytes.Equal(au.PPS[1:], pps) {
		t.Fatal("SPS/PPS were not captured onto the access unit")
	}
}

func TestDepacketizer_StapA(t *testing.T) {
	d := NewDepacketizer()

	sps := singleNALPacket(nal.TypeSPS, 3, []byte{1, 2, 3})
	pps := singleNALPacket(nal.TypePPS, 3, []byte{4, 5})
	idr := singleNALPacket(nal.TypeIDR, 3, bytes.Repeat([]byte{0x7F}, 10))

	au, err := pushOne(d, stapA(sps, pps, idr), 500, true)
	if err != nil {
		t.Fatalf("Push: %v", err)
	}
	if au == nil {
		t.Fatal("expected an access unit")
	}
	units := mustParseUnits(t, au.AVCC)
	if len(units) != 3 {
		t.Fatalf("expected 3 units out of one STAP-A packet, got %d", len(units))
	}
	if !au.IsIDR {
		t.Fatal("expected IsIDR from the aggregated IDR NAL")
	}
}

func TestDepacketizer_FUA_Reassembly(t *testing.T) {
	d := NewDepacketizer()

	rbsp := make([]byte, 4000)
	for i := range rbsp {
		rbsp[i] = byte(i)
	}
	fragments := fuA(nal.TypeIDR, 2, rbsp, 4)

	var au *AccessUnit
	for i, frag := range fragments {
		marker := i == len(fragments)-1
		var err error
		au, err = pushOne(d, frag, 12345, marker)
		if err != nil {
			t.Fatalf("fragment %d: %v", i, err)
		}
		if !marker && au != nil {
			t.Fatalf("fragment %d produced an AU before the marker packet", i)
		}
	}
	if au == nil {
		t.Fatal("expected a completed AU after the final fragment")
	}
	units := mustParseUnits(t, au.AVCC)
	if len(units) != 1 {
		t.Fatalf("expected exactly 1 reassembled NAL unit, got %d", len(units))
	}
	if !units[0].IsIDR() {
		t.Fatalf("expected the reassembled NAL to be an IDR, got type %d", units[0].Type)
	}
	if !bytes.Equal(units[0].Payload[1:], rbsp) {
		t.Fatal("FU-A reassembly did not reproduce the original RBSP byte for byte")
	}
}

func TestDepacketizer_MultipleAccessUnitsAdvancePTS(t *testing.T) {
	d := NewDepacketizer()

	idr := singleNALPacket(nal.TypeIDR, 3, []byte{1, 2, 3})
	p1 := singleNALPacket(nal.TypeSlice, 2, []byte{4, 5, 6})
	p2 := singleNALPacket(nal.TypeSlice, 2, []byte{7, 8, 9})

	au1, err := pushOne(d, idr, 90000, true)
	if err != nil || au1 == nil {
		t.Fatalf("au1: au=%v err=%v", au1, err)
	}
	au2, err := pushOne(d, p1, 93000, true) // +3000 ticks = +33.3ms at 90kHz
	if err != nil || au2 == nil {
		t.Fatalf("au2: au=%v err=%v", au2, err)
	}
	au3, err := pushOne(d, p2, 96000, true)
	if err != nil || au3 == nil {
		t.Fatalf("au3: au=%v err=%v", au3, err)
	}

	if au1.PTS != 0 || au2.PTS != 3000 || au3.PTS != 6000 {
		t.Fatalf("PTS sequence wrong: %d %d %d", au1.PTS, au2.PTS, au3.PTS)
	}
	if au2.IsIDR || au3.IsIDR {
		t.Fatal("P-slice access units must not report IsIDR")
	}
}

// TestDepacketizer_MissingMarkerDoesNotMergeFrames is the regression test
// for the bug Farol caught: a frame with no marker packet used to leave the
// next frame's NALs appended onto the previous (still-open, stale-PTS)
// access unit instead of splitting the boundary, producing one CMAF sample
// that silently spanned two pictures.
//
// The boundary rule it pins is unchanged; what the boundary DOES changed on
// 2026-09-18. Frame one ends on a whole NAL, so the timestamp change closes
// and DELIVERS it (flagged Markerless) instead of discarding it and asking
// for a keyframe -- see Push. Frame two's own packet carries marker=true,
// so one call returns both access units, each with its own PTS and its own
// bytes, which is a stronger statement of "do not merge" than the discard
// ever was.
func TestDepacketizer_MissingMarkerDoesNotMergeFrames(t *testing.T) {
	d := NewDepacketizer()

	// Frame one's marker is withheld: push its only packet with marker=false.
	if aus, err := d.Push(singleNALPacket(nal.TypeIDR, 3, []byte{0x11, 0x22}), 1000, false); len(aus) != 0 {
		t.Fatalf("expected no AU yet (marker withheld), got %v (err=%v)", aus, err)
	}

	// Frame two arrives at a new timestamp while frame one is still open,
	// and itself carries marker=true: two access units out of one call.
	aus, err := d.Push(singleNALPacket(nal.TypeSlice, 2, []byte{0x33, 0x44}), 2000, true)
	if err != nil {
		t.Fatalf("a markerless boundary over a whole NAL is not an error: %v", err)
	}
	if len(aus) != 2 {
		t.Fatalf("got %d access units, want frame one (markerless) and frame two", len(aus))
	}
	if !aus[0].Markerless || aus[0].PTS != 0 {
		t.Fatalf("frame one = markerless %t pts %d, want true 0", aus[0].Markerless, aus[0].PTS)
	}
	if units := mustParseUnits(t, aus[0].AVCC); len(units) != 1 || !units[0].IsIDR() {
		t.Fatalf("frame one must be delivered as exactly its own IDR NAL, got %d units", len(units))
	}
	if aus[1].Markerless || aus[1].PTS != 1000 {
		t.Fatalf("frame two = markerless %t pts %d, want false 1000", aus[1].Markerless, aus[1].PTS)
	}
	units := mustParseUnits(t, aus[1].AVCC)
	if len(units) != 1 || !units[0].IsSlice() {
		t.Fatalf("frame two must contain exactly its own NAL, got %d units (frame one's bytes leaked forward)", len(units))
	}
	if !bytes.Equal(units[0].Payload[1:], []byte{0x33, 0x44}) {
		t.Fatal("frame two's payload must be its own bytes, not frame one's")
	}

	// A clean frame three afterward proves the split did not wedge the
	// depacketizer.
	au3, err := pushOne(d, singleNALPacket(nal.TypeSlice, 2, []byte{0x55}), 3000, true)
	if err != nil {
		t.Fatalf("frame three: %v", err)
	}
	if au3 == nil {
		t.Fatal("expected a completed AU for frame three")
	}
	if units := mustParseUnits(t, au3.AVCC); len(units) != 1 {
		t.Fatalf("frame three must contain exactly its own NAL, got %d units", len(units))
	}
}

func TestDepacketizer_AccessUnitTooLargeIsDiscarded(t *testing.T) {
	d := NewDepacketizer()
	big := bytes.Repeat([]byte{0xAB}, maxAccessUnitBytes+1)

	au, err := pushOne(d, singleNALPacket(nal.TypeIDR, 3, big), 5000, false)
	if err != errAccessUnitTooLarge {
		t.Fatalf("expected errAccessUnitTooLarge, got %v", err)
	}
	if au != nil {
		t.Fatal("an oversized AU must not be returned")
	}

	// The depacketizer must recover: a fresh, small AU at a new timestamp
	// completes normally afterward.
	au2, err := pushOne(d, singleNALPacket(nal.TypeSlice, 2, []byte{0x01}), 6000, true)
	if err != nil {
		t.Fatalf("recovery frame: %v", err)
	}
	if au2 == nil || len(au2.AVCC) == 0 {
		t.Fatal("expected a normal AU after recovering from an oversized one")
	}
}

func TestDepacketizer_TimestampUnwrapAcrossWraparound(t *testing.T) {
	d := NewDepacketizer()

	idr := singleNALPacket(nal.TypeIDR, 3, []byte{1})
	slice := singleNALPacket(nal.TypeSlice, 2, []byte{2})

	// Start near the top of the 32-bit range and cross the wraparound.
	nearMax := ^uint32(0) - 1000

	au1, err := pushOne(d, idr, nearMax, true)
	if err != nil || au1 == nil {
		t.Fatalf("au1: au=%v err=%v", au1, err)
	}
	if au1.PTS != 0 {
		t.Fatalf("first AU PTS should be 0, got %d", au1.PTS)
	}

	wrapped := nearMax + 2000 // wraps past ^uint32(0), computed at runtime
	au2, err := pushOne(d, slice, wrapped, true)
	if err != nil || au2 == nil {
		t.Fatalf("au2: au=%v err=%v", au2, err)
	}
	if au2.PTS != 2000 {
		t.Fatalf("expected PTS to advance by 2000 across the wraparound, got %d", au2.PTS)
	}
}
