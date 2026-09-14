package control

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strconv"
	"testing"
	"time"
)

func signedHTTPRequest(t *testing.T, secret, method, path string, body []byte) *http.Request {
	t.Helper()
	ts := strconv.FormatInt(time.Now().UnixMilli(), 10)
	sig := sign([]byte(secret), method, path, ts, string(body))
	var r io.Reader
	if body != nil {
		r = bytes.NewReader(body)
	}
	req := httptest.NewRequest(method, path, r)
	req.Header.Set(TimestampHeader, ts)
	req.Header.Set(SignatureHeader, sig)
	return req
}

func newTestServer(t *testing.T, secret string, factory PipelineFactory) (*Server, *Registry) {
	t.Helper()
	reg := NewRegistry(factory, GlobalConfig{}, fixedWatchdogCfg(), nil)
	t.Cleanup(reg.StopAll)
	return NewServer(secret, reg), reg
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

func TestServer_MediaRoute_UnknownSessionIs404(t *testing.T) {
	secret := "topsecret"
	srv, _ := newTestServer(t, secret, failingFactory)

	rec := httptest.NewRecorder()
	srv.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/s/does-not-exist/playlist.m3u8", nil))
	if rec.Code != http.StatusNotFound {
		t.Fatalf("expected 404, got %d", rec.Code)
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
