package r2

import (
	"context"
	"fmt"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

// fakeUploader is an in-memory Uploader: every PutObject call is recorded,
// and failFirstN calls (per key) return an error before succeeding, so
// tests can exercise retry without a network call.
type fakeUploader struct {
	mu       sync.Mutex
	puts     []fakePut
	failN    map[string]int // key -> remaining failures before success
	attempts map[string]int
	blockCh  chan struct{} // if non-nil, PutObject waits on it before returning
	// delay, if non-zero, makes every PutObject take that long -- a slow
	// bucket, which is what the latency counters exist to make visible.
	delay time.Duration
}

type fakePut struct {
	key         string
	body        []byte
	contentType string
}

func newFakeUploader() *fakeUploader {
	return &fakeUploader{failN: make(map[string]int), attempts: make(map[string]int)}
}

func (f *fakeUploader) PutObject(ctx context.Context, key string, body []byte, contentType string) error {
	f.mu.Lock()
	f.attempts[key]++
	f.mu.Unlock()

	if f.delay > 0 {
		select {
		case <-time.After(f.delay):
		case <-ctx.Done():
			return ctx.Err()
		}
	}

	if f.blockCh != nil {
		select {
		case <-f.blockCh:
		case <-ctx.Done():
			// A real HTTP client aborts an in-flight request when its
			// context is cancelled; this fake mirrors that so
			// writer.go's Close-deadline cancellation can actually be
			// tested without the fake itself hanging forever.
			return ctx.Err()
		}
	}

	f.mu.Lock()
	defer f.mu.Unlock()
	if n := f.failN[key]; n > 0 {
		f.failN[key] = n - 1
		return fmt.Errorf("fake upload failure for %s (%d remaining)", key, n)
	}
	cp := append([]byte(nil), body...)
	f.puts = append(f.puts, fakePut{key: key, body: cp, contentType: contentType})
	return nil
}

func (f *fakeUploader) putsFor(key string) int {
	f.mu.Lock()
	defer f.mu.Unlock()
	n := 0
	for _, p := range f.puts {
		if p.key == key {
			n++
		}
	}
	return n
}

func (f *fakeUploader) attemptsFor(key string) int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.attempts[key]
}

// attemptsForAny sums attempts across every key, for a test that only
// cares whether *some* number of workers have started (e.g. are now
// blocked mid-PUT), not which specific keys.
func (f *fakeUploader) attemptsForAny() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	total := 0
	for _, n := range f.attempts {
		total += n
	}
	return total
}

func waitForCondition(t *testing.T, timeout time.Duration, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		if cond() {
			return
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatal("condition not met before timeout")
}

func TestWriterUploadsSuccessfully(t *testing.T) {
	up := newFakeUploader()
	w := NewWriter(up, WriterConfig{Workers: 1})
	defer w.Close()

	w.Enqueue("live/chan1/1000-ll/init.mp4", []byte("hello"), "video/mp4")

	waitForCondition(t, 2*time.Second, func() bool { return up.putsFor("live/chan1/1000-ll/init.mp4") == 1 })
	if w.Uploaded() != 1 {
		t.Fatalf("Uploaded() = %d, want 1", w.Uploaded())
	}
	if w.Failed() != 0 {
		t.Fatalf("Failed() = %d, want 0", w.Failed())
	}
}

func TestWriterRetriesTransientFailure(t *testing.T) {
	up := newFakeUploader()
	up.failN["seg-0.m4s"] = 2 // fails twice, succeeds on the 3rd attempt

	w := NewWriter(up, WriterConfig{Workers: 1, MaxRetries: 3})
	defer w.Close()

	w.Enqueue("seg-0.m4s", []byte("data"), "video/mp4")

	waitForCondition(t, 3*time.Second, func() bool { return up.putsFor("seg-0.m4s") == 1 })
	if got := up.attemptsFor("seg-0.m4s"); got != 3 {
		t.Fatalf("attempts = %d, want 3 (2 failures + 1 success)", got)
	}
	if w.Failed() != 0 {
		t.Fatalf("Failed() = %d, want 0 (it eventually succeeded)", w.Failed())
	}
	if w.Uploaded() != 1 {
		t.Fatalf("Uploaded() = %d, want 1", w.Uploaded())
	}
}

func TestWriterGivesUpAfterMaxRetries(t *testing.T) {
	up := newFakeUploader()
	up.failN["seg-1.m4s"] = 100 // never succeeds

	w := NewWriter(up, WriterConfig{Workers: 1, MaxRetries: 2})
	defer w.Close()

	w.Enqueue("seg-1.m4s", []byte("data"), "video/mp4")

	waitForCondition(t, 3*time.Second, func() bool { return w.Failed() == 1 })
	if got := up.attemptsFor("seg-1.m4s"); got != 3 { // 1 + MaxRetries
		t.Fatalf("attempts = %d, want 3 (1 + MaxRetries)", got)
	}
	if up.putsFor("seg-1.m4s") != 0 {
		t.Fatal("expected the upload to never actually succeed")
	}
}

// TestWriterHonorsExplicitZeroMaxRetries pins WriterConfig.MaxRetries's own
// doc comment (Farol review, PR #584): zero is a distinct, legitimate
// "never retry" choice, not an unset field that should silently fall back
// to DefaultMaxRetries the way QueueDepth/Workers's own zero values do.
// Before this fix, MaxRetries: 0 here would have retried DefaultMaxRetries
// (3) times instead of the 0 the caller asked for -- exactly the "operator
// sets a value, the value is silently ignored" shape control.LoadGlobalConfig
// exists to refuse at config-load time, so the writer itself must actually
// honor the value that validation lets through.
func TestWriterHonorsExplicitZeroMaxRetries(t *testing.T) {
	up := newFakeUploader()
	up.failN["seg-2.m4s"] = 100 // never succeeds

	w := NewWriter(up, WriterConfig{Workers: 1, MaxRetries: 0})
	defer w.Close()

	w.Enqueue("seg-2.m4s", []byte("data"), "video/mp4")

	waitForCondition(t, 3*time.Second, func() bool { return w.Failed() == 1 })
	if got := up.attemptsFor("seg-2.m4s"); got != 1 {
		t.Fatalf("attempts = %d, want 1 (MaxRetries: 0 means fail fast on the first attempt, not the package default of %d)", got, DefaultMaxRetries)
	}
}

func TestWriterEnqueueNeverBlocksWhenQueueIsFull(t *testing.T) {
	up := newFakeUploader()
	up.blockCh = make(chan struct{}) // every PutObject blocks until we close this

	w := NewWriter(up, WriterConfig{Workers: 1, QueueDepth: 1})
	defer func() {
		close(up.blockCh)
		w.Close()
	}()

	// First job: picked up by the single worker immediately and blocks
	// there. Second: fills the queue (depth 1). Third: must be dropped,
	// not block this test.
	w.Enqueue("a", []byte("1"), "")
	waitForCondition(t, time.Second, func() bool { return up.attemptsFor("a") >= 1 })
	w.Enqueue("b", []byte("2"), "")

	done := make(chan struct{})
	go func() {
		w.Enqueue("c", []byte("3"), "")
		close(done)
	}()
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("Enqueue blocked with a full queue instead of dropping")
	}

	if w.Dropped() != 1 {
		t.Fatalf("Dropped() = %d, want 1", w.Dropped())
	}
	if w.Enqueued() != 3 {
		t.Fatalf("Enqueued() = %d, want 3 (Enqueued counts every call, dropped or not)", w.Enqueued())
	}
}

func TestWriterCloseWaitsForInFlightUploads(t *testing.T) {
	up := newFakeUploader()
	w := NewWriter(up, WriterConfig{Workers: 2})

	for i := 0; i < 10; i++ {
		w.Enqueue(fmt.Sprintf("obj-%d", i), []byte("x"), "")
	}
	w.Close()

	if w.Uploaded() != 10 {
		t.Fatalf("Uploaded() = %d after Close, want 10 (Close must drain the queue)", w.Uploaded())
	}
}

// TestWriterCloseIsBoundedDuringAnOutage is the regression test for the
// "Close can block for tens of minutes" finding: an uploader that never
// returns (a hung/unreachable bucket) must not make Close wait for every
// queued job's full retry budget. With a short CloseDeadline, Close must
// return promptly, and every job that never got a real attempt must be
// counted Dropped rather than Failed (nothing about the upload itself
// was ever tried and found wanting -- shutdown just gave up waiting).
func TestWriterCloseIsBoundedDuringAnOutage(t *testing.T) {
	up := newFakeUploader()
	up.blockCh = make(chan struct{}) // every PutObject blocks forever until this test closes it, simulating a dead bucket

	w := NewWriter(up, WriterConfig{Workers: 2, QueueDepth: 10, CloseDeadline: 100 * time.Millisecond})

	for i := 0; i < 5; i++ {
		w.Enqueue(fmt.Sprintf("stuck-%d", i), []byte("x"), "")
	}
	waitForCondition(t, time.Second, func() bool { return up.attemptsForAny() >= 2 }) // both workers now blocked mid-PUT

	start := time.Now()
	w.Close()
	elapsed := time.Since(start)

	if elapsed > 2*time.Second {
		t.Fatalf("Close took %s, want roughly CloseDeadline (100ms), not tens of minutes", elapsed)
	}
	if w.Uploaded() != 0 {
		t.Fatalf("Uploaded() = %d, want 0 -- the uploader never actually returns", w.Uploaded())
	}
	if w.Failed() != 0 {
		t.Fatalf("Failed() = %d, want 0 -- an abandoned-at-shutdown job is Dropped, not Failed", w.Failed())
	}
	if w.Dropped() == 0 {
		t.Fatal("expected the abandoned jobs to be counted Dropped")
	}

	close(up.blockCh) // let the now-cancelled PutObject calls actually return, so the test process itself can exit cleanly
}

func TestWriterConcurrentEnqueueIsRace_Free(t *testing.T) {
	up := newFakeUploader()
	w := NewWriter(up, WriterConfig{Workers: 4, QueueDepth: 200})

	var wg sync.WaitGroup
	var n atomic.Int64
	for i := 0; i < 50; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			w.Enqueue(fmt.Sprintf("k-%d", i), []byte("v"), "")
			n.Add(1)
		}(i)
	}
	wg.Wait()
	w.Close()

	if n.Load() != 50 {
		t.Fatalf("expected all 50 goroutines to complete Enqueue, got %d", n.Load())
	}
	if w.Uploaded()+w.Failed()+w.Dropped() != 50 {
		t.Fatalf("uploaded+failed+dropped = %d, want 50", w.Uploaded()+w.Failed()+w.Dropped())
	}
}

// Hypothesis (d) of the 2026-09-15 investigation -- "the writer or the S3
// path is blocking" -- was unanswerable from this Writer's counters:
// Uploaded going up says nothing about how long each PUT took, and a
// bucket that has gone slow looks exactly like a healthy one until the
// queue overflows. These are the numbers that tell them apart.
func TestWriter_RecordsUploadLatencyAndInFlight(t *testing.T) {
	const delay = 40 * time.Millisecond
	up := newFakeUploader()
	up.delay = delay
	w := NewWriter(up, WriterConfig{Workers: 1, QueueDepth: 4})

	if w.LastLatencyMs() != 0 || w.MaxLatencyMs() != 0 {
		t.Fatal("latency is reported before any upload has happened")
	}

	w.Enqueue("a.m4s", []byte("a"), "video/mp4")
	w.Enqueue("b.m4s", []byte("b"), "video/mp4")
	w.Close()

	if got := w.Uploaded(); got != 2 {
		t.Fatalf("Uploaded = %d, want 2", got)
	}
	if got := w.LastLatencyMs(); got < int64(delay/time.Millisecond)-5 {
		t.Fatalf("LastLatencyMs = %d, want roughly %d", got, delay/time.Millisecond)
	}
	if w.MaxLatencyMs() < w.LastLatencyMs() {
		t.Fatalf("MaxLatencyMs (%d) is below LastLatencyMs (%d)", w.MaxLatencyMs(), w.LastLatencyMs())
	}
	if got := w.InFlight(); got != 0 {
		t.Fatalf("InFlight = %d after Close, want 0", got)
	}
	if got := w.Queued(); got != 0 {
		t.Fatalf("Queued = %d after Close, want 0", got)
	}
}
