package h264

import (
	"testing"

	"github.com/rafaelcg/pqp/tools/pqp-remux/internal/nal"
)

// pushOne and pushRTPOne are the one-access-unit shims the tests in this
// package are written against. Push returns a SLICE because one packet can
// close two access units (the markerless AU in front of it plus its own,
// when it is a single-packet frame); every case below feeds a shape where
// at most one comes out, and the shim fails loudly rather than quietly
// dropping the second if that ever stops being true.
func pushOne(d *Depacketizer, payload []byte, rtpTimestamp uint32, marker bool) (*AccessUnit, error) {
	aus, err := d.Push(payload, rtpTimestamp, marker)
	return exactlyOne(aus), err
}

func pushRTPOne(d *Depacketizer, payload []byte, seq uint16, rtpTimestamp uint32, marker bool) (*AccessUnit, error) {
	aus, err := d.PushRTP(payload, seq, rtpTimestamp, marker)
	return exactlyOne(aus), err
}

func exactlyOne(aus []*AccessUnit) *AccessUnit {
	switch len(aus) {
	case 0:
		return nil
	case 1:
		return aus[0]
	default:
		panic("h264 test shim: one packet closed more than one access unit; assert on Push directly")
	}
}

// Production 2026-09-17, a London box with a real Chrome presenter and a
// clean path (lost=0 in every window, nackCount 0 at the presenter, no
// reorder activity at all): eight access units in fifteen minutes arrived
// with no marker packet on their last packet. Each one was discarded and
// answered with a PLI, so the stream lost a frame and paid for a forced
// keyframe about once every two minutes for no reason. RFC 6184 section
// 5.1's marker bit is an optimisation; the RTP timestamp is the boundary
// ffmpeg, GStreamer and pion all fall back on. Deliver the frame.
func TestMarkerlessAccessUnitIsDeliveredNotDiscarded(t *testing.T) {
	d := NewDepacketizer()

	// Frame 1: two packets, the last of them WITHOUT the marker bit.
	if au, err := pushRTPOne(d, singleNALPacket(nal.TypeSPS, 3, []byte{0x01, 0x02}), 100, 9000, false); au != nil || err != nil {
		t.Fatalf("first packet: au=%v err=%v", au, err)
	}
	if au, err := pushRTPOne(d, singleNALPacket(nal.TypeSlice, 2, []byte{0x03, 0x04}), 101, 9000, false); au != nil || err != nil {
		t.Fatalf("second packet: au=%v err=%v", au, err)
	}

	// Frame 2's first packet: new timestamp, sequence number CONSECUTIVE
	// (nothing was lost), no marker. It closes frame 1.
	au, err := pushRTPOne(d, singleNALPacket(nal.TypeSlice, 2, []byte{0x05}), 102, 12000, false)
	if err != nil {
		t.Fatalf("a timestamp change over a whole NAL is not an error: %v", err)
	}
	if IsDamage(err) {
		t.Fatal("markerless boundary must never read as damage: that is what sends the PLI")
	}
	if au == nil {
		t.Fatal("the access unit the timestamp change closed was not delivered")
	}
	if !au.Markerless {
		t.Fatal("the delivered AU must be flagged Markerless so the session can count it")
	}
	if au.PTS != 0 {
		t.Fatalf("PTS = %d, want the FIRST frame's 0: a markerless close must not borrow the new timestamp", au.PTS)
	}
	units, perr := nal.ParseAVCC(au.AVCC)
	if perr != nil {
		t.Fatalf("delivered AU does not parse: %v", perr)
	}
	if len(units) != 2 {
		t.Fatalf("delivered %d NALs, want both of frame 1's", len(units))
	}
	if got := string(units[1].Payload[1:]); got != string([]byte{0x03, 0x04}) {
		t.Fatalf("frame 1 came through altered: % x", units[1].Payload)
	}
	if d.LostPackets() != 0 {
		t.Fatalf("LostPackets = %d, want 0: nothing was lost", d.LostPackets())
	}

	// And the second frame still closes normally on its own marker.
	au2, err := pushRTPOne(d, singleNALPacket(nal.TypeSlice, 2, []byte{0x06}), 103, 12000, true)
	if err != nil || au2 == nil {
		t.Fatalf("second frame: au=%v err=%v", au2, err)
	}
	if au2.Markerless {
		t.Fatal("a marker packet closed this one; Markerless must be false")
	}
	if au2.PTS != 3000 {
		t.Fatalf("second AU PTS = %d, want 3000", au2.PTS)
	}
}

// The one packet that closes TWO access units: a markerless frame followed
// by a whole single-packet frame carrying the marker. Returning one of them
// would silently drop a frame, which is why Push returns a slice.
func TestMarkerlessCloseAndSinglePacketFrameInOneCall(t *testing.T) {
	d := NewDepacketizer()

	if _, err := d.PushRTP(singleNALPacket(nal.TypeSlice, 2, []byte{0x01}), 10, 9000, false); err != nil {
		t.Fatalf("first frame: %v", err)
	}
	aus, err := d.PushRTP(singleNALPacket(nal.TypeIDR, 3, []byte{0x02}), 11, 12000, true)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(aus) != 2 {
		t.Fatalf("got %d access units, want 2 (the markerless one plus this frame)", len(aus))
	}
	if !aus[0].Markerless || aus[0].PTS != 0 {
		t.Fatalf("first returned AU = markerless %t pts %d, want true 0", aus[0].Markerless, aus[0].PTS)
	}
	if aus[1].Markerless || aus[1].PTS != 3000 || !aus[1].IsIDR {
		t.Fatalf("second returned AU = markerless %t pts %d idr %t, want false 3000 true", aus[1].Markerless, aus[1].PTS, aus[1].IsIDR)
	}
}

// The one case where a missing marker really does mean the AU is torn: the
// last packet accepted into it was an FU-A fragment with no End bit, so
// pion is holding half a NAL. That must still be discarded and still ask
// for a keyframe, because half a slice is what kills a hardware decoder.
func TestTimestampChangeMidFragmentIsStillDamage(t *testing.T) {
	d := NewDepacketizer()

	frags := fuAFragments(byte(nal.TypeSlice), make([]byte, 60), 3)
	if _, err := pushRTPOne(d, frags[0], 200, 9000, false); err != nil {
		t.Fatalf("start fragment: %v", err)
	}
	if _, err := pushRTPOne(d, frags[1], 201, 9000, false); err != nil {
		t.Fatalf("middle fragment: %v", err)
	}

	// The end fragment never comes; the next frame starts instead, with no
	// sequence gap (the SFU renumbered, or the publisher simply stopped).
	au, err := pushRTPOne(d, singleNALPacket(nal.TypeSlice, 2, []byte{0x09}), 202, 12000, false)
	if au != nil {
		t.Fatal("an access unit ending mid-NAL must never be delivered")
	}
	if !IsDamage(err) {
		t.Fatalf("err = %v, want damage: half a NAL is torn, not markerless", err)
	}
}

// fuAFragments splits rbsp into n FU-A packets for one NAL of the given
// type: START on the first, End on the last, neither on the middle ones.
func fuAFragments(nalType byte, rbsp []byte, n int) [][]byte {
	out := make([][]byte, 0, n)
	chunk := (len(rbsp) + n - 1) / n
	for i := 0; i < n; i++ {
		lo, hi := i*chunk, (i+1)*chunk
		if hi > len(rbsp) {
			hi = len(rbsp)
		}
		hdr := nalType & 0x1f
		if i == 0 {
			hdr |= 0x80
		}
		if i == n-1 {
			hdr |= 0x40
		}
		out = append(out, append([]byte{0x60 | 28, hdr}, rbsp[lo:hi]...))
	}
	return out
}

// payloadEndsNAL is the whole of that distinction, so pin it directly.
func TestPayloadEndsNAL(t *testing.T) {
	cases := []struct {
		name    string
		payload []byte
		want    bool
	}{
		{"single NAL", []byte{0x41, 0x00}, true},
		{"STAP-A", []byte{0x18, 0x00, 0x01, 0x41}, true},
		{"FU-A start", []byte{0x7c, 0x81, 0x00}, false},
		{"FU-A middle", []byte{0x7c, 0x01, 0x00}, false},
		{"FU-A end", []byte{0x7c, 0x41, 0x00}, true},
		{"FU-A truncated", []byte{0x7c}, false},
		{"empty", nil, false},
	}
	for _, c := range cases {
		if got := payloadEndsNAL(c.payload); got != c.want {
			t.Errorf("%s: payloadEndsNAL = %t, want %t", c.name, got, c.want)
		}
	}
}
