package film

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"os"
	"path/filepath"
	"sync"
	"time"
)

// The two objects a job writes under the session prefix. The API reads both
// (server/src/voice/hls-history.ts), so the names are a contract.
const (
	FilmObjectName   = "film.mp4"
	StatusObjectName = "film.json"
	FilmContentType  = "video/mp4"
)

// Job states, as film.json spells them.
const (
	StateQueued     = "queued"
	StateProcessing = "processing"
	StateReady      = "ready"
	StateFailed     = "failed"
)

// Status is film.json. UpdatedAt is refreshed every HeartbeatInterval while
// the job is queued or processing, so a reader can tell a job that is still
// going from one whose process died: the API treats a queued or processing
// status that has not been refreshed for a few intervals as failed.
type Status struct {
	State           string  `json:"state"`
	UpdatedAt       string  `json:"updatedAt"`
	Bytes           int64   `json:"bytes,omitempty"`
	DurationSeconds float64 `json:"durationSeconds,omitempty"`
	MissingSegments int     `json:"missingSegments,omitempty"`
	Error           string  `json:"error,omitempty"`
}

func (s Status) terminal() bool { return s.State == StateReady || s.State == StateFailed }

// HeartbeatInterval is how often a live status is re-written.
const HeartbeatInterval = 30 * time.Second

// uploadTimeout bounds the film's PUT. Generous: a gigabyte at a slow 5 MB/s
// is under four minutes, and a PUT that has not finished in an hour is not
// going to.
const uploadTimeout = time.Hour

// Worker runs film jobs ONE AT A TIME, in the order sessions ended, and
// keeps their film.json current. One at a time on purpose: every job is an
// x264 encode, and two at once on a four-core box that is also running the
// next show's transcodes is how that show would start dropping frames.
type Worker struct {
	store Store
	cfg   Config
	jobs  chan Job
	now   func() time.Time

	// statusMu serialises every film.json write, and guards live. Without
	// it a heartbeat that read "processing" could land its PUT after the
	// job's own "ready", and the last write would say the film is still
	// being made.
	statusMu sync.Mutex
	live     map[string]Status
}

// NewWorker returns a worker with room for depth jobs waiting.
func NewWorker(store Store, cfg Config, depth int) *Worker {
	if depth <= 0 {
		depth = 32
	}
	return &Worker{
		store: store,
		cfg:   cfg,
		jobs:  make(chan Job, depth),
		now:   time.Now,
		live:  make(map[string]Status),
	}
}

// Enqueue schedules a job and marks it queued. False when the queue is full,
// which is logged and leaves the session with no film (the API then says
// the recording is unavailable, which is true). Never blocks.
func (w *Worker) Enqueue(ctx context.Context, job Job) bool {
	select {
	case w.jobs <- job:
	default:
		log.Printf("pqp-film: %s: queue full, no film for this session", job.Prefix)
		return false
	}
	// The map entry now, the PUT in the background: this runs inside the
	// API's DELETE /sessions request, which must not wait on the bucket.
	// The PUT writes whatever the entry says by the time it runs, so a job
	// the worker has already picked up is never marked queued again.
	w.statusMu.Lock()
	w.live[job.Prefix] = Status{State: StateQueued}
	w.statusMu.Unlock()
	go w.flush(ctx, job.Prefix)
	log.Printf("pqp-film: %s: queued", job.Prefix)
	return true
}

func (w *Worker) flush(ctx context.Context, prefix string) {
	w.statusMu.Lock()
	defer w.statusMu.Unlock()
	if st, ok := w.live[prefix]; ok {
		w.putStatusLocked(ctx, prefix, st)
	}
}

// Run processes jobs until ctx ends, and heartbeats every live status.
func (w *Worker) Run(ctx context.Context) {
	go w.heartbeat(ctx)
	for {
		select {
		case <-ctx.Done():
			return
		case job := <-w.jobs:
			if err := w.process(ctx, job); err != nil {
				log.Printf("pqp-film: %s: failed: %v", job.Prefix, err)
			}
		}
	}
}

// RunOne processes one job synchronously, with its heartbeat: the backfill
// command's way in (cmd/pqp-film).
func (w *Worker) RunOne(ctx context.Context, job Job) error {
	hbCtx, cancel := context.WithCancel(ctx)
	defer cancel()
	go w.heartbeat(hbCtx)
	return w.process(ctx, job)
}

func (w *Worker) heartbeat(ctx context.Context) {
	ticker := time.NewTicker(HeartbeatInterval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			w.statusMu.Lock()
			for prefix, st := range w.live {
				w.putStatusLocked(ctx, prefix, st)
			}
			w.statusMu.Unlock()
		}
	}
}

func (w *Worker) report(ctx context.Context, prefix string, st Status) {
	w.statusMu.Lock()
	defer w.statusMu.Unlock()
	if st.terminal() {
		delete(w.live, prefix)
	} else {
		w.live[prefix] = st
	}
	w.putStatusLocked(ctx, prefix, st)
}

// putStatusLocked writes film.json with a fresh UpdatedAt. A failed write is
// logged and not retried: the next heartbeat or state change writes it again.
func (w *Worker) putStatusLocked(ctx context.Context, prefix string, st Status) {
	st.UpdatedAt = w.now().UTC().Format(time.RFC3339)
	body, err := json.Marshal(st)
	if err != nil {
		return
	}
	putCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 20*time.Second)
	defer cancel()
	if err := w.store.Put(putCtx, prefix+"/"+StatusObjectName, body, "application/json"); err != nil {
		log.Printf("pqp-film: %s: writing %s: %v", prefix, StatusObjectName, err)
	}
}

func (w *Worker) process(ctx context.Context, job Job) (err error) {
	started := w.now()
	w.report(ctx, job.Prefix, Status{State: StateProcessing})
	defer func() {
		if err != nil {
			w.report(ctx, job.Prefix, Status{State: StateFailed, Error: err.Error()})
		}
	}()

	cfg := w.cfg.withDefaults()
	out, err := os.CreateTemp(cfg.WorkDir, "pqp-film-*.mp4")
	if err != nil {
		return err
	}
	outPath := out.Name()
	out.Close()
	defer os.Remove(outPath)

	film, err := Build(ctx, w.store, cfg, job, outPath)
	if err != nil {
		return err
	}

	// The retention sweep may have deleted the session while this job ran
	// (a ten-minute window and a long show). Uploading anyway would leave a
	// film under a prefix no row names, which nothing would ever delete.
	// The playlist is the marker: the box writes it on the first segment
	// and only the sweep removes it.
	still, err := w.store.Exists(ctx, job.Prefix+"/video.m3u8")
	if err != nil {
		return fmt.Errorf("checking the session is still there: %w", err)
	}
	if !still {
		w.statusMu.Lock()
		delete(w.live, job.Prefix)
		w.statusMu.Unlock()
		log.Printf("pqp-film: %s: the session was swept while its film was made; not uploading", job.Prefix)
		return nil
	}

	upCtx, cancel := context.WithTimeout(ctx, uploadTimeout)
	defer cancel()
	if err := w.store.PutFile(upCtx, job.Prefix+"/"+FilmObjectName, outPath, FilmContentType); err != nil {
		return fmt.Errorf("uploading: %w", err)
	}
	w.report(ctx, job.Prefix, Status{
		State:           StateReady,
		Bytes:           film.Bytes,
		DurationSeconds: film.DurationSeconds,
		MissingSegments: film.MissingSegments,
	})
	log.Printf("pqp-film: %s: ready: %.1fs, %d bytes, %d missing segments, took %s (%s)",
		job.Prefix, film.DurationSeconds, film.Bytes, film.MissingSegments,
		w.now().Sub(started).Round(time.Second), filepath.Base(outPath))
	return nil
}
