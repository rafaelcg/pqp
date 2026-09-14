package ring

import (
	"bytes"
	"strings"
	"testing"

	"github.com/rafaelcg/pqp/tools/pqp-remux/internal/pipeline"
)

func frag(seq uint32, segIdx int, start bool, duration uint32, data []byte) *pipeline.Fragment {
	return &pipeline.Fragment{
		SequenceNumber: seq,
		SegmentIndex:   segIdx,
		IsSegmentStart: start,
		DurationTicks:  duration,
		Bytes:          data,
	}
}

func TestRing_InitNotSetInitially(t *testing.T) {
	r := New(6, 90000)
	if _, ok := r.Init(); ok {
		t.Fatal("expected no init segment before SetInit")
	}
	r.SetInit([]byte("ftyp+moov"))
	got, ok := r.Init()
	if !ok || string(got) != "ftyp+moov" {
		t.Fatalf("Init() = %q, %v", got, ok)
	}
}

func TestRing_PartLookupBySequenceNumber(t *testing.T) {
	r := New(6, 90000)
	r.Push(frag(1, 0, true, 45000, []byte("part1")))
	r.Push(frag(2, 0, false, 45000, []byte("part2")))

	got, ok := r.Part(1)
	if !ok || !bytes.Equal(got, []byte("part1")) {
		t.Fatalf("Part(1) = %q, %v", got, ok)
	}
	got, ok = r.Part(2)
	if !ok || !bytes.Equal(got, []byte("part2")) {
		t.Fatalf("Part(2) = %q, %v", got, ok)
	}
	if _, ok := r.Part(99); ok {
		t.Fatal("Part(99) should not exist")
	}
}

func TestRing_SegmentConcatenatesItsParts(t *testing.T) {
	r := New(6, 90000)
	r.Push(frag(1, 0, true, 45000, []byte("AAA")))
	r.Push(frag(2, 0, false, 45000, []byte("BBB")))
	r.Push(frag(3, 1, true, 45000, []byte("CCC"))) // opens segment 1, seals segment 0

	seg0, ok := r.Segment(0)
	if !ok || string(seg0) != "AAABBB" {
		t.Fatalf("Segment(0) = %q, %v, want AAABBB", seg0, ok)
	}
	seg1, ok := r.Segment(1)
	if !ok || string(seg1) != "CCC" {
		t.Fatalf("Segment(1) = %q, %v, want CCC", seg1, ok)
	}
	if _, ok := r.Segment(2); ok {
		t.Fatal("Segment(2) should not exist yet")
	}
}

func TestRing_PlaylistListsOnlySealedSegments(t *testing.T) {
	r := New(6, 90000)
	r.Push(frag(1, 0, true, 90000, []byte("A"))) // 1s @ 90kHz

	pl := r.Playlist()
	if strings.Contains(pl, "seg-0.m4s") {
		t.Fatal("an unsealed segment must not appear in the playlist")
	}
	if !strings.Contains(pl, `#EXT-X-MAP:URI="init.mp4"`) {
		t.Fatal("playlist must reference init.mp4")
	}

	r.Push(frag(2, 1, true, 90000, []byte("B"))) // seals segment 0

	pl = r.Playlist()
	if !strings.Contains(pl, "seg-0.m4s") {
		t.Fatalf("sealed segment 0 must now be listed:\n%s", pl)
	}
	if strings.Contains(pl, "seg-1.m4s") {
		t.Fatal("segment 1 is still open and must not be listed")
	}
	if !strings.Contains(pl, "#EXTINF:1.000,") {
		t.Fatalf("expected a 1.000s EXTINF entry for the 90000-tick segment:\n%s", pl)
	}
	if !strings.Contains(pl, "#EXT-X-TARGETDURATION:1") {
		t.Fatalf("expected target duration 1:\n%s", pl)
	}
}

func TestRing_EvictsOldestSegmentBeyondCapacity(t *testing.T) {
	r := New(2, 90000) // keep at most 2 segments
	r.Push(frag(1, 0, true, 90000, []byte("seg0")))
	r.Push(frag(2, 1, true, 90000, []byte("seg1")))
	r.Push(frag(3, 2, true, 90000, []byte("seg2"))) // evicts segment 0

	if _, ok := r.Segment(0); ok {
		t.Fatal("segment 0 should have been evicted")
	}
	if _, ok := r.Part(1); ok {
		t.Fatal("segment 0's part should have been evicted with it")
	}
	if _, ok := r.Segment(1); !ok {
		t.Fatal("segment 1 should still be retained")
	}
	if _, ok := r.Segment(2); !ok {
		t.Fatal("segment 2 should still be retained")
	}

	pl := r.Playlist()
	if !strings.Contains(pl, "#EXT-X-MEDIA-SEQUENCE:1") {
		t.Fatalf("expected media sequence to advance to 1 after eviction:\n%s", pl)
	}
}

func TestRing_SegmentServableWhileStillOpen(t *testing.T) {
	r := New(6, 90000)
	r.Push(frag(1, 0, true, 45000, []byte("partial")))

	got, ok := r.Segment(0)
	if !ok || string(got) != "partial" {
		t.Fatalf("an in-progress segment must still be servable by index: got %q, %v", got, ok)
	}
}

func TestRing_PlaylistWithURIPrefix(t *testing.T) {
	r := New(6, 90000)
	r.Push(frag(1, 0, true, 90000, []byte("A")))
	r.Push(frag(2, 1, true, 90000, []byte("B"))) // seals segment 0

	pl := r.PlaylistWithURIPrefix("audio-")
	if !strings.Contains(pl, `#EXT-X-MAP:URI="audio-init.mp4"`) {
		t.Fatalf("expected the init URI to carry the prefix:\n%s", pl)
	}
	if !strings.Contains(pl, "audio-seg-0.m4s") {
		t.Fatalf("expected the segment URI to carry the prefix:\n%s", pl)
	}
	if strings.Contains(pl, `URI="init.mp4"`) || (strings.Contains(pl, "seg-0.m4s") && !strings.Contains(pl, "audio-seg-0.m4s")) {
		t.Fatalf("did not expect any unprefixed URI in a prefixed playlist:\n%s", pl)
	}

	// The plain Playlist() must be entirely unaffected: video's own call
	// sites and every existing test depend on the unprefixed names.
	plain := r.Playlist()
	if !strings.Contains(plain, `URI="init.mp4"`) || !strings.Contains(plain, "seg-0.m4s") {
		t.Fatalf("Playlist() must still emit unprefixed URIs:\n%s", plain)
	}
}
