package session

import (
	"bytes"
	"context"
	"fmt"
	"io"
	"os/exec"
	"sync"
	"testing"
	"time"

	"github.com/pion/opus/pkg/oggreader"
	"github.com/pion/rtp"

	"github.com/rafaelcg/pqp/tools/pqp-remux/internal/r2"
	"github.com/rafaelcg/pqp/tools/pqp-remux/internal/ring"
)

// requireFFmpeg skips the test when ffmpeg is not on PATH, matching
// internal/aacenc's own pattern: this test exercises the real AAC encoder
// subprocess end to end (and, to build its own test input, a real Opus
// encode too), and a CI image without ffmpeg should see a clear skip.
func requireFFmpeg(t *testing.T) {
	t.Helper()
	if _, err := exec.LookPath("ffmpeg"); err != nil {
		t.Skip("ffmpeg not found on PATH; skipping the real-audio-pipeline test")
	}
}

// opusTonePackets shells out to ffmpeg to encode a short 48kHz stereo
// sine tone as Ogg Opus (in memory, no fixture file — session's tests
// don't otherwise depend on ffmpeg for input, only for the AAC step, so
// generating the source here keeps that dependency explicit rather than
// reaching into another package's testdata), then unpacks it into raw
// Opus RTP-payload-shaped packets exactly like internal/audiomix's own
// test helper does.
func opusTonePackets(t *testing.T, seconds float64) [][]byte {
	t.Helper()
	cmd := exec.Command("ffmpeg",
		"-hide_banner", "-loglevel", "error", "-y",
		"-f", "lavfi", "-i", fmt.Sprintf("sine=frequency=440:sample_rate=48000:duration=%f", seconds),
		"-ac", "2", "-c:a", "libopus", "-b:a", "64k",
		"-frame_duration", "20", "-page_duration", "20000",
		"-f", "ogg", "pipe:1",
	)
	var out bytes.Buffer
	cmd.Stdout = &out
	if err := cmd.Run(); err != nil {
		t.Fatalf("encoding the test tone to Opus: %v", err)
	}

	ogg, _, err := oggreader.NewWith(bytes.NewReader(out.Bytes()))
	if err != nil {
		t.Fatalf("parsing ogg header: %v", err)
	}
	var packets [][]byte
	for {
		pkt, _, err := ogg.ParseNextPacket()
		if err == io.EOF {
			break
		}
		if err != nil {
			t.Fatalf("reading ogg packet: %v", err)
		}
		if bytes.HasPrefix(pkt, []byte("OpusTags")) {
			continue
		}
		packets = append(packets, append([]byte(nil), pkt...))
	}
	if len(packets) < 10 {
		t.Fatalf("expected at least 10 opus packets, got %d", len(packets))
	}
	return packets
}

// countingUploader is an in-memory r2.Uploader: it records every key it
// was asked to PUT, safe for concurrent use (the R2 writer's own worker
// goroutines call it).
type countingUploader struct {
	mu   sync.Mutex
	keys []string
}

func (u *countingUploader) PutObject(ctx context.Context, key string, body []byte, contentType string) error {
	u.mu.Lock()
	defer u.mu.Unlock()
	u.keys = append(u.keys, key)
	return nil
}

func (u *countingUploader) hasKeySuffix(suffix string) bool {
	u.mu.Lock()
	defer u.mu.Unlock()
	for _, k := range u.keys {
		if len(k) >= len(suffix) && k[len(k)-len(suffix):] == suffix {
			return true
		}
	}
	return false
}

func (u *countingUploader) keysSnapshot() []string {
	u.mu.Lock()
	defer u.mu.Unlock()
	return append([]string(nil), u.keys...)
}

func waitFor(t *testing.T, timeout time.Duration, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		if cond() {
			return
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatal("condition not met before timeout")
}

// TestSessionAudioPipelineEndToEnd exercises L1.3 and L1.4 together
// against real subprocesses (ffmpeg for both the Opus test source and the
// AAC encode) and an in-memory R2 fake: screen-share audio in one end,
// AAC-muxed CMAF fragments and R2 uploads out the other, with the video
// path never touched (no video packets are ever sent in this test, which
// is itself part of what it proves: audio does not depend on video being
// present).
func TestSessionAudioPipelineEndToEnd(t *testing.T) {
	requireFFmpeg(t)

	videoRing := ring.New(6, 90000) // required by New, unused by this test
	s := New(45000, 360000, videoRing, nil)

	uploader := &countingUploader{}
	writer := r2.NewWriter(uploader, r2.WriterConfig{Workers: 2})
	defer writer.Close()
	s.EnableR2(writer, "chan-1", 1_700_000_000_000, "ll")

	audioRing := ring.New(6, 48000)
	ctx, cancel := context.WithCancel(context.Background())
	// Shutdown order matters (see Session.Close's doc comment): cancel
	// the pacer first so it stops feeding the encoder, then Close the
	// encoder to drain whatever it already has. Deferred in reverse, so
	// this runs cancel() before s.Close() at the end of the test.
	defer s.Close()
	defer cancel()
	if err := s.EnableAudio(ctx, AudioConfig{Ring: audioRing, SegmentTicks: 4 * 48000}); err != nil {
		t.Fatalf("EnableAudio: %v", err)
	}

	// The audio init segment is built and enqueued synchronously inside
	// EnableAudio, before any packet ever arrives.
	if _, ok := audioRing.Init(); !ok {
		t.Fatal("expected the audio init segment to exist immediately after EnableAudio")
	}
	waitFor(t, 2*time.Second, func() bool { return uploader.hasKeySuffix("/audio-init.mp4") })

	packets := opusTonePackets(t, 6.0) // 6s: comfortably over one 4s segment target
	rtpTS := uint32(1000)
	for _, p := range packets {
		s.HandleAudioPacket(&rtp.Packet{Header: rtp.Header{Timestamp: rtpTS}, Payload: p})
		rtpTS += 960 // 20ms @ 48kHz
	}

	waitFor(t, 10*time.Second, func() bool { return s.Health().AudioPartsWritten > 0 })
	waitFor(t, 10*time.Second, func() bool {
		_, ok := audioRing.Segment(0)
		return ok
	})
	waitFor(t, 10*time.Second, func() bool { return uploader.hasKeySuffix("/audio-seg-0.m4s") })

	h := s.Health()
	if h.AudioBytesWritten == 0 {
		t.Fatal("expected AudioBytesWritten to reflect real AAC bytes")
	}
	if h.R2Uploaded == 0 {
		t.Fatalf("expected at least one successful R2 upload, got Health=%+v", h)
	}

	// The video path must be entirely unaffected: no video packet was
	// ever sent, so nothing should have published there.
	if h.PartsWritten != 0 || h.BytesWritten != 0 {
		t.Fatalf("audio-only traffic must not touch the video counters, got PartsWritten=%d BytesWritten=%d", h.PartsWritten, h.BytesWritten)
	}
}

// TestSessionCloseUploadsTheFinalOpenAudioSegment is the regression test
// for Farol's "final audio segment is never closed or uploaded" finding:
// with less audio than one segment target, the audio track never rolls
// over on its own (uploadAudioSegment is only ever called from
// readEncoderFrames's roll-over branch before this fix), so the whole
// party's audio would be silently missing from R2 unless the session
// ending is itself treated as closing that last segment -- exactly what
// Session.Close now does.
func TestSessionCloseUploadsTheFinalOpenAudioSegment(t *testing.T) {
	requireFFmpeg(t)

	s := New(45000, 360000, ring.New(6, 90000), nil)

	uploader := &countingUploader{}
	writer := r2.NewWriter(uploader, r2.WriterConfig{Workers: 2})
	s.EnableR2(writer, "chan-1", 1_700_000_000_001, "ll")

	audioRing := ring.New(6, 48000)
	ctx, cancel := context.WithCancel(context.Background())
	if err := s.EnableAudio(ctx, AudioConfig{Ring: audioRing, SegmentTicks: 4 * 48000}); err != nil {
		t.Fatalf("EnableAudio: %v", err)
	}

	packets := opusTonePackets(t, 1.0) // well under the 4s segment target: no natural roll-over will ever happen
	rtpTS := uint32(1000)
	for _, p := range packets {
		s.HandleAudioPacket(&rtp.Packet{Header: rtp.Header{Timestamp: rtpTS}, Payload: p})
		rtpTS += 960
	}

	waitFor(t, 5*time.Second, func() bool { return s.Health().AudioPartsWritten > 0 })

	if uploader.hasKeySuffix("/audio-seg-0.m4s") {
		t.Fatal("segment 0 must not be uploaded before the session ends: it has not rolled over and is not yet closed")
	}

	// Shutdown order matters, as everywhere else in this package: cancel
	// before Close.
	cancel()
	s.Close()
	writer.Close()

	if _, ok := audioRing.Segment(0); !ok {
		t.Fatal("expected segment 0 to exist in the audio ring after Close")
	}
	if !uploader.hasKeySuffix("/audio-seg-0.m4s") {
		t.Fatalf("expected Close to upload the final (never-rolled-over) audio segment; got keys: %v", uploader.keysSnapshot())
	}
}

// TestSessionMicSinkAddsAndRemovesFromTheMix proves a second stage source
// (a participant's microphone, as opposed to the screen-share audio slot)
// can be added and cleanly removed without requiring EnableAudio's full
// ffmpeg round trip — this only needs the mixer wiring, which is why it
// does not call requireFFmpeg. NewMicSink before EnableAudio is exercised
// too, since main.go's real wiring order (subscriber tracks can be found
// before or after EnableAudio's own call, in principle) must not panic
// either way.
func TestSessionMicSinkAddsAndRemovesFromTheMix(t *testing.T) {
	s := New(45000, 360000, ring.New(6, 90000), nil)

	// Before EnableAudio: must be a harmless no-op, not a nil pointer
	// panic.
	sink := s.NewMicSink("alice")
	sink.HandlePacket(&rtp.Packet{Header: rtp.Header{Timestamp: 1000}, Payload: []byte{0xF8, 0xFF, 0xFE}})
	sink.Close()
}

func TestFramesElapsedNoDriftOverManyTicks(t *testing.T) {
	// Simulate 30 minutes of a 10ms pacer tick, and check that the
	// cumulative frame count implied by wall-clock elapsed time never
	// diverges from frames*duration by more than one frame's worth: this
	// is the property docs/plans/LL_HLS.md's L1.3 acceptance bar ("sync
	// drift stays under 40ms over 30 minutes") rests on at the pacing
	// layer. aacenc.SamplesPerFrame/audiomix.SampleRate are duplicated as
	// literals here (1024, 48000) so this test does not silently stop
	// testing anything if those constants ever change without updating
	// the expectation math below.
	const sampleRate = 48000
	const frameSamples = 1024
	const tick = 10 * time.Millisecond
	const totalDuration = 30 * time.Minute

	emitted := 0
	var elapsed time.Duration
	for elapsed = 0; elapsed < totalDuration; elapsed += tick {
		n := framesElapsed(elapsed, frameSamples, emitted)
		emitted += n

		wantFrames := int(elapsed.Seconds() * sampleRate / frameSamples)
		diff := emitted - wantFrames
		if diff < 0 {
			diff = -diff
		}
		if diff > 1 {
			t.Fatalf("at elapsed=%v: emitted=%d, want within 1 of %d (diff=%d)", elapsed, emitted, wantFrames, diff)
		}
	}
}

func TestFramesElapsedNeverGoesBackward(t *testing.T) {
	// A tick calling framesElapsed with an elapsed duration that has not
	// advanced enough for a new frame yet must return 0, never a negative
	// count (which would mean "un-emit" a frame).
	if n := framesElapsed(5*time.Millisecond, 1024, 0); n != 0 {
		t.Fatalf("framesElapsed(5ms, ...) = %d, want 0 (under one 21.3ms frame)", n)
	}
	if n := framesElapsed(100*time.Millisecond, 1024, 100); n != 0 {
		t.Fatalf("framesElapsed should never go negative: got %d", n)
	}
}

func TestFramesElapsedCatchesUpAfterADelayedTick(t *testing.T) {
	// A tick that fires late (e.g. the goroutine was descheduled) must
	// catch up in one call rather than drip-feeding one frame per
	// subsequent tick -- this is the whole point of deriving the target
	// from wall-clock elapsed time instead of counting ticks.
	n := framesElapsed(210*time.Millisecond, 1024, 0) // ~9.84 frames worth
	if n < 8 || n > 10 {
		t.Fatalf("framesElapsed(210ms, 1024, 0) = %d, want approximately 9", n)
	}
}
