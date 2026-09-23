package film

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"log"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"sync"

	"github.com/rafaelcg/pqp/tools/pqp-remux/internal/r2"
)

// Store is the bucket, as this package needs it. internal/r2.ObjectClient is
// the real one; tests use a directory. Get must wrap r2.ErrNotFound for a
// key the bucket does not have.
type Store interface {
	Get(ctx context.Context, key string) (io.ReadCloser, error)
	Exists(ctx context.Context, key string) (bool, error)
	Put(ctx context.Context, key string, body []byte, contentType string) error
	PutFile(ctx context.Context, key, path, contentType string) error
}

// Config is how a build runs.
type Config struct {
	// FFmpegPath / FFprobePath default to "ffmpeg" / "ffprobe" on PATH.
	FFmpegPath  string
	FFprobePath string
	// WorkDir is where the scratch directory goes (default os.TempDir()).
	// A two-hour show needs a few gigabytes here for the length of the job.
	WorkDir string
	// Threads caps x264 (default 2). The box has four cores and the next
	// show's live transcodes need them more than a replay does.
	Threads int
	// Nice runs every ffmpeg under `nice -n 19` when `nice` is on PATH.
	Nice bool
	// DownloadWorkers is how many segments are fetched at once (default 8).
	// One at a time, a two-hour show is 7,000 round trips to the bucket.
	DownloadWorkers int
	// Width/Height/FPS of the film (default 1280x720 at 30).
	Width, Height, FPS int
}

func (c Config) withDefaults() Config {
	if c.FFmpegPath == "" {
		c.FFmpegPath = "ffmpeg"
	}
	if c.FFprobePath == "" {
		dir := filepath.Dir(c.FFmpegPath)
		if dir != "." {
			c.FFprobePath = filepath.Join(dir, "ffprobe")
		} else {
			c.FFprobePath = "ffprobe"
		}
	}
	if c.WorkDir == "" {
		c.WorkDir = os.TempDir()
	}
	if c.Threads <= 0 {
		c.Threads = 2
	}
	if c.DownloadWorkers <= 0 {
		c.DownloadWorkers = 8
	}
	if c.Width <= 0 || c.Height <= 0 {
		c.Width, c.Height = 1280, 720
	}
	if c.FPS <= 0 {
		c.FPS = 30
	}
	return c
}

// Job is one finished session.
type Job struct {
	// Prefix is the session's object prefix, `live/<channel>/<startedAt>-ll`,
	// with no trailing slash. Playlist names resolve under `<Prefix>/`.
	Prefix        string
	VideoPlaylist string
	AudioPlaylist string
}

// Film is what a build produced.
type Film struct {
	Path            string
	Bytes           int64
	DurationSeconds float64
	// MissingSegments counts playlist entries the bucket did not have. The
	// film still plays across them (the clock comes from each segment's own
	// tfdt), but a large number is worth a log line.
	MissingSegments int
}

// track is one rendition, downloaded: each group as one fragmented MP4 on
// disk, with its place on the raw clock.
type track struct {
	files []string
	spans []Span
}

// Build downloads a session's media and writes the film to outPath. It does
// not upload anything. workDir scratch is removed before it returns.
func Build(ctx context.Context, store Store, cfg Config, job Job, outPath string) (Film, error) {
	cfg = cfg.withDefaults()
	videoGroups, err := ParsePlaylist(job.VideoPlaylist)
	if err != nil {
		return Film{}, fmt.Errorf("video playlist: %w", err)
	}
	audioGroups, err := ParsePlaylist(job.AudioPlaylist)
	if err != nil {
		return Film{}, fmt.Errorf("audio playlist: %w", err)
	}
	if len(videoGroups) == 0 {
		return Film{}, errors.New("film: the session has no video segments")
	}

	scratch, err := os.MkdirTemp(cfg.WorkDir, "pqp-film-")
	if err != nil {
		return Film{}, err
	}
	defer os.RemoveAll(scratch)

	missing := 0
	video, m, err := downloadTrack(ctx, store, cfg, job.Prefix, videoGroups, filepath.Join(scratch, "v"))
	if err != nil {
		return Film{}, fmt.Errorf("video: %w", err)
	}
	missing += m
	if len(video.files) == 0 {
		return Film{}, errors.New("film: no video segment could be read")
	}
	audio, m, err := downloadTrack(ctx, store, cfg, job.Prefix, audioGroups, filepath.Join(scratch, "a"))
	if err != nil {
		return Film{}, fmt.Errorf("audio: %w", err)
	}
	missing += m

	vOff, aOff := Offsets(video.spans, audio.spans)

	// MPEG-TS per group, on the film's timeline, concatenated per track. The
	// +10 s keeps every timestamp positive whatever the offsets did.
	videoTS := filepath.Join(scratch, "video.ts")
	if err := remuxTrack(ctx, cfg, video, vOff, "v", videoTS); err != nil {
		return Film{}, err
	}
	combined := filepath.Join(scratch, "combined.ts")
	args := []string{"-v", "error", "-y", "-copyts", "-i", videoTS}
	maps := []string{"-map", "0:v:0"}
	if len(audio.files) > 0 {
		audioTS := filepath.Join(scratch, "audio.ts")
		if err := remuxTrack(ctx, cfg, audio, aOff, "a", audioTS); err != nil {
			return Film{}, err
		}
		args = append(args, "-copyts", "-i", audioTS)
		maps = append(maps, "-map", "1:a:0")
	}
	args = append(args, maps...)
	args = append(args, "-c", "copy", "-copyts", "-muxdelay", "0", "-muxpreload", "0", "-f", "mpegts", combined)
	if err := runFFmpeg(ctx, cfg, args); err != nil {
		return Film{}, fmt.Errorf("film: joining the tracks: %w", err)
	}
	removeGlob(scratch, "*.ts", combined)

	// The one re-encode: fixed size, constant frame rate, faststart. Without
	// -copyts ffmpeg shifts the whole file so it starts at zero, which moves
	// both tracks together and keeps the offset between them.
	//
	// The frame rate comes from an fps filter, as in the hand recovery. Each
	// resolution change rebuilds the filter graph, and an fps filter rebuilt
	// with it does not fill the gap back to the frame before, so the moment
	// a watchdog restart skipped (a fraction of a second) is a held picture
	// rather than duplicated frames. Every other way of forcing constant
	// frame rate tried here moved the picture relative to the sound
	// (`-fps_mode cfr` starts the video at zero, `-reinit_filter 0` folds
	// timestamps together), which is worse than a short variable-rate stretch.
	// Checked against ffmpeg 6.1 (Ubuntu 24.04, what the box runs) and 8.
	vf := fmt.Sprintf(
		"scale=%d:%d:force_original_aspect_ratio=decrease:flags=lanczos,pad=%d:%d:(ow-iw)/2:(oh-ih)/2,fps=%d,format=yuv420p",
		cfg.Width, cfg.Height, cfg.Width, cfg.Height, cfg.FPS)
	encode := []string{"-v", "error", "-y", "-i", combined, "-map", "0:v:0", "-map", "0:a:0?",
		// passthrough: the fps filter already made the frames constant-rate,
		// and letting the muxer's own frame-rate logic run as well is what
		// differs between ffmpeg versions. 6.1 (the box) defaults to cfr for
		// MP4 and starts the picture at zero, pulling it earlier than the
		// sound by however late the video started; 8 does not. Passthrough
		// keeps the first picture where it was on both.
		"-vf", vf, "-fps_mode", "passthrough",
		"-c:v", "libx264", "-preset", "veryfast", "-crf", "22", "-threads", strconv.Itoa(cfg.Threads),
		"-af", "aresample=async=1", "-c:a", "aac", "-b:a", "160k",
		"-max_muxing_queue_size", "4096",
		"-movflags", "+faststart", "-f", "mp4", outPath}
	if err := runFFmpeg(ctx, cfg, encode); err != nil {
		return Film{}, fmt.Errorf("film: encoding: %w", err)
	}

	info, err := os.Stat(outPath)
	if err != nil {
		return Film{}, err
	}
	duration, err := probeDuration(ctx, cfg, outPath)
	if err != nil {
		return Film{}, fmt.Errorf("film: the encoded file does not probe: %w", err)
	}
	if duration <= 0 || info.Size() == 0 {
		return Film{}, fmt.Errorf("film: the encoded file is empty (%.1fs, %d bytes)", duration, info.Size())
	}
	return Film{Path: outPath, Bytes: info.Size(), DurationSeconds: duration, MissingSegments: missing}, nil
}

// downloadTrack fetches every segment of every group (DownloadWorkers at a
// time) and writes each group as init + segments into one file. A segment
// the bucket does not have is skipped and counted: the group still decodes,
// with a hole where it was. A group whose init is missing is dropped whole,
// since none of its segments can be decoded without it.
func downloadTrack(ctx context.Context, store Store, cfg Config, prefix string, groups []Group, dir string) (track, int, error) {
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return track{}, 0, err
	}
	type item struct {
		group, index int
		name         string
		path         string
	}
	var items []item
	for g, group := range groups {
		items = append(items, item{group: g, index: -1, name: group.Init, path: filepath.Join(dir, fmt.Sprintf("g%05d-init", g))})
		for i, seg := range group.Segments {
			items = append(items, item{group: g, index: i, name: seg.Name, path: filepath.Join(dir, fmt.Sprintf("g%05d-s%06d", g, i))})
		}
	}

	present := make([]bool, len(items))
	var firstErr error
	var errMu sync.Mutex
	work := make(chan int)
	var wg sync.WaitGroup
	for w := 0; w < cfg.DownloadWorkers; w++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for i := range work {
				ok, err := fetchTo(ctx, store, objectKey(prefix, items[i].name), items[i].path)
				if err != nil {
					errMu.Lock()
					if firstErr == nil {
						firstErr = err
					}
					errMu.Unlock()
					continue
				}
				present[i] = ok
			}
		}()
	}
	for i := range items {
		if ctx.Err() != nil {
			break
		}
		work <- i
	}
	close(work)
	wg.Wait()
	if firstErr != nil {
		return track{}, 0, firstErr
	}
	if err := ctx.Err(); err != nil {
		return track{}, 0, err
	}

	var out track
	missing := 0
	first := 0 // index into items of this group's init
	for g, group := range groups {
		initIdx := first
		first += 1 + len(group.Segments)
		initItem := items[initIdx]
		if !present[initIdx] {
			log.Printf("pqp-film: %s: init %s is missing; dropping its %d segments", prefix, group.Init, len(group.Segments))
			missing += len(group.Segments)
			continue
		}
		initBytes, err := os.ReadFile(initItem.path)
		if err != nil {
			return track{}, 0, err
		}
		timescale, err := InitTimescale(initBytes)
		if err != nil {
			return track{}, 0, fmt.Errorf("init %s: %w", group.Init, err)
		}
		groupPath := filepath.Join(dir, fmt.Sprintf("group-%05d.mp4", g))
		f, err := os.Create(groupPath)
		if err != nil {
			return track{}, 0, err
		}
		if _, err := f.Write(initBytes); err != nil {
			f.Close()
			return track{}, 0, err
		}
		span := Span{Start: -1}
		for i := range group.Segments {
			idx := initIdx + 1 + i
			si := items[idx]
			if !present[idx] {
				missing++
				continue
			}
			data, err := os.ReadFile(si.path)
			if err != nil {
				f.Close()
				return track{}, 0, err
			}
			tfdt, err := FirstDecodeTime(data)
			if err != nil {
				log.Printf("pqp-film: %s: %s has no readable tfdt (%v); skipping it", prefix, si.name, err)
				missing++
				continue
			}
			start := float64(tfdt) / float64(timescale)
			if span.Start < 0 {
				span.Start = start
			}
			span.End = start + group.Segments[i].Seconds
			if _, err := f.Write(data); err != nil {
				f.Close()
				return track{}, 0, err
			}
			os.Remove(si.path)
		}
		if err := f.Close(); err != nil {
			return track{}, 0, err
		}
		os.Remove(initItem.path)
		if span.Start < 0 {
			os.Remove(groupPath)
			continue
		}
		out.files = append(out.files, groupPath)
		out.spans = append(out.spans, span)
	}
	return out, missing, nil
}

func objectKey(prefix, name string) string {
	if strings.Contains(name, "/") {
		return name
	}
	return prefix + "/" + name
}

// fetchTo writes one object to path. (false, nil) is "the bucket does not
// have it"; an error is anything else, and fails the build, because a
// storage outage must not quietly produce a film full of holes.
func fetchTo(ctx context.Context, store Store, key, path string) (bool, error) {
	var lastErr error
	for attempt := 0; attempt < 3; attempt++ {
		body, err := store.Get(ctx, key)
		if err != nil {
			if errors.Is(err, r2.ErrNotFound) {
				return false, nil
			}
			lastErr = err
			continue
		}
		f, err := os.Create(path)
		if err != nil {
			body.Close()
			return false, err
		}
		_, copyErr := io.Copy(f, body)
		body.Close()
		closeErr := f.Close()
		if copyErr == nil && closeErr == nil {
			return true, nil
		}
		lastErr = errors.Join(copyErr, closeErr)
		if ctx.Err() != nil {
			return false, ctx.Err()
		}
	}
	return false, fmt.Errorf("fetching %s: %w", key, lastErr)
}

// remuxTrack writes each group as MPEG-TS at its place on the film's
// timeline and concatenates them into out.
func remuxTrack(ctx context.Context, cfg Config, t track, offsets []float64, kind, out string) error {
	dst, err := os.Create(out)
	if err != nil {
		return err
	}
	defer dst.Close()
	for i, src := range t.files {
		ts := strings.TrimSuffix(src, ".mp4") + ".ts"
		args := []string{"-v", "error", "-y", "-i", src, "-map", "0:" + kind + ":0", "-c", "copy",
			"-copyts", "-output_ts_offset", strconv.FormatFloat(10+offsets[i], 'f', 6, 64),
			"-muxdelay", "0", "-muxpreload", "0"}
		if kind == "v" {
			args = append(args, "-bsf:v", "h264_mp4toannexb")
		}
		args = append(args, "-f", "mpegts", ts)
		if err := runFFmpeg(ctx, cfg, args); err != nil {
			return fmt.Errorf("film: remuxing %s: %w", filepath.Base(src), err)
		}
		os.Remove(src)
		part, err := os.Open(ts)
		if err != nil {
			return err
		}
		_, err = io.Copy(dst, part)
		part.Close()
		os.Remove(ts)
		if err != nil {
			return err
		}
	}
	return dst.Close()
}

func removeGlob(dir, pattern, keep string) {
	matches, _ := filepath.Glob(filepath.Join(dir, pattern))
	for _, m := range matches {
		if m != keep {
			os.Remove(m)
		}
	}
}

func command(ctx context.Context, cfg Config, bin string, args []string) *exec.Cmd {
	if cfg.Nice {
		if nice, err := exec.LookPath("nice"); err == nil {
			return exec.CommandContext(ctx, nice, append([]string{"-n", "19", bin}, args...)...)
		}
	}
	return exec.CommandContext(ctx, bin, args...)
}

func runFFmpeg(ctx context.Context, cfg Config, args []string) error {
	cmd := command(ctx, cfg, cfg.FFmpegPath, append([]string{"-nostdin"}, args...))
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	if err := cmd.Run(); err != nil {
		msg := strings.TrimSpace(stderr.String())
		if len(msg) > 800 {
			msg = msg[len(msg)-800:]
		}
		return fmt.Errorf("%w: %s", err, msg)
	}
	return nil
}

func probeDuration(ctx context.Context, cfg Config, path string) (float64, error) {
	cmd := exec.CommandContext(ctx, cfg.FFprobePath, "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", path)
	out, err := cmd.Output()
	if err != nil {
		return 0, err
	}
	return strconv.ParseFloat(strings.TrimSpace(string(out)), 64)
}
