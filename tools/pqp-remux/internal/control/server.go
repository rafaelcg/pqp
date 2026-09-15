package control

import (
	"crypto/subtle"
	"encoding/json"
	"io"
	"log"
	"net/http"
	"strconv"
	"time"
)

// OriginKeyHeader carries MEDIA_ORIGIN_KEY on a request to /s/:id/* --
// L2.3's edge Worker's own credential for reaching this box, distinct from
// the HMAC signing /sessions uses (a viewer's player cannot produce that
// signature, and does not need to reach this route through anything but
// the edge Worker in a real deployment). See withOriginKey and the
// README's "Access control" section.
const OriginKeyHeader = "X-Pqp-Origin-Key"

// maxSignedBodyBytes bounds how much of a request body the signing
// middleware will buffer before verifying its signature. Every real body
// here is a small, fixed-shape JSON object (StartSessionRequest is the
// largest, a handful of numbers and short strings); this is generous
// headroom against a caller sending something absurd, not a realistic
// limit any legitimate request could hit.
const maxSignedBodyBytes = 1 << 20 // 1 MiB

// maxConcurrentSignedBodies bounds how many requests withSigning may be
// buffering a body for AT ONCE (Farol review, PR #584): maxSignedBodyBytes
// only caps one request's own buffer, so with no cap on concurrency itself
// the aggregate across every simultaneously in-flight signed request is
// still unbounded -- N callers each sending a body near that per-request
// cap is N times the memory, growing without limit as N does. 64 is
// generous for this control plane's real traffic (pqp-api, one call per
// session start/stop/list) while still giving a fixed ceiling on
// simultaneous buffering: 64 * maxSignedBodyBytes, 64 MiB, rather than a
// number that grows with however many requests happen to arrive at once.
const maxConcurrentSignedBodies = 64

// sanitizeForLog quotes an attacker-controlled string before it reaches a
// log line (Farol review, PR #584): r.URL.Path is decoded from whatever
// the caller sent -- an unsigned request that fails verifySignature never
// reaches anything that would reject a stray %0A/%0D -- so writing it into
// a log line unescaped lets a rejected request forge additional fake log
// lines. strconv.Quote escapes control characters (and wraps the result
// in quotes, which also makes an otherwise-empty or whitespace-only path
// visible in the log line) rather than stripping them, so nothing about
// the rejected path is lost for whoever reads the log.
func sanitizeForLog(s string) string { return strconv.Quote(s) }

// Server is the control-plane HTTP surface: POST/DELETE/GET /sessions
// (HMAC-signed) and GET /s/{id}/{rest...} (media, gated by MEDIA_ORIGIN_KEY
// when one is set -- see withOriginKey and control.go's package comment).
type Server struct {
	secret         []byte
	mediaOriginKey string
	registry       *Registry
	now            func() time.Time
	mux            *http.ServeMux
	// nonces is the replay cache withSigning consults after a signature
	// verifies (Farol review, PR #584): a per-request nonce is remembered
	// for 2xClockSkewMs, and an exact repeat within that window is
	// refused. See nonce_cache.go and NonceHeader's own doc comment.
	nonces *nonceCache
	// bodySem bounds how many requests withSigning may be buffering a
	// body for at once -- see maxConcurrentSignedBodies's own doc
	// comment. A buffered channel used as a counting semaphore: acquire
	// blocks (rather than rejecting outright) once it is full, applying
	// backpressure to a burst instead of refusing a legitimate caller
	// that simply arrived while others were mid-request.
	bodySem chan struct{}
}

// NewServer builds a Server. secret is REMUX_CONTROL_SECRET; mediaOriginKey
// is MEDIA_ORIGIN_KEY (empty means the media routes stay unauthenticated,
// relying on CONTROL_LISTEN's loopback-by-default binding alone -- see
// GlobalConfig.MediaOriginKey and LoadGlobalConfig's own validation, which
// refuses that combination once Listen is not loopback); registry holds
// every session. Panics if secret is empty -- GlobalConfig.Secret is
// already validated non-empty by LoadGlobalConfig, so this is a
// programmer error (a test constructing a Server with no secret on
// purpose), not a runtime condition a caller should handle.
func NewServer(secret, mediaOriginKey string, registry *Registry) *Server {
	if secret == "" {
		panic("control: NewServer called with an empty secret")
	}
	s := &Server{
		secret:         []byte(secret),
		mediaOriginKey: mediaOriginKey,
		registry:       registry,
		now:            time.Now,
		mux:            http.NewServeMux(),
		nonces:         newNonceCache(2 * time.Duration(ClockSkewMs) * time.Millisecond),
		bodySem:        make(chan struct{}, maxConcurrentSignedBodies),
	}
	s.mux.HandleFunc("POST /sessions", s.withSigning(s.handleStart))
	s.mux.HandleFunc("DELETE /sessions/{id}", s.withSigning(s.handleStop))
	s.mux.HandleFunc("GET /sessions", s.withSigning(s.handleList))
	s.mux.HandleFunc("/s/{id}/{rest...}", s.withOriginKey(s.handleMedia))
	return s
}

func (s *Server) ServeHTTP(w http.ResponseWriter, r *http.Request) { s.mux.ServeHTTP(w, r) }

// withSigning wraps next with signature verification: reads and buffers the
// raw body (so signaturePayload sees the EXACT bytes sent, per the
// contract's own "re-serializing JSON after signing invalidates the
// signature" rule), verifies it (including the nonce -- see
// NonceHeader's doc comment), checks the nonce has not been used before
// (the replay cache, only once the signature itself is known good), then
// restores r.Body for next to decode normally. A request that fails
// verification never reaches next at all -- no session lookup, no
// registry mutation, nothing.
func (s *Server) withSigning(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		// Held only across the buffer-then-verify window below, not the
		// whole handler: once a body is read and verified, next runs
		// with nothing left to bound here (Farol review, PR #584 --
		// maxSignedBodyBytes's own doc comment on the per-request cap
		// this closes the aggregate gap in).
		s.bodySem <- struct{}{}
		defer func() { <-s.bodySem }()

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
		nonce := r.Header.Get(NonceHeader)
		now := s.now()
		if err := verifySignature(s.secret, r.Method, r.URL.Path, ts, nonce, body, sig, now); err != nil {
			log.Printf("pqp-remux: control: rejected %s %s: %v", r.Method, sanitizeForLog(r.URL.Path), err)
			writeError(w, http.StatusUnauthorized, "invalid signature")
			return
		}
		if !s.nonces.checkAndRemember(nonce, now) {
			log.Printf("pqp-remux: control: rejected %s %s: replayed nonce", r.Method, sanitizeForLog(r.URL.Path))
			writeError(w, http.StatusUnauthorized, "replayed nonce")
			return
		}

		r.Body = io.NopCloser(&bodyReader{b: body})
		next(w, r)
	}
}

// withOriginKey gates /s/:id/* with a constant-time comparison against
// mediaOriginKey (Farol review, PR #584): this is the seam L2.3's edge
// Worker uses, a static shared value rather than a per-request signature
// (a viewer's player still never sees or produces this; the Worker
// attaches it when proxying, exactly the way a CDN-to-origin auth header
// works). A request missing the header, or carrying the wrong value, is
// rejected before the registry is ever consulted -- same "fail before any
// side effect" shape withSigning already gives the control routes.
//
// When mediaOriginKey is empty (the default, matching a loopback-only
// CONTROL_LISTEN), this is a no-op: LoadGlobalConfig already refuses to
// combine a non-loopback Listen with no MediaOriginKey, so reaching this
// package with both empty means the operator deliberately chose the
// loopback-only posture control.go's package comment describes.
func (s *Server) withOriginKey(next http.HandlerFunc) http.HandlerFunc {
	if s.mediaOriginKey == "" {
		return next
	}
	key := []byte(s.mediaOriginKey)
	return func(w http.ResponseWriter, r *http.Request) {
		given := r.Header.Get(OriginKeyHeader)
		if given == "" || subtle.ConstantTimeCompare([]byte(given), key) != 1 {
			writeError(w, http.StatusUnauthorized, "missing or invalid "+OriginKeyHeader)
			return
		}
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
