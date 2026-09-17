package pipeline

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"testing"

	"github.com/rafaelcg/pqp/tools/pqp-remux/internal/cmaf"
	"github.com/rafaelcg/pqp/tools/pqp-remux/internal/h264"
	"github.com/rafaelcg/pqp/tools/pqp-remux/internal/nal"
	"github.com/rafaelcg/pqp/tools/pqp-remux/internal/skipframe"
)

// THE HARNESS BEHIND THE PLAYER CHECK. Unit tests can say a part lasts
// exactly the target; only a player can say whether it will play the
// playlist that results. This renders a REAL capture (an Annex B dump of
// a Chrome screen share, pulled from R2) through the real fragmenter with
// the real synthesizer, injecting the frame gaps production actually
// produced, and writes an init segment, the parts, the whole segments and
// a manifest -- everything a local LL-HLS server needs to put it in front
// of AVPlayer and hls.js.
//
// It is skipped unless both env vars are set, because it is a rig, not a
// regression test: the regression tests are fragmenter_clockcut_test.go
// (the durations) and skipframe's bitstream test (the bytes).
//
//	PQP_CLOCKCUT_REPLAY_SRC=/path/capture.264 \
//	PQP_CLOCKCUT_REPLAY_OUT=/path/outdir \
//	go test ./internal/pipeline/ -run ClockCutReplay -v
func TestClockCutReplayRendersAPlayableStream(t *testing.T) {
	src := os.Getenv("PQP_CLOCKCUT_REPLAY_SRC")
	out := os.Getenv("PQP_CLOCKCUT_REPLAY_OUT")
	if src == "" || out == "" {
		t.Skip("set PQP_CLOCKCUT_REPLAY_SRC and PQP_CLOCKCUT_REPLAY_OUT to render a playable stream")
	}
	data, err := os.ReadFile(src)
	if err != nil {
		t.Fatalf("reading %s: %v", src, err)
	}
	aus, sps, pps := replayAccessUnits(t, data)
	t.Logf("source: %d access units", len(aus))

	if err := os.MkdirAll(out, 0o755); err != nil {
		t.Fatal(err)
	}
	initSeg, err := cmaf.BuildInitSegment(cmaf.InitParams{Timescale: timescale, SPS: sps, PPS: pps})
	if err != nil {
		t.Fatalf("building the init segment: %v", err)
	}
	if err := os.WriteFile(filepath.Join(out, "init.mp4"), initSeg, 0o644); err != nil {
		t.Fatal(err)
	}

	f := NewFragmenter(Config{Timescale: timescale, PartDuration: partDuration, SegmentDuration: segmentDuration})
	// PQP_CLOCKCUT_REPLAY_PLAIN renders the SAME capture with no repeater,
	// which is what the flag being off produces: it is how the "before"
	// playlist for a player comparison is made, and the bounds check
	// below is skipped for it because failing those bounds is the point.
	plain := os.Getenv("PQP_CLOCKCUT_REPLAY_PLAIN") != ""
	if !plain {
		synth, err := skipframe.New(sps, pps)
		if err != nil {
			t.Fatalf("the capture is not one repeat frames can be synthesized for: %v", err)
		}
		f.SetRepeater(synth)
	}

	// The gaps production measured on 2026-09-17, put back into an
	// otherwise 30fps stream: a two second stall, and a 1.1s one.
	stalls := map[int]int64{300: 2 * timescale, 900: 11 * timescale / 10}

	type partOut struct {
		URI  string  `json:"uri"`
		Dur  float64 `json:"dur"`
		Tfdt int64   `json:"tfdt"`
	}
	type segOut struct {
		Seg   int       `json:"seg"`
		URI   string    `json:"uri"`
		Dur   float64   `json:"dur"`
		Parts []partOut `json:"parts"`
	}
	var segs []segOut
	var segBytes []byte
	tfdt := int64(0)
	longest, shortestNonTerminal, longestSeen := uint32(0), ^uint32(0), uint32(0)

	emit := func(frag *Fragment) {
		for len(segs) <= frag.SegmentIndex {
			segs = append(segs, segOut{Seg: len(segs)})
		}
		if frag.IsSegmentStart {
			segBytes = nil
		}
		name := fmt.Sprintf("part-%d.m4s", frag.SequenceNumber)
		if err := os.WriteFile(filepath.Join(out, name), frag.Bytes, 0o644); err != nil {
			t.Fatal(err)
		}
		segBytes = append(segBytes, frag.Bytes...)
		s := &segs[frag.SegmentIndex]
		s.Parts = append(s.Parts, partOut{URI: name, Dur: float64(frag.DurationTicks) / timescale, Tfdt: tfdt})
		s.Dur += float64(frag.DurationTicks) / timescale
		s.URI = fmt.Sprintf("seg-%d.m4s", frag.SegmentIndex)
		if err := os.WriteFile(filepath.Join(out, s.URI), segBytes, 0o644); err != nil {
			t.Fatal(err)
		}
		tfdt += int64(frag.DurationTicks)
		if frag.DurationTicks > longest {
			longest = frag.DurationTicks
		}
	}

	pts := int64(0)
	for i, au := range aus {
		if gap, ok := stalls[i]; ok {
			pts += gap
		} else if i > 0 {
			pts += frameStep
		}
		au.PTS = pts
		frags, err := f.Push(au)
		if err != nil && err != ErrWaitingForIDR {
			t.Fatalf("access unit %d: %v", i, err)
		}
		for _, frag := range frags {
			emit(frag)
		}
	}
	if frag, err := f.Flush(); err == nil && frag != nil {
		emit(frag)
	}

	// The two bounds a player enforces, measured over what was written.
	for i := range segs {
		for j, p := range segs[i].Parts {
			d := uint32(p.Dur*timescale + 0.5)
			if d > longestSeen {
				longestSeen = d
			}
			if plain {
				continue
			}
			if d > partDuration {
				t.Fatalf("segment %d part %d lasts %v, past the part target", i, j, p.Dur)
			}
			terminal := j == len(segs[i].Parts)-1
			if !terminal && d < partDuration*85/100 {
				t.Fatalf("segment %d part %d lasts %v, under the 85%% floor", i, j, p.Dur)
			}
			if !terminal && d < shortestNonTerminal {
				shortestNonTerminal = d
			}
		}
	}

	manifest := map[string]any{"video": segs}
	buf, err := json.Marshal(manifest)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(out, "parts.json"), buf, 0o644); err != nil {
		t.Fatal(err)
	}
	if shortestNonTerminal == ^uint32(0) {
		shortestNonTerminal = longestSeen
	}
	t.Logf("wrote %d segments to %s; plain=%t longest part %.3fs, shortest non-terminal %.3fs, %d repeat frames over %d clock cuts",
		len(segs), out, plain, float64(longest)/timescale, float64(shortestNonTerminal)/timescale, f.RepeatFrames(), f.ClockCuts())
}

// replayAccessUnits turns an Annex B dump into access units in AVCC form,
// one per VCL NAL with whatever preceded it, which is the shape
// internal/h264's depacketizer produces from RTP.
func replayAccessUnits(t *testing.T, data []byte) (aus []*h264.AccessUnit, sps, pps []byte) {
	t.Helper()
	var pending []byte
	var idr bool
	flush := func() {
		if pending != nil {
			aus = append(aus, &h264.AccessUnit{AVCC: pending, IsIDR: idr})
			pending, idr = nil, false
		}
	}
	for _, n := range splitAnnexBFrames(data) {
		typ := nal.Type(n[0] & 0x1f)
		switch typ {
		case nal.TypeSPS:
			if sps == nil {
				sps = append([]byte(nil), n...)
			}
		case nal.TypePPS:
			if pps == nil {
				pps = append([]byte(nil), n...)
			}
		}
		pending = nal.AppendAVCC(pending, n)
		if typ == nal.TypeSlice || typ == nal.TypeIDR {
			idr = typ == nal.TypeIDR
			flush()
		}
	}
	flush()
	if sps == nil || pps == nil {
		t.Fatal("the capture carries no SPS/PPS")
	}
	return aus, sps, pps
}

func splitAnnexBFrames(b []byte) [][]byte {
	var out [][]byte
	start := -1
	for i := 0; i+3 < len(b); {
		if b[i] == 0 && b[i+1] == 0 && (b[i+2] == 1 || (b[i+2] == 0 && b[i+3] == 1)) {
			sc := 3
			if b[i+2] == 0 {
				sc = 4
			}
			if start >= 0 {
				if n := trimZeroTail(b[start:i]); len(n) > 0 {
					out = append(out, n)
				}
			}
			start = i + sc
			i += sc
			continue
		}
		i++
	}
	if start >= 0 {
		if n := trimZeroTail(b[start:]); len(n) > 0 {
			out = append(out, n)
		}
	}
	return out
}

func trimZeroTail(b []byte) []byte {
	for len(b) > 0 && b[len(b)-1] == 0 {
		b = b[:len(b)-1]
	}
	return b
}
