package control

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"
)

// rebindablePipeline is a fakePipeline that also rebinds, the way the
// production pipeline does through internal/subscriber.
type rebindablePipeline struct {
	*fakePipeline
	cfg PipelineConfig

	mu      sync.Mutex
	rebinds []string
	answer  string
}

func (p *rebindablePipeline) Rebind(identity string) string {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.rebinds = append(p.rebinds, identity)
	if p.answer == "" {
		return "bound"
	}
	return p.answer
}

func (p *rebindablePipeline) calls() []string {
	p.mu.Lock()
	defer p.mu.Unlock()
	return append([]string(nil), p.rebinds...)
}

type rebindSpy struct {
	mu        sync.Mutex
	pipelines []*rebindablePipeline
}

func (s *rebindSpy) factory() PipelineFactory {
	return func(_ context.Context, cfg PipelineConfig) (Pipeline, error) {
		p := &rebindablePipeline{fakePipeline: newFakePipeline(PipelineHealth{}), cfg: cfg}
		s.mu.Lock()
		s.pipelines = append(s.pipelines, p)
		s.mu.Unlock()
		return p, nil
	}
}

func (s *rebindSpy) all() []*rebindablePipeline {
	s.mu.Lock()
	defer s.mu.Unlock()
	return append([]*rebindablePipeline(nil), s.pipelines...)
}

func postRebind(t *testing.T, srv *Server, secret, id, identity string) *httptest.ResponseRecorder {
	t.Helper()
	body, _ := json.Marshal(RebindRequest{PresenterIdentity: identity})
	rec := httptest.NewRecorder()
	srv.ServeHTTP(rec, signedHTTPRequest(t, secret, http.MethodPost, "/sessions/"+id+"/rebind", body))
	return rec
}

func startWithPresenter(t *testing.T, srv *Server, secret, presenter string) {
	t.Helper()
	req := testStartReq(sessA, chanA, chanA)
	req.PresenterIdentity = presenter
	body, _ := json.Marshal(req)
	rec := httptest.NewRecorder()
	srv.ServeHTTP(rec, signedHTTPRequest(t, secret, http.MethodPost, "/sessions", body))
	if rec.Code != http.StatusCreated {
		t.Fatalf("start: %d %s", rec.Code, rec.Body.String())
	}
}

// A PRESENTER BACK UNDER A NEW PEER ID IS THE SAME SESSION. The rebind is a
// control call on the session that is already running: no new pipeline, no
// new session id, and GET /sessions says who it follows now.
func TestRebind_KeepsTheSessionAndFollowsTheNewIdentity(t *testing.T) {
	const secret = "topsecret"
	spy := &rebindSpy{}
	srv, reg := newTestServer(t, secret, spy.factory())
	startWithPresenter(t, srv, secret, "peer-1")
	if got := spy.all()[0].cfg.PresenterIdentity; got != "peer-1" {
		t.Fatalf("the start request's presenter did not reach the pipeline: %q", got)
	}

	rec := postRebind(t, srv, secret, sessA, "peer-2")
	if rec.Code != http.StatusOK {
		t.Fatalf("rebind: %d %s", rec.Code, rec.Body.String())
	}
	var resp RebindResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &resp); err != nil {
		t.Fatal(err)
	}
	if resp.SessionID != sessA || resp.PresenterIdentity != "peer-2" || resp.Result != "bound" {
		t.Fatalf("rebind answered %+v", resp)
	}
	if n := len(spy.all()); n != 1 {
		t.Fatalf("a rebind built %d pipelines, want the one already running", n)
	}
	if calls := spy.all()[0].calls(); len(calls) != 1 || calls[0] != "peer-2" {
		t.Fatalf("the pipeline was asked to rebind %v, want [peer-2]", calls)
	}
	infos := reg.List()
	if len(infos) != 1 || infos[0].PresenterIdentity != "peer-2" || infos[0].SessionID != sessA {
		t.Fatalf("GET /sessions after the rebind: %+v", infos)
	}
}

// A watchdog restart after a rebind must bind the identity the presenter has
// NOW, not the one the session was started with.
func TestRebind_AWatchdogRestartFollowsTheLatestIdentity(t *testing.T) {
	const secret = "topsecret"
	spy := &rebindSpy{}
	srv, reg := newTestServer(t, secret, spy.factory())
	startWithPresenter(t, srv, secret, "peer-1")
	if rec := postRebind(t, srv, secret, sessA, "peer-2"); rec.Code != http.StatusOK {
		t.Fatalf("rebind: %d", rec.Code)
	}
	ms, _ := reg.Get(sessA)
	ms.restart()
	ps := spy.all()
	if len(ps) != 2 {
		t.Fatalf("restart built %d pipelines in total, want 2", len(ps))
	}
	if got := ps[1].cfg.PresenterIdentity; got != "peer-2" {
		t.Fatalf("the replacement pipeline follows %q, want peer-2", got)
	}
}

func TestRebind_RefusalsSayWhy(t *testing.T) {
	const secret = "topsecret"
	spy := &rebindSpy{}
	srv, reg := newTestServer(t, secret, spy.factory())

	// Unknown session: a JSON 404, which is how pqp-api tells "no such
	// session" apart from an older box's plain-text "no such route".
	rec := postRebind(t, srv, secret, sessA, "peer-2")
	if rec.Code != http.StatusNotFound {
		t.Fatalf("unknown session: %d", rec.Code)
	}
	var e ErrorResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &e); err != nil || e.Error != "session not found" {
		t.Fatalf("unknown session body %q (err %v)", rec.Body.String(), err)
	}

	startWithPresenter(t, srv, secret, "peer-1")
	// Empty identity: 400, nothing touched.
	rec = postRebind(t, srv, secret, sessA, "")
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("empty identity: %d", rec.Code)
	}
	if calls := spy.all()[0].calls(); len(calls) != 0 {
		t.Fatalf("a refused rebind reached the pipeline: %v", calls)
	}

	// Demoted: 409, the demotion sweep on the API side owns what happens next.
	ms, _ := reg.Get(sessA)
	ms.demote("test-forced")
	rec = postRebind(t, srv, secret, sessA, "peer-2")
	if rec.Code != http.StatusConflict {
		t.Fatalf("demoted session: %d %s", rec.Code, rec.Body.String())
	}
}

// A pipeline that cannot rebind says so rather than pretending.
func TestRebind_APipelineWithoutRebindAnswersUnsupported(t *testing.T) {
	const secret = "topsecret"
	spy := &pipelineSpy{}
	srv, _ := newTestServer(t, secret, spy.factory())
	startWithPresenter(t, srv, secret, "peer-1")
	rec := postRebind(t, srv, secret, sessA, "peer-2")
	var resp RebindResponse
	_ = json.Unmarshal(rec.Body.Bytes(), &resp)
	if rec.Code != http.StatusOK || resp.Result != "unsupported" {
		t.Fatalf("got %d %+v, want 200 unsupported", rec.Code, resp)
	}
}
