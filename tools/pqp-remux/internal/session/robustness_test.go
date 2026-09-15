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

	if err := s.EnableAudio(ctx, AudioConfig{Ring: ring.New(6, 48000), PartTicks: 24000, SegmentTicks: 4 * 48000}); err != nil {
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

// TestSession_CloseDuringInFlightRestartNeverLeaksTheReplacementEncoder
// is the regression test for the shutdown race Farol found in
// commit 2a19abd1: Session.Close and a WriteSamples-triggered restart in
// recoverAudioEncoder could run concurrently, and Close could close the
// OLD (already-failed) encoder while the restart went on to install a
// brand new one that nothing would ever close again -- a replacement
// ffmpeg outliving the session. audioMu (held for recoverAudioEncoder's
// entire body, including the newEncoderFunc call) fixes this: Close
// either completes before a restart ever begins, or blocks on audioMu
// until the in-flight restart finishes and then closes whatever encoder
// that restart left as current.
//
// This test forces the second interleaving deterministically: the first
// (always-failing) encoder triggers a restart, whose newEncoderFunc call
// is held open until the test has started Close() concurrently and given
// it time to actually reach (and block on) audioMu.
func TestSession_CloseDuringInFlightRestartNeverLeaksTheReplacementEncoder(t *testing.T) {
	var mu sync.Mutex
	var built []*fakeEncoder
	proceedWithRestart := make(chan struct{})
	firstEncoderBuilt := make(chan struct{})
	secondEncoderConstructing := make(chan struct{})

	withFakeEncoderFactory(t, func(ctx context.Context, cfg aacenc.Config) (remuxEncoder, error) {
		mu.Lock()
		idx := len(built)
		fe := newFakeEncoder()
		if idx == 0 {
			fe.writeErr = errors.New("broken pipe") // always fails: forces exactly one restart attempt
		}
		built = append(built, fe)
		mu.Unlock()

		switch idx {
		case 0:
			close(firstEncoderBuilt)
		case 1:
			close(secondEncoderConstructing)
			<-proceedWithRestart // hold the restart open until the test says go
		}
		return fe, nil
	})

	s := New(45000, 360000, ring.New(6, 90000), nil)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	if err := s.EnableAudio(ctx, AudioConfig{Ring: ring.New(6, 48000), PartTicks: 24000, SegmentTicks: 4 * 48000}); err != nil {
		t.Fatalf("EnableAudio: %v", err)
	}

	<-firstEncoderBuilt
	select {
	case <-secondEncoderConstructing:
	case <-time.After(2 * time.Second):
		t.Fatal("recoverAudioEncoder never attempted a restart after the write failure")
	}

	// Close races the in-flight restart: it must block on audioMu (held
	// by recoverAudioEncoder) rather than closing the old encoder while
	// the restart is still deciding what the new current one will be.
	closeDone := make(chan struct{})
	go func() {
		s.Close()
		close(closeDone)
	}()

	select {
	case <-closeDone:
		t.Fatal("Close returned before the in-flight restart finished -- it did not wait on audioMu")
	case <-time.After(150 * time.Millisecond):
	}

	close(proceedWithRestart) // let recoverAudioEncoder's newEncoderFunc call return

	select {
	case <-closeDone:
	case <-time.After(3 * time.Second):
		t.Fatal("Close did not return after the restart finished -- a replacement encoder may be stuck outliving the session")
	}

	mu.Lock()
	defer mu.Unlock()
	if len(built) != 2 {
		t.Fatalf("expected exactly 2 encoders built, got %d", len(built))
	}
	for i, fe := range built {
		fe.mu.Lock()
		closed := fe.closed
		fe.mu.Unlock()
		if !closed {
			t.Fatalf("encoder %d was never closed: it can outlive the session", i)
		}
	}
}

// TestSession_RestartRejectedOnceSessionIsAlreadyClosed covers the other
// interleaving: Close runs to completion (setting audioClosed) BEFORE a
// pending restart ever gets to run. recoverAudioEncoder must see
// audioClosed and refuse to spawn a replacement at all, rather than
// starting a new encoder for a session that has already shut down.
func TestSession_RestartRejectedOnceSessionIsAlreadyClosed(t *testing.T) {
	s := New(45000, 360000, ring.New(6, 90000), nil)
	s.audioClosed = true // simulate Close() having already run
	s.audioReaderDone = nil

	var restarted bool
	ok := s.recoverAudioEncoder(context.Background(), AudioConfig{}, &restarted)
	if ok {
		t.Fatal("recoverAudioEncoder must refuse to restart once the session is closed")
	}
	if restarted {
		t.Fatal("the restart flag must not be consumed by a rejected restart")
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

	if err := s.EnableAudio(ctx, AudioConfig{Ring: ring.New(6, 48000), PartTicks: 24000, SegmentTicks: 4 * 48000}); err != nil {
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

// TestSession_UnexpectedEncoderErrorTripsRecovery is the session-level
// regression test for Farol's "unexpected ffmpeg exit is exposed as
// clean audio completion" finding: an error arriving on Errs() (the
// shape aacenc.Encoder's readADTS produces for a crash or an unrequested
// exit) must trip the same recoverAudioEncoder path a WriteSamples
// failure does -- one restart attempt, then AudioDead if that also
// fails -- rather than the audio track just going quiet while nothing
// downstream (Session.Health included) ever notices.
func TestSession_UnexpectedEncoderErrorTripsRecovery(t *testing.T) {
	var mu sync.Mutex
	var built []*fakeEncoder
	withFakeEncoderFactory(t, func(ctx context.Context, cfg aacenc.Config) (remuxEncoder, error) {
		mu.Lock()
		fe := newFakeEncoder()
		built = append(built, fe)
		idx := len(built) - 1
		mu.Unlock()

		if idx == 0 {
			// Mirror aacenc.readADTS's own shape for an unexpected exit:
			// an error on Errs(), then Frames() closes.
			go func() {
				time.Sleep(20 * time.Millisecond)
				fe.errs <- errors.New("ffmpeg exited unexpectedly")
				fe.Close()
			}()
		}
		return fe, nil
	})

	s := New(45000, 360000, ring.New(6, 90000), nil)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	defer s.Close()

	if err := s.EnableAudio(ctx, AudioConfig{Ring: ring.New(6, 48000), PartTicks: 24000, SegmentTicks: 4 * 48000}); err != nil {
		t.Fatalf("EnableAudio: %v", err)
	}

	waitFor(t, 3*time.Second, func() bool { return s.Health().AudioRestarts == 1 })

	mu.Lock()
	n := len(built)
	mu.Unlock()
	if n != 2 {
		t.Fatalf("expected exactly 2 encoders (the crashed one + one restart), got %d", n)
	}
	time.Sleep(100 * time.Millisecond)
	if s.Health().AudioDead {
		t.Fatal("audio should not be dead: the replacement encoder never fails")
	}
}

// --- Farol finding 3: reading Errs() without an ok check can busy-loop
// or exit prematurely. ---

func TestReadEncoderFrames_ExitsCleanlyWhenFramesClosesWithErrsOpenAndEmpty(t *testing.T) {
	s := New(45000, 360000, ring.New(6, 90000), nil)
	s.audioFrag = pipeline.NewAudioFragmenter(pipeline.AudioConfig{Timescale: 48000, PartDuration: 1024, SegmentDuration: 4 * 48000}) // one frame per part: this test is about frame DELIVERY, not part sizing
	s.audioRing = ring.New(6, 48000)
	s.audioRing.SetInit([]byte("init"))

	fe := newFakeEncoder()
	done := make(chan struct{})
	failed := make(chan struct{})
	finished := make(chan struct{})
	go func() {
		s.readEncoderFrames(fe, done, failed)
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
	s.audioFrag = pipeline.NewAudioFragmenter(pipeline.AudioConfig{Timescale: 48000, PartDuration: 1024, SegmentDuration: 4 * 48000}) // one frame per part: this test is about frame DELIVERY, not part sizing
	s.audioRing = ring.New(6, 48000)
	s.audioRing.SetInit([]byte("init"))

	fe := newFakeEncoder()
	done := make(chan struct{})
	failed := make(chan struct{})
	finished := make(chan struct{})
	go func() {
		s.readEncoderFrames(fe, done, failed)
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

// --- PART_MS batching (the 2026-09-15 audio-parts incident) ---

// TestSession_CloseFlushesThePartStillAccumulating is the session-level
// half of the PART_MS fix. Once audio parts batch frames to a target,
// up to PART_MS of already-encoded audio lives inside the fragmenter at
// any instant; a session that ends without draining it silently drops
// that tail, and for a party shorter than one part target it would drop
// the audio track entirely.
func TestSession_CloseFlushesThePartStillAccumulating(t *testing.T) {
	var mu sync.Mutex
	var built []*fakeEncoder
	withFakeEncoderFactory(t, func(ctx context.Context, cfg aacenc.Config) (remuxEncoder, error) {
		mu.Lock()
		defer mu.Unlock()
		fe := newFakeEncoder()
		built = append(built, fe)
		return fe, nil
	})

	s := New(45000, 360000, ring.New(6, 90000), nil)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	audioRing := ring.New(6, 48000)
	// 500ms parts at 48kHz: three 1024-sample frames is ~64ms, nowhere
	// near closing one.
	if err := s.EnableAudio(ctx, AudioConfig{Ring: audioRing, PartTicks: 24000, SegmentTicks: 4 * 48000}); err != nil {
		t.Fatalf("EnableAudio: %v", err)
	}

	mu.Lock()
	fe := built[0]
	mu.Unlock()

	for i := 0; i < 3; i++ {
		fe.frames <- aacenc.Frame{Data: []byte{byte(i), 0x21}}
	}
	waitFor(t, 2*time.Second, func() bool { return s.audioNextPTS.Load() == 3*aacenc.SamplesPerFrame })

	if got := s.audioPartsWritten.Load(); got != 0 {
		t.Fatalf("audioPartsWritten = %d after 64ms of audio at a 500ms part target, want 0 (a part per frame is the bug)", got)
	}

	cancel()
	s.Close()

	if got := s.audioPartsWritten.Load(); got != 1 {
		t.Fatalf("audioPartsWritten = %d after Close, want 1: the pending part was never flushed", got)
	}
	if _, ok := audioRing.Segment(0); !ok {
		t.Fatal("the flushed part never reached the audio ring")
	}
}

// TestSession_CloseDoesNotTouchTheFragmenterAfterADrainTimeout is Farol's
// finding on PR #623. Close waits a BOUNDED time for the audio reader to
// drain, then carries on -- and the flush the PART_MS batching added is
// only safe once that reader has actually returned, because
// AudioFragmenter is explicitly not safe for concurrent use. On the
// timeout branch the reader may still be inside Push, so Close must
// leave the fragmenter alone entirely. Run under -race, this is the test
// that would report the race the finding describes.
func TestSession_CloseDoesNotTouchTheFragmenterAfterADrainTimeout(t *testing.T) {
	origDeadline := audioCloseFlushDeadline
	audioCloseFlushDeadline = 50 * time.Millisecond
	t.Cleanup(func() { audioCloseFlushDeadline = origDeadline })

	var mu sync.Mutex
	var built []*fakeEncoder
	withFakeEncoderFactory(t, func(ctx context.Context, cfg aacenc.Config) (remuxEncoder, error) {
		mu.Lock()
		defer mu.Unlock()
		// Close() that does NOT close Frames(): the reader goroutine
		// stays blocked, which is exactly the stuck-downstream case the
		// deadline exists for.
		fe := newFakeEncoder()
		fe.closed = true
		built = append(built, fe)
		return fe, nil
	})

	s := New(45000, 360000, ring.New(6, 90000), nil)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	audioRing := ring.New(6, 48000)
	if err := s.EnableAudio(ctx, AudioConfig{Ring: audioRing, PartTicks: 24000, SegmentTicks: 4 * 48000}); err != nil {
		t.Fatalf("EnableAudio: %v", err)
	}

	mu.Lock()
	fe := built[0]
	mu.Unlock()

	// Two frames in, sitting inside the fragmenter's open part.
	for i := 0; i < 2; i++ {
		fe.frames <- aacenc.Frame{Data: []byte{byte(i), 0x21}}
	}
	waitFor(t, 2*time.Second, func() bool { return s.audioNextPTS.Load() == 2*aacenc.SamplesPerFrame })

	cancel()
	s.Close() // times out waiting for the reader, which is still parked on Frames()

	if got := s.audioPartsWritten.Load(); got != 0 {
		t.Fatalf("audioPartsWritten = %d: Close flushed the fragmenter while the reader could still be pushing into it", got)
	}

	// Let the reader out so the goroutine does not outlive the test.
	fe.mu.Lock()
	close(fe.frames)
	fe.mu.Unlock()
}
