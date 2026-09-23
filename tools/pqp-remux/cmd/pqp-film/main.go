// Command pqp-film makes the film of one finished LL session by hand: the
// same job pqp-remuxd runs when a session ends (internal/film), for a
// session that ended before the box knew how, whose job failed, or that was
// cut off by a restart of the box.
//
//	pqp-film -prefix live/<channel>/<startedAt>-ll            # build and upload
//	pqp-film -prefix live/<channel>/<startedAt>-ll -out f.mp4  # build locally only
//
// Reads the same environment as pqp-remuxd (LIVE_HLS_S3_*, FFMPEG_PATH), so
// on the egress box: `set -a; . /etc/pqp-remux.env; set +a; pqp-film ...`.
// The session's own video.m3u8 and audio.m3u8 are read from the bucket.
package main

import (
	"context"
	"flag"
	"io"
	"log"
	"os"
	"os/signal"
	"strings"
	"syscall"

	"github.com/rafaelcg/pqp/tools/pqp-remux/internal/film"
	"github.com/rafaelcg/pqp/tools/pqp-remux/internal/r2"
)

func main() {
	prefix := flag.String("prefix", "", "the session's object prefix, live/<channel>/<startedAt>-ll")
	out := flag.String("out", "", "write the film here and upload nothing")
	threads := flag.Int("threads", 2, "x264 threads")
	nice := flag.Bool("nice", true, "run ffmpeg under nice -n 19")
	flag.Parse()
	p := strings.TrimSuffix(strings.TrimSpace(*prefix), "/")
	if p == "" || !strings.HasPrefix(p, "live/") {
		log.Fatal("pqp-film: -prefix live/<channel>/<startedAt>-ll is required")
	}

	cfg := r2.Config{
		Endpoint:        os.Getenv("LIVE_HLS_S3_ENDPOINT"),
		Bucket:          os.Getenv("LIVE_HLS_S3_BUCKET"),
		Region:          os.Getenv("LIVE_HLS_S3_REGION"),
		AccessKeyID:     os.Getenv("LIVE_HLS_S3_ACCESS_KEY_ID"),
		SecretAccessKey: os.Getenv("LIVE_HLS_S3_SECRET_ACCESS_KEY"),
		ForcePathStyle:  os.Getenv("LIVE_HLS_S3_FORCE_PATH_STYLE") == "true",
	}
	if !cfg.Configured() {
		log.Fatal("pqp-film: LIVE_HLS_S3_ENDPOINT/BUCKET/ACCESS_KEY_ID/SECRET_ACCESS_KEY are required")
	}
	store := r2.NewObjectClient(cfg)

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	job := film.Job{Prefix: p}
	var err error
	if job.VideoPlaylist, err = readObject(ctx, store, p+"/video.m3u8"); err != nil {
		log.Fatalf("pqp-film: %v", err)
	}
	if job.AudioPlaylist, err = readObject(ctx, store, p+"/audio.m3u8"); err != nil {
		log.Printf("pqp-film: no audio playlist (%v); the film will be silent", err)
	}

	fc := film.Config{FFmpegPath: os.Getenv("FFMPEG_PATH"), Threads: *threads, Nice: *nice, WorkDir: os.Getenv("FILM_WORK_DIR")}
	if *out != "" {
		f, err := film.Build(ctx, store, fc, job, *out)
		if err != nil {
			log.Fatalf("pqp-film: %v", err)
		}
		log.Printf("pqp-film: wrote %s: %.1fs, %d bytes, %d missing segments", f.Path, f.DurationSeconds, f.Bytes, f.MissingSegments)
		return
	}
	if err := film.NewWorker(store, fc, 1).RunOne(ctx, job); err != nil {
		log.Fatalf("pqp-film: %v", err)
	}
}

func readObject(ctx context.Context, store *r2.ObjectClient, key string) (string, error) {
	body, err := store.Get(ctx, key)
	if err != nil {
		return "", err
	}
	defer body.Close()
	b, err := io.ReadAll(body)
	return string(b), err
}
