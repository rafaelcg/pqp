package h264

import (
	"testing"

	"github.com/rafaelcg/pqp/tools/pqp-remux/internal/nal"
)

// A keyframe split into FU-A fragments is "open" from its first fragment,
// even though pion hands back no bytes until the one with the End bit: that
// is exactly the window internal/session's part deadline must not fill
// past, so the timestamp has to be reported for all of it.
func TestDepacketizer_OpenAccessUnitPTSCoversAFragmentedFrame(t *testing.T) {
	d := NewDepacketizer()
	if _, open := d.OpenAccessUnitPTS(); open {
		t.Fatal("a fresh depacketizer reports an open access unit")
	}
	// PTS is measured from the session's first timestamp, so start the
	// clock with one whole frame first.
	if _, err := d.PushRTP(singleNALPacket(nal.TypeSlice, 2, []byte{0xAA}), 99, 1000, true); err != nil {
		t.Fatal(err)
	}
	rbsp := make([]byte, 4000)
	fragments := fuA(nal.TypeIDR, 3, rbsp, 4)
	for i, frag := range fragments {
		last := i == len(fragments)-1
		if _, err := d.PushRTP(frag, uint16(100+i), 10000, last); err != nil {
			t.Fatalf("fragment %d: %v", i, err)
		}
		pts, open := d.OpenAccessUnitPTS()
		if last {
			if open {
				t.Fatal("the access unit is still open after its marker packet")
			}
			continue
		}
		if !open || pts != 9000 {
			t.Fatalf("fragment %d: OpenAccessUnitPTS = %d, %t; want 9000, true", i, pts, open)
		}
	}
}

// A damaged access unit is dropped when it closes, so it bounds nothing.
func TestDepacketizer_OpenAccessUnitPTSIgnoresADamagedFrame(t *testing.T) {
	d := NewDepacketizer()
	fragments := fuA(nal.TypeSlice, 2, make([]byte, 3000), 3)
	if _, err := d.PushRTP(fragments[0], 1, 3000, false); err != nil {
		t.Fatal(err)
	}
	// Sequence 2 is lost; 3 lands mid-NAL.
	if _, err := d.PushRTP(fragments[2], 3, 3000, false); err == nil {
		t.Fatal("expected the gap to be reported")
	}
	if _, open := d.OpenAccessUnitPTS(); open {
		t.Fatal("a discarded access unit is reported open")
	}
}
