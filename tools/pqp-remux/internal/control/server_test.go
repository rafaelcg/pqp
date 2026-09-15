package control

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

// testNonceCounter hands every signedHTTPRequest call a distinct nonce:
// tests that intentionally want a REPEATED nonce (replay) build the
// request by hand instead -- see TestServer_RejectsReplayedNonce.
var testNonceCounter atomic.Int64

func signedHTTPRequest(t *testing.T, secret, method, path string, body []byte) *http.Request {
	t.Helper()
	nonce := fmt.Sprintf("test-nonce-%d", testNonceCounter.Add(1))
	return signedHTTPRequestWithNonce(t, secret, method, path, nonce, body)
}

func signedHTTPRequestWithNonce(t *testing.T, secret, method, path, nonce string, body []byte) *http.Request {
	t.Helper()
	ts := strconv.FormatInt(time.Now().UnixMilli(), 10)
	sig := sign([]byte(secret), method, path, ts, nonce, string(body))
	var r io.Reader
	if body != nil {
		r = bytes.NewReader(body)
	}
	req := httptest.NewRequest(method, path, r)
	req.Header.Set(TimestampHeader, ts)
	req.Header.Set(SignatureHeader, sig)
	req.Header.Set(NonceHeader, nonce)
	return req
}

func newTestServer(t *testing.T, secret string, factory PipelineFactory) (*Server, *Registry) {
	t.Helper()
	return newTestServerWithOriginKey(t, secret, "", factory)
}

func newTestServerWithOriginKey(t *testing.T, secret, mediaOriginKey string, factory PipelineFactory) (*Server, *Registry) {
	t.Helper()
	reg := NewRegistry(context.Background(), factory, GlobalConfig{}, fixedWatchdogCfg(), nil)
	t.Cleanup(reg.StopAll)
	return NewServer(secret, mediaOriginKey, reg), reg
}

func TestServer_RejectsUnsignedControlRequests(t *testing.T) {
	secret := "topsecret"
	srv, _ := newTestServer(t, secret, failingFactory)

	rec := httptest.NewRecorder()
	srv.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/sessions", nil))
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("expected 401 for an unsigned request, got %d", rec.Code)
	}
	var errBody ErrorResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &errBody); err != nil || errBody.Error == "" {
		t.Fatalf("expected an ErrorResponse body, got %q (decode err=%v)", rec.Body.String(), err)
	}

	rec2 := httptest.NewRecorder()
	srv.ServeHTTP(rec2, signedHTTPRequest(t, "wrong-secret", http.MethodGet, "/sessions", nil))
	if rec2.Code != http.StatusUnauthorized {
		t.Fatalf("expected 401 for a wrongly-signed request, got %d", rec2.Code)
	}
}

// TestServer_RejectsReplayedNonce is the "bounded seen-nonce cache" finding
// from Farol's review of PR #584: a nonce this box has already accepted a
// signature for must not work a second time, even though each individual
// request is (on its own) validly signed -- this is what makes a captured
// request stop working on its SECOND use, not merely once the clock-skew
// window eventually closes.
func TestServer_RejectsReplayedNonce(t *testing.T) {
	secret := "topsecret"
	srv, _ := newTestServer(t, secret, failingFactory)

	const nonce = "fixed-nonce-for-replay-test"
	rec1 := httptest.NewRecorder()
	srv.ServeHTTP(rec1, signedHTTPRequestWithNonce(t, secret, http.MethodGet, "/sessions", nonce, nil))
	if rec1.Code != http.StatusOK {
		t.Fatalf("expected the first use of a fresh nonce to succeed, got %d: %s", rec1.Code, rec1.Body.String())
	}

	rec2 := httptest.NewRecorder()
	srv.ServeHTTP(rec2, signedHTTPRequestWithNonce(t, secret, http.MethodGet, "/sessions", nonce, nil))
	if rec2.Code != http.StatusUnauthorized {
		t.Fatalf("expected a replayed nonce to be rejected, got %d: %s", rec2.Code, rec2.Body.String())
	}

	// A DIFFERENT nonce must be unaffected by the first one's use.
	rec3 := httptest.NewRecorder()
	srv.ServeHTTP(rec3, signedHTTPRequest(t, secret, http.MethodGet, "/sessions", nil))
	if rec3.Code != http.StatusOK {
		t.Fatalf("expected a fresh, different nonce to succeed, got %d: %s", rec3.Code, rec3.Body.String())
	}
}

// TestSanitizeForLog_EscapesControlCharacters pins sanitizeForLog's job
// (Farol review, PR #584): a rejected request's r.URL.Path is
// attacker-controlled and unverified (that is WHY the request was
// rejected), so writing it into a log line unescaped would let a crafted
// path forge additional fake log lines via an encoded newline.
func TestSanitizeForLog_EscapesControlCharacters(t *testing.T) {
	tests := []struct {
		name  string
		input string
	}{
		{"newline", "/sessions/evil\nFAKE LOG LINE: everything is fine"},
		{"carriage return", "/sessions/evil\r\nFAKE LOG LINE"},
		{"tab", "/sessions/evil\ttabbed"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := sanitizeForLog(tt.input)
			if strings.ContainsAny(got, "\n\r") {
				t.Fatalf("sanitizeForLog(%q) = %q still contains a raw control character", tt.input, got)
			}
			// Nothing about the original path is silently dropped --
			// Quote escapes rather than strips, so the same bytes are
			// still recoverable from the log line.
			unquoted, err := strconv.Unquote(got)
			if err != nil {
				t.Fatalf("sanitizeForLog(%q) = %q is not a valid quoted string: %v", tt.input, got, err)
			}
			if unquoted != tt.input {
				t.Fatalf("sanitizeForLog(%q) round-tripped to %q, want the original input preserved", tt.input, unquoted)
			}
		})
	}
}

// TestServer_RejectedControlRequest_DoesNotForgeLogLines is the same
// finding exercised end to end: an unsigned request against a path
// carrying an encoded newline must not be able to inject a second,
// fabricated line into this process's own log output.
func TestServer_RejectedControlRequest_DoesNotForgeLogLines(t *testing.T) {
	secret := "topsecret"
	srv, _ := newTestServer(t, secret, failingFactory)

	var logBuf bytes.Buffer
	origOutput := log.Writer()
	origFlags := log.Flags()
	log.SetOutput(&logBuf)
	log.SetFlags(0)
	t.Cleanup(func() {
		log.SetOutput(origOutput)
		log.SetFlags(origFlags)
	})

	// %0A is a decoded newline by the time this reaches r.URL.Path; the
	// request is deliberately unsigned so it exercises the "rejected"
	// log line this finding is about.
	req := httptest.NewRequest(http.MethodDelete, "/sessions/evil%0AFAKE-LOG-LINE-INJECTED", nil)
	rec := httptest.NewRecorder()
	srv.ServeHTTP(rec, req)
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("expected 401 for an unsigned request, got %d", rec.Code)
	}

	lines := strings.Split(strings.TrimRight(logBuf.String(), "\n"), "\n")
	if len(lines) != 1 {
		t.Fatalf("expected exactly one log line from one rejected request, got %d: %q", len(lines), logBuf.String())
	}
	if strings.Contains(lines[0], "FAKE-LOG-LINE-INJECTED") && !strings.Contains(lines[0], `"`) {
		t.Fatalf("log line contains the injected text unescaped: %q", lines[0])
	}
}

// TestServer_ConcurrentSignedRequests_DoNotDeadlock pins the aggregate
// body-buffering cap withSigning applies (Farol review, PR #584):
// maxConcurrentSignedBodies bounds how many requests may be buffering a
// body at once, via a channel semaphore acquired then released around
// that window. This drives well past that cap concurrently and requires
// every request to still complete -- a regression that acquired without
// releasing (or released on the wrong path, e.g. only some early
// returns) would deadlock the requests queued behind the leaked slot
// instead of merely slowing them down.
func TestServer_ConcurrentSignedRequests_DoNotDeadlock(t *testing.T) {
	secret := "topsecret"
	srv, _ := newTestServer(t, secret, failingFactory)

	const n = maxConcurrentSignedBodies*3 + 1
	reqs := make([]*http.Request, n)
	for i := range reqs {
		reqs[i] = signedHTTPRequest(t, secret, http.MethodGet, "/sessions", nil)
	}

	var wg sync.WaitGroup
	codes := make([]int, n)
	for i, req := range reqs {
		wg.Add(1)
		go func(i int, req *http.Request) {
			defer wg.Done()
			rec := httptest.NewRecorder()
			srv.ServeHTTP(rec, req)
			codes[i] = rec.Code
		}(i, req)
	}

	done := make(chan struct{})
	go func() {
		wg.Wait()
		close(done)
	}()
	select {
	case <-done:
	case <-time.After(10 * time.Second):
		t.Fatal("requests did not all complete within the timeout -- the concurrency semaphore likely deadlocked")
	}

	for i, code := range codes {
		if code != http.StatusOK {
			t.Fatalf("request %d: expected 200, got %d", i, code)
		}
	}
}

// TestServer_SlowRequestBodyDoesNotHoldSemaphoreForever is Farol's
// follow-up finding on the concurrency cap above (PR #584, round 2):
// bodySem is acquired BEFORE the body is read or the request is
// authenticated, on purpose (an unauthenticated caller is exactly who
// this cap must bound), which means an unauthenticated caller that opens
// a connection and never finishes sending its body would hold that slot
// forever if nothing ever aborts the read. This drives a real TCP
// connection (httptest.NewRecorder can't exercise this -- the timeout
// lives in net/http.Server's own connection handling, not in the
// Handler) that declares a body and then sends none of it, against a
// server configured with the same ReadTimeout cmd/pqp-remuxd/main.go now
// sets, and requires the semaphore slot to be released once that
// timeout elapses.
func TestServer_SlowRequestBodyDoesNotHoldSemaphoreForever(t *testing.T) {
	secret := "topsecret"
	srv, _ := newTestServer(t, secret, failingFactory)

	ts := httptest.NewUnstartedServer(srv)
	ts.Config.ReadHeaderTimeout = 100 * time.Millisecond
	ts.Config.ReadTimeout = 200 * time.Millisecond
	ts.Start()
	defer ts.Close()

	conn, err := net.Dial("tcp", ts.Listener.Addr().String())
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	defer conn.Close()

	// A large declared Content-Length with nothing behind it -- the
	// unsigned, incomplete request a slow-loris caller sends. No
	// signature headers at all: withSigning must reach io.ReadAll (and
	// acquire bodySem) before it ever gets a chance to reject this for
	// being unsigned.
	if _, err := conn.Write([]byte("POST /sessions HTTP/1.1\r\nHost: test\r\nContent-Length: 1000000\r\n\r\n")); err != nil {
		t.Fatalf("writing request headers: %v", err)
	}

	waitFor := func(t *testing.T, desc string, cond func() bool) {
		t.Helper()
		deadline := time.Now().Add(2 * time.Second)
		for time.Now().Before(deadline) {
			if cond() {
				return
			}
			time.Sleep(5 * time.Millisecond)
		}
		t.Fatalf("timed out waiting for: %s", desc)
	}

	waitFor(t, "the slow request to acquire a semaphore slot", func() bool {
		return len(srv.bodySem) > 0
	})
	waitFor(t, "the semaphore slot to be released after the read timeout", func() bool {
		return len(srv.bodySem) == 0
	})
}

func TestServer_StartSession_RejectsInvalidBody(t *testing.T) {
	secret := "topsecret"
	srv, _ := newTestServer(t, secret, failingFactory)

	body := []byte(`{"sessionId":"not-a-uuid"}`)
	rec := httptest.NewRecorder()
	srv.ServeHTTP(rec, signedHTTPRequest(t, secret, http.MethodPost, "/sessions", body))
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("expected 400 for an invalid start request, got %d: %s", rec.Code, rec.Body.String())
	}
}

func TestServer_StartSession_CreatedThenConflict(t *testing.T) {
	secret := "topsecret"
	spy := &pipelineSpy{}
	srv, _ := newTestServer(t, secret, spy.factory())

	body, _ := json.Marshal(testStartReq(sessA, chanA, chanA))

	rec1 := httptest.NewRecorder()
	srv.ServeHTTP(rec1, signedHTTPRequest(t, secret, http.MethodPost, "/sessions", body))
	if rec1.Code != http.StatusCreated {
		t.Fatalf("expected 201, got %d: %s", rec1.Code, rec1.Body.String())
	}
	var info1 SessionInfo
	if err := json.Unmarshal(rec1.Body.Bytes(), &info1); err != nil {
		t.Fatalf("invalid JSON: %v", err)
	}
	if info1.SessionID != sessA {
		t.Fatalf("unexpected sessionId: %q", info1.SessionID)
	}

	rec2 := httptest.NewRecorder()
	srv.ServeHTTP(rec2, signedHTTPRequest(t, secret, http.MethodPost, "/sessions", body))
	if rec2.Code != http.StatusConflict {
		t.Fatalf("expected 409 on a retried start, got %d: %s", rec2.Code, rec2.Body.String())
	}
	if spy.count() != 1 {
		t.Fatalf("expected exactly one pipeline built, got %d", spy.count())
	}
}

func TestServer_DeleteSession_IsIdempotentViaHTTP(t *testing.T) {
	secret := "topsecret"
	spy := &pipelineSpy{}
	srv, _ := newTestServer(t, secret, spy.factory())

	rec := httptest.NewRecorder()
	srv.ServeHTTP(rec, signedHTTPRequest(t, secret, http.MethodDelete, "/sessions/does-not-exist", nil))
	if rec.Code != http.StatusNoContent {
		t.Fatalf("expected 204 for an unknown id, got %d", rec.Code)
	}

	startBody, _ := json.Marshal(testStartReq(sessA, chanA, chanA))
	rec2 := httptest.NewRecorder()
	srv.ServeHTTP(rec2, signedHTTPRequest(t, secret, http.MethodPost, "/sessions", startBody))
	if rec2.Code != http.StatusCreated {
		t.Fatalf("expected 201, got %d", rec2.Code)
	}

	rec3 := httptest.NewRecorder()
	srv.ServeHTTP(rec3, signedHTTPRequest(t, secret, http.MethodDelete, "/sessions/"+sessA, nil))
	if rec3.Code != http.StatusNoContent {
		t.Fatalf("expected 204, got %d", rec3.Code)
	}
	if !spy.last().isClosed() {
		t.Fatal("expected DELETE to close the pipeline")
	}

	rec4 := httptest.NewRecorder()
	srv.ServeHTTP(rec4, signedHTTPRequest(t, secret, http.MethodDelete, "/sessions/"+sessA, nil))
	if rec4.Code != http.StatusNoContent {
		t.Fatalf("expected a second DELETE of an already-gone session to also be 204, got %d", rec4.Code)
	}
}

// TestServer_GetSessions_ShapeMatchesContractFixture checks GET /sessions's
// response against the exact field set
// packages/shared/src/hls-remux-control.ts's remuxSessionInfoSchema names
// (sessionId, room, channelId, subscribed, startedAtMs, lastPartAtMs,
// lastIdrAtMs, openSegmentMs, partsWritten, bytesServed). That file has no
// literal worked JSON example to copy (it is a set of Zod schemas, not a
// fixture) -- this field list is transcribed directly from
// remuxSessionInfoSchema's own z.object({...}), so a change to that schema
// is what should break this test, not an independently hand-maintained
// example drifting from it. It also round-trips into a Go mirror of the
// TS-inferred type, so nullability (a fresh session has never produced a
// part or an IDR: those three fields must be JSON null, not zero) is
// checked at the type level too, not just "the key exists".
func TestServer_GetSessions_ShapeMatchesContractFixture(t *testing.T) {
	secret := "topsecret"
	spy := &pipelineSpy{}
	srv, _ := newTestServer(t, secret, spy.factory())

	startBody, _ := json.Marshal(testStartReq(sessA, chanA, chanA))
	rec := httptest.NewRecorder()
	srv.ServeHTTP(rec, signedHTTPRequest(t, secret, http.MethodPost, "/sessions", startBody))
	if rec.Code != http.StatusCreated {
		t.Fatalf("expected 201, got %d: %s", rec.Code, rec.Body.String())
	}

	rec2 := httptest.NewRecorder()
	srv.ServeHTTP(rec2, signedHTTPRequest(t, secret, http.MethodGet, "/sessions", nil))
	if rec2.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d", rec2.Code)
	}

	var raw struct {
		Sessions []map[string]json.RawMessage `json:"sessions"`
	}
	if err := json.Unmarshal(rec2.Body.Bytes(), &raw); err != nil {
		t.Fatalf("invalid JSON: %v", err)
	}
	if len(raw.Sessions) != 1 {
		t.Fatalf("expected exactly one session, got %d", len(raw.Sessions))
	}
	fields := raw.Sessions[0]

	contractFields := []string{
		"sessionId", "room", "channelId", "subscribed", "startedAtMs",
		"lastPartAtMs", "lastIdrAtMs", "openSegmentMs", "partsWritten", "bytesServed",
	}
	for _, f := range contractFields {
		if _, ok := fields[f]; !ok {
			t.Errorf("missing contract field %q in GET /sessions response: %s", f, rec2.Body.String())
		}
	}

	type contractShape struct {
		SessionID     string `json:"sessionId"`
		Room          string `json:"room"`
		ChannelID     string `json:"channelId"`
		Subscribed    bool   `json:"subscribed"`
		StartedAtMs   int64  `json:"startedAtMs"`
		LastPartAtMs  *int64 `json:"lastPartAtMs"`
		LastIdrAtMs   *int64 `json:"lastIdrAtMs"`
		OpenSegmentMs *int64 `json:"openSegmentMs"`
		PartsWritten  uint64 `json:"partsWritten"`
		BytesServed   uint64 `json:"bytesServed"`
	}
	reEncoded, err := json.Marshal(fields)
	if err != nil {
		t.Fatalf("re-encoding failed: %v", err)
	}
	var decoded contractShape
	if err := json.Unmarshal(reEncoded, &decoded); err != nil {
		t.Fatalf("failed to decode the contract shape: %v", err)
	}
	if decoded.SessionID != sessA || decoded.ChannelID != chanA || decoded.Room != chanA {
		t.Fatalf("unexpected identity fields: %+v", decoded)
	}
	if decoded.LastPartAtMs != nil || decoded.LastIdrAtMs != nil || decoded.OpenSegmentMs != nil {
		t.Fatalf("expected nullable fields to be null for a fresh session, got %+v", decoded)
	}
}

func TestServer_MediaRoute_ProxiesUnsignedToSession(t *testing.T) {
	secret := "topsecret"
	spy := &pipelineSpy{}
	srv, reg := newTestServer(t, secret, spy.factory())

	startBody, _ := json.Marshal(testStartReq(sessA, chanA, chanA))
	rec := httptest.NewRecorder()
	srv.ServeHTTP(rec, signedHTTPRequest(t, secret, http.MethodPost, "/sessions", startBody))
	if rec.Code != http.StatusCreated {
		t.Fatalf("expected 201, got %d", rec.Code)
	}
	spy.last().setBody("#EXTM3U\n")

	// Deliberately unsigned: a viewer's player cannot produce an HMAC
	// over pqp-api's shared secret.
	rec2 := httptest.NewRecorder()
	srv.ServeHTTP(rec2, httptest.NewRequest(http.MethodGet, "/s/"+sessA+"/playlist.m3u8", nil))
	if rec2.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", rec2.Code, rec2.Body.String())
	}
	if rec2.Body.String() != "#EXTM3U\n" {
		t.Fatalf("unexpected body: %q", rec2.Body.String())
	}

	if _, ok := reg.Get(sessA); !ok {
		t.Fatal("expected the session to still be registered")
	}
	if got := reg.List()[0].BytesServed; got == 0 {
		t.Fatal("expected BytesServed to reflect the media bytes written to the response")
	}
}

// state.json is the FIRST thing the edge Worker asks for, and on
// 2026-09-15 08:01 UTC it was the one media route this box did not answer
// -- every other one returned 200 while every viewer stalled. This pins
// the seam handleMedia owns: the path reaches the session unchanged, under
// the SAME origin-key gate as every other /s/:id/* route (refused without
// the header, served with it).
func TestServer_MediaRoute_StateJSONReachesTheSession(t *testing.T) {
	secret := "topsecret"
	originKey := "origin-key-value"
	spy := &pipelineSpy{}
	srv, _ := newTestServerWithOriginKey(t, secret, originKey, spy.factory())

	startBody, _ := json.Marshal(testStartReq(sessA, chanA, chanA))
	rec := httptest.NewRecorder()
	srv.ServeHTTP(rec, signedHTTPRequest(t, secret, http.MethodPost, "/sessions", startBody))
	if rec.Code != http.StatusCreated {
		t.Fatalf("expected 201, got %d", rec.Code)
	}
	spy.last().setBody(`{"sessionId":"x"}`)

	noKey := httptest.NewRecorder()
	srv.ServeHTTP(noKey, httptest.NewRequest(http.MethodGet, "/s/"+sessA+"/state.json", nil))
	if noKey.Code != http.StatusUnauthorized {
		t.Fatalf("state.json without the origin key = %d, want 401", noKey.Code)
	}
	if got := spy.last().path(); got != "" {
		t.Fatalf("a refused request still reached the session at %q", got)
	}

	withKey := httptest.NewRequest(http.MethodGet, "/s/"+sessA+"/state.json", nil)
	withKey.Header.Set(OriginKeyHeader, originKey)
	rec2 := httptest.NewRecorder()
	srv.ServeHTTP(rec2, withKey)
	if rec2.Code != http.StatusOK {
		t.Fatalf("state.json = %d: %s", rec2.Code, rec2.Body.String())
	}
	if got := spy.last().path(); got != "/state.json" {
		t.Fatalf("the session saw %q, want /state.json", got)
	}
}

func TestServer_MediaRoute_UnknownSessionIs404(t *testing.T) {
	secret := "topsecret"
	srv, _ := newTestServer(t, secret, failingFactory)

	rec := httptest.NewRecorder()
	srv.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/s/does-not-exist/playlist.m3u8", nil))
	if rec.Code != http.StatusNotFound {
		t.Fatalf("expected 404, got %d", rec.Code)
	}
}

// TestServer_MediaRoute_RequiresOriginKeyWhenConfigured is the HIGH
// finding from Farol's review of PR #584: once MEDIA_ORIGIN_KEY is set,
// /s/:id/* -- L2.3's edge Worker's own seam -- must refuse a request that
// does not carry the matching X-Pqp-Origin-Key header, checked before the
// registry is ever consulted (a request for an id that does not even
// exist must still be refused on the header alone, not leak a 404-vs-401
// distinction to an unauthenticated caller).
func TestServer_MediaRoute_RequiresOriginKeyWhenConfigured(t *testing.T) {
	secret := "topsecret"
	originKey := "edge-worker-shared-key"
	spy := &pipelineSpy{}
	srv, _ := newTestServerWithOriginKey(t, secret, originKey, spy.factory())

	startBody, _ := json.Marshal(testStartReq(sessA, chanA, chanA))
	rec := httptest.NewRecorder()
	srv.ServeHTTP(rec, signedHTTPRequest(t, secret, http.MethodPost, "/sessions", startBody))
	if rec.Code != http.StatusCreated {
		t.Fatalf("expected 201, got %d", rec.Code)
	}
	spy.last().setBody("#EXTM3U\n")

	// No header at all: refused, even for a session id that does exist.
	rec2 := httptest.NewRecorder()
	srv.ServeHTTP(rec2, httptest.NewRequest(http.MethodGet, "/s/"+sessA+"/playlist.m3u8", nil))
	if rec2.Code != http.StatusUnauthorized {
		t.Fatalf("expected 401 with no origin key header, got %d", rec2.Code)
	}

	// Wrong value: also refused.
	rec3 := httptest.NewRecorder()
	req3 := httptest.NewRequest(http.MethodGet, "/s/"+sessA+"/playlist.m3u8", nil)
	req3.Header.Set(OriginKeyHeader, "not-the-right-key")
	srv.ServeHTTP(rec3, req3)
	if rec3.Code != http.StatusUnauthorized {
		t.Fatalf("expected 401 with a wrong origin key, got %d", rec3.Code)
	}

	// An unknown session id, still refused on the header alone -- must
	// not leak whether the id exists to an unauthenticated caller.
	rec4 := httptest.NewRecorder()
	srv.ServeHTTP(rec4, httptest.NewRequest(http.MethodGet, "/s/does-not-exist/playlist.m3u8", nil))
	if rec4.Code != http.StatusUnauthorized {
		t.Fatalf("expected 401 (not 404) for an unknown id with no origin key, got %d", rec4.Code)
	}

	// The correct value: allowed through to the session.
	rec5 := httptest.NewRecorder()
	req5 := httptest.NewRequest(http.MethodGet, "/s/"+sessA+"/playlist.m3u8", nil)
	req5.Header.Set(OriginKeyHeader, originKey)
	srv.ServeHTTP(rec5, req5)
	if rec5.Code != http.StatusOK {
		t.Fatalf("expected 200 with the correct origin key, got %d: %s", rec5.Code, rec5.Body.String())
	}
	if rec5.Body.String() != "#EXTM3U\n" {
		t.Fatalf("unexpected body: %q", rec5.Body.String())
	}
}

// TestServer_MediaRoute_NoOriginKeyConfiguredStaysOpen documents the
// default (loopback) posture is unchanged: with MEDIA_ORIGIN_KEY unset,
// the media routes behave exactly as before this fix (see
// TestServer_MediaRoute_ProxiesUnsignedToSession).
func TestServer_MediaRoute_NoOriginKeyConfiguredStaysOpen(t *testing.T) {
	secret := "topsecret"
	spy := &pipelineSpy{}
	srv, _ := newTestServerWithOriginKey(t, secret, "", spy.factory())

	startBody, _ := json.Marshal(testStartReq(sessA, chanA, chanA))
	rec := httptest.NewRecorder()
	srv.ServeHTTP(rec, signedHTTPRequest(t, secret, http.MethodPost, "/sessions", startBody))
	if rec.Code != http.StatusCreated {
		t.Fatalf("expected 201, got %d", rec.Code)
	}

	rec2 := httptest.NewRecorder()
	srv.ServeHTTP(rec2, httptest.NewRequest(http.MethodGet, "/s/"+sessA+"/playlist.m3u8", nil))
	if rec2.Code != http.StatusOK {
		t.Fatalf("expected 200 with no origin key configured, got %d", rec2.Code)
	}
}

func TestServer_MediaRoute_DemotedSessionIs503(t *testing.T) {
	secret := "topsecret"
	spy := &pipelineSpy{}
	srv, reg := newTestServer(t, secret, spy.factory())

	startBody, _ := json.Marshal(testStartReq(sessA, chanA, chanA))
	rec := httptest.NewRecorder()
	srv.ServeHTTP(rec, signedHTTPRequest(t, secret, http.MethodPost, "/sessions", startBody))
	if rec.Code != http.StatusCreated {
		t.Fatalf("expected 201, got %d", rec.Code)
	}

	ms, ok := reg.Get(sessA)
	if !ok {
		t.Fatal("expected the session to be registered")
	}
	ms.demote("test-forced")

	rec2 := httptest.NewRecorder()
	srv.ServeHTTP(rec2, httptest.NewRequest(http.MethodGet, "/s/"+sessA+"/playlist.m3u8", nil))
	if rec2.Code != http.StatusServiceUnavailable {
		t.Fatalf("expected 503 for a demoted session's media route, got %d", rec2.Code)
	}

	// The session must still be LISTED (demoted, not removed) so pqp-api
	// can notice via GET /sessions -- only an explicit DELETE removes it.
	listRec := httptest.NewRecorder()
	srv.ServeHTTP(listRec, signedHTTPRequest(t, secret, http.MethodGet, "/sessions", nil))
	var listResp ListSessionsResponse
	if err := json.Unmarshal(listRec.Body.Bytes(), &listResp); err != nil {
		t.Fatalf("invalid JSON: %v", err)
	}
	if len(listResp.Sessions) != 1 || !listResp.Sessions[0].Demoted {
		t.Fatalf("expected the demoted session to still be listed with demoted=true, got %+v", listResp.Sessions)
	}
}
