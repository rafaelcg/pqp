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
	"sync"
	"sync/atomic"
	"syscall"
	"time"

	"github.com/pion/rtp"

	"github.com/rafaelcg/pqp/tools/pqp-remux/internal/aacenc"
	"github.com/rafaelcg/pqp/tools/pqp-remux/internal/config"
	"github.com/rafaelcg/pqp/tools/pqp-remux/internal/h264"
	"github.com/rafaelcg/pqp/tools/pqp-remux/internal/idrlog"
	"github.com/rafaelcg/pqp/tools/pqp-remux/internal/keyframe"
	"github.com/rafaelcg/pqp/tools/pqp-remux/internal/r2"
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
//
// ctx is created before sess so EnableAudio (L1.3) can be started on it:
// cancelling ctx on shutdown stops both the audio pacer goroutine and (via
// aacenc.New's own exec.CommandContext) the ffmpeg subprocess.
//
// Shutdown order is deliberate throughout this function's defers, and it
// is the OPPOSITE of registration order (defers run last-registered-
// first): registering r2Writer.Close() first, then sess.Close(), then
// cancel(), then (once Connect succeeds) sub.Close() means execution runs
// sub.Close() (stop new packets) -> cancel() (stop the audio pacer
// writing more PCM) -> sess.Close() (drain the encoder and flush the
// final segments, which enqueues their uploads) -> r2Writer.Close()
// LAST, so those final uploads actually get a chance to run before the
// writer stops accepting and processing work. Getting this backwards --
// registering the writer's Close after the session's, which used to
// execute it BEFORE session finalization -- was a Farol finding: it
// silently dropped every party's last few segments.
func runServer(cfg config.Config) error {
	r := ring.New(cfg.RingSegments, 90000)

	ctx, cancel := context.WithCancel(context.Background())

	// L1.4: the R2 writer, created (and its Close deferred) before the
	// session -- see this function's own doc comment for why the order
	// matters.
	var r2Writer *r2.Writer
	if cfg.LiveHlsS3Configured() {
		r2Writer = r2.NewWriter(r2.NewUploader(r2.Config{
			Endpoint:        cfg.LiveHlsS3Endpoint,
			Bucket:          cfg.LiveHlsS3Bucket,
			Region:          cfg.LiveHlsS3Region,
			AccessKeyID:     cfg.LiveHlsS3AccessKeyID,
			SecretAccessKey: cfg.LiveHlsS3SecretAccessKey,
			ForcePathStyle:  cfg.LiveHlsS3ForcePathStyle,
		}), r2.WriterConfig{
			QueueDepth: cfg.R2UploadQueueDepth,
			MaxRetries: cfg.R2UploadMaxRetries,
		})
		defer r2Writer.Close()
		log.Printf("pqp-remux: R2 writer enabled: bucket=%s prefix=%s", cfg.LiveHlsS3Bucket, r2.ObjectPrefix(cfg.ChannelID, cfg.StartedAtMs, cfg.Rung))
	}

	sess := session.New(cfg.PartTicks(), cfg.SegmentTicks(), r, nil)
	sess.SetReorderHold(time.Duration(cfg.ReorderHoldMS) * time.Millisecond)
	sess.SetPartDeadlineGrace(time.Duration(cfg.PartDeadlineGraceMS) * time.Millisecond)
	if cfg.ClockCutParts {
		sess.EnableClockCutParts()
	}
	defer sess.Close()
	defer cancel()

	if r2Writer != nil {
		sess.EnableR2(r2Writer, cfg.ChannelID, cfg.StartedAtMs, cfg.Rung)
		// The replay playlists beside the segments. One per process here,
		// unlike the supervisor (internal/control), which keeps one per
		// SESSION so a watchdog restart does not truncate the recording --
		// this binary has no restart to survive.
		sess.EnableVodIndex(r2.NewVodIndex())
	}

	// L1.3: audio. Non-fatal if the encoder subprocess cannot start (e.g.
	// ffmpeg missing) — video passthrough must never depend on this
	// succeeding, per the plan's own instruction to keep the video path
	// untouched.
	audioRing := ring.New(ring.AudioSegments(cfg.RingSegments), aacenc.SampleRate)
	audioEnabled := true
	if err := sess.EnableAudio(ctx, session.AudioConfig{
		Ring:         audioRing,
		PartTicks:    uint32(cfg.PartMS) * aacenc.SampleRate / 1000,
		SegmentTicks: uint32(cfg.SegmentMS) * aacenc.SampleRate / 1000,
		Encoder: aacenc.Config{
			FFmpegPath:  cfg.FFmpegPath,
			BitrateKbps: cfg.AACBitrateKbps,
		},
	}); err != nil {
		audioEnabled = false
		log.Printf("pqp-remux: audio mixing disabled: %v", err)
	}

	sub, err := subscriber.Connect(subscriber.Config{
		URL:       cfg.LiveKitURL,
		APIKey:    cfg.LiveKitAPIKey,
		APISecret: cfg.LiveKitAPISec,
		Room:      cfg.Room,
	}, subscriber.Handlers{
		OnVideoTrackFound: func(*subscriber.Session) { sess.MarkSubscribed() },
		OnVideoPacket:     sess.HandleVideoPacket,
		OnAudioPacket:     sess.HandleAudioPacket,
		// A republished screen continues this session (see
		// session.Session.BeginVideoSource).
		OnVideoSourceChanged: sess.BeginVideoSource,
		OnScreenAudioChanged: sess.ReplaceScreenAudio,
		// Every stage microphone, not just the presenter's screen-share
		// audio above — see subscriber.Handlers.OnMicTrackFound's doc
		// comment for why no further authorization check belongs here.
		// sess.NewMicSink is a harmless no-op sink when EnableAudio
		// failed above (see NewMicSink's doc comment).
		OnMicTrackFound: func(identity string) subscriber.AudioSink { return sess.NewMicSink(identity) },
		// The session ending is the only signal that a trailing partial
		// fragment needs flushing; without this, whatever accumulated
		// since the last part boundary is silently lost. (A track ending
		// mid-session is a presenter between two shares, not an end.)
		OnVideoTrackEnded: sess.Finish,
	})
	if err != nil {
		return fmt.Errorf("connecting to %s room %q: %w", cfg.LiveKitURL, cfg.Room, err)
	}
	defer sub.Close()

	if cfg.KeyframePolicy == keyframe.PolicyPLI {
		keyReq := keyframe.NewRequester(cfg.KeyframeConfig(), sub)
		sess.SetKeyframeRequester(keyReq)
		go keyReq.Run(ctx)
	}

	// The session's own always-on instrumentation and video keep-alive
	// (internal/session.Session.StartMonitor): one stats line every few
	// seconds, and the idle flush that keeps a static screen share's
	// playlist advancing. Started after EnableAudio/EnableR2 so the
	// first line already reports them, and stopped-and-joined FIRST on
	// the way down (this defer is registered after sub.Close's, so it
	// executes before it) -- the keep-alive tick touches the fragmenter,
	// and nothing else should still be doing that while the track's own
	// teardown flushes the trailing fragment.
	stopMonitor := sess.StartMonitor(ctx, "room="+cfg.Room)
	defer stopMonitor()

	srv := serve.New(r, sess)
	if audioEnabled {
		srv.SetAudioRing(audioRing)
	}
	httpServer := &http.Server{Addr: cfg.Listen, Handler: srv}

	log.Printf("pqp-remux: listening on %s, subscribing to room %q at %s (part=%dms segment=%dms policy=%s audio=%t)",
		cfg.Listen, cfg.Room, cfg.LiveKitURL, cfg.PartMS, cfg.SegmentMS, cfg.KeyframePolicy, audioEnabled)

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
//
// A write failure along the way (a full disk, a closed stdout) is
// reported by returning a non-nil error even though every IDR was
// otherwise observed correctly: the whole point of this mode is the CSV
// it produces, so main() must exit non-zero rather than print a summary
// and claim success over data that never reached the file.
func runIDRLog(cfg config.Config) (err error) {
	out := os.Stdout
	if cfg.IDRLogPath != "-" && cfg.IDRLogPath != "" {
		f, ferr := os.Create(cfg.IDRLogPath)
		if ferr != nil {
			return fmt.Errorf("creating %s: %w", cfg.IDRLogPath, ferr)
		}
		defer func() {
			if cerr := f.Close(); cerr != nil && err == nil {
				err = fmt.Errorf("closing %s: %w", cfg.IDRLogPath, cerr)
			}
		}()
		out = f
	}

	scanner := newAccessUnitScanner(idrlog.New(out))

	// readerDone closes when the RTP reader goroutine has fully stopped
	// (subscriber's readRTP calls this after its loop returns, which is
	// strictly after any packet still in flight has already reached
	// scanner.push and, in turn, any OnIDR call has already returned).
	// Waiting on it before reading scanner.writeError() below is what
	// makes that read genuinely synchronized with the writer, not merely
	// "probably done by now" — this is the caller-side half of the fix;
	// accessUnitScanner.firstErr being an atomic.Pointer is the other
	// half, guarding the field itself.
	readerDone := make(chan struct{})
	var closeReaderDoneOnce sync.Once
	// subscriber's own single-track guard (internal/subscriber.go's
	// video.CompareAndSwap) means OnVideoTrackEnded should only ever fire
	// once in practice, but close() on an already-closed channel panics,
	// and this call site should not depend on an invariant enforced in a
	// different file to stay panic-safe.
	closeReaderDone := func() { closeReaderDoneOnce.Do(func() { close(readerDone) }) }

	sub, connErr := subscriber.Connect(subscriber.Config{
		URL:       cfg.LiveKitURL,
		APIKey:    cfg.LiveKitAPIKey,
		APISecret: cfg.LiveKitAPISec,
		Room:      cfg.Room,
	}, subscriber.Handlers{
		OnVideoPacket:     scanner.push,
		OnVideoTrackEnded: closeReaderDone,
	})
	if connErr != nil {
		return fmt.Errorf("connecting to %s room %q: %w", cfg.LiveKitURL, cfg.Room, connErr)
	}

	log.Printf("pqp-remux: idr-log running against room %q for %s", cfg.Room, cfg.Duration)
	time.Sleep(cfg.Duration)

	sub.Close()
	select {
	case <-readerDone:
	case <-time.After(2 * time.Second):
		// No video track was ever found (readRTP, and so
		// OnVideoTrackEnded, never started), or teardown is unusually
		// slow. Either way, wait no longer than this: the summary and
		// error check below still run, just without the same guarantee.
		log.Print("pqp-remux: idr-log: timed out waiting for the RTP reader to stop; the summary below may not reflect the very last IDR")
	}

	fmt.Fprintln(os.Stderr, scanner.logger.Stats().Summary())

	if writeErr := scanner.writeError(); writeErr != nil {
		return fmt.Errorf("idr-log: the CSV is incomplete, at least one write failed: %w", writeErr)
	}
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

	// firstErr is written from the RTP reader's goroutine (push, below)
	// and read from runIDRLog's goroutine after waiting on readerDone. An
	// atomic.Pointer (rather than a plain field, even one guarded by
	// sync.Once) is what makes that cross-goroutine read well-defined: a
	// bare field read racing a Once-guarded write is not automatically
	// synchronized by the Once itself unless the reader also calls Do.
	firstErr atomic.Pointer[error]
}

func newAccessUnitScanner(logger *idrlog.Logger) *accessUnitScanner {
	return &accessUnitScanner{dep: h264.NewDepacketizer(), logger: logger}
}

func (a *accessUnitScanner) push(pkt *rtp.Packet) {
	aus, err := a.dep.Push(pkt.Payload, pkt.Timestamp, pkt.Marker)
	if err != nil {
		log.Printf("pqp-remux: idr-log depacketize: %v", err)
	}
	for _, au := range aus {
		if au == nil || !au.IsIDR {
			continue
		}
		if werr := a.logger.OnIDR(au.PTS, au.Bytes(), time.Now()); werr != nil {
			log.Printf("pqp-remux: idr-log: %v", werr)
			a.firstErr.CompareAndSwap(nil, &werr)
		}
	}
}

// writeError returns the first CSV write failure seen, if any. Call it
// only after readerDone has closed (see runIDRLog): that ordering, plus
// firstErr's own atomicity, is what makes this read see every write the
// reader goroutine ever made, not a possibly-stale snapshot.
func (a *accessUnitScanner) writeError() error {
	if p := a.firstErr.Load(); p != nil {
		return *p
	}
	return nil
}
