package session

import (
	"context"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/rafaelcg/pqp/tools/pqp-remux/internal/aacenc"
	"github.com/rafaelcg/pqp/tools/pqp-remux/internal/llstate"
	"github.com/rafaelcg/pqp/tools/pqp-remux/internal/ring"
)

// THE PROPERTY. hls.js aligns an audio rendition to video by
// EXT-X-PROGRAM-DATE-TIME. When each ring stamped PDT with the wall instant
// its segment's first part happened to be published, the two playlists
// disagreed by 1.5 to 1.7 s about the time of the same media, and hls.js
// skipped audio parts and then jumped the gap it had made. These tests read
// PDT the way a player does, out of the state.json llstate renders, and
// require the two tracks to agree to within one video frame for the same
// media time: across a parameter-set change (a new init, a discontinuity)
// and across a watchdog restart (a whole new pipeline).

const frameTolerance = 34 * time.Millisecond

// pdtRun drives one pipeline: a video source whose first packet arrives
// `videoDelay` after the session's epoch (the subscription taking its
// time, as it always does), 30 fps with a resolution change halfway, and
// the audio track's encoder emitting one AAC frame per 1024 samples.
type pdtRun struct {
	s          *Session
	video      *ring.Ring
	audio      *ring.Ring
	enc        *fakeEncoder
	epoch      time.Time
	arrivals   map[int64]time.Time // video media ticks -> wall arrival
	lastSimNow time.Time
}

func startPDTRun(t *testing.T, epoch time.Time) *pdtRun {
	t.Helper()
	enc := newFakeEncoder()
	withFakeEncoderFactory(t, func(ctx context.Context, cfg aacenc.Config) (remuxEncoder, error) { return enc, nil })
	video := ring.New(60, 90000)
	s := New(45000, 360000, video, nil)
	// The production anchor is time.Now() at construction; a test that
	// drives its own clock has to hand the session the same instant, the
	// way pipeline construction does in production.
	s.epoch = epoch
	video.SetPDTAnchor(epoch)
	audio := ring.New(60, aacenc.SampleRate)
	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(func() { cancel(); s.Close() })
	if err := s.EnableAudio(ctx, AudioConfig{Ring: audio, PartTicks: 24576, SegmentTicks: 4 * aacenc.SampleRate}); err != nil {
		t.Fatalf("EnableAudio: %v", err)
	}
	return &pdtRun{s: s, video: video, audio: audio, enc: enc, epoch: epoch, arrivals: map[int64]time.Time{}}
}

// feed sends `seconds` of 30 fps video starting `videoDelay` after the
// epoch, switching resolution at `switchAt`, and the matching audio.
func (r *pdtRun) feed(t *testing.T, videoDelay time.Duration, seconds int, switchAt time.Duration) {
	t.Helper()
	sps1 := buildSPS(t, 640, 352, 0x1E)
	sps2 := buildSPS(t, 1280, 720, 0x1F)
	pps := buildPPS()
	var clock time.Time
	r.s.now = func() time.Time { return clock }
	const rtpBase = uint32(3_000_000_000) // any publisher epoch; wraps soon after
	frames := seconds * 30
	for i := 0; i < frames; i++ {
		at := time.Duration(i) * time.Second / 30
		clock = r.epoch.Add(videoDelay + at)
		ts := rtpBase + uint32(i*3000)
		sps := []byte(nil)
		idr := i%30 == 0
		if idr {
			sps = sps1
			if at >= switchAt {
				sps = sps2
			}
		}
		if sps != nil {
			feedAU(r.s, sps, pps, true, ts)
		} else {
			feedAU(r.s, nil, nil, false, ts)
		}
		r.arrivals[int64(i)*3000] = clock
	}
	r.lastSimNow = clock
	// Audio: every AAC frame the pacer would have produced by then.
	n := int((videoDelay + time.Duration(seconds)*time.Second) * aacenc.SampleRate / time.Second / 1024)
	for i := 0; i < n; i++ {
		r.enc.frames <- aacenc.Frame{Data: []byte{0x21, 0x10, 0x04, byte(i)}}
	}
	waitFor(t, 3*time.Second, func() bool { return r.s.Stats().AudioFramesSeen >= uint64(n) })
}

type pdtSeg struct {
	pdt        time.Time
	startTicks int64
	timescale  int64
	disc       bool
}

func (p pdtSeg) mediaStart() time.Duration {
	return time.Duration(p.startTicks) * time.Second / time.Duration(p.timescale)
}

// segments renders state.json exactly as the edge reads it and returns,
// per track, each segment's PDT beside its first part's tfdt.
func (r *pdtRun) segments(t *testing.T) (video, audio []pdtSeg) {
	t.Helper()
	aSnap := r.audio.Snapshot()
	st, ok := llstate.Build(llstate.Meta{SessionID: "5a1b2c3d-4e5f-4a7b-8c9d-0e1f2a3b4c5d", ChannelID: "c", PartTargetMs: 500, SegmentTargetMs: 4000}, r.video.Snapshot(), &aSnap)
	if !ok {
		t.Fatal("llstate.Build: nothing to render")
	}
	read := func(tr *llstate.Track, rg *ring.Ring, prefix string, ts int64) []pdtSeg {
		var out []pdtSeg
		for _, seg := range tr.Segments {
			pdt, err := time.Parse(time.RFC3339Nano, seg.ProgramDateTime)
			if err != nil {
				t.Fatalf("PDT %q: %v", seg.ProgramDateTime, err)
			}
			seq, err := strconv.Atoi(strings.TrimSuffix(strings.TrimPrefix(seg.Parts[0].URI, prefix+"part-"), ".m4s"))
			if err != nil {
				t.Fatalf("part uri %q: %v", seg.Parts[0].URI, err)
			}
			b, ok := rg.Part(uint32(seq))
			if !ok {
				t.Fatalf("part %d not in ring", seq)
			}
			out = append(out, pdtSeg{pdt: pdt, startTicks: int64(tfdtOf(t, b)), timescale: ts, disc: seg.Discontinuity})
		}
		return out
	}
	return read(st.Video, r.video, "", 90000), read(st.Audio, r.audio, "audio-", aacenc.SampleRate)
}

// pdtAt is the PDT a track's playlist assigns to media time m: the PDT of
// the segment holding m plus how far into it m is.
func pdtAt(segs []pdtSeg, m time.Duration) (time.Time, bool) {
	for i := len(segs) - 1; i >= 0; i-- {
		if segs[i].mediaStart() <= m {
			return segs[i].pdt.Add(m - segs[i].mediaStart()), true
		}
	}
	return time.Time{}, false
}

func abs(d time.Duration) time.Duration {
	if d < 0 {
		return -d
	}
	return d
}

func checkTracksAgree(t *testing.T, label string, video, audio []pdtSeg) {
	t.Helper()
	if len(video) < 3 || len(audio) < 3 {
		t.Fatalf("%s: too few segments to compare (video %d, audio %d)", label, len(video), len(audio))
	}
	for _, v := range video {
		a, ok := pdtAt(audio, v.mediaStart())
		if !ok {
			continue // media before the audio window
		}
		if d := abs(v.pdt.Sub(a)); d > frameTolerance {
			t.Fatalf("%s: video segment at media %s has PDT %s, audio says %s for the same media: %s apart",
				label, v.mediaStart(), v.pdt.Format(time.RFC3339Nano), a.Format(time.RFC3339Nano), d)
		}
	}
}

func TestPDT_VideoAndAudioAgreeForTheSameMediaTime(t *testing.T) {
	epoch := time.Date(2026, 9, 23, 20, 0, 0, 0, time.UTC)
	r := startPDTRun(t, epoch)
	r.feed(t, 1700*time.Millisecond, 20, 9*time.Second)
	video, audio := r.segments(t)

	sawDisc := false
	for _, v := range video {
		sawDisc = sawDisc || v.disc
	}
	if !sawDisc {
		t.Fatal("test setup: the resolution change produced no discontinuity")
	}
	checkTracksAgree(t, "one pipeline", video, audio)

	// And PDT is the wall instant the media arrived: the first video
	// segment's PDT is when its IDR reached the box, not the epoch the
	// video timeline used to start at.
	if d := abs(video[0].pdt.Sub(epoch.Add(1700 * time.Millisecond))); d > frameTolerance {
		t.Fatalf("first video segment PDT %s, want the first frame's arrival %s", video[0].pdt, epoch.Add(1700*time.Millisecond))
	}
	for _, v := range video {
		want, ok := r.arrivals[v.startTicks-durationToTicks(1700*time.Millisecond)]
		if ok && abs(v.pdt.Sub(want)) > frameTolerance {
			t.Fatalf("video segment at media %s: PDT %s, frame arrived %s", v.mediaStart(), v.pdt, want)
		}
	}
	if st := r.s.Stats(); st.PTSShiftMs != 0 {
		t.Fatalf("PTSShiftMs = %d: the timeline anchor was counted as a shift", st.PTSShiftMs)
	}
}

// A watchdog restart builds a new pipeline with its own epoch and a media
// timeline that starts again. Its two tracks must agree with each other,
// and its PDT must continue forward from where the old pipeline's ended.
func TestPDT_AgreeAcrossARestartAndNeverRewind(t *testing.T) {
	epoch := time.Date(2026, 9, 23, 20, 0, 0, 0, time.UTC)
	first := startPDTRun(t, epoch)
	first.feed(t, 900*time.Millisecond, 12, time.Hour)
	v1, a1 := first.segments(t)
	checkTracksAgree(t, "before the restart", v1, a1)
	lastEnd := first.lastSimNow

	// The replacement is built after the old one stopped, as
	// ManagedSession.restart does, and its subscriber takes a while too.
	second := startPDTRun(t, lastEnd.Add(300*time.Millisecond))
	second.feed(t, 1200*time.Millisecond, 12, 5*time.Second)
	v2, a2 := second.segments(t)
	checkTracksAgree(t, "after the restart", v2, a2)

	if !v2[0].pdt.After(lastEnd) || !a2[0].pdt.After(v1[len(v1)-1].pdt) {
		t.Fatalf("PDT rewound across the restart: old last video %s, new first video %s, new first audio %s",
			v1[len(v1)-1].pdt, v2[0].pdt, a2[0].pdt)
	}
}
