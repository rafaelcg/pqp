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
	"syscall"
	"time"

	"github.com/rafaelcg/pqp/tools/pqp-remux/internal/control"
)

// shutdownTimeout bounds how long a graceful shutdown waits for in-flight
// requests to finish on their own before this process forces the issue
// (Close, below) -- shutdown must complete even if something downstream
// (a held media response, a slow client) is unexpectedly stuck, the same
// "bounded shutdown" reasoning internal/r2.Writer.Close and
// internal/session's audioCloseFlushDeadline already apply elsewhere in
// this module.
const shutdownTimeout = 10 * time.Second

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
	srv := control.NewServer(cfg.Secret, cfg.MediaOriginKey, registry)
	httpServer := &http.Server{Addr: cfg.Listen, Handler: srv}

	log.Printf("pqp-remuxd: listening on %s (part-stuck=%dms demote-window=%dms)",
		cfg.Listen, cfg.PartStuckMs, cfg.DemoteWindowMs)

	errCh := make(chan error, 1)
	go func() { errCh <- httpServer.ListenAndServe() }()

	sigCh := make(chan os.Signal, 1)
	signal.Notify(sigCh, os.Interrupt, syscall.SIGTERM)

	select {
	case err := <-errCh:
		if err != nil && err != http.ErrServerClosed {
			log.Fatalf("pqp-remuxd: %v", err)
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
	// out from under a request actively being served.
	registry.StopAll()
}
