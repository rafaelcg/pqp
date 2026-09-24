package h264

import "testing"

// ResetSource: a republished track is a new RTP stream. Its sequence numbers
// must not read as a gap against the old stream's, its PTS count from zero
// again, and the loss counters the stats line diffs stay where they were.
func TestDepacketizer_ResetSourceStartsANewStreamAndKeepsTheCounters(t *testing.T) {
	d := NewDepacketizer()
	idr := []byte{0x65, 0x88, 0x84}
	if _, err := d.PushRTP(idr, 100, 1_000_000, true); err != nil {
		t.Fatal(err)
	}
	// A real gap on the old stream, counted.
	if _, err := d.PushRTP([]byte{0x41, 0x9a}, 105, 1_003_000, true); err == nil {
		t.Fatal("expected the old stream's gap to be reported")
	}
	lost := d.LostPackets()
	if lost == 0 {
		t.Fatal("test setup: no loss recorded")
	}

	d.ResetSource()
	aus, err := d.PushRTP(idr, 60000, 42, true)
	if err != nil {
		t.Fatalf("the new stream's first packet was judged against the old one: %v", err)
	}
	if len(aus) != 1 || aus[0].PTS != 0 {
		t.Fatalf("new stream's first access unit: %+v, want one at PTS 0", aus)
	}
	aus, err = d.PushRTP([]byte{0x41, 0x9a}, 60001, 42+3000, true)
	if err != nil || len(aus) != 1 || aus[0].PTS != 3000 {
		t.Fatalf("new stream's second access unit: %+v err=%v, want PTS 3000", aus, err)
	}
	if d.LostPackets() != lost {
		t.Fatalf("LostPackets went from %d to %d across a reset: the stats line would print a nonsense delta", lost, d.LostPackets())
	}
}
