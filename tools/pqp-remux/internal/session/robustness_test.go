package session

import (
	"context"
	"errors"
	"fmt"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/rafaelcg/pqp/tools/pqp-remux/internal/aacenc"
	"github.com/rafaelcg/pqp/tools/pqp-remux/internal/pipeline"
	"github.com/rafaelcg/pqp/tools/pqp-remux/internal/r2"
	"github.com/rafaelcg/pqp/tools/pqp-remux/internal/ring"
)

// --- Farol finding 1: a PCM write failure must not silently leave the
// audio pipeline dead-but-reporting-alive. ---

// fakeEncoder is a remuxEncoder that never touches ffmpeg: WriteSamples
// can be told to always fail, and Frames()/Errs() are driven directly by
// the test, so the pacer/reader/restart machinery in session.go is
// exercised without a real subprocess.
type fakeEncoder struct {
	mu       sync.Mutex
	writeErr error
	writes   int
	closed   bool

	frames chan aacenc.Frame
	errs   chan error
}

func newFakeEncoder() *fakeEncoder {
	return &fakeEncoder{frames: make(chan aacenc.Frame), errs: make(chan error)}
}

func (f *fakeEncoder) WriteSamples(pcm []float32) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.writes++
	return f.writeErr
}

func (f *fakeEncoder) Frames() <-chan aacenc.Frame { return f.frames }
func (f *fakeEncoder) Errs() <-chan error          { return f.errs }

func (f *fakeEncoder) Close() error {
	f.mu.Lock()
	defer f.mu.Unlock()
	if !f.closed {
		f.closed = true
		close(f.frames)
	}
	return nil
}

// withFakeEncoderFactory swaps newEncoderFunc for the duration of t,
// restoring the real one (aacenc.New) afterward so no other test in this
// package is affected.
func withFakeEncoderFactory(t *testing.T, factory func(ctx context.Context, cfg aacenc.Config) (remuxEncoder, error)) {
	t.Helper()
	orig := newEncoderFunc
	newEncoderFunc = factory
	t.Cleanup(func() { newEncoderFunc = orig })
}

func TestSession_AudioEncoderWriteFailureRestartsOnceThenMarksDead(t *testing.T) {
	var mu sync.Mutex
	var built []*fakeEncoder
	withFakeEncoderFactory(t, func(ctx context.Context, cfg aacenc.Config) (remuxEncoder, error) {
		mu.Lock()
		defer mu.Unlock()
		fe := newFakeEncoder()
		fe.writeErr = errors.New("broken pipe")
		built = append(built, fe)
		return fe, nil
	})

	s := New(45000, 360000, ring.New(6, 90000), nil)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	defer s.Close()

	if err := s.EnableAudio(ctx, AudioConfig{Ring: ring.New(6, 48000), SegmentTicks: 4 * 48000}); err != nil {
		t.Fatalf("EnableAudio: %v", err)
	}

	waitFor(t, 3*time.Second, func() bool { return s.Health().AudioDead })

	h := s.Health()
	if h.AudioRestarts != 1 {
		t.Fatalf("AudioRestarts = %d, want exactly 1 (one allowed restart, then give up)", h.AudioRestarts)
	}

	mu.Lock()
	n := len(built)
	mu.Unlock()
	if n != 2 {
		t.Fatalf("expected exactly 2 encoders constructed (initial + one restart), got %d", n)
	}
	for i, fe := range built {
		fe.mu.Lock()
		writes := fe.writes
		closed := fe.closed
		fe.mu.Unlock()
		if writes == 0 {
			t.Fatalf("encoder %d was never written to", i)
		}
		if !closed {
			t.Fatalf("encoder %d was never closed", i)
		}
	}
}

func TestSession_AudioEncoderRecoversFromATransientFailure(t *testing.T) {
	// The FIRST encoder fails once then works; this proves a restart
	// gets the pipeline back to healthy rather than always marking it
	// dead regardless of whether the replacement actually works.
	var mu sync.Mutex
	var built []*fakeEncoder
	withFakeEncoderFactory(t, func(ctx context.Context, cfg aacenc.Config) (remuxEncoder, error) {
		mu.Lock()
		defer mu.Unlock()
		fe := newFakeEncoder()
		if len(built) == 0 {
			fe.writeErr = errors.New("broken pipe")
		}
		built = append(built, fe)
		return fe, nil
	})

	s := New(45000, 360000, ring.New(6, 90000), nil)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	defer s.Close()

	if err := s.EnableAudio(ctx, AudioConfig{Ring: ring.New(6, 48000), SegmentTicks: 4 * 48000}); err != nil {
		t.Fatalf("EnableAudio: %v", err)
	}

	waitFor(t, 3*time.Second, func() bool { return s.Health().AudioRestarts == 1 })

	// Give the pacer a little longer to keep ticking against the healthy
	// second encoder, then confirm it never gave up.
	time.Sleep(100 * time.Millisecond)
	if s.Health().AudioDead {
		t.Fatal("audio pipeline should not be dead: the restarted encoder never fails")
	}

	mu.Lock()
	secondWrites := 0
	if len(built) == 2 {
		built[1].mu.Lock()
		secondWrites = built[1].writes
		built[1].mu.Unlock()
	}
	mu.Unlock()
	if secondWrites == 0 {
		t.Fatal("expected the restarted (healthy) encoder to receive writes")
	}
}

// --- Farol finding 3: reading Errs() without an ok check can busy-loop
// or exit prematurely. ---

func TestReadEncoderFrames_ExitsCleanlyWhenFramesClosesWithErrsOpenAndEmpty(t *testing.T) {
	s := New(45000, 360000, ring.New(6, 90000), nil)
	s.audioFrag = pipeline.NewAudioFragmenter(pipeline.AudioConfig{Timescale: 48000, SegmentDuration: 4 * 48000})
	s.audioRing = ring.New(6, 48000)
	s.audioRing.SetInit([]byte("init"))

	fe := newFakeEncoder()
	done := make(chan struct{})
	finished := make(chan struct{})
	go func() {
		s.readEncoderFrames(fe, done)
		close(finished)
	}()

	close(fe.frames) // the only definitive shutdown signal; Errs() is left open and empty

	select {
	case <-finished:
	case <-time.After(2 * time.Second):
		t.Fatal("readEncoderFrames did not return after Frames() closed")
	}
	select {
	case <-done:
	default:
		t.Fatal("readEncoderFrames returned without closing its done channel")
	}
}

func TestReadEncoderFrames_KeepsDeliveringFramesAfterErrsCloses(t *testing.T) {
	s := New(45000, 360000, ring.New(6, 90000), nil)
	s.audioFrag = pipeline.NewAudioFragmenter(pipeline.AudioConfig{Timescale: 48000, SegmentDuration: 4 * 48000})
	s.audioRing = ring.New(6, 48000)
	s.audioRing.SetInit([]byte("init"))

	fe := newFakeEncoder()
	done := make(chan struct{})
	finished := make(chan struct{})
	go func() {
		s.readEncoderFrames(fe, done)
		close(finished)
	}()

	close(fe.errs) // Errs() closes first, having never sent anything

	// Frames() must still be drained correctly afterward: no spurious
	// "AAC encode: <nil>" busy loop starving this select.
	fe.frames <- aacenc.Frame{Data: []byte{1, 2, 3}}
	fe.frames <- aacenc.Frame{Data: []byte{4, 5, 6}}

	waitFor(t, 2*time.Second, func() bool { return s.audioPartsWritten.Load() == 2 })

	close(fe.frames)
	select {
	case <-finished:
	case <-time.After(2 * time.Second):
		t.Fatal("readEncoderFrames did not return after Frames() closed")
	}
}

// --- Farol finding 2: an R2 upload must never happen before the ring has
// actually sealed the segment it names. ---

type recordingUploader struct {
	mu             sync.Mutex
	ring           *ring.Ring
	puts           []string
	sealViolations []string
}

func (u *recordingUploader) PutObject(ctx context.Context, key string, body []byte, contentType string) error {
	u.mu.Lock()
	defer u.mu.Unlock()
	u.puts = append(u.puts, key)
	if idx, ok := parseSegIndex(key, "video-seg-"); ok {
		playlist := u.ring.Playlist()
		want := fmt.Sprintf("seg-%d.m4s\n", idx)
		if !strings.Contains(playlist, want) {
			u.sealViolations = append(u.sealViolations, key)
		}
	}
	return nil
}

func parseSegIndex(key, prefix string) (int, bool) {
	i := strings.Index(key, prefix)
	if i < 0 {
		return 0, false
	}
	rest := strings.TrimSuffix(key[i+len(prefix):], ".m4s")
	n, err := strconv.Atoi(rest)
	if err != nil {
		return 0, false
	}
	return n, true
}

func TestSession_R2UploadHappensOnlyAfterSegmentSeals(t *testing.T) {
	r := ring.New(6, 90000)
	const segTicks = 45000 // 500ms, same as the part target, for a fast test
	s := New(45000, segTicks, r, nil)

	uploader := &recordingUploader{ring: r}
	writer := r2.NewWriter(uploader, r2.WriterConfig{Workers: 4})
	defer writer.Close()
	s.EnableR2(writer, "chan-1", 1000, "ll")

	s.HandleVideoPacket(videoPacket(singleNAL(7, realishSPS()[1:]), 0, false))
	s.HandleVideoPacket(videoPacket(singleNAL(8, realishPPS()[1:]), 0, false))

	// Every frame an IDR, frameStep (3000 ticks, ~33ms) apart: crosses the
	// 45000-tick segment target repeatedly, forcing several rollovers.
	frameIdx := int64(0)
	const numFrames = 90
	for i := 0; i < numFrames; i++ {
		s.HandleVideoPacket(videoPacket(singleNAL(5, []byte{0xAA, byte(i)}), uint32(frameIdx*frameStep), true))
		frameIdx++
	}

	waitFor(t, 2*time.Second, func() bool {
		uploader.mu.Lock()
		defer uploader.mu.Unlock()
		return len(uploader.puts) >= 3
	})

	uploader.mu.Lock()
	defer uploader.mu.Unlock()

	if len(uploader.sealViolations) > 0 {
		t.Fatalf("uploaded before the ring sealed the segment: %v", uploader.sealViolations)
	}
	counts := map[string]int{}
	for _, k := range uploader.puts {
		counts[k]++
	}
	segUploads := 0
	for k, c := range counts {
		if _, ok := parseSegIndex(k, "video-seg-"); ok {
			segUploads++
			if c != 1 {
				t.Fatalf("key %s uploaded %d times, want exactly 1", k, c)
			}
		}
	}
	if segUploads < 2 {
		t.Fatalf("expected at least 2 distinct sealed segments uploaded, got %d (%v)", segUploads, uploader.puts)
	}
}
