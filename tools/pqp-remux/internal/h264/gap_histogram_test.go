package h264

import (
	"errors"
	"testing"

	"github.com/rafaelcg/pqp/tools/pqp-remux/internal/nal"
)

// One gap of each bucket size, in order, and the histogram has to land
// them one per bucket. The sizes are chosen at the bucket edges on
// purpose: 1 is the whole of bucket 0, 4 is the top of bucket 1, 5 the
// bottom of bucket 2, 64 the top of bucket 3 and 65 the bottom of the
// open-ended one.
func TestDepacketizer_GapHistogramBuckets(t *testing.T) {
	d := NewDepacketizer()
	seq := uint16(1000)
	var ts uint32 = 1000
	push := func(s uint16) error {
		ts += 3000
		_, err := d.PushRTP(singleNALPacket(nal.TypeSlice, 2, []byte{0x02}), s, ts, true)
		return err
	}
	if err := push(seq); err != nil {
		t.Fatalf("first packet: %v", err)
	}

	for _, tc := range []struct {
		gap    uint64
		bucket int
	}{
		{1, 0}, {2, 1}, {4, 1}, {5, 2}, {16, 2}, {17, 3}, {64, 3}, {65, 4}, {200, 4},
	} {
		seq += uint16(tc.gap) + 1
		if err := push(seq); !errors.Is(err, ErrPacketsLost) {
			t.Fatalf("gap %d: err = %v, want ErrPacketsLost", tc.gap, err)
		}
		if got := d.LastGap(); got != tc.gap {
			t.Fatalf("LastGap after a %d-packet gap = %d", tc.gap, got)
		}
	}

	got := d.GapHistogram()
	want := [GapBucketCount]uint64{1, 2, 2, 2, 2}
	if got != want {
		t.Fatalf("GapHistogram = %v, want %v", got, want)
	}
	// The cumulative total and the histogram count different things and
	// both have to stay honest: 1+2+4+5+16+17+64+65+200 packets lost
	// across 9 gaps.
	if lost := d.LostPackets(); lost != 374 {
		t.Fatalf("LostPackets = %d, want 374", lost)
	}
}

// A stream with no gaps leaves the histogram empty and LastGap at zero --
// the "nothing to see" reading of the stats line has to be unambiguous.
func TestDepacketizer_GapHistogramEmptyWithoutLoss(t *testing.T) {
	d := NewDepacketizer()
	var ts uint32 = 1000
	for i := uint16(0); i < 20; i++ {
		ts += 3000
		if _, err := d.PushRTP(singleNALPacket(nal.TypeSlice, 2, []byte{0x02}), 500+i, ts, true); err != nil {
			t.Fatalf("seq %d: %v", 500+i, err)
		}
	}
	if got := d.GapHistogram(); got != ([GapBucketCount]uint64{}) {
		t.Fatalf("GapHistogram = %v on a clean stream", got)
	}
	if got := d.LastGap(); got != 0 {
		t.Fatalf("LastGap = %d on a clean stream", got)
	}
}
