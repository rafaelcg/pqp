package aacenc

import (
	"context"
	"math"
	"os/exec"
	"testing"
	"time"
)

// requireFFmpeg skips the test when no ffmpeg binary is on PATH, rather
// than failing: this package's whole reason to exist is wrapping ffmpeg
// (see the package doc comment for why there is no pure-Go alternative),
// so a CI image without it should see a clear skip, not a red build for a
// missing system dependency the workflow is responsible for installing
// (see .github/workflows/pqp-remux.yml and the README's config table).
func requireFFmpeg(t *testing.T) {
	t.Helper()
	if _, err := exec.LookPath("ffmpeg"); err != nil {
		t.Skip("ffmpeg not found on PATH; skipping the real-subprocess test (see the README's config table for the runtime dependency)")
	}
}

// sineWavePCM synthesizes seconds of a 440Hz stereo tone as interleaved
// float32 PCM at Encoder's SampleRate/Channels, for feeding a real
// ffmpeg subprocess without needing a fixture file (unlike
// internal/audiomix, which decodes real Opus and so does need one; this
// package only encodes, and ffmpeg is a perfectly good source of PCM to
// re-encode from Go's own math.Sin).
func sineWavePCM(seconds float64) []float32 {
	n := int(seconds * SampleRate)
	out := make([]float32, n*Channels)
	for i := 0; i < n; i++ {
		v := float32(0.2 * math.Sin(2*math.Pi*440*float64(i)/SampleRate))
		out[i*Channels] = v
		out[i*Channels+1] = v
	}
	return out
}

func TestEncoderProducesFramesFromRealFFmpeg(t *testing.T) {
	requireFFmpeg(t)

	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()

	enc, err := New(ctx, Config{})
	if err != nil {
		t.Fatalf("New: %v", err)
	}

	pcm := sineWavePCM(1.0) // 1s @ 48kHz stereo -> ~46.9 AAC frames worth
	done := make(chan error, 1)
	go func() { done <- enc.WriteSamples(pcm) }()

	var frames []Frame
	timeout := time.After(15 * time.Second)
	closed := false
	for !closed {
		select {
		case f, ok := <-enc.Frames():
			if !ok {
				closed = true
				break
			}
			frames = append(frames, f)
			if len(frames) >= 20 {
				// Enough to assert on; stop reading before Close so we
				// also exercise Close() draining the rest.
				closed = true
			}
		case err := <-enc.Errs():
			t.Fatalf("encoder error: %v", err)
		case <-timeout:
			t.Fatal("timed out waiting for AAC frames")
		}
	}

	if err := <-done; err != nil {
		t.Fatalf("WriteSamples: %v", err)
	}
	if err := enc.Close(); err != nil {
		t.Fatalf("Close: %v", err)
	}

	if len(frames) == 0 {
		t.Fatal("got zero AAC frames from a 1s tone")
	}
	for i, f := range frames {
		if len(f.Data) == 0 {
			t.Fatalf("frame %d has zero-length payload", i)
		}
	}
}

func TestEncoderCloseIsIdempotent(t *testing.T) {
	requireFFmpeg(t)

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	enc, err := New(ctx, Config{})
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	if err := enc.Close(); err != nil {
		t.Fatalf("first Close: %v", err)
	}
	if err := enc.Close(); err != nil {
		t.Fatalf("second Close should be a no-op, got: %v", err)
	}
}
