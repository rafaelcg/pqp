package session

import (
	"strings"
	"testing"
	"time"

	"github.com/rafaelcg/pqp/tools/pqp-remux/internal/h264"
)

// The stats line is the whole observability surface of a live session, so
// the three fields this PR adds have to actually appear on it, with window
// deltas for the two cumulative ones and an absolute for the windowed max.
//
// `gaps=` is the field the 2026-09-17 analysis did not have and guessed
// at: a total of 77 lost packets is one 77-packet burst or twenty-five
// three-packet holes, and those call for opposite fixes.
func TestFormatStatsLine_CarriesTheLossShapeAndReorderCost(t *testing.T) {
	prev := Stats{
		VideoPacketsLost:        100,
		VideoGapHistogram:       [h264.GapBucketCount]uint64{5, 4, 3, 2, 1},
		VideoReorderHeldDelayed: 10,
		VideoReorderResequenced: 20,
	}
	cur := Stats{
		Now:                     time.Unix(1_700_000_000, 0),
		VideoPacketsLost:        177,
		VideoGapHistogram:       [h264.GapBucketCount]uint64{9, 6, 3, 2, 2},
		VideoReorderHeldDelayed: 37,
		VideoReorderResequenced: 21,
		ReorderMaxDelayMs:       312,
	}
	line := formatStatsLine("s", prev, cur, 5*time.Second)
	for _, want := range []string{
		"lost=+77",
		"gaps=1:4 2:2 5:0 17:0 65:1",
		"heldDelayed=+27",
		"resequenced=+1",
		"reorderMaxDelayMs=312",
	} {
		if !strings.Contains(line, want) {
			t.Fatalf("stats line lacks %q:\n%s", want, line)
		}
	}
	// `held=` conflated the two halves and must not come back.
	if strings.Contains(line, " held=") {
		t.Fatalf("the combined held= counter is back:\n%s", line)
	}
}

// A clean window still prints every bucket, so an all-zero reading is a
// measurement rather than a missing field.
func TestFormatStatsLine_GapHistogramIsAlwaysPresent(t *testing.T) {
	line := formatStatsLine("s", Stats{}, Stats{Now: time.Unix(1, 0)}, time.Second)
	if !strings.Contains(line, "gaps=1:0 2:0 5:0 17:0 65:0") {
		t.Fatalf("a clean window must still carry the histogram:\n%s", line)
	}
	if !strings.Contains(line, "reorderMaxDelayMs=0") {
		t.Fatalf("a clean window must still carry the reorder max:\n%s", line)
	}
}

// Stats() is read by internal/control's watchdog on every 100ms tick and
// must never consume the windowed reorder max -- only RunMonitor's own
// take does, once per printed line. This is the shape of the bug that
// would otherwise print 0 forever while the number was real.
func TestStats_DoesNotConsumeTheWindowedReorderMax(t *testing.T) {
	s := New(45000, 360000, nil, nil)
	defer s.Close()
	s.videoMu.Lock()
	s.reorder.noteDelay(250 * time.Millisecond)
	s.videoMu.Unlock()

	for i := 0; i < 3; i++ {
		if got := s.Stats().ReorderMaxDelayMs; got != 0 {
			t.Fatalf("Stats().ReorderMaxDelayMs = %d; Stats must not fill it in", got)
		}
	}
	if got := s.takeReorderMaxDelayMs(); got != 250 {
		t.Fatalf("takeReorderMaxDelayMs() = %d, want 250", got)
	}
	if got := s.takeReorderMaxDelayMs(); got != 0 {
		t.Fatalf("takeReorderMaxDelayMs() = %d on the second call, want 0", got)
	}
}
