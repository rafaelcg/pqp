package serve

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/rafaelcg/pqp/tools/pqp-remux/internal/llstate"
	"github.com/rafaelcg/pqp/tools/pqp-remux/internal/pipeline"
	"github.com/rafaelcg/pqp/tools/pqp-remux/internal/ring"
)

func stateMeta() llstate.Meta {
	return llstate.Meta{
		SessionID:       "5a1b2c3d-4e5f-4a7b-8c9d-0e1f2a3b4c5d",
		ChannelID:       "chan_abc123",
		PartTargetMs:    500,
		SegmentTargetMs: 4000,
	}
}

func getState(t *testing.T, s *Server) *httptest.ResponseRecorder {
	t.Helper()
	rec := httptest.NewRecorder()
	s.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/state.json", nil))
	if cc := rec.Header().Get("Cache-Control"); cc != "no-store" {
		t.Fatalf("Cache-Control = %q, want no-store (a cached state.json freezes every viewer at that edge)", cc)
	}
	return rec
}

// The single-session binary never calls SetLlState -- it has no session id
// to put in the document -- so the route exists but answers 404 there.
func TestState_NotEnabled(t *testing.T) {
	r := ring.New(6, 90000)
	r.SetInit([]byte("init"))
	r.Push(&pipeline.Fragment{SequenceNumber: 1, SegmentIndex: 0, IsSegmentStart: true, DurationTicks: 45000, Bytes: []byte("p")})
	if rec := getState(t, New(r, nil)); rec.Code != http.StatusNotFound {
		t.Fatalf("status = %d, want 404 without SetLlState", rec.Code)
	}
}

// 404 rather than 503 before the first part: the edge Worker reads 404 as
// "this session is conventional, try again in a few seconds" and anything
// else as an error it logs per probe. See handleState's doc comment.
func TestState_BeforeTheFirstPart(t *testing.T) {
	r := ring.New(6, 90000)
	r.SetInit([]byte("init"))
	s := New(r, nil)
	s.SetLlState(stateMeta())
	if rec := getState(t, s); rec.Code != http.StatusNotFound {
		t.Fatalf("status = %d, want 404 before any part exists", rec.Code)
	}
}

func TestState_ServedFromTheLiveRing(t *testing.T) {
	r := ring.New(6, 90000)
	r.SetInit([]byte("init"))
	// Two parts of the first segment, then the IDR that opens (and so
	// seals the first) the second.
	r.Push(&pipeline.Fragment{SequenceNumber: 1, SegmentIndex: 0, IsSegmentStart: true, DurationTicks: 45000, Bytes: []byte("a")})
	r.Push(&pipeline.Fragment{SequenceNumber: 2, SegmentIndex: 0, DurationTicks: 45000, Bytes: []byte("b")})
	r.Push(&pipeline.Fragment{SequenceNumber: 3, SegmentIndex: 1, IsSegmentStart: true, DurationTicks: 45000, Bytes: []byte("c")})

	audio := ring.New(6, 48000)
	audio.SetInit([]byte("audio init"))
	audio.Push(&pipeline.Fragment{SequenceNumber: 1, SegmentIndex: 0, IsSegmentStart: true, DurationTicks: 24000, Bytes: []byte("d")})

	s := New(r, nil)
	s.SetAudioRing(audio)
	s.SetLlState(stateMeta())

	rec := getState(t, s)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %q", rec.Code, rec.Body.String())
	}
	if ct := rec.Header().Get("Content-Type"); ct != "application/json" {
		t.Fatalf("Content-Type = %q", ct)
	}

	var got llstate.State
	if err := json.Unmarshal(rec.Body.Bytes(), &got); err != nil {
		t.Fatalf("decoding state.json: %v", err)
	}
	if got.SessionID != stateMeta().SessionID || got.ChannelID != stateMeta().ChannelID {
		t.Fatalf("identity = %+v", got)
	}
	if got.MediaSequence != 0 || len(got.Video.Segments) != 2 {
		t.Fatalf("video = %+v", got.Video)
	}
	if !got.Video.Segments[0].Complete || got.Video.Segments[1].Complete {
		t.Fatalf("segment completeness wrong: %+v", got.Video.Segments)
	}
	if got.Video.PreloadHint == nil || got.Video.PreloadHint.URI != "part-4.m4s" {
		t.Fatalf("preloadHint = %+v, want the next unwritten part (part-4.m4s)", got.Video.PreloadHint)
	}
	// Every URI in the document must be fetchable from THIS server: the
	// Worker resolves each one against /s/:id/<uri>, so a name this box
	// does not serve is a 404 a viewer sees as a stall.
	for _, uri := range collectURIs(got) {
		probe := httptest.NewRecorder()
		s.ServeHTTP(probe, httptest.NewRequest(http.MethodGet, "/"+uri, nil))
		if probe.Code != http.StatusOK {
			t.Fatalf("GET /%s = %d, but state.json advertises it", uri, probe.Code)
		}
	}
	if got.Audio == nil || got.Audio.InitURI != "audio-init.mp4" {
		t.Fatalf("audio = %+v", got.Audio)
	}
}

// collectURIs returns every name the document tells the Worker to fetch,
// EXCEPT the preload hints -- those name a part that deliberately does not
// exist yet (RFC 8216bis 4.4.3.9).
func collectURIs(s llstate.State) []string {
	var out []string
	for _, track := range []*llstate.Track{s.Video, s.Audio} {
		if track == nil {
			continue
		}
		out = append(out, track.InitURI)
		for _, seg := range track.Segments {
			if seg.URI != nil {
				out = append(out, *seg.URI)
			}
			for _, p := range seg.Parts {
				out = append(out, p.URI)
			}
		}
	}
	return out
}
