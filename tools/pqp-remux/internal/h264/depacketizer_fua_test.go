package h264

import (
	"bytes"
	"testing"
)

// fuA builds one FU-A packet (RFC 6184 5.8): indicator byte, FU header with
// the S/E bits, then the fragment bytes.
func fuAPkt(nalType byte, start, end bool, frag []byte) []byte {
	hdr := nalType & 0x1f
	if start {
		hdr |= 0x80
	}
	if end {
		hdr |= 0x40
	}
	return append([]byte{0x60 | 28, hdr}, frag...)
}

// A fragmented NAL whose END fragment is lost must not leak its bytes into
// the next fragmented NAL. Before the fix pion's FU-A buffer kept the
// orphaned fragment and glued the next NAL onto it; the decoder then saw a
// slice with garbage in the middle (MEDIA_ERR_DECODE -12909 in Chrome).
func TestDepacketizer_LostFragmentTailDoesNotLeakIntoNextNAL(t *testing.T) {
	d := NewDepacketizer()
	stale := bytes.Repeat([]byte{0xDE}, 40)
	if au, err := d.Push(fuAPkt(1, true, false, stale), 1000, false); au != nil || err != nil {
		t.Fatalf("start fragment: au=%v err=%v", au, err)
	}
	fresh1 := bytes.Repeat([]byte{0x11}, 30)
	fresh2 := bytes.Repeat([]byte{0x22}, 30)
	if _, err := d.Push(fuAPkt(1, true, false, fresh1), 4000, false); err == nil {
		t.Fatal("expected the timestamp-change discard to be reported")
	}
	au, err := d.Push(fuAPkt(1, false, true, fresh2), 4000, true)
	if err != nil || au == nil {
		t.Fatalf("end fragment: au=%v err=%v", au, err)
	}
	if len(au.Units) != 1 {
		t.Fatalf("units = %d, want exactly the one fresh NAL", len(au.Units))
	}
	if bytes.Contains(au.AVCC, stale[:8]) {
		t.Fatalf("stale fragment bytes leaked into the next NAL: % x", au.AVCC[:16])
	}
	if got, want := len(au.Units[0].Payload), 1+len(fresh1)+len(fresh2); got != want && got != want-1 {
		t.Fatalf("reassembled NAL length %d, want the fresh fragments alone (%d)", got, want)
	}
}

// The same guarantee when the discard comes from a malformed packet.
func TestDepacketizer_MalformedPacketResetsReassembly(t *testing.T) {
	d := NewDepacketizer()
	stale := bytes.Repeat([]byte{0xDE}, 40)
	if _, err := d.Push(fuAPkt(1, true, false, stale), 1000, false); err != nil {
		t.Fatalf("start fragment: %v", err)
	}
	if _, err := d.Push([]byte{0x60 | 28}, 1000, false); err == nil {
		t.Fatal("expected a malformed-packet error for a one-byte FU-A")
	}
	fresh := bytes.Repeat([]byte{0x33}, 20)
	if _, err := d.Push(fuAPkt(1, true, false, fresh), 1000, false); err != nil {
		t.Fatalf("fresh start: %v", err)
	}
	au, err := d.Push(fuAPkt(1, false, true, fresh), 1000, true)
	if err != nil || au == nil {
		t.Fatalf("fresh end: au=%v err=%v", au, err)
	}
	if bytes.Contains(au.AVCC, stale[:8]) {
		t.Fatal("stale fragment bytes leaked after a malformed packet")
	}
}
