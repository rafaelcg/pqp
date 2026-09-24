package film

import (
	"bytes"
	"context"
	"encoding/binary"
	"encoding/json"
	"fmt"
	"io"
	"math"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/rafaelcg/pqp/tools/pqp-remux/internal/r2"
)

// memStore is a bucket in a map.
type memStore struct {
	mu      sync.Mutex
	objects map[string][]byte
	puts    []string
}

func newMemStore() *memStore { return &memStore{objects: map[string][]byte{}} }

func (s *memStore) Get(_ context.Context, key string) (io.ReadCloser, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	b, ok := s.objects[key]
	if !ok {
		return nil, fmt.Errorf("%w: %s", r2.ErrNotFound, key)
	}
	return io.NopCloser(bytes.NewReader(b)), nil
}

func (s *memStore) Exists(_ context.Context, key string) (bool, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	_, ok := s.objects[key]
	return ok, nil
}

func (s *memStore) Put(_ context.Context, key string, body []byte, _ string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.objects[key] = append([]byte(nil), body...)
	s.puts = append(s.puts, key+"="+string(body))
	return nil
}

func (s *memStore) PutFile(ctx context.Context, key, path, ct string) error {
	b, err := os.ReadFile(path)
	if err != nil {
		return err
	}
	return s.Put(ctx, key, b, ct)
}

func needFFmpeg(t *testing.T) {
	t.Helper()
	for _, bin := range []string{"ffmpeg", "ffprobe"} {
		if _, err := exec.LookPath(bin); err != nil {
			t.Skipf("%s not on PATH", bin)
		}
	}
}

// cmafGroup encodes durSec of a test source into CMAF (init + 1 s segments)
// whose decode times start at offsetSec, which is what one of the box's init
// groups looks like, and stores it under prefix with the given names.
// Returns the playlist lines for it.
func cmafGroup(t *testing.T, store *memStore, prefix, kind, size string, offsetSec, durSec float64, initName, segPrefix string, firstIndex int, source ...string) []string {
	t.Helper()
	dir := t.TempDir()
	var input []string
	var codec []string
	switch {
	case len(source) > 0:
		// A lavfi graph of the caller's, plus its -vf/-af.
		input = append([]string{"-f", "lavfi", "-i", source[0]}, source[1:]...)
		if kind == "video" {
			codec = []string{"-c:v", "libx264", "-profile:v", "baseline", "-bf", "0", "-g", "30", "-pix_fmt", "yuv420p"}
		} else {
			codec = []string{"-c:a", "aac", "-b:a", "96k"}
		}
	case kind == "video":
		input = []string{"-f", "lavfi", "-i", "testsrc2=size=" + size + ":rate=30"}
		codec = []string{"-c:v", "libx264", "-profile:v", "baseline", "-bf", "0", "-g", "30", "-pix_fmt", "yuv420p"}
	default:
		input = []string{"-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000"}
		codec = []string{"-c:a", "aac", "-b:a", "96k"}
	}
	args := append([]string{"-v", "error", "-y"}, input...)
	args = append(args, "-t", strconv.FormatFloat(durSec, 'f', 3, 64))
	args = append(args, codec...)
	args = append(args, "-f", "hls", "-hls_time", "1", "-hls_playlist_type", "vod",
		"-hls_segment_type", "fmp4", "-hls_fmp4_init_filename", "init.mp4",
		"-hls_segment_filename", filepath.Join(dir, "seg%d.m4s"), filepath.Join(dir, "out.m3u8"))
	if out, err := exec.Command("ffmpeg", args...).CombinedOutput(); err != nil {
		t.Fatalf("ffmpeg fixture: %v: %s", err, out)
	}
	initBytes, err := os.ReadFile(filepath.Join(dir, "init.mp4"))
	if err != nil {
		t.Fatal(err)
	}
	store.objects[prefix+"/"+initName] = initBytes
	timescale, err := InitTimescale(initBytes)
	if err != nil {
		t.Fatal(err)
	}
	shift := uint64(math.Round(offsetSec * float64(timescale)))
	pl, _ := os.ReadFile(filepath.Join(dir, "out.m3u8"))
	var lines []string
	var extinf string
	n := firstIndex
	for _, line := range strings.Split(string(pl), "\n") {
		switch {
		case strings.HasPrefix(line, "#EXTINF:"):
			extinf = line
		case strings.HasPrefix(line, "seg"):
			b, err := os.ReadFile(filepath.Join(dir, line))
			if err != nil {
				t.Fatal(err)
			}
			name := fmt.Sprintf("%s-%d.m4s", segPrefix, n)
			n++
			// The box writes its session clock into tfdt itself; ffmpeg's
			// muxer starts at zero, so move it there by hand.
			shiftTfdt(t, b, shift)
			store.objects[prefix+"/"+name] = b
			lines = append(lines, extinf, name)
		}
	}
	return lines
}

// shiftTfdt adds ticks to every moof/traf/tfdt in seg, in place.
func shiftTfdt(t *testing.T, seg []byte, ticks uint64) {
	t.Helper()
	var walk func(data []byte, inside string)
	walk = func(data []byte, inside string) {
		for len(data) >= 8 {
			size := int(binary.BigEndian.Uint32(data[0:4]))
			kind := string(data[4:8])
			if size < 8 || size > len(data) {
				t.Fatalf("bad box %q size %d", kind, size)
			}
			body := data[8:size]
			switch {
			case kind == "moof" || (kind == "traf" && inside == "moof"):
				walk(body, kind)
			case kind == "tfdt" && inside == "traf":
				if body[0] == 1 {
					binary.BigEndian.PutUint64(body[4:12], binary.BigEndian.Uint64(body[4:12])+ticks)
				} else {
					v := uint64(binary.BigEndian.Uint32(body[4:8])) + ticks
					if v > math.MaxUint32 {
						t.Fatal("tfdt overflow in fixture")
					}
					binary.BigEndian.PutUint32(body[4:8], uint32(v))
				}
			}
			data = data[size:]
		}
	}
	walk(seg, "")
}

func playlist(parts ...[]string) string {
	out := []string{"#EXTM3U", "#EXT-X-VERSION:7", "#EXT-X-TARGETDURATION:2", "#EXT-X-PLAYLIST-TYPE:VOD", "#EXT-X-MEDIA-SEQUENCE:0"}
	for _, p := range parts {
		out = append(out, p...)
	}
	return strings.Join(append(out, "#EXT-X-ENDLIST", ""), "\n")
}

type probed struct {
	Streams []struct {
		CodecType  string `json:"codec_type"`
		Width      int    `json:"width"`
		Height     int    `json:"height"`
		StartTime  string `json:"start_time"`
		Duration   string `json:"duration"`
		RFrameRate string `json:"r_frame_rate"`
	} `json:"streams"`
	Format struct {
		Duration string `json:"duration"`
	} `json:"format"`
}

func probe(t *testing.T, path string) probed {
	t.Helper()
	out, err := exec.Command("ffprobe", "-v", "error", "-show_streams", "-show_format", "-of", "json", path).Output()
	if err != nil {
		t.Fatalf("ffprobe: %v", err)
	}
	var p probed
	if err := json.Unmarshal(out, &p); err != nil {
		t.Fatal(err)
	}
	return p
}

func f(s string) float64 { v, _ := strconv.ParseFloat(s, 64); return v }

// session builds the shape of a real LL session: video anchored 0.5 s after
// the audio epoch, a resolution change at 4.5 s (new init, same clock), then
// a watchdog restart at ~8 s after which BOTH tracks start over from zero.
func session(t *testing.T, store *memStore, prefix string) Job {
	v1 := cmafGroup(t, store, prefix, "video", "640x360", 0.5, 4, "video-init.mp4", "video-seg", 0)
	v2 := cmafGroup(t, store, prefix, "video", "1280x720", 4.5, 3.5, "video-init-1.mp4", "video-seg", 100)
	v3 := cmafGroup(t, store, prefix, "video", "960x540", 0.3, 3, "video-init-2.mp4", "video-seg", 200)
	a1 := cmafGroup(t, store, prefix, "audio", "", 0, 8, "audio-init.mp4", "audio-seg", 0)
	a2 := cmafGroup(t, store, prefix, "audio", "", 0, 3.3, "audio-init.mp4", "audio-seg", 100)
	video := playlist(
		append([]string{`#EXT-X-MAP:URI="video-init.mp4"`}, v1...),
		append([]string{"#EXT-X-DISCONTINUITY", `#EXT-X-MAP:URI="video-init-1.mp4"`}, v2...),
		append([]string{"#EXT-X-DISCONTINUITY", `#EXT-X-MAP:URI="video-init-2.mp4"`}, v3...),
	)
	audio := playlist(
		append([]string{`#EXT-X-MAP:URI="audio-init.mp4"`}, a1...),
		append([]string{"#EXT-X-DISCONTINUITY"}, a2...),
	)
	store.objects[prefix+"/video.m3u8"] = []byte(video)
	store.objects[prefix+"/audio.m3u8"] = []byte(audio)
	return Job{Prefix: prefix, VideoPlaylist: video, AudioPlaylist: audio}
}

func TestBuildJoinsInitChangesAndARestartIntoOnePlayableFilm(t *testing.T) {
	needFFmpeg(t)
	store := newMemStore()
	job := session(t, store, "live/ch/1-ll")
	out := filepath.Join(t.TempDir(), "film.mp4")
	film, err := Build(context.Background(), store, Config{}, job, out)
	if err != nil {
		t.Fatal(err)
	}
	if keep := os.Getenv("FILM_TEST_KEEP"); keep != "" {
		b, _ := os.ReadFile(out)
		_ = os.WriteFile(keep, b, 0o644)
	}
	// 8 s before the restart (the later track, audio, ends at 8), then the
	// new epoch's 3.3 s of audio: about 11.3 s of film.
	if math.Abs(film.DurationSeconds-11.3) > 0.4 {
		t.Fatalf("duration %.2f, want ~11.3", film.DurationSeconds)
	}
	if film.MissingSegments != 0 {
		t.Fatalf("missing %d", film.MissingSegments)
	}
	p := probe(t, out)
	var v, a int
	for _, s := range p.Streams {
		switch s.CodecType {
		case "video":
			v++
			if s.Width != 1280 || s.Height != 720 || s.RFrameRate != "30/1" {
				t.Fatalf("video %dx%d @ %s, want 1280x720 @ 30/1", s.Width, s.Height, s.RFrameRate)
			}
			if end := f(s.StartTime) + f(s.Duration); math.Abs(end-11.3) > 0.4 {
				t.Fatalf("video ends at %.2f, want ~11.3", end)
			}
		case "audio":
			a++
			if math.Abs(f(s.StartTime)) > 0.1 {
				t.Fatalf("audio starts at %s, want ~0", s.StartTime)
			}
			if math.Abs(f(s.Duration)-11.3) > 0.4 {
				t.Fatalf("audio lasts %s, want ~11.3", s.Duration)
			}
		}
	}
	if v != 1 || a != 1 {
		t.Fatalf("streams: %d video, %d audio", v, a)
	}
	// The half second the video started after the audio is kept.
	for _, st := range p.Streams {
		if st.CodecType == "video" && math.Abs(f(st.StartTime)-0.5) > 0.1 {
			t.Fatalf("video starts at %s, want ~0.5 (the anchor offset)", st.StartTime)
		}
	}
	// Decodes end to end without an error.
	if out, err := exec.Command("ffmpeg", "-v", "error", "-xerror", "-i", out, "-f", "null", "-").CombinedOutput(); err != nil {
		t.Fatalf("film does not decode cleanly: %v %s", err, out)
	}
}

func TestBuildPlaysAcrossASegmentTheBucketLost(t *testing.T) {
	needFFmpeg(t)
	store := newMemStore()
	job := session(t, store, "live/ch/2-ll")
	delete(store.objects, "live/ch/2-ll/video-seg-101.m4s")
	film, err := Build(context.Background(), store, Config{}, job, filepath.Join(t.TempDir(), "film.mp4"))
	if err != nil {
		t.Fatal(err)
	}
	if film.MissingSegments != 1 {
		t.Fatalf("missing %d, want 1", film.MissingSegments)
	}
	if math.Abs(film.DurationSeconds-11.3) > 0.4 {
		t.Fatalf("duration %.2f: a lost segment must leave a hole, not shorten the film", film.DurationSeconds)
	}
}

func TestWorkerUploadsTheFilmAndSaysSo(t *testing.T) {
	needFFmpeg(t)
	store := newMemStore()
	job := session(t, store, "live/ch/3-ll")
	w := NewWorker(store, Config{}, 4)
	if err := w.RunOne(context.Background(), job); err != nil {
		t.Fatal(err)
	}
	if len(store.objects["live/ch/3-ll/film.mp4"]) == 0 {
		t.Fatal("no film.mp4 uploaded")
	}
	var st Status
	if err := json.Unmarshal(store.objects["live/ch/3-ll/film.json"], &st); err != nil {
		t.Fatal(err)
	}
	if st.State != StateReady || st.Bytes != int64(len(store.objects["live/ch/3-ll/film.mp4"])) || st.DurationSeconds <= 0 {
		t.Fatalf("status %+v", st)
	}
	if _, err := time.Parse(time.RFC3339, st.UpdatedAt); err != nil {
		t.Fatalf("updatedAt %q: %v", st.UpdatedAt, err)
	}
	var states []string
	for _, put := range store.puts {
		if strings.HasPrefix(put, "live/ch/3-ll/film.json=") {
			var s Status
			_ = json.Unmarshal([]byte(strings.TrimPrefix(put, "live/ch/3-ll/film.json=")), &s)
			states = append(states, s.State)
		}
	}
	if strings.Join(states, ",") != "processing,ready" {
		t.Fatalf("status sequence %v", states)
	}
}

func TestWorkerDoesNotUploadIntoASweptSession(t *testing.T) {
	needFFmpeg(t)
	store := newMemStore()
	job := session(t, store, "live/ch/4-ll")
	delete(store.objects, "live/ch/4-ll/video.m3u8") // the sweep ran
	if err := NewWorker(store, Config{}, 4).RunOne(context.Background(), job); err != nil {
		t.Fatal(err)
	}
	if _, ok := store.objects["live/ch/4-ll/film.mp4"]; ok {
		t.Fatal("uploaded a film under a swept prefix")
	}
}

func TestWorkerReportsAFailure(t *testing.T) {
	store := newMemStore()
	err := NewWorker(store, Config{}, 4).RunOne(context.Background(), Job{Prefix: "live/ch/5-ll", VideoPlaylist: "#EXTM3U\n"})
	if err == nil {
		t.Fatal("want an error for a session with no video")
	}
	var st Status
	_ = json.Unmarshal(store.objects["live/ch/5-ll/film.json"], &st)
	if st.State != StateFailed || st.Error == "" {
		t.Fatalf("status %+v", st)
	}
}

func TestFirstDecodeTimeAndTimescaleReadTheBoxesFFmpegWrites(t *testing.T) {
	needFFmpeg(t)
	store := newMemStore()
	cmafGroup(t, store, "p", "video", "320x240", 4, 2, "init.mp4", "seg", 0)
	ts, err := InitTimescale(store.objects["p/init.mp4"])
	if err != nil {
		t.Fatal(err)
	}
	tfdt, err := FirstDecodeTime(store.objects["p/seg-1.m4s"])
	if err != nil {
		t.Fatal(err)
	}
	if got := float64(tfdt) / float64(ts); math.Abs(got-5) > 0.05 {
		t.Fatalf("second segment starts at %.3f, want 5", got)
	}
}

// flash is a black picture with one white flash at local time at, and beep
// is silence with one tone at local time at: an event whose position in the
// film can be measured on each track independently.
func flash(size string, at float64) []string {
	return []string{"color=c=black:s=" + size + ":r=30",
		"-vf", fmt.Sprintf("drawbox=c=white:t=fill:enable='between(t,%.3f,%.3f)'", at, at+0.3)}
}

func beep(at float64) []string {
	return []string{"sine=frequency=1000:sample_rate=48000",
		"-af", fmt.Sprintf("volume=0:enable='not(between(t,%.3f,%.3f))'", at, at+0.3)}
}

// events runs a detector filter over one track and returns the times the
// matching log key reports.
func events(t *testing.T, path string, args []string, key string) []float64 {
	t.Helper()
	out, _ := exec.Command("ffmpeg", append(append([]string{"-hide_banner", "-nostats", "-i", path}, args...), "-f", "null", "-")...).CombinedOutput()
	var times []float64
	for _, line := range strings.Split(string(out), "\n") {
		i := strings.Index(line, key)
		if i < 0 {
			continue
		}
		field := strings.Fields(line[i+len(key):])
		if len(field) == 0 {
			continue
		}
		if v, err := strconv.ParseFloat(strings.TrimSpace(field[0]), 64); err == nil {
			times = append(times, v)
		}
	}
	return times
}

// The property the whole timeline exists for: something that happened at
// the same instant on the presenter's screen and in the room's sound is at
// the same instant in the film, before AND after a watchdog restart, with
// the picture starting later than the sound and changing size in between.
func TestBuildKeepsPictureAndSoundInSyncAcrossARestart(t *testing.T) {
	needFFmpeg(t)
	store := newMemStore()
	prefix := "live/ch/sync-ll"
	// Epoch 0: video raw 0.5..4.5 (flash at raw 2.0), then a resolution
	// change 4.5..8; audio raw 0..8 (beep at raw 2.0).
	v1 := cmafGroup(t, store, prefix, "video", "", 0.5, 4, "video-init.mp4", "video-seg", 0, flash("640x360", 1.5)...)
	v2 := cmafGroup(t, store, prefix, "video", "", 4.5, 3.5, "video-init-1.mp4", "video-seg", 100, flash("1280x720", 99)...)
	a1 := cmafGroup(t, store, prefix, "audio", "", 0, 8, "audio-init.mp4", "audio-seg", 0, beep(2.0)...)
	// Epoch 1 (restart, clocks back to zero): video raw 0.3..3.3 with a
	// flash at raw 1.3; audio raw 0..3.3 with a beep at raw 1.3.
	v3 := cmafGroup(t, store, prefix, "video", "", 0.3, 3, "video-init-2.mp4", "video-seg", 200, flash("960x540", 1.0)...)
	a2 := cmafGroup(t, store, prefix, "audio", "", 0, 3.3, "audio-init.mp4", "audio-seg", 100, beep(1.3)...)
	job := Job{
		Prefix: prefix,
		VideoPlaylist: playlist(
			append([]string{`#EXT-X-MAP:URI="video-init.mp4"`}, v1...),
			append([]string{"#EXT-X-DISCONTINUITY", `#EXT-X-MAP:URI="video-init-1.mp4"`}, v2...),
			append([]string{"#EXT-X-DISCONTINUITY", `#EXT-X-MAP:URI="video-init-2.mp4"`}, v3...),
		),
		AudioPlaylist: playlist(
			append([]string{`#EXT-X-MAP:URI="audio-init.mp4"`}, a1...),
			append([]string{"#EXT-X-DISCONTINUITY"}, a2...),
		),
	}
	out := filepath.Join(t.TempDir(), "film.mp4")
	if _, err := Build(context.Background(), store, Config{}, job, out); err != nil {
		t.Fatal(err)
	}
	// Where each flash starts (the end of a black stretch) and each beep
	// starts (the end of a silence), in the film's own presentation time.
	flashes := events(t, out, []string{"-map", "0:v:0", "-vf", "blackdetect=d=0.1:pix_th=0.1"}, "black_end:")
	beeps := events(t, out, []string{"-map", "0:a:0", "-af", "silencedetect=n=-40dB:d=0.1"}, "silence_end:")
	t.Logf("flashes %v beeps %v", flashes, beeps)
	want := []float64{2.0, 9.3} // raw 2.0 in epoch 0; 8 (the shift) + 1.3 in epoch 1
	if len(flashes) < 2 || len(beeps) < 2 {
		t.Fatalf("flashes %v beeps %v, want two of each", flashes, beeps)
	}
	for i, w := range want {
		if math.Abs(flashes[i]-w) > 0.1 {
			t.Errorf("flash %d at %.3f, want %.1f (flashes %v)", i, flashes[i], w, flashes)
		}
		if math.Abs(beeps[i]-w) > 0.1 {
			t.Errorf("beep %d at %.3f, want %.1f (beeps %v)", i, beeps[i], w, beeps)
		}
		if math.Abs(flashes[i]-beeps[i]) > 0.07 {
			t.Errorf("event %d: picture at %.3f, sound at %.3f: out of sync", i, flashes[i], beeps[i])
		}
	}
}

// A REBIND IS ONE CLOCK. The presenter republished their screen in the
// middle of the show (a new track, a smaller window) and the box bound it
// inside the same session (internal/session.BeginVideoSource): the video
// playlist switches init with a discontinuity, but the tfdt carries straight
// on, and the audio never noticed. The film must come out as one continuous
// file of the show's length, with no shift where the rebind was and nothing
// dropped around it.
func TestBuildJoinsARebindIntoOneContinuousFilm(t *testing.T) {
	needFFmpeg(t)
	store := newMemStore()
	prefix := "live/ch/3-ll"
	v1 := cmafGroup(t, store, prefix, "video", "1280x720", 0.5, 6, "video-init.mp4", "video-seg", 0)
	v2 := cmafGroup(t, store, prefix, "video", "640x360", 6.5, 5, "video-init-2.mp4", "video-seg", 6)
	a := cmafGroup(t, store, prefix, "audio", "", 0, 11.5, "audio-init.mp4", "audio-seg", 0)
	video := playlist(
		append([]string{`#EXT-X-MAP:URI="video-init.mp4"`}, v1...),
		append([]string{"#EXT-X-DISCONTINUITY", `#EXT-X-MAP:URI="video-init-2.mp4"`}, v2...),
	)
	audio := playlist(append([]string{`#EXT-X-MAP:URI="audio-init.mp4"`}, a...))
	store.objects[prefix+"/video.m3u8"] = []byte(video)
	store.objects[prefix+"/audio.m3u8"] = []byte(audio)
	job := Job{Prefix: prefix, VideoPlaylist: video, AudioPlaylist: audio}

	out := filepath.Join(t.TempDir(), "film.mp4")
	film, err := Build(context.Background(), store, Config{}, job, out)
	if err != nil {
		t.Fatal(err)
	}
	if math.Abs(film.DurationSeconds-11.5) > 0.4 {
		t.Fatalf("duration %.2f, want ~11.5: the rebind was read as a restart and the film re-laid", film.DurationSeconds)
	}
	if film.MissingSegments != 0 {
		t.Fatalf("missing %d", film.MissingSegments)
	}
	p := probe(t, out)
	for _, s := range p.Streams {
		if s.CodecType == "video" {
			if math.Abs(f(s.StartTime)-0.5) > 0.1 {
				t.Fatalf("video starts at %s, want ~0.5 (the anchor offset, untouched)", s.StartTime)
			}
			if end := f(s.StartTime) + f(s.Duration); math.Abs(end-11.5) > 0.4 {
				t.Fatalf("video ends at %.2f, want ~11.5", end)
			}
		}
	}
	if out, err := exec.Command("ffmpeg", "-v", "error", "-xerror", "-i", out, "-f", "null", "-").CombinedOutput(); err != nil {
		t.Fatalf("film does not decode cleanly: %v %s", err, out)
	}
}
