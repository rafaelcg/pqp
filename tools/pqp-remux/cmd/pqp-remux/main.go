// Command pqp-remux is a headless, hidden LiveKit subscriber that remuxes
// a presenter's screen-share H.264 into CMAF (fMP4) parts and segments for
// LL-HLS, with no decode and no transcode (docs/plans/LL_HLS.md, tasks
// L1.1 and L1.2). See the README for the full config table and what is and
// is not implemented yet.
package main

import (
	"context"
	"flag"
	"fmt"
	"log"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/pion/rtp"

	"github.com/rafaelcg/pqp/tools/pqp-remux/internal/config"
	"github.com/rafaelcg/pqp/tools/pqp-remux/internal/h264"
	"github.com/rafaelcg/pqp/tools/pqp-remux/internal/idrlog"
	"github.com/rafaelcg/pqp/tools/pqp-remux/internal/keyframe"
	"github.com/rafaelcg/pqp/tools/pqp-remux/internal/ring"
	"github.com/rafaelcg/pqp/tools/pqp-remux/internal/serve"
	"github.com/rafaelcg/pqp/tools/pqp-remux/internal/session"
	"github.com/rafaelcg/pqp/tools/pqp-remux/internal/subscriber"
)

func main() {
	idrLogPath := flag.String("idr-log", "", "run L0.2's passive keyframe-cadence logger instead of serving: write one CSV line per IDR to this path ('-' for stdout), then a summary, then exit")
	duration := flag.Duration("duration", 0, "with -idr-log, stop and print the summary after this long (required with -idr-log)")
	flag.Parse()

	cfg, err := config.FromEnv()
	if err != nil {
		log.Fatalf("pqp-remux: %v", err)
	}
	cfg.IDRLogPath = *idrLogPath
	cfg.Duration = *duration

	if cfg.IDRLogPath != "" {
		if cfg.Duration <= 0 {
			log.Fatal("pqp-remux: -idr-log requires -duration")
		}
		if err := runIDRLog(cfg); err != nil {
			log.Fatalf("pqp-remux: %v", err)
		}
		return
	}

	if err := runServer(cfg); err != nil {
		log.Fatalf("pqp-remux: %v", err)
	}
}

// runServer is the normal mode: subscribe, mux, serve. sess is built
// before Connect (Connect's Handlers need its bound methods) and PLI mode
// is wired into it afterward via SetKeyframeRequester, since only Connect's
// return value (the subscriber.Session) can write a PLI — see that
// method's doc comment for why this can't just be a second session.New
// call.
func runServer(cfg config.Config) error {
	r := ring.New(cfg.RingSegments, 90000)
	sess := session.New(cfg.PartTicks(), cfg.SegmentTicks(), r, nil)

	sub, err := subscriber.Connect(subscriber.Config{
		URL:       cfg.LiveKitURL,
		APIKey:    cfg.LiveKitAPIKey,
		APISecret: cfg.LiveKitAPISec,
		Room:      cfg.Room,
	}, subscriber.Handlers{
		OnVideoTrackFound: func(*subscriber.Session) { sess.MarkSubscribed() },
		OnVideoPacket:     sess.HandleVideoPacket,
		OnAudioPacket:     sess.HandleAudioPacket,
	})
	if err != nil {
		return fmt.Errorf("connecting to %s room %q: %w", cfg.LiveKitURL, cfg.Room, err)
	}
	defer sub.Close()

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	if cfg.KeyframePolicy == keyframe.PolicyPLI {
		keyReq := keyframe.NewRequester(cfg.KeyframeConfig(), sub)
		sess.SetKeyframeRequester(keyReq)
		go keyReq.Run(ctx)
	}

	srv := serve.New(r, sess)
	httpServer := &http.Server{Addr: cfg.Listen, Handler: srv}

	log.Printf("pqp-remux: listening on %s, subscribing to room %q at %s (part=%dms segment=%dms policy=%s)",
		cfg.Listen, cfg.Room, cfg.LiveKitURL, cfg.PartMS, cfg.SegmentMS, cfg.KeyframePolicy)

	errCh := make(chan error, 1)
	go func() { errCh <- httpServer.ListenAndServe() }()

	sigCh := make(chan os.Signal, 1)
	signal.Notify(sigCh, os.Interrupt, syscall.SIGTERM)

	select {
	case err := <-errCh:
		if err != nil && err != http.ErrServerClosed {
			return err
		}
	case <-sigCh:
		log.Print("pqp-remux: shutting down")
		shutdownCtx, shutdownCancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer shutdownCancel()
		_ = httpServer.Shutdown(shutdownCtx)
	}
	return nil
}

// runIDRLog is L0.2's passive logging mode: subscribe, never publish
// anything, never send a PLI (regardless of KEYFRAME_POLICY — this
// function never constructs a keyframe.Requester at all, which is what
// L0.1 result item 4 means by "passive by construction"), log every IDR,
// then print a summary and exit after cfg.Duration.
func runIDRLog(cfg config.Config) error {
	out := os.Stdout
	if cfg.IDRLogPath != "-" && cfg.IDRLogPath != "" {
		f, err := os.Create(cfg.IDRLogPath)
		if err != nil {
			return fmt.Errorf("creating %s: %w", cfg.IDRLogPath, err)
		}
		defer f.Close()
		out = f
	}

	scanner := newAccessUnitScanner(idrlog.New(out))

	sub, err := subscriber.Connect(subscriber.Config{
		URL:       cfg.LiveKitURL,
		APIKey:    cfg.LiveKitAPIKey,
		APISecret: cfg.LiveKitAPISec,
		Room:      cfg.Room,
	}, subscriber.Handlers{
		OnVideoPacket: scanner.push,
	})
	if err != nil {
		return fmt.Errorf("connecting to %s room %q: %w", cfg.LiveKitURL, cfg.Room, err)
	}
	defer sub.Close()

	log.Printf("pqp-remux: idr-log running against room %q for %s", cfg.Room, cfg.Duration)
	time.Sleep(cfg.Duration)

	fmt.Fprintln(os.Stderr, scanner.logger.Stats().Summary())
	return nil
}

// accessUnitScanner is idr-log mode's own minimal use of the depacketizer:
// it only needs to know when an access unit is an IDR and how big it is,
// so it talks to h264.Depacketizer directly rather than pulling in the
// fragmenter or the ring — this mode's dependency graph is honestly
// smaller than the serving mode's, and its code should look like it.
type accessUnitScanner struct {
	dep    *h264.Depacketizer
	logger *idrlog.Logger
}

func newAccessUnitScanner(logger *idrlog.Logger) *accessUnitScanner {
	return &accessUnitScanner{dep: h264.NewDepacketizer(), logger: logger}
}

func (a *accessUnitScanner) push(pkt *rtp.Packet) {
	au, err := a.dep.Push(pkt.Payload, pkt.Timestamp, pkt.Marker)
	if err != nil {
		log.Printf("pqp-remux: idr-log depacketize: %v", err)
	}
	if au != nil && au.IsIDR {
		a.logger.OnIDR(au.PTS, au.Bytes(), time.Now())
	}
}
