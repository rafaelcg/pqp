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

func main() {
	cfg, err := control.LoadGlobalConfig()
	if err != nil {
		log.Fatalf("pqp-remuxd: %v", err)
	}

	registry := control.NewRegistry(control.NewRemuxPipeline, cfg, cfg.WatchdogConfig(), time.Now)
	srv := control.NewServer(cfg.Secret, registry)
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
	case <-sigCh:
		log.Print("pqp-remuxd: shutting down")
		shutdownCtx, shutdownCancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer shutdownCancel()
		_ = httpServer.Shutdown(shutdownCtx)
	}

	// Stop every live session (unsubscribe, close encoders, flush R2
	// queues) AFTER the HTTP server itself has stopped taking new
	// requests, so a session doesn't get torn down mid-request.
	registry.StopAll()
}
