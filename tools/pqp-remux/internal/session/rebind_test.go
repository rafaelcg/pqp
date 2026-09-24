package session

import (
	"context"
	"sort"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/pion/rtp"

	"github.com/rafaelcg/pqp/tools/pqp-remux/internal/aacenc"
	"github.com/rafaelcg/pqp/tools/pqp-remux/internal/film"
	"github.com/rafaelcg/pqp/tools/pqp-remux/internal/r2"
	"github.com/rafaelcg/pqp/tools/pqp-remux/internal/ring"
)

// A REPUBLISHED SCREEN IS THE SAME SESSION. Production, 2026-09-24: the web
// client republishes the presenter's screen on a new track when it resumes
// after an API deploy, and whenever the presenter changes what they share.
// The subscriber binds the new track and calls BeginVideoSource; these tests
// drive the session the way it then sees the world: a second RTP stream with
// its own SSRC, sequence space and timestamp base, whose parameter sets may
// differ from the first's, arriving after a gap.

// rtpSource is one publisher's RTP stream: its own sequence numbers and
// timestamp base, as a new track has.
type rtpSource struct {
	seq    uint16
	tsBase uint32
}

func (src *rtpSource) packet(payload []byte, ts uint32, marker bool) *rtp.Packet {
	src.seq++
	return &rtp.Packet{Header: rtp.Header{SequenceNumber: src.seq, Timestamp: src.tsBase + ts, Marker: marker}, Payload: payload}
}

// frame sends one access unit: SPS+PPS+IDR on a keyframe, one slice
// otherwise.
func (src *rtpSource) frame(s *Session, sps, pps []byte, idr bool, ts uint32) {
	if idr {
		s.HandleVideoPacket(src.packet(singleNAL(7, sps[1:]), ts, false))
		s.HandleVideoPacket(src.packet(singleNAL(8, pps[1:]), ts, false))
		s.HandleVideoPacket(src.packet(singleNAL(5, []byte{0xAA, 0xBB}), ts, true))
		return
	}
	s.HandleVideoPacket(src.packet(singleNAL(1, []byte{0xAA, 0xBB}), ts, true))
}

// rebindRun is one session across a rebind: source A for aSeconds, a gap,
// then source B (a new track: new seq, new timestamp base, optionally new
// parameter sets) whose first frames are P-frames the session must drop.
type rebindRun struct {
	*pdtRun
	idrArrival  time.Time // B's first keyframe's arrival
	partsAtBind uint32
}

func runRebind(t *testing.T, spsA, spsB []byte, withKeepAlive bool) *rebindRun {
	t.Helper()
	epoch := time.Date(2026, 9, 24, 7, 51, 0, 0, time.UTC)
	r := startPDTRun(t, epoch)
	s := r.s
	pps := buildPPS()
	var clock time.Time
	s.now = func() time.Time { return clock }

	a := &rtpSource{seq: 1000, tsBase: 3_000_000_000}
	s.BeginVideoSource() // the first bind: must change nothing
	const videoDelay = 800 * time.Millisecond
	const aFrames = 10 * 30
	for i := 0; i < aFrames; i++ {
		clock = epoch.Add(videoDelay + time.Duration(i)*time.Second/30)
		a.frame(s, spsA, pps, i%30 == 0, uint32(i*3000))
	}
	lastA := clock
	partsAtBind := s.CurrentVideoPartSequence()

	// The presenter's client republishes. The subscriber switches tracks.
	clock = lastA.Add(200 * time.Millisecond)
	s.BeginVideoSource()
	if withKeepAlive {
		// The monitor keeps ticking through the gap: the held frame is
		// published by the keep-alive before the new source arrives.
		for at := lastA; at.Before(lastA.Add(1500 * time.Millisecond)); at = at.Add(100 * time.Millisecond) {
			clock = at
			s.idleTick(at)
		}
	}

	// B: a new RTP stream 1.5 s later, P-frames first (they started
	// sending before the keyframe the PLI asked for), then its IDR.
	b := &rtpSource{seq: 50000, tsBase: 12345}
	bStart := lastA.Add(1500 * time.Millisecond)
	idrArrival := time.Time{}
	for i := 0; i < 10*30; i++ {
		clock = bStart.Add(time.Duration(i) * time.Second / 30)
		idr := i == 4 || (i > 4 && (i-4)%30 == 0)
		if i == 4 {
			idrArrival = clock
		}
		b.frame(s, spsB, pps, idr, uint32(i*3000))
	}
	r.lastSimNow = clock
	// Audio for the whole run, as the pacer would have produced it.
	n := int(clock.Sub(epoch) * aacenc.SampleRate / time.Second / 1024)
	for i := 0; i < n; i++ {
		r.enc.frames <- aacenc.Frame{Data: []byte{0x21, 0x10, 0x04, byte(i)}}
	}
	waitFor(t, 3*time.Second, func() bool { return s.Stats().AudioFramesSeen >= uint64(n) })
	return &rebindRun{pdtRun: r, idrArrival: idrArrival, partsAtBind: partsAtBind}
}

func sortedSeqs(parts map[uint32]partInfo) []uint32 {
	seqs := make([]uint32, 0, len(parts))
	for seq := range parts {
		seqs = append(seqs, seq)
	}
	sort.Slice(seqs, func(i, j int) bool { return seqs[i] < seqs[j] })
	return seqs
}

// checkOneTimeline: part numbers run on with no gap and no reuse, and every
// part begins exactly where the one before it ended -- no rewind, no hole.
func checkOneTimeline(t *testing.T, parts map[uint32]partInfo) {
	t.Helper()
	seqs := sortedSeqs(parts)
	for i := 1; i < len(seqs); i++ {
		if seqs[i] != seqs[i-1]+1 {
			t.Fatalf("part numbering jumps from %d to %d", seqs[i-1], seqs[i])
		}
		prev, cur := parts[seqs[i-1]], parts[seqs[i]]
		if cur.StartTicks != prev.EndTicks {
			t.Fatalf("part %d starts at %d, part %d ended at %d: the timeline %s",
				seqs[i], cur.StartTicks, seqs[i-1], prev.EndTicks,
				map[bool]string{true: "rewound", false: "has a hole"}[cur.StartTicks < prev.EndTicks])
		}
	}
}

func TestRebind_InitChangeMidSessionKeepsNumberingAndTheTimeline(t *testing.T) {
	spsA := buildSPS(t, 1280, 720, 0x1F)
	spsB := buildSPS(t, 640, 352, 0x1E) // the new share is a smaller window
	run := runRebind(t, spsA, spsB, false)
	s := run.s

	if got := s.VideoRebinds(); got != 1 {
		t.Fatalf("VideoRebinds = %d, want 1 (the first bind is not a rebind)", got)
	}
	if _, waiting := s.RebindWaitingSince(); waiting {
		t.Fatal("RebindWaitingSince still reports a wait after the new source's keyframe")
	}
	if got := s.rebindDroppedAUs.Load(); got != 4 {
		t.Fatalf("dropped %d of the new source's frames before its keyframe, want the 4 P-frames", got)
	}
	if s.DemoteReason() != "" {
		t.Fatalf("the rebind demoted the session: %s", s.DemoteReason())
	}
	if got := s.CurrentInitGeneration(); got != 2 {
		t.Fatalf("init generation %d, want 2: the new source's parameter sets are a new init map", got)
	}

	parts := partInfos(t, s)
	checkOneTimeline(t, parts)
	if s.CurrentVideoPartSequence() <= run.partsAtBind {
		t.Fatal("no part was published after the rebind")
	}

	// The segment the new source opens: on its keyframe, under the new init,
	// flagged discontinuous, and at the wall instant that keyframe arrived.
	video, audio := run.segments(t)
	var opened *pdtSeg
	snap := s.ring.Snapshot()
	for i, seg := range snap.Segments {
		if seg.InitURI == "init-2.mp4" {
			if !seg.Discontinuity {
				t.Fatal("the new source's first segment is not flagged discontinuous")
			}
			if !seg.Parts[0].Independent {
				t.Fatal("the new source's first part does not start on its keyframe")
			}
			opened = &video[i]
			break
		}
	}
	if opened == nil {
		t.Fatal("no segment was built against the new source's init")
	}
	if d := abs(opened.pdt.Sub(run.idrArrival)); d > frameTolerance {
		t.Fatalf("the new source's first segment has PDT %s, its keyframe arrived %s (%s apart)", opened.pdt, run.idrArrival, d)
	}
	// And the two tracks still name the same instant for the same media,
	// on both sides of the rebind: PDT comes from the one session anchor.
	checkTracksAgree(t, "across a rebind", video, audio)
	for i := 1; i < len(video); i++ {
		if !video[i].pdt.After(video[i-1].pdt) {
			t.Fatalf("PDT rewound at segment %d: %s after %s", i, video[i].pdt, video[i-1].pdt)
		}
	}
}

func TestRebind_SameParameterSetsKeepTheInitAndStillOpenANewSegment(t *testing.T) {
	sps := buildSPS(t, 1280, 720, 0x1F)
	run := runRebind(t, sps, sps, false)
	s := run.s
	if got := s.CurrentInitGeneration(); got != 1 {
		t.Fatalf("init generation %d, want 1: identical parameter sets need no new init", got)
	}
	checkOneTimeline(t, partInfos(t, s))
	// The first part the new source contributes starts a segment, on its
	// keyframe, so no frame from the new encoder shares a segment with the
	// old one's.
	parts := partInfos(t, s)
	seqs := sortedSeqs(parts)
	for _, seq := range seqs {
		if seq <= run.partsAtBind {
			continue
		}
		// The part the bind closed (the old source's last) comes first; the
		// one after it is the new source's.
		next := parts[seq+1]
		if parts[seq].SegmentIndex == next.SegmentIndex {
			t.Fatalf("the new source's keyframe did not open a new segment (parts %d and %d share segment %d)", seq, seq+1, next.SegmentIndex)
		}
		break
	}
}

func TestRebind_KeepAliveThroughTheGapNeverRewinds(t *testing.T) {
	spsA := buildSPS(t, 1280, 720, 0x1F)
	spsB := buildSPS(t, 640, 352, 0x1E)
	run := runRebind(t, spsA, spsB, true)
	s := run.s
	if s.Stats().KeepAlivePartsWrites == 0 {
		t.Fatal("test setup: the keep-alive never published during the gap")
	}
	checkOneTimeline(t, partInfos(t, s))
	video, audio := run.segments(t)
	checkTracksAgree(t, "keep-alive through a rebind", video, audio)
}

// THE REPLAY AND THE FILM ACROSS A REBIND. What the session uploads is one
// continuous replay: the video playlist names every segment once, in order,
// switching EXT-X-MAP at the new init with one discontinuity, and the film
// planner reads it as ONE clock (an init change, never a restart), so the
// film is laid end to end with no shift and no gap where the rebind was.
func TestRebind_ReplayAndFilmStayOneContinuousRecording(t *testing.T) {
	enc := newFakeEncoder()
	withFakeEncoderFactory(t, func(ctx context.Context, cfg aacenc.Config) (remuxEncoder, error) { return enc, nil })
	up := &objectUploader{objects: map[string][]byte{}}
	writer := r2.NewWriter(up, r2.WriterConfig{QueueDepth: 4096, MaxRetries: 1})
	vod := r2.NewVodIndex()
	video := ring.New(60, 90000)
	s := New(45000, 360000, video, nil)
	epoch := time.Date(2026, 9, 24, 7, 51, 0, 0, time.UTC)
	s.epoch = epoch
	video.SetPDTAnchor(epoch)
	s.EnableR2(writer, "c0ffee00-0000-4000-8000-000000000001", epoch.UnixMilli(), "ll")
	s.EnableVodIndex(vod)
	var clock time.Time
	s.now = func() time.Time { return clock }

	spsA := buildSPS(t, 1280, 720, 0x1F)
	spsB := buildSPS(t, 640, 352, 0x1E)
	pps := buildPPS()
	a := &rtpSource{seq: 7, tsBase: 90_000}
	for i := 0; i < 12*30; i++ {
		clock = epoch.Add(500*time.Millisecond + time.Duration(i)*time.Second/30)
		a.frame(s, spsA, pps, i%30 == 0, uint32(i*3000))
	}
	gapFrom := clock
	s.BeginVideoSource()
	b := &rtpSource{seq: 40000, tsBase: 7}
	for i := 0; i < 12*30; i++ {
		clock = gapFrom.Add(1200*time.Millisecond + time.Duration(i)*time.Second/30)
		b.frame(s, spsB, pps, i%30 == 0, uint32(i*3000))
	}
	s.Finish()
	s.Close()
	writer.Close()

	body, ok := vod.VideoPlaylist()
	if !ok {
		t.Fatal("no replay playlist")
	}
	groups, err := film.ParsePlaylist(body)
	if err != nil {
		t.Fatal(err)
	}
	if len(groups) != 2 || groups[0].Init != "video-init.mp4" || groups[1].Init != "video-init-2.mp4" {
		t.Fatalf("replay groups %+v, want two: the old source's init, then the new one's", groups)
	}
	seen := map[string]bool{}
	var spans []film.Span
	for _, g := range groups {
		start := -1.0
		dur := 0.0
		for _, seg := range g.Segments {
			if seen[seg.Name] {
				t.Fatalf("segment %s listed twice", seg.Name)
			}
			seen[seg.Name] = true
			if !up.has(seg.Name) {
				t.Fatalf("the replay names %s, which was never uploaded", seg.Name)
			}
			if start < 0 {
				start = float64(tfdtOf(t, up.get(seg.Name))) / 90000
			}
			dur += seg.Seconds
		}
		spans = append(spans, film.Span{Start: start, End: start + dur})
	}
	if gap := spans[1].Start - spans[0].End; gap < -0.05 || gap > 0.05 {
		t.Fatalf("the new source's first segment starts %.3fs after the old source's last ended: the recording has a hole or an overlap", gap)
	}
	videoOff, _ := film.Offsets(spans, nil)
	for i, off := range videoOff {
		if off != 0 {
			t.Fatalf("the film planner shifts group %d by %.3fs: it read the rebind as a restart, not one clock", i, off)
		}
	}
}

// objectUploader keeps every object it is handed, by name within the
// session prefix.
type objectUploader struct {
	mu      sync.Mutex
	objects map[string][]byte
}

func (u *objectUploader) PutObject(_ context.Context, key string, body []byte, _ string) error {
	u.mu.Lock()
	defer u.mu.Unlock()
	u.objects[key[strings.LastIndex(key, "/")+1:]] = append([]byte(nil), body...)
	return nil
}

func (u *objectUploader) has(name string) bool {
	u.mu.Lock()
	defer u.mu.Unlock()
	_, ok := u.objects[name]
	return ok
}

func (u *objectUploader) get(name string) []byte {
	u.mu.Lock()
	defer u.mu.Unlock()
	return u.objects[name]
}

// The watchdog's view of a rebind: waiting from the bind until the new
// source's first keyframe, and not before or after.
func TestRebind_ReportsTheKeyframeWaitToTheWatchdog(t *testing.T) {
	sps := buildSPS(t, 1280, 720, 0x1F)
	pps := buildPPS()
	s := New(45000, 360000, ring.New(6, 90000), nil)
	epoch := time.Date(2026, 9, 24, 7, 51, 0, 0, time.UTC)
	s.epoch = epoch
	clock := epoch
	s.now = func() time.Time { return clock }
	a := &rtpSource{seq: 1, tsBase: 1000}
	for i := 0; i < 60; i++ {
		clock = epoch.Add(time.Duration(i) * time.Second / 30)
		a.frame(s, sps, pps, i%30 == 0, uint32(i*3000))
	}
	if _, waiting := s.RebindWaitingSince(); waiting {
		t.Fatal("a session that never rebound reports a keyframe wait")
	}
	clock = clock.Add(100 * time.Millisecond)
	bindAt := clock
	s.BeginVideoSource()
	b := &rtpSource{seq: 9000, tsBase: 77}
	for i := 0; i < 30*16; i++ { // 16 s of P-frames: a slow keyframe
		clock = bindAt.Add(time.Duration(i) * time.Second / 30)
		b.frame(s, sps, pps, false, uint32(i*3000))
	}
	since, waiting := s.RebindWaitingSince()
	if !waiting || !since.Equal(bindAt) {
		t.Fatalf("RebindWaitingSince = %s, %t; want %s, true", since, waiting, bindAt)
	}
	b.frame(s, sps, pps, true, uint32(30*16*3000))
	if _, waiting := s.RebindWaitingSince(); waiting {
		t.Fatal("still waiting after the keyframe")
	}
	if s.DemoteReason() != "" {
		t.Fatalf("the session asked to be demoted: %s", s.DemoteReason())
	}
}
