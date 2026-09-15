package ring

import (
	"bytes"
	"strings"
	"testing"
	"time"

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

func TestSnapshot(t *testing.T) {
	r := New(3, 90000)
	stamp := time.Date(2026, 9, 15, 8, 1, 0, 0, time.UTC)
	r.SetClock(func() time.Time { return stamp })

	if snap := r.Snapshot(); snap.HasInit || len(snap.Segments) != 0 || snap.HaveParts {
		t.Fatalf("a fresh ring must snapshot empty: %+v", snap)
	}

	r.SetInit([]byte("init"))
	r.Push(&pipeline.Fragment{SequenceNumber: 1, SegmentIndex: 0, IsSegmentStart: true, DurationTicks: 45000, Bytes: []byte("a")})
	stamp = stamp.Add(500 * time.Millisecond)
	r.Push(&pipeline.Fragment{SequenceNumber: 2, SegmentIndex: 0, DurationTicks: 45000, Bytes: []byte("b")})
	stamp = stamp.Add(500 * time.Millisecond)
	r.Push(&pipeline.Fragment{SequenceNumber: 3, SegmentIndex: 1, IsSegmentStart: true, DurationTicks: 45000, Bytes: []byte("c")})

	snap := r.Snapshot()
	if !snap.HasInit || snap.Timescale != 90000 {
		t.Fatalf("snapshot = %+v", snap)
	}
	if len(snap.Segments) != 2 {
		t.Fatalf("segments = %d, want 2", len(snap.Segments))
	}
	if !snap.Segments[0].Sealed || snap.Segments[1].Sealed {
		t.Fatalf("sealed flags wrong: %+v", snap.Segments)
	}
	// The segment's anchor is stamped when its FIRST part lands, never
	// per part: both parts of segment 0 share 08:01:00.
	if got := snap.Segments[0].OpenedAt; !got.Equal(time.Date(2026, 9, 15, 8, 1, 0, 0, time.UTC)) {
		t.Fatalf("segment 0 openedAt = %v", got)
	}
	if got := snap.Segments[1].OpenedAt; !got.Equal(time.Date(2026, 9, 15, 8, 1, 1, 0, time.UTC)) {
		t.Fatalf("segment 1 openedAt = %v", got)
	}
	// Independence is the fragmenter's own IsSegmentStart, carried
	// through -- not inferred from a part's position.
	if !snap.Segments[0].Parts[0].Independent || snap.Segments[0].Parts[1].Independent {
		t.Fatalf("independence not carried through: %+v", snap.Segments[0].Parts)
	}
	if !snap.HaveParts || snap.NextPartSeq != 4 {
		t.Fatalf("NextPartSeq = %d (haveParts=%v), want 4", snap.NextPartSeq, snap.HaveParts)
	}
}

// Eviction drops parts from the ring, but the NEXT part's sequence number
// must keep counting up: a preload hint that pointed back at an evicted
// name would send a player after bytes this process no longer holds.
func TestSnapshotNextPartSeqSurvivesEviction(t *testing.T) {
	r := New(2, 90000)
	r.SetInit([]byte("init"))
	for i := 0; i < 5; i++ {
		r.Push(&pipeline.Fragment{
			SequenceNumber: uint32(i + 1),
			SegmentIndex:   i,
			IsSegmentStart: true,
			DurationTicks:  45000,
			Bytes:          []byte("x"),
		})
	}
	snap := r.Snapshot()
	if len(snap.Segments) != 2 {
		t.Fatalf("segments = %d, want the 2 retained", len(snap.Segments))
	}
	if snap.Segments[0].Index != 3 || snap.Segments[1].Index != 4 {
		t.Fatalf("retained indices = %d,%d, want 3,4", snap.Segments[0].Index, snap.Segments[1].Index)
	}
	if snap.NextPartSeq != 6 {
		t.Fatalf("NextPartSeq = %d, want 6", snap.NextPartSeq)
	}
}

// TestAudioSegmentsGivesTheAudioRingHeadroom pins the rule, not the
// number: an audio ring counted in the same number of segments as the
// video ring covers strictly LESS wall clock, because the video
// fragmenter's segments are elastic (first IDR at or after the target)
// and the audio fragmenter's are not (first frame boundary at or after
// it). Production on 2026-09-15 closed 4s-target video segments at 7 to
// 11 seconds, so six of each was ~24s of audio against ~50s of video and
// an `hlsEdge.llPartMissing` on audio parts the video side could not
// explain.
func TestAudioSegmentsGivesTheAudioRingHeadroom(t *testing.T) {
	for _, videoSegments := range []int{1, 6, 12} {
		if got := AudioSegments(videoSegments); got <= videoSegments {
			t.Fatalf("AudioSegments(%d) = %d, want more than the video ring's own depth", videoSegments, got)
		}
	}
	// A nonsense video depth must still produce a usable audio ring,
	// matching New's own floor of 1.
	if got := AudioSegments(0); got < 1 {
		t.Fatalf("AudioSegments(0) = %d, want at least 1", got)
	}
}

// TestAudioRingHoldsAtLeastAsManyPartsAsVideo is the property the
// incident actually violated, expressed end to end: at the default
// config (6 segments, 500ms parts, 4s segments) the audio ring must
// retain at least as many parts as the video ring does, even when the
// video track's segments run long.
func TestAudioRingHoldsAtLeastAsManyPartsAsVideo(t *testing.T) {
	const ringSegments = 6

	// Video: 6 segments that ran to 8s each (twice the target, what a
	// PLI-gated Chromium share produced in production), 500ms parts.
	video := New(ringSegments, 90000)
	video.SetInit([]byte("v"))
	var vseq uint32
	for seg := 0; seg < ringSegments+2; seg++ {
		for part := 0; part < 16; part++ { // 16 x 500ms = 8s
			vseq++
			video.Push(&pipeline.Fragment{
				SequenceNumber: vseq,
				SegmentIndex:   seg,
				IsSegmentStart: part == 0,
				DurationTicks:  45000,
				Bytes:          []byte{1},
			})
		}
	}

	// Audio: the same 500ms parts, but segments that close on schedule
	// at 4s, in a ring sized by AudioSegments.
	audio := New(AudioSegments(ringSegments), 48000)
	audio.SetInit([]byte("a"))
	var aseq uint32
	for seg := 0; seg < AudioSegments(ringSegments)+2; seg++ {
		for part := 0; part < 8; part++ { // 8 x 500ms = 4s
			aseq++
			audio.Push(&pipeline.Fragment{
				SequenceNumber: aseq,
				SegmentIndex:   seg,
				IsSegmentStart: part == 0,
				DurationTicks:  24000,
				Bytes:          []byte{1},
			})
		}
	}

	countParts := func(r *Ring) int {
		n := 0
		for _, s := range r.Snapshot().Segments {
			n += len(s.Parts)
		}
		return n
	}
	gotVideo, gotAudio := countParts(video), countParts(audio)
	if gotAudio < gotVideo {
		t.Fatalf("audio ring holds %d parts, video holds %d: audio parts are evicted while the video playlist still lists the same window", gotAudio, gotVideo)
	}
}
