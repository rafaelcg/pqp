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
	if au, err := d.Push(singleNALPacket(nal.TypeSPS, 3, sps), 1000, false); err != nil || au != nil {
		t.Fatalf("sps packet: au=%v err=%v", au, err)
	}
	if au, err := d.Push(singleNALPacket(nal.TypePPS, 3, pps), 1000, false); err != nil || au != nil {
		t.Fatalf("pps packet: au=%v err=%v", au, err)
	}
	au, err := d.Push(singleNALPacket(nal.TypeIDR, 3, idr), 1000, true)
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

	au, err := d.Push(stapA(sps, pps, idr), 500, true)
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
		au, err = d.Push(frag, 12345, marker)
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

	au1, err := d.Push(idr, 90000, true)
	if err != nil || au1 == nil {
		t.Fatalf("au1: au=%v err=%v", au1, err)
	}
	au2, err := d.Push(p1, 93000, true) // +3000 ticks = +33.3ms at 90kHz
	if err != nil || au2 == nil {
		t.Fatalf("au2: au=%v err=%v", au2, err)
	}
	au3, err := d.Push(p2, 96000, true)
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

func TestDepacketizer_TimestampUnwrapAcrossWraparound(t *testing.T) {
	d := NewDepacketizer()

	idr := singleNALPacket(nal.TypeIDR, 3, []byte{1})
	slice := singleNALPacket(nal.TypeSlice, 2, []byte{2})

	// Start near the top of the 32-bit range and cross the wraparound.
	nearMax := ^uint32(0) - 1000

	au1, err := d.Push(idr, nearMax, true)
	if err != nil || au1 == nil {
		t.Fatalf("au1: au=%v err=%v", au1, err)
	}
	if au1.PTS != 0 {
		t.Fatalf("first AU PTS should be 0, got %d", au1.PTS)
	}

	wrapped := nearMax + 2000 // wraps past ^uint32(0), computed at runtime
	au2, err := d.Push(slice, wrapped, true)
	if err != nil || au2 == nil {
		t.Fatalf("au2: au=%v err=%v", au2, err)
	}
	if au2.PTS != 2000 {
		t.Fatalf("expected PTS to advance by 2000 across the wraparound, got %d", au2.PTS)
	}
}
