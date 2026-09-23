package film

import (
	"math"
	"testing"
)

func near(a, b float64) bool { return math.Abs(a-b) < 1e-9 }

func TestOffsetsKeepOneClockAcrossAnInitChange(t *testing.T) {
	// Two video groups (a resolution change) on one clock, audio continuous.
	v, a := Offsets(
		[]Span{{0.4, 60}, {60, 120}},
		[]Span{{0, 120}},
	)
	for i, off := range append(v, a...) {
		if off != 0 {
			t.Fatalf("offset %d = %v, want 0: an init change keeps the session clock", i, off)
		}
	}
}

func TestOffsetsFollowARestartWithOneShiftForBothTracks(t *testing.T) {
	// A watchdog restart at ~100 s: both tracks start over, video anchored
	// 0.3 s after the new epoch, as the box does.
	v, a := Offsets(
		[]Span{{0.5, 60}, {60, 100}, {0.3, 50}},
		[]Span{{0, 101}, {0, 50.2}},
	)
	if !near(v[0], 0) || !near(v[1], 0) || !near(a[0], 0) {
		t.Fatalf("epoch 0 moved: v=%v a=%v", v, a)
	}
	// The new epoch starts where the LATER track of the old one ended (101),
	// by one shift for both, so the 0.3 s A/V offset inside it survives.
	if !near(v[2], 101) || !near(a[1], 101) {
		t.Fatalf("restart shift: v=%v a=%v, want 101 for both", v, a)
	}
}

func TestOffsetsFallBackPerTrackWhenTheTracksDisagree(t *testing.T) {
	// Video restarted, audio did not: no shared clock to trust.
	v, a := Offsets(
		[]Span{{0, 60}, {0, 30}},
		[]Span{{0, 90}},
	)
	if !near(v[1], 60) || !near(a[0], 0) {
		t.Fatalf("v=%v a=%v", v, a)
	}
}

func TestOffsetsToleratesAFrameOfOverlap(t *testing.T) {
	v, _ := Offsets([]Span{{0, 10.02}, {10, 20}}, nil)
	if v[1] != 0 {
		t.Fatalf("a 20 ms overlap was taken for a restart: %v", v)
	}
}

func TestParsePlaylistSplitsOnInitAndDiscontinuity(t *testing.T) {
	body := `#EXTM3U
#EXT-X-VERSION:7
#EXT-X-TARGETDURATION:3
#EXT-X-PLAYLIST-TYPE:VOD
#EXT-X-MEDIA-SEQUENCE:0
#EXT-X-MAP:URI="video-init.mp4"
#EXTINF:2.000,
video-seg-0.m4s
#EXTINF:2.100,
video-seg-1.m4s
#EXT-X-DISCONTINUITY
#EXT-X-MAP:URI="video-init-1.mp4"
#EXTINF:1.900,
video-seg-2.m4s
#EXT-X-DISCONTINUITY
#EXTINF:2.000,
video-seg-3.m4s
#EXT-X-ENDLIST
`
	groups, err := ParsePlaylist(body)
	if err != nil {
		t.Fatal(err)
	}
	if len(groups) != 3 {
		t.Fatalf("got %d groups, want 3: %+v", len(groups), groups)
	}
	if groups[0].Init != "video-init.mp4" || len(groups[0].Segments) != 2 || groups[0].Segments[1].Seconds != 2.1 {
		t.Fatalf("group 0: %+v", groups[0])
	}
	if groups[1].Init != "video-init-1.mp4" || groups[1].Segments[0].Name != "video-seg-2.m4s" {
		t.Fatalf("group 1: %+v", groups[1])
	}
	// A discontinuity with no new MAP (the audio track across a restart)
	// still starts a group, on the same init.
	if groups[2].Init != "video-init-1.mp4" || groups[2].Segments[0].Name != "video-seg-3.m4s" {
		t.Fatalf("group 2: %+v", groups[2])
	}
}

func TestParsePlaylistRefusesASegmentWithoutAnInit(t *testing.T) {
	if _, err := ParsePlaylist("#EXTM3U\n#EXTINF:2.0,\nseg.m4s\n"); err == nil {
		t.Fatal("want an error for a segment before any EXT-X-MAP")
	}
}
