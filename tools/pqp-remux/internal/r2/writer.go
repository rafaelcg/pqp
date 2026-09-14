package r2

import (
	"context"
	"log"
	"sync"
	"sync/atomic"
	"time"
)

// DefaultQueueDepth/DefaultMaxRetries/DefaultWorkers are used when a
// WriterConfig field is left at its zero value.
const (
	DefaultQueueDepth = 64
	DefaultMaxRetries = 3
	DefaultWorkers    = 2
	uploadTimeout     = 20 * time.Second
)

// WriterConfig tunes the bounded upload queue.
type WriterConfig struct {
	// QueueDepth bounds how many not-yet-uploaded objects Writer holds at
	// once. Enqueue never blocks past this: a full queue drops the new
	// item and counts it (Dropped), rather than applying backpressure to
	// the part/segment pipeline that called it -- "never block the part
	// pipeline on an upload" (L1.4's own acceptance bar) means a slow or
	// down bucket must degrade the *replay/DVR copy*, never the live
	// stream this process serves over HTTP.
	QueueDepth int
	// MaxRetries is how many additional attempts a failed upload gets
	// (so MaxRetries=3 means up to 4 total attempts) before it is counted
	// as Failed and dropped for good.
	MaxRetries int
	// Workers is how many uploads may be in flight at once. R2/MinIO PUT
	// latency measured elsewhere in this repo (hls-egress.ts's own
	// comment, "a 1 KB PUT from the São Paulo box to the live bucket
	// takes 0.6 to 1.0 s") is why this defaults to more than 1: a single
	// worker serializing every segment (video and audio both write here)
	// would fall behind a 4s segment cadence under exactly the latency
	// this service's own design doc measured.
	Workers int
}

// Writer is a bounded, async upload queue in front of an Uploader: Enqueue
// never blocks the caller past the queue being full, retries a transient
// failure with backoff, and exposes counters for a health/metrics
// endpoint (L1.6's job to wire up; this package only counts).
type Writer struct {
	uploader   Uploader
	maxRetries int
	queue      chan uploadJob
	wg         sync.WaitGroup

	enqueued atomic.Uint64
	failed   atomic.Uint64
	dropped  atomic.Uint64
	uploaded atomic.Uint64
}

type uploadJob struct {
	key         string
	body        []byte
	contentType string
}

// NewWriter starts cfg.Workers upload goroutines (default DefaultWorkers)
// pulling from a queue of depth cfg.QueueDepth (default DefaultQueueDepth),
// each upload retried up to cfg.MaxRetries times (default
// DefaultMaxRetries) before being counted Failed.
func NewWriter(uploader Uploader, cfg WriterConfig) *Writer {
	queueDepth := cfg.QueueDepth
	if queueDepth <= 0 {
		queueDepth = DefaultQueueDepth
	}
	maxRetries := cfg.MaxRetries
	if maxRetries <= 0 {
		maxRetries = DefaultMaxRetries
	}
	workers := cfg.Workers
	if workers <= 0 {
		workers = DefaultWorkers
	}

	w := &Writer{
		uploader:   uploader,
		maxRetries: maxRetries,
		queue:      make(chan uploadJob, queueDepth),
	}
	for i := 0; i < workers; i++ {
		w.wg.Add(1)
		go w.run()
	}
	return w
}

// Enqueue schedules key/body/contentType for upload. Never blocks past
// the queue being full: a full queue drops this item, counts it in
// Dropped, and logs once per drop (a live incident with a down bucket is
// exactly when an operator needs these in the log, and this is not a
// per-part-cadence-frequency event under normal operation, unlike e.g. a
// per-video-frame log line would be).
func (w *Writer) Enqueue(key string, body []byte, contentType string) {
	w.enqueued.Add(1)
	select {
	case w.queue <- uploadJob{key: key, body: body, contentType: contentType}:
	default:
		w.dropped.Add(1)
		log.Printf("r2: upload queue full, dropping %s (see Writer.Dropped for the running count)", key)
	}
}

func (w *Writer) run() {
	defer w.wg.Done()
	for job := range w.queue {
		w.uploadWithRetry(job)
	}
}

func (w *Writer) uploadWithRetry(job uploadJob) {
	var lastErr error
	for attempt := 0; attempt <= w.maxRetries; attempt++ {
		if attempt > 0 {
			time.Sleep(retryBackoff(attempt))
		}
		ctx, cancel := context.WithTimeout(context.Background(), uploadTimeout)
		err := w.uploader.PutObject(ctx, job.key, job.body, job.contentType)
		cancel()
		if err == nil {
			w.uploaded.Add(1)
			return
		}
		lastErr = err
	}
	w.failed.Add(1)
	log.Printf("r2: upload failed after %d attempts: %s: %v", w.maxRetries+1, job.key, lastErr)
}

// retryBackoff is a simple capped exponential backoff: 200ms, 400ms,
// 800ms, ... capped at 5s, so a transiently unreachable bucket is retried
// with increasing patience without ever silently stalling a worker for a
// dangerously long time between attempts.
func retryBackoff(attempt int) time.Duration {
	d := 200 * time.Millisecond
	for i := 1; i < attempt; i++ {
		d *= 2
		if d >= 5*time.Second {
			return 5 * time.Second
		}
	}
	return d
}

// Enqueued/Failed/Dropped/Uploaded are running counters since this Writer
// was created, safe to read from any goroutine at any time -- meant for
// GET /healthz (L1.6) to report directly, the same shape as
// Session.Health() already reports partsWritten/bytesWritten.
func (w *Writer) Enqueued() uint64 { return w.enqueued.Load() }
func (w *Writer) Failed() uint64   { return w.failed.Load() }
func (w *Writer) Dropped() uint64  { return w.dropped.Load() }
func (w *Writer) Uploaded() uint64 { return w.uploaded.Load() }

// Close stops accepting new work implicitly (any Enqueue after Close
// racing a worker's final drain is a caller bug, matching every other
// single-owner shutdown in this codebase -- e.g. aacenc.Encoder.Close)
// and waits for every in-flight and already-queued upload to finish.
func (w *Writer) Close() {
	close(w.queue)
	w.wg.Wait()
}
