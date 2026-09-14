// Package serve is the local-testing HTTP surface (task item 4): init
// segment, parts, segments, a conventional media playlist, and a health
// check. This is not the production wiring (tmpfs+Caddy, a loopback-only
// /healthz split from the publicly-proxied artifact routes) — see the
// README's "not yet" list — it exists so `ffprobe`/hls.js/curl can be
// pointed at LISTEN directly while developing and load-testing L1.1/L1.2.
//
// None of these routes authenticate a caller: whoever can reach LISTEN can
// read the presenter's screen-share media and /healthz's session counters.
// That is why config.DefaultListen binds loopback only — the only real
// mitigation this package can offer on its own, since access control for
// a watch party's viewers is a room-membership question this process has
// no way to answer (it holds one hidden LiveKit token, not a viewer
// session). Setting LISTEN to a non-loopback address is a deliberate
// choice a caller makes; a real access-control layer in front of it is
// L1.5/L2.x's job, not this local test surface's.
package serve

import (
	"encoding/json"
	"net/http"
	"strconv"
	"strings"
	"sync/atomic"

	"github.com/rafaelcg/pqp/tools/pqp-remux/internal/ring"
)

// Health is what GET /healthz reports. It intentionally mirrors the shape
// section 5 of the plan describes for the eventual watchdog endpoint
// (`{sessionId, channelId, subscribed, lastPartAtMs, lastIdrAtMs, ...}`)
// so L1.6 can extend this handler instead of replacing it.
type Health struct {
	Status       string `json:"status"`
	Subscribed   bool   `json:"subscribed"`
	PartsWritten uint64 `json:"partsWritten"`
	BytesWritten uint64 `json:"bytesWritten"`
	LastPartAtMs int64  `json:"lastPartAtMs,omitempty"`
	LastIdrAtMs  int64  `json:"lastIdrAtMs,omitempty"`

	// AudioPartsWritten/AudioBytesWritten are zero (and omitted) until
	// EnableAudio (L1.3, internal/session) has successfully started; they
	// report the audio track's own ring the same way
	// PartsWritten/BytesWritten report the video track's.
	AudioPartsWritten uint64 `json:"audioPartsWritten,omitempty"`
	AudioBytesWritten uint64 `json:"audioBytesWritten,omitempty"`

	// R2Uploaded/R2Failed/R2Dropped mirror internal/r2.Writer's own
	// counters (L1.4), zero and omitted until EnableR2 has been called.
	R2Uploaded uint64 `json:"r2Uploaded,omitempty"`
	R2Failed   uint64 `json:"r2Failed,omitempty"`
	R2Dropped  uint64 `json:"r2Dropped,omitempty"`
}

// HealthSource is polled fresh on every GET /healthz; the pipeline
// implements it directly rather than pushing updates through the server.
type HealthSource interface {
	Health() Health
}

// Server serves one session's ring over HTTP.
type Server struct {
	ring   *ring.Ring
	health HealthSource
	mux    *http.ServeMux

	// audioRing is nil until SetAudioRing is called (L1.3: EnableAudio
	// builds the audio ring only once the AAC encoder has actually
	// started, which can happen after New — main.go may call serve.New
	// before or after session.EnableAudio). An atomic.Pointer because it
	// is written from main's setup goroutine and read from HTTP handler
	// goroutines.
	audioRing atomic.Pointer[ring.Ring]
}

// New builds a Server backed by r. health may be nil (then GET /healthz
// reports {"status":"starting"} rather than panicking, useful before the
// pipeline is wired up).
func New(r *ring.Ring, health HealthSource) *Server {
	s := &Server{ring: r, health: health, mux: http.NewServeMux()}
	s.mux.HandleFunc("/init.mp4", s.handleInit)
	s.mux.HandleFunc("/playlist.m3u8", s.handlePlaylist)
	s.mux.HandleFunc("/audio-init.mp4", s.handleAudioInit)
	s.mux.HandleFunc("/audio-playlist.m3u8", s.handleAudioPlaylist)
	s.mux.HandleFunc("/healthz", s.handleHealthz)
	s.mux.HandleFunc("/", s.handleFragmentOrNotFound)
	return s
}

// SetAudioRing wires the audio track's ring in, once EnableAudio has
// built one; /audio-*.mp4 and /audio-*.m4s answer 503 until this is
// called, matching how /init.mp4 answers 503 before the video's own init
// segment exists. Safe to call at most once, concurrently with requests
// already being served.
func (s *Server) SetAudioRing(r *ring.Ring) { s.audioRing.Store(r) }

func (s *Server) ServeHTTP(w http.ResponseWriter, r *http.Request) { s.mux.ServeHTTP(w, r) }

func (s *Server) handleInit(w http.ResponseWriter, r *http.Request) {
	b, ok := s.ring.Init()
	if !ok {
		http.Error(w, "init segment not ready yet", http.StatusServiceUnavailable)
		return
	}
	w.Header().Set("Content-Type", "video/mp4")
	w.Write(b)
}

func (s *Server) handlePlaylist(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/vnd.apple.mpegurl")
	// A conventional playlist is safe to poll-cache briefly; LL blocking
	// reload semantics (L2.1) do not apply to this endpoint.
	w.Header().Set("Cache-Control", "no-store")
	w.Write([]byte(s.ring.Playlist()))
}

func (s *Server) handleAudioInit(w http.ResponseWriter, r *http.Request) {
	ar := s.audioRing.Load()
	if ar == nil {
		http.Error(w, "audio is not enabled on this session", http.StatusServiceUnavailable)
		return
	}
	b, ok := ar.Init()
	if !ok {
		http.Error(w, "audio init segment not ready yet", http.StatusServiceUnavailable)
		return
	}
	w.Header().Set("Content-Type", "audio/mp4")
	w.Write(b)
}

func (s *Server) handleAudioPlaylist(w http.ResponseWriter, r *http.Request) {
	ar := s.audioRing.Load()
	if ar == nil {
		http.Error(w, "audio is not enabled on this session", http.StatusServiceUnavailable)
		return
	}
	w.Header().Set("Content-Type", "application/vnd.apple.mpegurl")
	w.Header().Set("Cache-Control", "no-store")
	w.Write([]byte(ar.Playlist()))
}

func (s *Server) handleHealthz(w http.ResponseWriter, r *http.Request) {
	h := Health{Status: "starting"}
	if s.health != nil {
		h = s.health.Health()
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(h)
}

// handleFragmentOrNotFound serves /part-<seq>.m4s, /seg-<n>.m4s and their
// audio-prefixed equivalents (/audio-part-<seq>.m4s, /audio-seg-<n>.m4s):
// the file families the two rings key by a plain integer, kept off the
// mux's pattern matching (Go 1.22's ServeMux doesn't do typed path params)
// with a small manual parse instead.
func (s *Server) handleFragmentOrNotFound(w http.ResponseWriter, r *http.Request) {
	path := strings.TrimPrefix(r.URL.Path, "/")

	targetRing, contentType, path := s.ring, "video/mp4", path
	if rest, ok := strings.CutPrefix(path, "audio-"); ok {
		path = rest
		contentType = "audio/mp4"
		ar := s.audioRing.Load()
		if ar == nil {
			http.Error(w, "audio is not enabled on this session", http.StatusServiceUnavailable)
			return
		}
		targetRing = ar
	}

	switch {
	case strings.HasPrefix(path, "part-") && strings.HasSuffix(path, ".m4s"):
		seqStr := strings.TrimSuffix(strings.TrimPrefix(path, "part-"), ".m4s")
		seq, err := strconv.ParseUint(seqStr, 10, 32)
		if err != nil {
			http.NotFound(w, r)
			return
		}
		b, ok := targetRing.Part(uint32(seq))
		if !ok {
			http.NotFound(w, r)
			return
		}
		w.Header().Set("Content-Type", contentType)
		w.Write(b)

	case strings.HasPrefix(path, "seg-") && strings.HasSuffix(path, ".m4s"):
		idxStr := strings.TrimSuffix(strings.TrimPrefix(path, "seg-"), ".m4s")
		idx, err := strconv.Atoi(idxStr)
		if err != nil {
			http.NotFound(w, r)
			return
		}
		b, ok := targetRing.Segment(idx)
		if !ok {
			http.NotFound(w, r)
			return
		}
		w.Header().Set("Content-Type", contentType)
		w.Write(b)

	default:
		http.NotFound(w, r)
	}
}
