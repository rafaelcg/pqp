package serve

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/rafaelcg/pqp/tools/pqp-remux/internal/pipeline"
	"github.com/rafaelcg/pqp/tools/pqp-remux/internal/ring"
)

func TestServer_InitNotReady(t *testing.T) {
	s := New(ring.New(6, 90000), nil)
	rec := httptest.NewRecorder()
	s.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/init.mp4", nil))
	if rec.Code != http.StatusServiceUnavailable {
		t.Fatalf("status = %d, want 503 before SetInit", rec.Code)
	}
}

func TestServer_InitServed(t *testing.T) {
	r := ring.New(6, 90000)
	r.SetInit([]byte("ftyp+moov bytes"))
	s := New(r, nil)

	rec := httptest.NewRecorder()
	s.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/init.mp4", nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d", rec.Code)
	}
	if rec.Body.String() != "ftyp+moov bytes" {
		t.Fatalf("body = %q", rec.Body.String())
	}
	if ct := rec.Header().Get("Content-Type"); ct != "video/mp4" {
		t.Fatalf("Content-Type = %q", ct)
	}
}

func TestServer_PartAndSegment(t *testing.T) {
	r := ring.New(6, 90000)
	r.Push(&pipeline.Fragment{SequenceNumber: 5, SegmentIndex: 0, IsSegmentStart: true, DurationTicks: 45000, Bytes: []byte("part-bytes")})
	s := New(r, nil)

	rec := httptest.NewRecorder()
	s.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/part-5.m4s", nil))
	if rec.Code != http.StatusOK || rec.Body.String() != "part-bytes" {
		t.Fatalf("GET /part-5.m4s: status=%d body=%q", rec.Code, rec.Body.String())
	}

	rec = httptest.NewRecorder()
	s.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/part-999.m4s", nil))
	if rec.Code != http.StatusNotFound {
		t.Fatalf("GET /part-999.m4s: status=%d, want 404", rec.Code)
	}

	rec = httptest.NewRecorder()
	s.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/seg-0.m4s", nil))
	if rec.Code != http.StatusOK || rec.Body.String() != "part-bytes" {
		t.Fatalf("GET /seg-0.m4s: status=%d body=%q", rec.Code, rec.Body.String())
	}

	rec = httptest.NewRecorder()
	s.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/seg-7.m4s", nil))
	if rec.Code != http.StatusNotFound {
		t.Fatalf("GET /seg-7.m4s: status=%d, want 404", rec.Code)
	}
}

func TestServer_Playlist(t *testing.T) {
	r := ring.New(6, 90000)
	r.Push(&pipeline.Fragment{SequenceNumber: 1, SegmentIndex: 0, IsSegmentStart: true, DurationTicks: 90000, Bytes: []byte("a")})
	r.Push(&pipeline.Fragment{SequenceNumber: 2, SegmentIndex: 1, IsSegmentStart: true, DurationTicks: 90000, Bytes: []byte("b")})
	s := New(r, nil)

	rec := httptest.NewRecorder()
	s.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/playlist.m3u8", nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d", rec.Code)
	}
	body := rec.Body.String()
	if !strings.HasPrefix(body, "#EXTM3U\n") {
		t.Fatalf("playlist does not start with #EXTM3U:\n%s", body)
	}
	if !strings.Contains(body, "seg-0.m4s") {
		t.Fatalf("expected sealed segment 0 in playlist:\n%s", body)
	}
}

func TestServer_HealthzDefaultsToStarting(t *testing.T) {
	s := New(ring.New(6, 90000), nil)
	rec := httptest.NewRecorder()
	s.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/healthz", nil))
	var h Health
	if err := json.Unmarshal(rec.Body.Bytes(), &h); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if h.Status != "starting" {
		t.Fatalf("Status = %q, want starting", h.Status)
	}
}

type fakeHealth struct{ h Health }

func (f fakeHealth) Health() Health { return f.h }

func TestServer_HealthzUsesSource(t *testing.T) {
	s := New(ring.New(6, 90000), fakeHealth{Health{Status: "ok", Subscribed: true, PartsWritten: 42}})
	rec := httptest.NewRecorder()
	s.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/healthz", nil))
	var h Health
	if err := json.Unmarshal(rec.Body.Bytes(), &h); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if h.Status != "ok" || !h.Subscribed || h.PartsWritten != 42 {
		t.Fatalf("unexpected health: %+v", h)
	}
}

func TestServer_UnknownPathIs404(t *testing.T) {
	s := New(ring.New(6, 90000), nil)
	rec := httptest.NewRecorder()
	s.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/nonsense", nil))
	if rec.Code != http.StatusNotFound {
		t.Fatalf("status = %d, want 404", rec.Code)
	}
}

func TestServer_AudioRoutesNotEnabledBy503(t *testing.T) {
	s := New(ring.New(6, 90000), nil)

	for _, path := range []string{"/audio-init.mp4", "/audio-playlist.m3u8", "/audio-part-1.m4s", "/audio-seg-0.m4s"} {
		rec := httptest.NewRecorder()
		s.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, path, nil))
		if rec.Code != http.StatusServiceUnavailable {
			t.Fatalf("GET %s before SetAudioRing: status=%d, want 503", path, rec.Code)
		}
	}
}

func TestServer_AudioRoutesServedAfterSetAudioRing(t *testing.T) {
	s := New(ring.New(6, 90000), nil)

	audioRing := ring.New(6, 48000)
	audioRing.SetInit([]byte("audio ftyp+moov"))
	audioRing.Push(&pipeline.Fragment{SequenceNumber: 1, SegmentIndex: 0, IsSegmentStart: true, DurationTicks: 1024, Bytes: []byte("audio-part-bytes")})
	audioRing.Push(&pipeline.Fragment{SequenceNumber: 2, SegmentIndex: 1, IsSegmentStart: true, DurationTicks: 1024, Bytes: []byte("audio-part-2")}) // seals segment 0
	s.SetAudioRing(audioRing)

	rec := httptest.NewRecorder()
	s.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/audio-init.mp4", nil))
	if rec.Code != http.StatusOK || rec.Body.String() != "audio ftyp+moov" {
		t.Fatalf("GET /audio-init.mp4: status=%d body=%q", rec.Code, rec.Body.String())
	}
	if ct := rec.Header().Get("Content-Type"); ct != "audio/mp4" {
		t.Fatalf("Content-Type = %q, want audio/mp4", ct)
	}

	rec = httptest.NewRecorder()
	s.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/audio-part-1.m4s", nil))
	if rec.Code != http.StatusOK || rec.Body.String() != "audio-part-bytes" {
		t.Fatalf("GET /audio-part-1.m4s: status=%d body=%q", rec.Code, rec.Body.String())
	}

	rec = httptest.NewRecorder()
	s.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/audio-seg-0.m4s", nil))
	if rec.Code != http.StatusOK || rec.Body.String() != "audio-part-bytes" {
		t.Fatalf("GET /audio-seg-0.m4s: status=%d body=%q", rec.Code, rec.Body.String())
	}

	rec = httptest.NewRecorder()
	s.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/audio-playlist.m3u8", nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("GET /audio-playlist.m3u8: status=%d", rec.Code)
	}
	if !strings.Contains(rec.Body.String(), "seg-0.m4s") {
		t.Fatalf("audio playlist does not mention seg-0.m4s: %q", rec.Body.String())
	}

	// The video-side routes must be entirely unaffected by SetAudioRing.
	rec = httptest.NewRecorder()
	s.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/init.mp4", nil))
	if rec.Code != http.StatusServiceUnavailable {
		t.Fatalf("video /init.mp4 should still be 503 (nothing set on the video ring), got %d", rec.Code)
	}
}
