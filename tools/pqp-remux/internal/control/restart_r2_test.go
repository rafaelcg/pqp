package control

import (
	"context"
	"fmt"
	"net/http"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/pion/rtp"

	"github.com/rafaelcg/pqp/tools/pqp-remux/internal/h264"
	"github.com/rafaelcg/pqp/tools/pqp-remux/internal/r2"
	"github.com/rafaelcg/pqp/tools/pqp-remux/internal/ring"
	"github.com/rafaelcg/pqp/tools/pqp-remux/internal/session"
)

// --- A real session.Session-backed test Pipeline, with no LiveKit at all ---
//
// remuxPipeline (remux_pipeline.go) cannot be built in a unit test -- it
// needs a live LiveKit room (subscriber.Connect). The R2-key-collision
// concern this file's test guards against (Farol review, PR #584: "carry
// the video and audio segment counters and the R2 key sequence across the
// restart... never overwriting uploaded objects") is entirely about
// internal/session + internal/r2's own interaction, driven by
// managed_session.go's restart -- so this Pipeline wraps a REAL
// session.Session and a REAL r2.Writer (over a fake in-memory Uploader),
// and the test drives it directly with synthetic RTP packets instead of a
// live subscription.

func singleNAL(naluType byte, rbsp []byte) []byte {
	return append([]byte{naluType}, rbsp...)
}

func videoPacket(payload []byte, ts uint32, marker bool) *rtp.Packet {
	return &rtp.Packet{Header: rtp.Header{Timestamp: ts, Marker: marker}, Payload: payload}
}

// realishSPS/realishPPS mirror internal/session's own test fixtures
// exactly (a minimal-but-valid 1280x720 baseline SPS) -- duplicated here
// rather than exported from internal/session, matching this repo's
// existing convention of small test-only fixtures living beside their own
// package (see internal/cmaf's buildTestSPS for the same shape used a
// third time).
func realishSPS() []byte {
	return []byte{0x07, 0x42, 0x00, 0x1F, 0x8C, 0x8D, 0x40, 0x50, 0x1E, 0xD0, 0x80, 0x00, 0x00, 0x00}
}

func realishPPS() []byte { return []byte{0x08, 0xAA} }

// keyTrackingUploader records every PutObject call's key, so a test can
// assert no key is ever PUT more than once -- the literal acceptance bar
// Farol's review names for this fix.
type keyTrackingUploader struct {
	mu   sync.Mutex
	seen map[string]int
}

func newKeyTrackingUploader() *keyTrackingUploader {
	return &keyTrackingUploader{seen: map[string]int{}}
}

func (u *keyTrackingUploader) PutObject(ctx context.Context, key string, body []byte, contentType string) error {
	u.mu.Lock()
	defer u.mu.Unlock()
	u.seen[key]++
	return nil
}

// duplicates reports every key PUT more than once, EXCLUDING each
// rendition's *-init.mp4 -- that object is a fixed key (unlike
// video-seg-N.m4s/audio-seg-N.m4s, it carries no segment index), and every
// pipeline generation, restart included, re-publishes it from its own
// SPS/PPS on purpose: it is expected, harmless, idempotent-in-content
// (the codec parameters do not change because the room reconnected) and
// entirely unrelated to the segment-numbering collision this fix guards
// against. This is what makes the assertion this type exists for
// ("no key is PUT twice across a restart") mean "no NUMBERED segment
// object is silently overwritten", which is what Farol's review actually
// asked for.
func (u *keyTrackingUploader) duplicates() []string {
	u.mu.Lock()
	defer u.mu.Unlock()
	var dups []string
	for k, n := range u.seen {
		if n > 1 && !strings.HasSuffix(k, "-init.mp4") {
			dups = append(dups, k)
		}
	}
	return dups
}

func (u *keyTrackingUploader) count() int {
	u.mu.Lock()
	defer u.mu.Unlock()
	return len(u.seen)
}

// putsForSuffix sums PUT counts for every key ending in suffix (object
// names are unique per prefix, so in practice this matches at most one
// key; matching by suffix rather than the full key saves the test from
// having to reconstruct r2.ObjectPrefix's exact prefix string by hand).
func (u *keyTrackingUploader) putsForSuffix(suffix string) int {
	u.mu.Lock()
	defer u.mu.Unlock()
	total := 0
	for k, n := range u.seen {
		if strings.HasSuffix(k, suffix) {
			total += n
		}
	}
	return total
}

// realSessionPipeline implements Pipeline (pipeline.go) around a real
// session.Session, fed by pushIDRFrame instead of a live RTP reader.
type realSessionPipeline struct {
	sess   *session.Session
	cancel context.CancelFunc
}

func newRealSessionPipelineFactory(writer *r2.Writer) PipelineFactory {
	return func(cfg PipelineConfig) (Pipeline, error) {
		r := ring.New(cfg.RingSegments, h264.ClockRate)
		partTicks := uint32(msToTicks(cfg.PartMs))
		segmentTicks := uint32(msToTicks(cfg.SegmentMs))
		sess := session.New(partTicks, segmentTicks, r, nil)
		if cfg.StartVideoSegmentIndex > 0 {
			sess.SetStartSegmentIndex(cfg.StartVideoSegmentIndex)
		}
		if writer != nil {
			sess.EnableR2(writer, cfg.ChannelID, cfg.StartedAtMs, "ll")
		}
		_, cancel := context.WithCancel(context.Background())
		return &realSessionPipeline{sess: sess, cancel: cancel}, nil
	}
}

func (p *realSessionPipeline) Health() PipelineHealth {
	h := p.sess.Health()
	ph := PipelineHealth{
		Subscribed:        h.Subscribed,
		PartsWritten:      h.PartsWritten,
		VideoSegmentIndex: p.sess.CurrentVideoSegmentIndex(),
		AudioSegmentIndex: p.sess.CurrentAudioSegmentIndex(),
	}
	if p.sess.HasPart() {
		ph.LastPartAt = p.sess.Started().Add(msDuration(h.LastPartAtMs))
	}
	if p.sess.HasIdr() {
		ph.LastIdrAt = p.sess.Started().Add(msDuration(h.LastIdrAtMs))
	}
	return ph
}

func (p *realSessionPipeline) ServeHTTP(w http.ResponseWriter, r *http.Request) { http.NotFound(w, r) }

func (p *realSessionPipeline) Close() { p.cancel(); p.sess.Close() }

// pushSPSPPS primes the fragmenter's init segment, at ts (the SAME
// timestamp the first real IDR frame that follows will carry -- matching
// how a real stream repeats SPS/PPS immediately ahead of the keyframe they
// describe, not at some earlier, unrelated timestamp). Using a mismatched
// ts here would make internal/h264's depacketizer discard this
// SPS/PPS-only access unit as an incomplete one abandoned mid-timestamp
// (it never carries a marker packet of its own) -- harmless (SPS/PPS
// still get attached to the next successfully flushed AU either way, see
// Depacketizer's own pendingSPS/pendingPPS) but a needless logged warning
// this helper exists to avoid.
func (p *realSessionPipeline) pushSPSPPS(ts uint32) {
	p.sess.HandleVideoPacket(videoPacket(singleNAL(7, realishSPS()[1:]), ts, false))
	p.sess.HandleVideoPacket(videoPacket(singleNAL(8, realishPPS()[1:]), ts, false))
}

// pushIDRFrames pushes n synthetic IDR frames (every frame an IDR, so
// every frame is a valid segment boundary), starting at startFrameIdx*step
// ticks -- mirrors internal/session's own test helpers' frameStep
// (3000 ticks, ~33ms at 90kHz).
func (p *realSessionPipeline) pushIDRFrames(startFrameIdx, n int, step uint32) {
	for i := 0; i < n; i++ {
		idx := startFrameIdx + i
		p.sess.HandleVideoPacket(videoPacket(singleNAL(5, []byte{0xAA, byte(idx)}), uint32(idx)*step, true))
	}
}

const restartTestFrameStep = 3000 // ~33ms at 90kHz, matches internal/session's own tests

// TestManagedSession_RestartNeverReusesR2Key is the "test with an
// in-memory S3 fake asserting no key is PUT twice across a restart" Farol's
// review asks for (PR #584). It drives managed_session.go's real restart()
// against two real session.Session-backed pipelines sharing one r2.Writer
// and one object prefix (same channelId/startedAt, exactly as a real
// restart keeps them): the first pipeline seals a couple of segments via
// ordinary rollover, restart() is invoked directly and deterministically,
// and the replacement pipeline seals a couple more. Without the fix
// (segment numbering NOT carried across the restart), the replacement
// would re-produce segments 0 and 1 and silently overwrite the first
// pipeline's already-uploaded objects at those same keys.
//
// This builds a ManagedSession directly (newManagedSession), WITHOUT going
// through Registry.StartOrGet and WITHOUT ever starting its watchdog
// goroutine: the real watchdog runs on WALL-CLOCK time
// (managed_session.go's watchdogTick, evaluateWatchdog's IDR-gap
// thresholds), while this test's synthetic frames advance an independent
// simulated RTP clock near-instantly -- letting the real watchdog run
// concurrently here would race its own restart/demote decisions against
// this test's deliberate, manual one for no reason relevant to what this
// test checks (R2 key continuity is orthogonal to the watchdog's own
// timing logic, which TestManagedSession_WatchdogRestartsThenDemotes_
// Integration already covers on its own).
func TestManagedSession_RestartNeverReusesR2Key(t *testing.T) {
	uploader := newKeyTrackingUploader()
	writer := r2.NewWriter(uploader, r2.WriterConfig{Workers: 4})
	defer writer.Close()

	// 500ms segments (matching internal/session's own proven test
	// parameters) so a handful of frames reliably rolls over more than
	// one segment.
	factory := newRealSessionPipelineFactory(writer)
	req := testStartReq(sessA, chanA, chanA)
	req.PartMs = 500
	req.SegmentMs = 500

	ms, err := newManagedSession(req, time.Now().UnixMilli(), GlobalConfig{}, fixedWatchdogCfg(), factory)
	if err != nil {
		t.Fatalf("unexpected error starting session: %v", err)
	}

	// 45000-tick segments (500ms) / 3000-tick frames = 15 frames per
	// rollover; a fragmenter only UPLOADS segment N once segment N+1 has
	// also started (internal/session.Session.publish's own sealing rule),
	// so 50 frames comfortably seals TWO segments (0 and 1) with a third
	// left open -- enough margin to prove real, sealed, uploaded objects
	// on both sides of the restart, not just an advanced index.
	const framesPerGeneration = 50

	p1 := ms.currentPipelineForTest().(*realSessionPipeline)
	p1.pushSPSPPS(0)
	p1.pushIDRFrames(0, framesPerGeneration, restartTestFrameStep)

	preRestartIndex := p1.sess.CurrentVideoSegmentIndex()
	if preRestartIndex < 2 {
		t.Fatalf("expected the first pipeline to have rolled over at least two segments before the simulated restart, got index %d", preRestartIndex)
	}

	// Simulate the watchdog detecting a stall and restarting: call the
	// real restart() directly, deterministically, rather than waiting on
	// real-time ticks.
	ms.restart()

	p2 := ms.currentPipelineForTest().(*realSessionPipeline)
	if p2 == p1 {
		t.Fatal("expected restart to build a new pipeline instance")
	}
	if got := p2.sess.CurrentVideoSegmentIndex(); got != preRestartIndex+1 {
		t.Fatalf("expected the replacement pipeline to continue numbering at %d (old current %d, plus one), got %d", preRestartIndex+1, preRestartIndex, got)
	}
	p2.pushSPSPPS(framesPerGeneration * restartTestFrameStep)
	p2.pushIDRFrames(framesPerGeneration, framesPerGeneration, restartTestFrameStep)

	// video-seg-0 and video-seg-1 (p1, sealed via ordinary rollover) plus
	// video-seg-(preRestartIndex+1) and its successor (p2, same) -- four
	// distinct SEALED segment objects, proving both pipelines actually
	// produced and uploaded real content, not just advanced a counter.
	wantKeys := []string{
		"video-seg-0.m4s",
		"video-seg-1.m4s",
		fmt.Sprintf("video-seg-%d.m4s", preRestartIndex+1),
		fmt.Sprintf("video-seg-%d.m4s", preRestartIndex+2),
	}
	waitFor(t, 2*time.Second, func() bool {
		for _, want := range wantKeys {
			if uploader.putsForSuffix(want) == 0 {
				return false
			}
		}
		return true
	})

	if dups := uploader.duplicates(); len(dups) > 0 {
		t.Fatalf("expected no numbered R2 segment key to be PUT twice across a restart, got duplicate keys: %v", dups)
	}
}

// currentPipelineForTest exposes ManagedSession's private current field for
// this file's white-box test -- same package, deliberately not part of
// ManagedSession's real API (production code has no legitimate reason to
// reach around Health()/ServeHTTP()).
func (m *ManagedSession) currentPipelineForTest() Pipeline {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.current
}
