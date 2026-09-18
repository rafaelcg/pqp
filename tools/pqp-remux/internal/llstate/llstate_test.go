package llstate

import (
	"bytes"
	"encoding/json"
	"flag"
	"fmt"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/rafaelcg/pqp/tools/pqp-remux/internal/pipeline"
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

// TestAudioTwinIsRenderedFromRealFragmenterOutput closes the gap the
// 2026-09-15 incident fell through. Every other test in this file (the
// golden included) hands Build a SYNTHETIC snapshot with 500ms audio
// parts, which is what the contract says and what the Worker's own
// cross-check then reads back -- so both sides agreed with each other
// while the actual producer, pipeline.AudioFragmenter, was emitting one
// part per 21ms AAC frame. Nothing in either repository compared the
// document to what the fragmenter really makes. This does: a real
// AudioFragmenter through a real ring into Build.
func TestAudioTwinIsRenderedFromRealFragmenterOutput(t *testing.T) {
	const partMs = 500
	const segmentMs = 4000
	const frameTicks = 1024 // aacenc.SamplesPerFrame

	audioRing := ring.New(6, audioTimescale)
	audioRing.SetInit([]byte("audio-init"))
	audioRing.SetClock(func() time.Time { return epoch })

	f := pipeline.NewAudioFragmenter(pipeline.AudioConfig{
		Timescale:       audioTimescale,
		PartDuration:    partMs * audioTimescale / 1000,
		SegmentDuration: segmentMs * audioTimescale / 1000,
	})

	// Twelve seconds of audio: three whole segments and a bit.
	var pts int64
	for i := 0; i < 12*audioTimescale/frameTicks; i++ {
		if frag := f.Push(pts, frameTicks, []byte{byte(i)}); frag != nil {
			audioRing.Push(frag)
		}
		pts += frameTicks
	}

	video := videoSnapshot(0, 2, 8, 2, videoTimescale, partTicks)
	audioSnap := audioRing.Snapshot()
	state, ok := Build(meta(), video, &audioSnap)
	if !ok {
		t.Fatal("Build refused a real audio ring")
	}
	if state.Audio == nil {
		t.Fatal("no audio twin")
	}

	// Parts are PART_MS, within one AAC frame. 0.021 -- one part per
	// frame -- is the bug.
	const frameSecs = float64(frameTicks) / audioTimescale
	target := float64(partMs) / 1000
	var parts int
	for _, seg := range state.Audio.Segments {
		for i, p := range seg.Parts {
			parts++
			last := i == len(seg.Parts)-1
			if p.DurationSecs > target+frameSecs {
				t.Fatalf("audio part %s is %.3fs, past the %.3fs target", p.URI, p.DurationSecs, target)
			}
			// Only the part a segment boundary cut short may be under
			// the target.
			if !last && p.DurationSecs < target {
				t.Fatalf("audio part %s is %.3fs, under the %.3fs target mid-segment", p.URI, p.DurationSecs, target)
			}
		}
	}
	if parts == 0 {
		t.Fatal("no audio parts at all")
	}

	// Segments hold the same order of magnitude of parts as the video
	// rendition's: 8 against 8, not 69 against 6.
	for _, seg := range state.Audio.Segments {
		if !seg.Complete {
			continue
		}
		if n := len(seg.Parts); n < 7 || n > 9 {
			t.Fatalf("audio segment %d holds %d parts at a %dms part target and a %dms segment target, want about %d",
				seg.MSN, n, partMs, segmentMs, segmentMs/partMs)
		}
	}

	// The preload hint names the part the fragmenter has not emitted
	// yet -- the very next sequence number, not one 20,000 ahead.
	hint := state.Audio.PreloadHint
	if hint == nil {
		t.Fatal("no audio preload hint")
	}
	lastSeg := state.Audio.Segments[len(state.Audio.Segments)-1]
	lastPart := lastSeg.Parts[len(lastSeg.Parts)-1]
	var lastSeq, hintSeq int
	if _, err := fmt.Sscanf(lastPart.URI, "audio-part-%d.m4s", &lastSeq); err != nil {
		t.Fatalf("parsing %q: %v", lastPart.URI, err)
	}
	if _, err := fmt.Sscanf(hint.URI, "audio-part-%d.m4s", &hintSeq); err != nil {
		t.Fatalf("parsing %q: %v", hint.URI, err)
	}
	if hintSeq != lastSeq+1 {
		t.Fatalf("preload hint %q follows the last published part %q by %d, want 1", hint.URI, lastPart.URI, hintSeq-lastSeq)
	}
}

// PART-TARGET is a promise about the MAXIMUM part duration, so a quiet
// source publishing parts longer than PART_MS must be reported honestly:
// the edge Worker times its blocking playlist reloads at three of these,
// and a stale 500ms times a viewer out on a healthy stream.
func TestBuild_PartTargetCoversTheLongestPart(t *testing.T) {
	// A static Chrome tab at ~1.4 frames/s: parts close on real frames,
	// about a second apart.
	oneSecond := uint32(videoTimescale)
	got, ok := Build(meta(), videoSnapshot(3, 1, 4, 2, videoTimescale, oneSecond), nil)
	if !ok {
		t.Fatal("Build refused a snapshot of second-long parts")
	}
	if got.PartTargetMs != 1000 {
		t.Fatalf("partTargetMs = %d against second-long parts, want 1000", got.PartTargetMs)
	}

	// An ordinary source never moves it off the configured value.
	got, ok = Build(meta(), videoSnapshot(3, 1, 4, 2, videoTimescale, partTicks), nil)
	if !ok {
		t.Fatal("Build refused an ordinary snapshot")
	}
	if got.PartTargetMs != 500 {
		t.Fatalf("partTargetMs = %d on a 500ms source, want the configured 500", got.PartTargetMs)
	}
}

// Every part duration here descends from the PUBLISHER's own access-unit
// timestamps, and the browser on the far side of the SFU is not a trusted
// input: two frames stamped an hour apart would otherwise become the
// edge's blocking-reload deadline for every viewer of the session. A part
// is never usefully longer than a segment, so the segment target is the
// ceiling.
func TestBuild_PartTargetIsBoundedByTheSegmentTarget(t *testing.T) {
	hostile := uint32(videoTimescale) * 3600 // an hour in one part
	got, ok := Build(meta(), videoSnapshot(3, 1, 1, 1, videoTimescale, hostile), nil)
	if !ok {
		t.Fatal("Build refused the snapshot")
	}
	if got.PartTargetMs != 4000 {
		t.Fatalf("partTargetMs = %d from an hour-long part, want it capped at the 4000ms segment target", got.PartTargetMs)
	}
	if got.PartTargetMs <= 0 {
		t.Fatal("parseLlState refuses a non-positive partTargetMs, which blanks the stream")
	}
}

// TestBuild_AudioSegmentInitURINeverAdvertisesBareInit is the Farol finding
// on PR #656: an audio ring whose segments still carry the ring-internal
// DefaultInitURI ("init.mp4" — what SetInit stores, and what a live audio
// ring stamped before SetNamedInit("audio-init.mp4")) must NEVER emit that
// bare name on state.json segments. The Worker prefers
// track.segments[0].initUri for the audio MAP, and ll-audio/init.mp4 is
// refused by nameBelongsToRung (audio rung requires the audio- prefix).
func TestBuild_AudioSegmentInitURINeverAdvertisesBareInit(t *testing.T) {
	video := videoSnapshot(41, 1, 2, 1, videoTimescale, partTicks)
	audio := videoSnapshot(41, 2, 2, 1, audioTimescale, audioTimescale/2)
	audio.InitURI = ring.DefaultInitURI // "init.mp4" — what a live audio ring stores
	for i := range audio.Segments {
		audio.Segments[i].InitURI = ring.DefaultInitURI
	}

	got, ok := Build(meta(), video, &audio)
	if !ok {
		t.Fatal("Build refused a snapshot whose audio segments carry init.mp4")
	}
	if got.Audio == nil {
		t.Fatal("audio track missing")
	}
	if got.Audio.InitURI != "audio-init.mp4" {
		t.Fatalf("audio track initUri = %q, want audio-init.mp4", got.Audio.InitURI)
	}
	for _, seg := range got.Audio.Segments {
		if seg.InitURI != "audio-init.mp4" {
			t.Fatalf("audio segment msn=%d initUri = %q, want audio-init.mp4 (never the ring's bare init.mp4)", seg.MSN, seg.InitURI)
		}
	}
}
