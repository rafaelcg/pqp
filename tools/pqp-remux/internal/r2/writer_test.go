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

	if f.blockCh != nil {
		<-f.blockCh
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
