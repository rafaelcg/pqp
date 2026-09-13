// Package serve is the local-testing HTTP surface (task item 4): init
// segment, parts, segments, a conventional media playlist, and a health
// check. This is not the production wiring (tmpfs+Caddy, a loopback-only
// /healthz split from the publicly-proxied artifact routes) — see the
// README's "not yet" list — it exists so `ffprobe`/hls.js/curl can be
// pointed at LISTEN directly while developing and load-testing L1.1/L1.2.
package serve

import (
	"encoding/json"
	"net/http"
	"strconv"
	"strings"

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
	BytesServed  uint64 `json:"bytesServed"`
	LastPartAtMs int64  `json:"lastPartAtMs,omitempty"`
	LastIdrAtMs  int64  `json:"lastIdrAtMs,omitempty"`
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
}

// New builds a Server backed by r. health may be nil (then GET /healthz
// reports {"status":"starting"} rather than panicking, useful before the
// pipeline is wired up).
func New(r *ring.Ring, health HealthSource) *Server {
	s := &Server{ring: r, health: health, mux: http.NewServeMux()}
	s.mux.HandleFunc("/init.mp4", s.handleInit)
	s.mux.HandleFunc("/playlist.m3u8", s.handlePlaylist)
	s.mux.HandleFunc("/healthz", s.handleHealthz)
	s.mux.HandleFunc("/", s.handleFragmentOrNotFound)
	return s
}

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

func (s *Server) handleHealthz(w http.ResponseWriter, r *http.Request) {
	h := Health{Status: "starting"}
	if s.health != nil {
		h = s.health.Health()
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(h)
}

// handleFragmentOrNotFound serves /part-<seq>.m4s and /seg-<n>.m4s: the
// two file families the ring keys by a plain integer, kept off the mux's
// pattern matching (Go 1.22's ServeMux doesn't do typed path params) with a
// small manual parse instead.
func (s *Server) handleFragmentOrNotFound(w http.ResponseWriter, r *http.Request) {
	path := strings.TrimPrefix(r.URL.Path, "/")

	switch {
	case strings.HasPrefix(path, "part-") && strings.HasSuffix(path, ".m4s"):
		seqStr := strings.TrimSuffix(strings.TrimPrefix(path, "part-"), ".m4s")
		seq, err := strconv.ParseUint(seqStr, 10, 32)
		if err != nil {
			http.NotFound(w, r)
			return
		}
		b, ok := s.ring.Part(uint32(seq))
		if !ok {
			http.NotFound(w, r)
			return
		}
		w.Header().Set("Content-Type", "video/mp4")
		w.Write(b)

	case strings.HasPrefix(path, "seg-") && strings.HasSuffix(path, ".m4s"):
		idxStr := strings.TrimSuffix(strings.TrimPrefix(path, "seg-"), ".m4s")
		idx, err := strconv.Atoi(idxStr)
		if err != nil {
			http.NotFound(w, r)
			return
		}
		b, ok := s.ring.Segment(idx)
		if !ok {
			http.NotFound(w, r)
			return
		}
		w.Header().Set("Content-Type", "video/mp4")
		w.Write(b)

	default:
		http.NotFound(w, r)
	}
}
