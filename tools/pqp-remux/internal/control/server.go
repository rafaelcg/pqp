package control

import (
	"encoding/json"
	"io"
	"log"
	"net/http"
	"time"
)

// maxSignedBodyBytes bounds how much of a request body the signing
// middleware will buffer before verifying its signature. Every real body
// here is a small, fixed-shape JSON object (StartSessionRequest is the
// largest, a handful of numbers and short strings); this is generous
// headroom against a caller sending something absurd, not a realistic
// limit any legitimate request could hit.
const maxSignedBodyBytes = 1 << 20 // 1 MiB

// Server is the control-plane HTTP surface: POST/DELETE/GET /sessions
// (signed) and GET /s/{id}/{rest...} (unsigned media, loopback-only by
// convention -- see control.go's package comment).
type Server struct {
	secret   []byte
	registry *Registry
	now      func() time.Time
	mux      *http.ServeMux
}

// NewServer builds a Server. secret is REMUX_CONTROL_SECRET; registry holds
// every session. Panics if secret is empty -- GlobalConfig.Secret is
// already validated non-empty by LoadGlobalConfig, so this is a
// programmer error (a test constructing a Server with no secret on
// purpose), not a runtime condition a caller should handle.
func NewServer(secret string, registry *Registry) *Server {
	if secret == "" {
		panic("control: NewServer called with an empty secret")
	}
	s := &Server{secret: []byte(secret), registry: registry, now: time.Now, mux: http.NewServeMux()}
	s.mux.HandleFunc("POST /sessions", s.withSigning(s.handleStart))
	s.mux.HandleFunc("DELETE /sessions/{id}", s.withSigning(s.handleStop))
	s.mux.HandleFunc("GET /sessions", s.withSigning(s.handleList))
	// Deliberately unsigned: a viewer's player cannot produce an HMAC over
	// pqp-api's shared secret, and does not need to -- see control.go's
	// package comment on why CONTROL_LISTEN's own loopback-by-default
	// binding is this route family's actual access control today.
	s.mux.HandleFunc("/s/{id}/{rest...}", s.handleMedia)
	return s
}

func (s *Server) ServeHTTP(w http.ResponseWriter, r *http.Request) { s.mux.ServeHTTP(w, r) }

// withSigning wraps next with signature verification: reads and buffers the
// raw body (so signaturePayload sees the EXACT bytes sent, per the
// contract's own "re-serializing JSON after signing invalidates the
// signature" rule), verifies it, then restores r.Body for next to decode
// normally. A request that fails verification never reaches next at all --
// no session lookup, no registry mutation, nothing.
func (s *Server) withSigning(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		body, err := io.ReadAll(io.LimitReader(r.Body, maxSignedBodyBytes+1))
		r.Body.Close()
		if err != nil {
			writeError(w, http.StatusBadRequest, "reading request body")
			return
		}
		if len(body) > maxSignedBodyBytes {
			writeError(w, http.StatusRequestEntityTooLarge, "request body too large")
			return
		}

		ts := r.Header.Get(TimestampHeader)
		sig := r.Header.Get(SignatureHeader)
		if err := verifySignature(s.secret, r.Method, r.URL.Path, ts, body, sig, s.now()); err != nil {
			log.Printf("pqp-remux: control: rejected %s %s: %v", r.Method, r.URL.Path, err)
			writeError(w, http.StatusUnauthorized, "invalid signature")
			return
		}

		r.Body = io.NopCloser(&bodyReader{b: body})
		next(w, r)
	}
}

// bodyReader is a minimal io.Reader over an already-read byte slice, used
// only to rebuild r.Body after withSigning consumed the original for
// verification. A bytes.Reader would do the same job; this is spelled out
// locally to avoid importing bytes for one struct.
//
// Read has a POINTER receiver deliberately: io.Reader's contract requires
// each call to observe the advance a previous call made, and a value
// receiver would silently re-copy the ORIGINAL b on every call (each call
// getting its own copy of the struct) instead of ever reaching io.EOF --
// exactly the bug this comment now exists to prevent reintroducing (caught
// by this package's own handler tests: every signed POST decoded as
// "invalid JSON body" until this was a pointer receiver).
type bodyReader struct{ b []byte }

func (r *bodyReader) Read(p []byte) (int, error) {
	if len(r.b) == 0 {
		return 0, io.EOF
	}
	n := copy(p, r.b)
	r.b = r.b[n:]
	return n, nil
}

func writeError(w http.ResponseWriter, status int, message string) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	json.NewEncoder(w).Encode(ErrorResponse{Error: message})
}

func writeJSON(w http.ResponseWriter, status int, body any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	json.NewEncoder(w).Encode(body)
}

// handleStart implements POST /sessions.
func (s *Server) handleStart(w http.ResponseWriter, r *http.Request) {
	var req StartSessionRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid JSON body")
		return
	}
	if err := req.Validate(); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}

	info, isNew, err := s.registry.StartOrGet(req)
	if err != nil {
		log.Printf("pqp-remux: control: starting session %s failed: %v", req.SessionID, err)
		writeError(w, http.StatusBadGateway, "starting the session failed: "+err.Error())
		return
	}

	status := http.StatusCreated
	if !isNew {
		status = http.StatusConflict
	}
	writeJSON(w, status, info)
}

// handleStop implements DELETE /sessions/:id: 204, unconditionally, on both
// "found and stopped" and "no such session" -- see the contract's own
// idempotency rule.
func (s *Server) handleStop(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	s.registry.Stop(id)
	w.WriteHeader(http.StatusNoContent)
}

// handleList implements GET /sessions.
func (s *Server) handleList(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, ListSessionsResponse{Sessions: s.registry.List()})
}

// handleMedia implements GET /s/{id}/{rest...}: one origin path shape for
// every session's parts and playlists, so L2.3's edge Worker has one thing
// to proxy to regardless of which or how many sessions are live. Unsigned
// by design (see withSigning's own doc comment on why). A session id this
// registry has never held (or has since Stopped, which removes it from the
// registry entirely -- see registry.go's Stop) is a plain 404; a session
// that exists but is demoted/has no active pipeline answers 503, from
// ManagedSession.ServeHTTP itself.
func (s *Server) handleMedia(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	ms, ok := s.registry.Get(id)
	if !ok {
		http.NotFound(w, r)
		return
	}

	rest := r.PathValue("rest")
	inner := r.Clone(r.Context())
	inner.URL.Path = "/" + rest
	inner.URL.RawPath = ""
	ms.ServeHTTP(w, inner)
}
