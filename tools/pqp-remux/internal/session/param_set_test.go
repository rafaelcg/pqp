package session

import (
	"testing"
	"time"

	"github.com/rafaelcg/pqp/tools/pqp-remux/internal/keyframe"
	"github.com/rafaelcg/pqp/tools/pqp-remux/internal/llstate"
	"github.com/rafaelcg/pqp/tools/pqp-remux/internal/nal"
	"github.com/rafaelcg/pqp/tools/pqp-remux/internal/ring"
)

// buildSPS mirrors internal/cmaf's test helper: a baseline SPS for a
// crop-free width/height (multiples of 16) so BuildInitSegment succeeds.
func buildSPS(t *testing.T, width, height uint32, levelIDC byte) []byte {
	t.Helper()
	if width%16 != 0 || height%16 != 0 {
		t.Fatalf("buildSPS: %dx%d must be multiples of 16", width, height)
	}
	w := &spsBits{}
	w.writeBits(66, 8) // baseline
	w.writeBits(0, 8)
	w.writeBits(uint32(levelIDC), 8)
	w.writeUE(0)
	w.writeUE(4)
	w.writeUE(0)
	w.writeUE(4)
	w.writeUE(1)
	w.writeBit(0)
	w.writeUE(width/16 - 1)
	w.writeUE(height/16 - 1)
	w.writeBit(1)
	w.writeBit(1)
	w.writeBit(0)
	w.writeBit(1)
	return append([]byte{0x07}, w.finish()...)
}

func buildPPS() []byte { return []byte{0x08, 0xAA} }

type spsBits struct {
	bytes []byte
	cur   byte
	nbits uint
}

func (w *spsBits) writeBit(b uint32) {
	w.cur = (w.cur << 1) | byte(b&1)
	w.nbits++
	if w.nbits == 8 {
		w.bytes = append(w.bytes, w.cur)
		w.cur = 0
		w.nbits = 0
	}
}
func (w *spsBits) writeBits(v uint32, n int) {
	for i := n - 1; i >= 0; i-- {
		w.writeBit((v >> uint(i)) & 1)
	}
}
func (w *spsBits) writeUE(v uint32) {
	x := v + 1
	nbits := 0
	for t := x; t > 1; t >>= 1 {
		nbits++
	}
	for i := 0; i < nbits; i++ {
		w.writeBit(0)
	}
	w.writeBits(x, nbits+1)
}
func (w *spsBits) finish() []byte {
	for w.nbits != 0 {
		w.writeBit(0)
	}
	return w.bytes
}

func feedAU(s *Session, sps, pps []byte, idr bool, ts uint32) {
	if len(sps) > 0 {
		s.HandleVideoPacket(videoPacket(singleNAL(7, sps[1:]), ts, false))
	}
	if len(pps) > 0 {
		s.HandleVideoPacket(videoPacket(singleNAL(8, pps[1:]), ts, false))
	}
	nalType := byte(1)
	if idr {
		nalType = 5
	}
	s.HandleVideoPacket(videoPacket(singleNAL(nalType, []byte{0xAA, 0xBB}), ts, true))
}

// TestSession_ParameterSetChangeRebuildsInit is the regression for the
// 2026-09-16 production failure: Chrome's screen-share encoder starts at
// 640x360 and ramps to 1280x720, the remuxer kept the 360p init, and every
// viewer died with MEDIA_ERR_DECODE. A mid-stream (and mid-segment) switch
// must close the open segment, publish init-2.mp4, stamp discontinuity on
// the new segment, and keep the media timeline moving forward.
func TestSession_ParameterSetChangeRebuildsInit(t *testing.T) {
	r := ring.New(6, 90000)
	s := New(45000, 360000, r, nil) // 500ms parts, 4s segments

	sps360 := buildSPS(t, 640, 352, 0x1E)  // level 3.0
	sps720 := buildSPS(t, 1280, 720, 0x1F) // level 3.1
	pps := buildPPS()

	if _, err := nal.ParseSPS(sps360); err != nil {
		t.Fatalf("sps360: %v", err)
	}
	if _, err := nal.ParseSPS(sps720); err != nil {
		t.Fatalf("sps720: %v", err)
	}

	frame := uint32(0)
	feedAU(s, sps360, pps, true, frame)
	frame += frameStep
	// Enough P-frames to open a part mid-segment (well under 4s).
	for i := 0; i < 20; i++ {
		feedAU(s, nil, nil, false, frame)
		frame += frameStep
	}
	if _, ok := r.InitByURI(ring.DefaultInitURI); !ok {
		t.Fatal("expected init.mp4 after the first IDR")
	}
	if r.CurrentInitURI() != ring.DefaultInitURI {
		t.Fatalf("current init = %q, want %s", r.CurrentInitURI(), ring.DefaultInitURI)
	}
	partsBefore := s.Health().PartsWritten
	if partsBefore == 0 {
		t.Fatal("expected at least one part before the resolution change")
	}

	// Mid-segment switch: new SPS/PPS on an IDR before the 4s target.
	feedAU(s, sps720, pps, true, frame)
	frame += frameStep
	// Close the part that holds the new IDR so the new segment is visible.
	for i := 0; i < 20; i++ {
		feedAU(s, nil, nil, false, frame)
		frame += frameStep
	}

	if _, ok := r.InitByURI("init-2.mp4"); !ok {
		t.Fatal("expected init-2.mp4 after the parameter-set change")
	}
	if r.CurrentInitURI() != "init-2.mp4" {
		t.Fatalf("current init = %q, want init-2.mp4", r.CurrentInitURI())
	}
	// Original init.mp4 must still be fetchable for segments that used it.
	if _, ok := r.InitByURI(ring.DefaultInitURI); !ok {
		t.Fatal("init.mp4 must remain available after init-2.mp4 is published")
	}

	snap := r.Snapshot()
	if len(snap.Segments) < 2 {
		t.Fatalf("expected at least two segments after the switch, got %d", len(snap.Segments))
	}
	var disc *ring.SegmentSnapshot
	for i := range snap.Segments {
		seg := &snap.Segments[i]
		if seg.Discontinuity {
			disc = seg
			break
		}
	}
	if disc == nil {
		t.Fatal("expected a discontinuous segment after the parameter-set change")
	}
	if disc.InitURI != "init-2.mp4" {
		t.Fatalf("discontinuous segment initURI = %q, want init-2.mp4", disc.InitURI)
	}
	if snap.Segments[0].InitURI != ring.DefaultInitURI {
		t.Fatalf("first segment initURI = %q, want %s", snap.Segments[0].InitURI, ring.DefaultInitURI)
	}
	// Timeline must not rewind: segment indices strictly increase.
	for i := 1; i < len(snap.Segments); i++ {
		if snap.Segments[i].Index <= snap.Segments[i-1].Index {
			t.Fatalf("segment indices rewound: %+v", snap.Segments)
		}
	}

	state, ok := llstate.Build(llstate.Meta{
		SessionID:       "5a1b2c3d-4e5f-4a7b-8c9d-0e1f2a3b4c5d",
		ChannelID:       "chan_test",
		PartTargetMs:    500,
		SegmentTargetMs: 4000,
	}, snap, nil)
	if !ok {
		t.Fatal("llstate.Build refused the dual-init snapshot")
	}
	if state.Video.InitURI != "init-2.mp4" {
		t.Fatalf("track.initUri = %q, want init-2.mp4 (newest)", state.Video.InitURI)
	}
	foundDisc := false
	for _, seg := range state.Video.Segments {
		if seg.Discontinuity {
			foundDisc = true
			if seg.InitURI != "init-2.mp4" {
				t.Fatalf("state segment discontinuity initUri = %q", seg.InitURI)
			}
		}
	}
	if !foundDisc {
		t.Fatal("state.json missing discontinuity flag")
	}
	if s.DemoteReason() != "" {
		t.Fatalf("successful change must not demote, got %q", s.DemoteReason())
	}
}

func TestSession_IdenticalParameterSetsDoNotRebuildInit(t *testing.T) {
	r := ring.New(6, 90000)
	s := New(45000, 360000, r, nil)
	sps := buildSPS(t, 1280, 720, 0x1F)
	pps := buildPPS()

	frame := uint32(0)
	feedAU(s, sps, pps, true, frame)
	frame += frameStep
	for i := 0; i < 20; i++ {
		feedAU(s, nil, nil, false, frame)
		frame += frameStep
	}
	// Byte-identical SPS/PPS on a later IDR must not publish init-2.
	feedAU(s, sps, pps, true, frame)
	frame += frameStep
	for i := 0; i < 20; i++ {
		feedAU(s, nil, nil, false, frame)
		frame += frameStep
	}

	if _, ok := r.InitByURI("init-2.mp4"); ok {
		t.Fatal("byte-identical SPS/PPS must not publish a second init")
	}
	if r.CurrentInitURI() != ring.DefaultInitURI {
		t.Fatalf("current init = %q, want %s", r.CurrentInitURI(), ring.DefaultInitURI)
	}
	for _, seg := range r.Snapshot().Segments {
		if seg.Discontinuity {
			t.Fatal("identical repeats must not set discontinuity")
		}
	}
}

func TestSession_ParameterSetChangeWithoutIDRDemotes(t *testing.T) {
	r := ring.New(6, 90000)
	s := New(45000, 360000, r, nil)
	sps360 := buildSPS(t, 640, 352, 0x1E)
	sps720 := buildSPS(t, 1280, 720, 0x1F)
	pps := buildPPS()

	frame := uint32(0)
	feedAU(s, sps360, pps, true, frame)
	frame += frameStep
	for i := 0; i < 5; i++ {
		feedAU(s, nil, nil, false, frame)
		frame += frameStep
	}
	// Non-IDR access unit carrying a new SPS/PPS: cannot open a CMAF
	// segment, so demote rather than ship undecodable media.
	feedAU(s, sps720, pps, false, frame)

	if got := s.DemoteReason(); got != "parameter-set-change-without-idr" {
		t.Fatalf("DemoteReason = %q, want parameter-set-change-without-idr", got)
	}
	if _, ok := r.InitByURI("init-2.mp4"); ok {
		t.Fatal("must not publish init-2.mp4 when demoting")
	}
}

// A damaged SPS (here 16x16, well under anything a publisher sends) must not
// rebuild the init or demote: the stream keeps playing on the init it has.
func TestSession_ImplausibleParameterSetIsIgnored(t *testing.T) {
	r := ring.New(6, 90000)
	s := New(45000, 360000, r, nil)

	sps720 := buildSPS(t, 1280, 720, 0x1F)
	spsTiny := buildSPS(t, 16, 16, 0x1F)
	pps := buildPPS()

	frame := uint32(0)
	feedAU(s, sps720, pps, true, frame)
	frame += frameStep
	for i := 0; i < 20; i++ {
		feedAU(s, nil, nil, false, frame)
		frame += frameStep
	}
	if r.CurrentInitURI() != ring.DefaultInitURI {
		t.Fatalf("current init = %q, want %s", r.CurrentInitURI(), ring.DefaultInitURI)
	}

	partsBeforeDamage := s.Health().PartsWritten
	feedAU(s, spsTiny, pps, true, frame)
	frame += frameStep
	for i := 0; i < 5; i++ {
		feedAU(s, nil, nil, false, frame)
		frame += frameStep
	}
	if got := s.Health().PartsWritten; got != partsBeforeDamage {
		t.Fatalf("parts grew from %d to %d during the damaged GOP; those frames must be dropped", partsBeforeDamage, got)
	}
	if r.CurrentInitURI() != ring.DefaultInitURI {
		t.Fatalf("a 16x16 SPS rebuilt the init to %q; it must be ignored", r.CurrentInitURI())
	}
	if _, ok := r.InitByURI("init-2.mp4"); ok {
		t.Fatal("init-2.mp4 must not exist after an implausible parameter set")
	}
	if s.DemoteReason() != "" {
		t.Fatalf("demoted for %q; an implausible SPS must be ignored, not demoted", s.DemoteReason())
	}
	// Counted per access unit that still carries the damaged set, so the
	// stats line shows how long the publisher kept sending it.
	if got := s.implausibleParamSets.Load(); got < 1 {
		t.Fatalf("implausibleParamSets = %d, want >= 1", got)
	}
	// The depacketizer carries the active parameter set on every access unit,
	// so each damaged frame is refused by the plausibility check itself; the
	// droppingDamaged flag covers a depacketizer that does not. Either way all
	// six frames of the damaged GOP are accounted for and none was fragmented.
	if got := s.implausibleParamSets.Load() + s.damagedAUsDropped.Load(); got != 6 {
		t.Fatalf("dropped %d frames of the damaged GOP, want 6 (1 IDR + 5 P)", got)
	}

	// The next sane keyframe resumes the stream on the init it kept.
	partsBefore := s.Health().PartsWritten
	feedAU(s, sps720, pps, true, frame)
	frame += frameStep
	for i := 0; i < 20; i++ {
		feedAU(s, nil, nil, false, frame)
		frame += frameStep
	}
	if s.Health().PartsWritten <= partsBefore {
		t.Fatal("expected parts to resume after the next sane IDR")
	}
	if r.CurrentInitURI() != ring.DefaultInitURI {
		t.Fatalf("current init = %q after resuming, want %s", r.CurrentInitURI(), ring.DefaultInitURI)
	}
}

// blockingSender's RequestKeyframe reports one call on `called` and then
// blocks until `release` is closed, so a test can prove a caller does not
// wait on it.
type blockingSender struct {
	called  chan struct{}
	release chan struct{}
}

func newBlockingSender() *blockingSender {
	return &blockingSender{called: make(chan struct{}, 1), release: make(chan struct{})}
}

func (b *blockingSender) RequestKeyframe() {
	select {
	case b.called <- struct{}{}:
	default:
	}
	<-b.release
}

// TestSession_ForcedKeyframeDoesNotBlockVideoMu is the regression for the
// Farol review on PR #659: ForcePLI's RTCP write (subscriber.Session.
// RequestKeyframe -> WritePLI) used to run synchronously inside
// HandleVideoPacket's s.videoMu critical section. A slow or backpressured
// write there held videoMu for as long as the send took, stalling every
// later video packet -- turning the exact loss/corruption event this PLI
// exists to recover from into an additional, self-inflicted stall. A
// damaged parameter set (the "damaged-gop-dropped" path, same as
// TestSession_ImplausibleParameterSetIsIgnored above) triggers a forced
// PLI; with a PLISender that blocks forever, HandleVideoPacket must still
// return promptly, and a second packet must not queue behind the still
// in-flight send.
func TestSession_ForcedKeyframeDoesNotBlockVideoMu(t *testing.T) {
	r := ring.New(6, 90000)
	send := newBlockingSender()
	defer close(send.release)
	kr := keyframe.NewRequester(keyframe.Config{Policy: keyframe.PolicyPLI, PaceMs: 500}, send)
	s := New(45000, 360000, r, kr)

	sps720 := buildSPS(t, 1280, 720, 0x1F)
	spsTiny := buildSPS(t, 16, 16, 0x1F)
	pps := buildPPS()

	feedAU(s, sps720, pps, true, 0)

	first := make(chan struct{})
	go func() {
		// The implausible SPS triggers handleParameterSetChange's forced PLI.
		feedAU(s, spsTiny, pps, true, frameStep)
		close(first)
	}()
	select {
	case <-first:
	case <-time.After(2 * time.Second):
		t.Fatal("HandleVideoPacket blocked on a forced PLI's RTCP write; the send must run outside s.videoMu")
	}
	select {
	case <-send.called:
	case <-time.After(2 * time.Second):
		t.Fatal("forced PLI was never sent")
	}

	// videoMu must actually be free: a second packet processes without
	// waiting for the still-blocked send to finish.
	second := make(chan struct{})
	go func() {
		feedAU(s, nil, nil, false, 2*frameStep)
		close(second)
	}()
	select {
	case <-second:
	case <-time.After(2 * time.Second):
		t.Fatal("a second packet blocked behind the in-flight forced PLI send")
	}
}
