// Command pqp-remuxd is the L1.6 control-plane supervisor: it exposes the
// HTTP contract packages/shared/src/hls-remux-control.ts (L1.5) defines --
// POST/DELETE/GET /sessions, HMAC-signed -- and holds N concurrent
// low-latency remux sessions in one process, each a real
// session.Session + subscriber.Session pair, built and torn down on
// demand rather than fixed at process start the way cmd/pqp-remux's own
// single-session ROOM env var is.
//
// See internal/control's package doc comment for the full picture and the
// README's "Control API" section for how to run this against a real box.
package main

import (
	"context"
	"log"
	"net/http"
	"os"
	"os/signal"
	"strconv"
	"strings"
	"syscall"
	"time"

	"github.com/rafaelcg/pqp/tools/pqp-remux/internal/control"
	"github.com/rafaelcg/pqp/tools/pqp-remux/internal/film"
	"github.com/rafaelcg/pqp/tools/pqp-remux/internal/r2"
)

// startFilmWorker makes every LL session that ends into one downloadable
// film (internal/film), one job at a time, niced, beside the live work.
// On whenever the bucket is configured; LL_FILM=off turns it off without a
// rebuild. FILM_WORK_DIR (default the service's private /tmp) needs a few
// gigabytes free per hour of show while a job runs; FILM_THREADS caps x264.
func startFilmWorker(ctx context.Context, cfg control.GlobalConfig, registry *control.Registry) {
	if !cfg.LiveHlsS3Configured() {
		return
	}
	if v := strings.ToLower(strings.TrimSpace(os.Getenv("LL_FILM"))); v == "off" || v == "false" || v == "0" {
		log.Print("pqp-remuxd: LL film jobs are off (LL_FILM)")
		return
	}
	threads, _ := strconv.Atoi(os.Getenv("FILM_THREADS"))
	store := r2.NewObjectClient(r2.Config{
		Endpoint:        cfg.LiveHlsS3Endpoint,
		Bucket:          cfg.LiveHlsS3Bucket,
		Region:          cfg.LiveHlsS3Region,
		AccessKeyID:     cfg.LiveHlsS3AccessKeyID,
		SecretAccessKey: cfg.LiveHlsS3SecretAccessKey,
		ForcePathStyle:  cfg.LiveHlsS3ForcePathStyle,
	})
	worker := film.NewWorker(store, film.Config{
		FFmpegPath: cfg.FFmpegPath,
		WorkDir:    os.Getenv("FILM_WORK_DIR"),
		Threads:    threads,
		Nice:       true,
	}, 32)
	go worker.Run(ctx)
	registry.SetSessionEndedHook(func(e control.SessionEnded) {
		worker.Enqueue(ctx, film.Job{Prefix: e.Prefix, VideoPlaylist: e.VideoPlaylist, AudioPlaylist: e.AudioPlaylist})
	})
	log.Print("pqp-remuxd: LL film jobs on")
}

// shutdownTimeout bounds how long a graceful shutdown waits for in-flight
// requests to finish on their own before this process forces the issue
// (Close, below) -- shutdown must complete even if something downstream
// (a held media response, a slow client) is unexpectedly stuck, the same
// "bounded shutdown" reasoning internal/r2.Writer.Close and
// internal/session's audioCloseFlushDeadline already apply elsewhere in
// this module.
const shutdownTimeout = 10 * time.Second

// readHeaderTimeout/readTimeout bound how long ListenAndServe will let one
// connection take to send its headers, and its whole request (headers plus
// body), before closing it (Farol review, PR #584): withSigning's
// concurrency semaphore (internal/control/server.go's bodySem) is acquired
// BEFORE the body is read or authenticated, on purpose -- it exists to
// bound aggregate buffering, which an unauthenticated caller must not be
// able to grow without limit by opening many requests at once. Without a
// server-level deadline on receiving the request, that same caller could
// instead hold ONE slot indefinitely by sending an incomplete body slowly
// (or never finishing it), and 64 such connections would block every
// legitimate session start/stop/list behind them. Go's default
// http.Server has no such deadline (the "default unlimited timeout
// behavior" this review also flagged) -- these two constants close both
// findings at once, at the one place (the listener itself) that can act
// before a body read even begins. 10s is generous for real bodies (a
// handful of numbers and short strings, StartSessionRequest's own doc
// comment) while still giving an unauthenticated slow-loris connection a
// bounded, not unbounded, hold on a semaphore slot.
const (
	readHeaderTimeout = 5 * time.Second
	readTimeout       = 10 * time.Second
)

func main() {
	cfg, err := control.LoadGlobalConfig()
	if err != nil {
		log.Fatalf("pqp-remuxd: %v", err)
	}

	// supervisorCtx is this PROCESS's own lifetime, handed to every
	// session's Pipeline construction (control.PipelineFactory's own doc
	// comment) so shutdown reaches a session even while it is still being
	// built -- still inside EnableAudio's ffmpeg spawn, or blocked in
	// subscriber.Connect's network dial -- not only the sessions that had
	// already finished starting and been registered (Farol review, PR
	// #584). Cancelled explicitly, as the very first step of shutdown,
	// below; the defer here is only a safety net for any return path that
	// bypasses that (there is none today, but a context that outlives the
	// function that created it, with nothing to ever cancel it, is
	// exactly the shape this whole change exists to avoid repeating).
	supervisorCtx, supervisorCancel := context.WithCancel(context.Background())
	defer supervisorCancel()

	registry := control.NewRegistry(supervisorCtx, control.NewRemuxPipeline, cfg, cfg.WatchdogConfig(), time.Now)
	startFilmWorker(supervisorCtx, cfg, registry)
	srv := control.NewServer(cfg.Secret, cfg.MediaOriginKey, registry)
	httpServer := &http.Server{
		Addr:              cfg.Listen,
		Handler:           srv,
		ReadHeaderTimeout: readHeaderTimeout,
		ReadTimeout:       readTimeout,
	}

	log.Printf("pqp-remuxd: listening on %s (part-stuck=%dms demote-window=%dms)",
		cfg.Listen, cfg.PartStuckMs, cfg.DemoteWindowMs)

	errCh := make(chan error, 1)
	go func() { errCh <- httpServer.ListenAndServe() }()

	sigCh := make(chan os.Signal, 1)
	signal.Notify(sigCh, os.Interrupt, syscall.SIGTERM)

	// listenErr is set when the listener itself fails (e.g. the port is
	// already in use) so the process can still exit non-zero -- but only
	// AFTER running the exact same registry.StopAll() teardown the normal
	// shutdown path gets below, never in place of it (Farol review, PR
	// #584: log.Fatalf calls os.Exit before that point, so a listener
	// failure used to skip session cleanup entirely -- no unsubscribe, no
	// encoder shutdown, no R2 queue flush -- something SIGTERM never
	// skips).
	var listenErr error
	select {
	case err := <-errCh:
		if err != nil && err != http.ErrServerClosed {
			log.Printf("pqp-remuxd: %v", err)
			listenErr = err
		}
		supervisorCancel()
	case <-sigCh:
		log.Print("pqp-remuxd: shutting down")
		// Cancel FIRST, before even starting the HTTP graceful drain
		// below: any session construction currently in flight inside a
		// handleStart call starts tearing itself down immediately and
		// concurrently with that drain, instead of only after it
		// finishes (or times out) -- see supervisorCtx's own doc
		// comment above for what this does and does not reach.
		supervisorCancel()
		shutdownCtx, shutdownCancel := context.WithTimeout(context.Background(), shutdownTimeout)
		defer shutdownCancel()
		// Shutdown blocks until every in-flight request finishes on its
		// own OR shutdownCtx's deadline passes, whichever is first --
		// "honours its timeout" (Farol review, PR #584) means THIS call
		// must never be allowed to run longer than that, which
		// http.Server.Shutdown already guarantees by contract. What it
		// does NOT do on its own is abort a request still in flight when
		// the deadline arrives: Shutdown returns ctx.Err() in that case,
		// but the underlying connection (and whatever handler goroutine
		// is still running against it -- e.g. a held media response) is
		// left exactly as it was. Close forces that: it closes every
		// listener and every active connection immediately, so a request
		// held past the deadline is aborted rather than left to race the
		// registry.StopAll() that follows and observe a pipeline torn
		// down out from under it.
		if err := httpServer.Shutdown(shutdownCtx); err != nil {
			log.Printf("pqp-remuxd: graceful shutdown did not finish within %s (%v); forcibly closing remaining connections, including any held media responses", shutdownTimeout, err)
			if cerr := httpServer.Close(); cerr != nil {
				log.Printf("pqp-remuxd: error forcibly closing the HTTP server: %v", cerr)
			}
		}
	}

	// Stop every live session (unsubscribe, close encoders, flush R2
	// queues) AFTER the HTTP server itself has stopped taking new
	// requests -- and, per the above, after any request still holding one
	// open has been forcibly cut off -- so a session never gets torn down
	// out from under a request actively being served. Runs on EVERY exit
	// path out of the select above, listener failure included.
	registry.StopAll()

	if listenErr != nil {
		os.Exit(1)
	}
}
