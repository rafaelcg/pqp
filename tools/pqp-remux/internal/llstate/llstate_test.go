package llstate

import (
	"bytes"
	"encoding/json"
	"flag"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/rafaelcg/pqp/tools/pqp-remux/internal/ring"
)

var updateGolden = flag.Bool("update-golden", false,
	"rewrite testdata/state-golden.json (and therefore what tools/hls-edge's cross-check test reads) from this package's own renderer")

const (
	videoTimescale = 90000
	audioTimescale = 48000
	partTicks      = videoTimescale / 2 // 500ms
)

var epoch = time.Date(2026, 9, 15, 8, 1, 0, 0, time.UTC)

// videoSnapshot builds a synthetic ring snapshot: `sealed` segments of
// `partsPerSegment` parts each starting at segment index `first`, then one
// open segment with `openParts` parts. Part sequence numbers run 1..N
// across the whole track, exactly as pipeline.Fragmenter numbers them.
func videoSnapshot(first, sealed, partsPerSegment, openParts int, timescale uint32, ticks uint32) ring.Snapshot {
	snap := ring.Snapshot{Timescale: timescale, HasInit: true}
	seq := uint32(0)
	longest := 0.0
	partDur := time.Duration(float64(ticks) / float64(timescale) * float64(time.Second))
	elapsed := time.Duration(0)
	add := func(index, parts int, isSealed bool) {
		seg := ring.SegmentSnapshot{
			Index:    index,
			Sealed:   isSealed,
			OpenedAt: epoch.Add(elapsed),
		}
		elapsed += time.Duration(parts) * partDur
		for i := 0; i < parts; i++ {
			seq++
			seg.Parts = append(seg.Parts, ring.PartSnapshot{
				Seq:           seq,
				DurationTicks: ticks,
				Independent:   i == 0,
			})
		}
		if isSealed {
			if d := float64(parts) * float64(ticks) / float64(timescale); d > longest {
				longest = d
			}
		}
		snap.Segments = append(snap.Segments, seg)
	}
	for i := 0; i < sealed; i++ {
		add(first+i, partsPerSegment, true)
	}
	if openParts > 0 {
		add(first+sealed, openParts, false)
	}
	if seq > 0 {
		snap.HaveParts = true
		snap.NextPartSeq = seq + 1
	}
	snap.TargetSecs = int(longest + 0.999999)
	return snap
}

func meta() Meta {
	return Meta{
		SessionID:       "5a1b2c3d-4e5f-4a7b-8c9d-0e1f2a3b4c5d",
		ChannelID:       "chan_abc123",
		PartTargetMs:    500,
		SegmentTargetMs: 4000,
	}
}

func TestBuild(t *testing.T) {
	tests := []struct {
		name   string
		video  ring.Snapshot
		audio  *ring.Snapshot
		wantOK bool
		check  func(t *testing.T, got State)
	}{
		{
			name:   "complete segments, an open segment with two parts, and a preload hint",
			video:  videoSnapshot(41, 2, 4, 2, videoTimescale, partTicks),
			wantOK: true,
			check: func(t *testing.T, got State) {
				if got.MediaSequence != 41 {
					t.Fatalf("mediaSequence = %d, want the oldest listed segment (41)", got.MediaSequence)
				}
				if len(got.Video.Segments) != 3 {
					t.Fatalf("segments = %d, want 3", len(got.Video.Segments))
				}
				for i, want := range []bool{true, true, false} {
					if got.Video.Segments[i].Complete != want {
						t.Fatalf("segment %d complete = %v, want %v", i, got.Video.Segments[i].Complete, want)
					}
				}
				last := got.Video.Segments[2]
				if last.URI != nil || last.DurationSecs != nil {
					t.Fatalf("the open segment must carry neither uri nor duration: %+v", last)
				}
				if len(last.Parts) != 2 {
					t.Fatalf("open segment parts = %d, want 2", len(last.Parts))
				}
				// Sealed: 8 parts consumed, so the open segment holds
				// parts 9 and 10 and the hint names 11.
				if got.Video.Segments[2].Parts[0].URI != "part-9.m4s" {
					t.Fatalf("first open part uri = %q, want part-9.m4s", got.Video.Segments[2].Parts[0].URI)
				}
				if got.Video.PreloadHint == nil {
					t.Fatal("preloadHint missing")
				}
				if *got.Video.PreloadHint != (PreloadHint{MSN: 43, Part: 2, URI: "part-11.m4s"}) {
					t.Fatalf("preloadHint = %+v, want {43 2 part-11.m4s}", *got.Video.PreloadHint)
				}
				if got.Video.InitURI != "init.mp4" {
					t.Fatalf("initUri = %q", got.Video.InitURI)
				}
				if *got.Video.Segments[0].URI != "seg-41.m4s" {
					t.Fatalf("segment uri = %q, want seg-41.m4s", *got.Video.Segments[0].URI)
				}
				if got.Audio != nil {
					t.Fatalf("audio should be absent when no audio ring was passed: %+v", got.Audio)
				}
			},
		},
		{
			name:   "empty session before the first part",
			video:  ring.Snapshot{Timescale: videoTimescale, HasInit: true},
			wantOK: false,
		},
		{
			name:   "init segment written but no part yet",
			video:  ring.Snapshot{Timescale: videoTimescale, HasInit: true, Segments: nil},
			wantOK: false,
		},
		{
			name: "parts but no init segment",
			video: func() ring.Snapshot {
				s := videoSnapshot(0, 1, 2, 1, videoTimescale, partTicks)
				s.HasInit = false
				return s
			}(),
			wantOK: false,
		},
		{
			name:   "a sealed last segment hints part 0 of the next one",
			video:  videoSnapshot(7, 2, 4, 0, videoTimescale, partTicks),
			wantOK: true,
			check: func(t *testing.T, got State) {
				if *got.Video.PreloadHint != (PreloadHint{MSN: 9, Part: 0, URI: "part-9.m4s"}) {
					t.Fatalf("preloadHint = %+v, want {9 0 part-9.m4s}", *got.Video.PreloadHint)
				}
			},
		},
		{
			name:  "the audio twin is prefixed, every part independent, and its own msn space",
			video: videoSnapshot(41, 2, 4, 2, videoTimescale, partTicks),
			audio: func() *ring.Snapshot {
				s := videoSnapshot(12, 1, 2, 1, audioTimescale, audioTimescale/2)
				return &s
			}(),
			wantOK: true,
			check: func(t *testing.T, got State) {
				if got.Audio == nil {
					t.Fatal("audio track missing")
				}
				if got.Audio.InitURI != "audio-init.mp4" {
					t.Fatalf("audio initUri = %q", got.Audio.InitURI)
				}
				if *got.Audio.Segments[0].URI != "audio-seg-12.m4s" {
					t.Fatalf("audio segment uri = %q", *got.Audio.Segments[0].URI)
				}
				if got.Audio.Segments[0].Parts[1].URI != "audio-part-2.m4s" {
					t.Fatalf("audio part uri = %q", got.Audio.Segments[0].Parts[1].URI)
				}
				for _, seg := range got.Audio.Segments {
					for _, p := range seg.Parts {
						if !p.Independent {
							t.Fatalf("every audio part must be independent: %+v", p)
						}
					}
				}
				// Only the SECOND part of a video segment proves the
				// override is not blanket-true for both tracks.
				if got.Video.Segments[0].Parts[1].Independent {
					t.Fatal("a mid-segment video part must not claim independence")
				}
				if got.MediaSequence != 41 {
					t.Fatalf("mediaSequence = %d, want the VIDEO track's oldest (41)", got.MediaSequence)
				}
				if got.Audio.PreloadHint.URI != "audio-part-4.m4s" {
					t.Fatalf("audio preload hint = %+v", *got.Audio.PreloadHint)
				}
			},
		},
		{
			name:   "an audio ring with nothing in it yet leaves a video-only document",
			video:  videoSnapshot(41, 1, 4, 1, videoTimescale, partTicks),
			audio:  &ring.Snapshot{Timescale: audioTimescale, HasInit: true},
			wantOK: true,
			check: func(t *testing.T, got State) {
				if got.Audio != nil {
					t.Fatalf("audio = %+v, want absent", got.Audio)
				}
			},
		},
		{
			name: "a gap in the segment indices is refused, not rendered",
			video: func() ring.Snapshot {
				s := videoSnapshot(41, 2, 4, 1, videoTimescale, partTicks)
				s.Segments[1].Index = 44
				s.Segments[2].Index = 45
				return s
			}(),
			wantOK: false,
		},
		{
			name: "an incomplete segment before the live edge is refused",
			video: func() ring.Snapshot {
				s := videoSnapshot(41, 2, 4, 1, videoTimescale, partTicks)
				s.Segments[0].Sealed = false
				return s
			}(),
			wantOK: false,
		},
		{
			name: "targetDuration never lands below a listed segment's own duration",
			video: func() ring.Snapshot {
				s := videoSnapshot(0, 1, 8, 1, videoTimescale, partTicks) // 4.0s sealed
				s.TargetSecs = 1                                          // a stale/too-small running max
				return s
			}(),
			wantOK: true,
			check: func(t *testing.T, got State) {
				if got.TargetDurationSecs != 4 {
					t.Fatalf("targetDurationSecs = %v, want 4 (ceil of the 4.0s segment listed)", got.TargetDurationSecs)
				}
			},
		},
		{
			name: "a zero-tick part is floored rather than blanking the document",
			video: func() ring.Snapshot {
				s := videoSnapshot(0, 1, 2, 1, videoTimescale, partTicks)
				s.Segments[1].Parts[0].DurationTicks = 0
				return s
			}(),
			wantOK: true,
			check: func(t *testing.T, got State) {
				if got.Video.Segments[1].Parts[0].DurationSecs != minDurationSecs {
					t.Fatalf("durationSecs = %v, want the %v floor", got.Video.Segments[1].Parts[0].DurationSecs, minDurationSecs)
				}
			},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			var audio *ring.Snapshot
			if tt.audio != nil {
				a := *tt.audio
				audio = &a
			}
			got, ok := Build(meta(), tt.video, audio)
			if ok != tt.wantOK {
				t.Fatalf("Build ok = %v, want %v", ok, tt.wantOK)
			}
			if !ok {
				return
			}
			if got.SessionID != meta().SessionID || got.ChannelID != meta().ChannelID {
				t.Fatalf("identity not carried through: %+v", got)
			}
			if tt.check != nil {
				tt.check(t, got)
			}
		})
	}
}

// TestGolden pins the exact document this package renders -- the same
// bytes tools/hls-edge/test/ll-state-remux-golden.test.mjs feeds to
// `parseLlState` and its playlist renderer. If this test and that one
// disagree, one side has drifted from the contract in
// tools/hls-edge/src/ll-state.js; run `go test ./internal/llstate
// -update-golden` only when the change is deliberate, and expect the
// Worker's cross-check to be the thing that says whether it is legal.
func TestGolden(t *testing.T) {
	video := videoSnapshot(41, 2, 4, 2, videoTimescale, partTicks)
	audioSnap := videoSnapshot(41, 2, 2, 1, audioTimescale, audioTimescale/2)
	state, ok := Build(meta(), video, &audioSnap)
	if !ok {
		t.Fatal("Build refused the golden snapshot")
	}

	// The bytes the HTTP surface actually writes (compact, one line),
	// re-indented for review. Comparing the indented form means the
	// golden file stays readable while still being the exact document
	// served, byte for byte, once whitespace is normalized.
	compact, err := json.Marshal(state)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	var pretty bytes.Buffer
	if err := json.Indent(&pretty, compact, "", "  "); err != nil {
		t.Fatalf("indent: %v", err)
	}
	pretty.WriteString("\n")

	path := filepath.Join("testdata", "state-golden.json")
	if *updateGolden {
		if err := os.WriteFile(path, pretty.Bytes(), 0o644); err != nil {
			t.Fatalf("writing golden: %v", err)
		}
		t.Logf("wrote %s", path)
		return
	}
	want, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("reading golden (run with -update-golden to create it): %v", err)
	}
	if !bytes.Equal(pretty.Bytes(), want) {
		t.Fatalf("state.json drifted from the golden.\n--- got ---\n%s\n--- want ---\n%s", pretty.String(), want)
	}
}
