package r2

import (
	"strings"
	"testing"
)

// One init change mid-show, which is the shape the 2026-09-21 broadcast had
// thirty-five times over: the segments before it keep the init that
// describes them, the change is announced with DISCONTINUITY ahead of the
// new MAP, and the whole list is there (nothing trimmed by a ring).
func TestVodIndex_VideoPlaylistGoldenWithOneInitChange(t *testing.T) {
	v := NewVodIndex()
	v.AddVideoSegment(VodSegment{Name: "video-seg-0.m4s", Seconds: 4.0, InitURI: "video-init.mp4", Discontinuity: true}, 400_000)
	v.AddVideoSegment(VodSegment{Name: "video-seg-1.m4s", Seconds: 3.967, InitURI: "video-init.mp4"}, 400_000)
	v.AddVideoSegment(VodSegment{Name: "video-seg-2.m4s", Seconds: 5.2, InitURI: "video-init-2.mp4", Discontinuity: true}, 400_000)
	v.AddVideoSegment(VodSegment{Name: "video-seg-3.m4s", Seconds: 4.033, InitURI: "video-init-2.mp4"}, 400_000)

	got, ok := v.VideoPlaylist()
	if !ok {
		t.Fatal("expected a playlist")
	}
	want := strings.Join([]string{
		"#EXTM3U",
		"#EXT-X-VERSION:7",
		"#EXT-X-TARGETDURATION:6",
		"#EXT-X-PLAYLIST-TYPE:EVENT",
		"#EXT-X-MEDIA-SEQUENCE:0",
		"#EXT-X-INDEPENDENT-SEGMENTS",
		`#EXT-X-MAP:URI="video-init.mp4"`,
		"#EXTINF:4.000,",
		"video-seg-0.m4s",
		"#EXTINF:3.967,",
		"video-seg-1.m4s",
		"#EXT-X-DISCONTINUITY",
		`#EXT-X-MAP:URI="video-init-2.mp4"`,
		"#EXTINF:5.200,",
		"video-seg-2.m4s",
		"#EXTINF:4.033,",
		"video-seg-3.m4s",
		"",
	}, "\n")
	if got != want {
		t.Fatalf("playlist mismatch\n--- got ---\n%s\n--- want ---\n%s", got, want)
	}
}

// Finish flips EVENT to VOD and closes the list; a segment arriving after
// it (a watchdog replacement's first) reopens it, so the object the last
// PUT leaves behind is always the truthful one.
func TestVodIndex_FinishWritesEndlistAndVod(t *testing.T) {
	v := NewVodIndex()
	v.AddVideoSegment(VodSegment{Name: "video-seg-0.m4s", Seconds: 4, InitURI: "video-init.mp4"}, 1000)
	v.AddAudioSegment(VodSegment{Name: "audio-seg-0.m4s", Seconds: 4, InitURI: "audio-init.mp4"}, 1000)
	v.Finish()

	for name, render := range map[string]func() (string, bool){"video": v.VideoPlaylist, "audio": v.AudioPlaylist} {
		got, _ := render()
		if !strings.Contains(got, "#EXT-X-PLAYLIST-TYPE:VOD\n") || strings.Contains(got, "EVENT") {
			t.Fatalf("%s: expected PLAYLIST-TYPE:VOD after Finish, got\n%s", name, got)
		}
		if !strings.HasSuffix(got, "#EXT-X-ENDLIST\n") {
			t.Fatalf("%s: expected a trailing ENDLIST after Finish, got\n%s", name, got)
		}
	}

	v.AddVideoSegment(VodSegment{Name: "video-seg-2.m4s", Seconds: 4, InitURI: "video-init-2.mp4", Discontinuity: true}, 1000)
	got, _ := v.VideoPlaylist()
	if strings.Contains(got, "ENDLIST") || !strings.Contains(got, "PLAYLIST-TYPE:EVENT") {
		t.Fatalf("a segment after Finish must reopen the playlist, got\n%s", got)
	}
}

// A segment uploaded twice replaces its own line; a duplicate would be a
// second copy of the same four seconds in somebody's replay.
func TestVodIndex_ReaddingASegmentReplacesIt(t *testing.T) {
	v := NewVodIndex()
	v.AddAudioSegment(VodSegment{Name: "audio-seg-0.m4s", Seconds: 2, InitURI: "audio-init.mp4"}, 10)
	v.AddAudioSegment(VodSegment{Name: "audio-seg-0.m4s", Seconds: 4, InitURI: "audio-init.mp4"}, 10)
	got, _ := v.AudioPlaylist()
	if strings.Count(got, "audio-seg-0.m4s") != 1 || !strings.Contains(got, "#EXTINF:4.000,") {
		t.Fatalf("expected one line for the segment at its final duration, got\n%s", got)
	}
}

// The audio track keeps one init across a watchdog restart, so the only
// thing that marks the timestamp reset is the flag itself.
func TestVodIndex_DiscontinuityOnUnchangedInit(t *testing.T) {
	v := NewVodIndex()
	v.AddAudioSegment(VodSegment{Name: "audio-seg-0.m4s", Seconds: 4, InitURI: "audio-init.mp4", Discontinuity: true}, 10)
	v.AddAudioSegment(VodSegment{Name: "audio-seg-5.m4s", Seconds: 4, InitURI: "audio-init.mp4", Discontinuity: true}, 10)
	got, _ := v.AudioPlaylist()
	if strings.Count(got, "#EXT-X-DISCONTINUITY") != 1 || strings.Count(got, "#EXT-X-MAP") != 1 {
		t.Fatalf("expected one DISCONTINUITY (not ahead of the first segment) and one MAP, got\n%s", got)
	}
	if strings.Index(got, "#EXT-X-DISCONTINUITY") < strings.Index(got, "audio-seg-0.m4s") {
		t.Fatalf("the DISCONTINUITY belongs before the second segment, got\n%s", got)
	}
}

func TestVodIndex_MasterPlaylist(t *testing.T) {
	v := NewVodIndex()
	if _, ok := v.MasterPlaylist(); ok {
		t.Fatal("no master before there is any video")
	}
	v.SetVideoInit("avc1.42c01f", 1280, 720)
	// 1 MB over 4 s is 2 Mbit/s of video; 64 KB over 4 s is 131072 bit/s.
	v.AddVideoSegment(VodSegment{Name: "video-seg-0.m4s", Seconds: 4, InitURI: "video-init.mp4"}, 1_000_000)
	v.AddAudioSegment(VodSegment{Name: "audio-seg-0.m4s", Seconds: 4, InitURI: "audio-init.mp4"}, 65_536)

	got, ok := v.MasterPlaylist()
	if !ok {
		t.Fatal("expected a master")
	}
	want := strings.Join([]string{
		"#EXTM3U",
		"#EXT-X-VERSION:7",
		"#EXT-X-INDEPENDENT-SEGMENTS",
		`#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio",NAME="audio",DEFAULT=YES,AUTOSELECT=YES,URI="audio.m3u8"`,
		`#EXT-X-STREAM-INF:BANDWIDTH=2131072,RESOLUTION=1280x720,CODECS="avc1.42c01f,mp4a.40.2",AUDIO="audio"`,
		"video.m3u8",
		"",
	}, "\n")
	if got != want {
		t.Fatalf("master mismatch\n--- got ---\n%s\n--- want ---\n%s", got, want)
	}
}

// Every method is a no-op on a nil index, which is what lets a Session with
// no bucket call them unconditionally.
func TestVodIndex_NilIsSafe(t *testing.T) {
	var v *VodIndex
	v.SetVideoInit("avc1", 1, 1)
	v.AddVideoSegment(VodSegment{Name: "x"}, 1)
	v.AddAudioSegment(VodSegment{Name: "x"}, 1)
	v.Finish()
	if v.HasVideo() {
		t.Fatal("nil index has no video")
	}
	if _, ok := v.VideoPlaylist(); ok {
		t.Fatal("nil index renders nothing")
	}
}
