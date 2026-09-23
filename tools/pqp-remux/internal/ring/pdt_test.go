package ring

import (
	"testing"
	"time"

	"github.com/rafaelcg/pqp/tools/pqp-remux/internal/pipeline"
)

// A segment's PROGRAM-DATE-TIME is the ring's anchor plus the segment's
// first tfdt, not the instant it was pushed: two rings sharing an anchor
// agree about the time of the same media whatever their timescales and
// whenever their parts happen to land.
func TestSegmentPDTIsAnchorPlusMediaTime(t *testing.T) {
	anchor := time.Date(2026, 9, 23, 20, 0, 0, 0, time.UTC)
	pushedAt := anchor.Add(time.Hour) // arrival must not matter
	video, audio := New(6, 90000), New(6, 48000)
	for _, r := range []*Ring{video, audio} {
		r.SetClock(func() time.Time { return pushedAt })
		r.SetPDTAnchor(anchor)
	}
	video.Push(&pipeline.Fragment{SequenceNumber: 1, SegmentIndex: 0, IsSegmentStart: true, StartTicks: 90000*7 + 45000, DurationTicks: 45000})
	audio.Push(&pipeline.Fragment{SequenceNumber: 1, SegmentIndex: 0, IsSegmentStart: true, StartTicks: 48000*7 + 24000, DurationTicks: 24000})

	want := anchor.Add(7500 * time.Millisecond)
	for name, r := range map[string]*Ring{"video": video, "audio": audio} {
		if got := r.Snapshot().Segments[0].OpenedAt; !got.Equal(want) {
			t.Fatalf("%s segment PDT %s, want %s", name, got, want)
		}
	}
}

// Hours into a session the arithmetic must neither overflow nor drift.
func TestSegmentPDTSurvivesLongSessions(t *testing.T) {
	anchor := time.Date(2026, 9, 23, 20, 0, 0, 0, time.UTC)
	r := New(6, 90000)
	r.SetPDTAnchor(anchor)
	ticks := int64(90000) * 3600 * 30 // thirty hours
	r.Push(&pipeline.Fragment{SequenceNumber: 1, IsSegmentStart: true, StartTicks: ticks + 1, DurationTicks: 3000})
	want := anchor.Add(30*time.Hour + time.Second/90000)
	if got := r.Snapshot().Segments[0].OpenedAt; !got.Equal(want) {
		t.Fatalf("PDT %s, want %s", got, want)
	}
}

// With no anchor the ring falls back to its clock, which is what a ring
// used on its own (and the golden state.json test) relies on.
func TestSegmentPDTWithoutAnAnchorUsesTheClock(t *testing.T) {
	at := time.Date(2026, 9, 15, 8, 1, 0, 0, time.UTC)
	r := New(6, 90000)
	r.SetClock(func() time.Time { return at })
	r.Push(&pipeline.Fragment{SequenceNumber: 1, IsSegmentStart: true, StartTicks: 12345, DurationTicks: 45000})
	if got := r.Snapshot().Segments[0].OpenedAt; !got.Equal(at) {
		t.Fatalf("PDT %s, want the clock %s", got, at)
	}
}
