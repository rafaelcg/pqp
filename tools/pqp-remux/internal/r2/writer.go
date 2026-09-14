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
	// DefaultCloseDeadline bounds how long Close waits for the queue to
	// drain naturally before giving up. Without a bound, a live outage
	// could make Close wait roughly QueueDepth/Workers upload slots deep,
	// each up to (1+MaxRetries) attempts of uploadTimeout plus backoff --
	// with the defaults above, tens of minutes -- which would hang this
	// process's own shutdown for that long. Past the deadline, Close
	// cancels every in-flight and queued attempt and counts them Dropped
	// instead of waiting for them to fail on their own.
	DefaultCloseDeadline = 10 * time.Second
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
	// as Failed and dropped for good. Zero is a legitimate, meaningful
	// value here -- "never retry, fail fast" -- NOT "unset, use
	// DefaultMaxRetries" the way QueueDepth/Workers below treat their own
	// zero value: unlike those two (where 0 has no coherent standalone
	// meaning of its own), 0 retries is a real, distinct operator choice
	// (Farol review, PR #584: control.LoadGlobalConfig validates
	// R2_UPLOAD_MAX_RETRIES >= 0 specifically so this value means what it
	// says once it reaches here). Only a NEGATIVE value -- which every
	// production caller's own config validation already refuses before
	// it can reach this struct -- falls back to the default, as a
	// defensive floor for a caller that skips that validation (a test
	// leaving this field unset gets Go's own int zero value, 0, which is
	// exactly the "no retries" case, not the negative one).
	MaxRetries int
	// Workers is how many uploads may be in flight at once. R2/MinIO PUT
	// latency measured elsewhere in this repo (hls-egress.ts's own
	// comment, "a 1 KB PUT from the São Paulo box to the live bucket
	// takes 0.6 to 1.0 s") is why this defaults to more than 1: a single
	// worker serializing every segment (video and audio both write here)
	// would fall behind a 4s segment cadence under exactly the latency
	// this service's own design doc measured.
	Workers int
	// CloseDeadline overrides DefaultCloseDeadline; mainly for tests that
	// want Close's bounded-drain behaviour to trigger quickly.
	CloseDeadline time.Duration
}

// Writer is a bounded, async upload queue in front of an Uploader: Enqueue
// never blocks the caller past the queue being full, retries a transient
// failure with backoff, and exposes counters for a health/metrics
// endpoint (L1.6's job to wire up; this package only counts).
type Writer struct {
	uploader      Uploader
	maxRetries    int
	closeDeadline time.Duration
	queue         chan uploadJob
	wg            sync.WaitGroup

	// ctx is cancelled by Close once CloseDeadline has passed with the
	// queue still not drained: every in-flight PutObject is derived from
	// it (so an open HTTP request aborts promptly) and every retry's
	// backoff sleep also selects on it, so cancellation reaches both a
	// worker that is sleeping between attempts and one that is mid-PUT.
	ctx    context.Context
	cancel context.CancelFunc

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
// each upload retried up to cfg.MaxRetries times (default DefaultMaxRetries,
// but an explicit zero is honored as "never retry" -- see WriterConfig.
// MaxRetries's own doc comment for why that field's zero value is treated
// differently than QueueDepth/Workers's).
func NewWriter(uploader Uploader, cfg WriterConfig) *Writer {
	queueDepth := cfg.QueueDepth
	if queueDepth <= 0 {
		queueDepth = DefaultQueueDepth
	}
	maxRetries := cfg.MaxRetries
	if maxRetries < 0 {
		maxRetries = DefaultMaxRetries
	}
	workers := cfg.Workers
	if workers <= 0 {
		workers = DefaultWorkers
	}
	closeDeadline := cfg.CloseDeadline
	if closeDeadline <= 0 {
		closeDeadline = DefaultCloseDeadline
	}

	ctx, cancel := context.WithCancel(context.Background())
	w := &Writer{
		uploader:      uploader,
		maxRetries:    maxRetries,
		closeDeadline: closeDeadline,
		queue:         make(chan uploadJob, queueDepth),
		ctx:           ctx,
		cancel:        cancel,
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
	if w.ctx.Err() != nil {
		// Close's deadline already passed and cancelled w.ctx: this job
		// was still sitting in the queue when that happened, so it never
		// gets a real attempt at all -- dropped, not failed, since
		// nothing about the upload itself was ever tried and found
		// wanting.
		w.dropped.Add(1)
		return
	}

	var lastErr error
	for attempt := 0; attempt <= w.maxRetries; attempt++ {
		if attempt > 0 {
			select {
			case <-time.After(retryBackoff(attempt)):
			case <-w.ctx.Done():
				w.dropped.Add(1)
				log.Printf("r2: upload for %s abandoned during shutdown (attempt %d of %d)", job.key, attempt+1, w.maxRetries+1)
				return
			}
		}
		ctx, cancel := context.WithTimeout(w.ctx, uploadTimeout)
		err := w.uploader.PutObject(ctx, job.key, job.body, job.contentType)
		cancel()
		if err == nil {
			w.uploaded.Add(1)
			return
		}
		if w.ctx.Err() != nil {
			// The in-flight PUT above was aborted by w.ctx (Close's
			// deadline), not a genuine upload failure: count it the same
			// way as a job that never got tried, not as Failed.
			w.dropped.Add(1)
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
// and waits up to CloseDeadline for every in-flight and already-queued
// upload to finish normally. Past the deadline, it cancels w.ctx --
// aborting every in-flight PutObject and every retry's backoff sleep --
// and counts whatever never got a real attempt as Dropped, so shutdown
// completes in bounded time even during a real bucket outage (a slow or
// dead R2/MinIO must not hang this process's own teardown for as long as
// a full queue's worth of retries would otherwise take).
func (w *Writer) Close() {
	close(w.queue)

	done := make(chan struct{})
	go func() {
		w.wg.Wait()
		close(done)
	}()

	select {
	case <-done:
		return
	case <-time.After(w.closeDeadline):
	}

	log.Printf("r2: Close exceeded its %s deadline with uploads still pending; cancelling and dropping the rest", w.closeDeadline)
	w.cancel()
	<-done // every worker now exits promptly: uploadWithRetry checks w.ctx at every wait point
}
