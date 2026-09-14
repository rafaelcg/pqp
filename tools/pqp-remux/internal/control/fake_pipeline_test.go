package control

import (
	"context"
	"errors"
	"net/http"
	"sync"
)

// fakePipeline is a Pipeline with no LiveKit connection, no subprocess and
// no goroutine of its own: its Health() is whatever the test last set,
// which is what makes the watchdog's real (goroutine-driven) restart/demote
// behavior testable end to end without a live room -- see
// registry_test.go and server_test.go.
type fakePipeline struct {
	mu     sync.Mutex
	health PipelineHealth
	body   string
	closed bool
}

func newFakePipeline(h PipelineHealth) *fakePipeline {
	return &fakePipeline{health: h}
}

func (f *fakePipeline) Health() PipelineHealth {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.health
}

func (f *fakePipeline) setHealth(h PipelineHealth) {
	f.mu.Lock()
	f.health = h
	f.mu.Unlock()
}

func (f *fakePipeline) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	f.mu.Lock()
	body := f.body
	f.mu.Unlock()
	w.Write([]byte(body))
}

func (f *fakePipeline) setBody(body string) {
	f.mu.Lock()
	f.body = body
	f.mu.Unlock()
}

func (f *fakePipeline) Close() {
	f.mu.Lock()
	f.closed = true
	f.mu.Unlock()
}

func (f *fakePipeline) isClosed() bool {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.closed
}

// pipelineSpy records every *fakePipeline a PipelineFactory built, in call
// order, so a test can inspect a session's whole pipeline history --
// including a watchdog-triggered restart, which swaps in a genuinely new
// Pipeline instance (managed_session.go's restart).
type pipelineSpy struct {
	mu        sync.Mutex
	pipelines []*fakePipeline
}

func (s *pipelineSpy) factory() PipelineFactory {
	return s.factoryWithHealth(PipelineHealth{})
}

// factoryWithHealth is factory, but every pipeline it builds starts with
// initial (rather than the zero value): useful for watchdog integration
// tests that need to skip straight past the "waiting for a first part"
// phase (see managed_session_test.go's restart-then-demote test, which
// primes every generation with a recent LastPartAt/LastIdrAt so the
// part-stuck ladder -- not FirstPartTimeoutMs -- is what's under test).
func (s *pipelineSpy) factoryWithHealth(initial PipelineHealth) PipelineFactory {
	return func(ctx context.Context, cfg PipelineConfig) (Pipeline, error) {
		p := newFakePipeline(initial)
		s.mu.Lock()
		s.pipelines = append(s.pipelines, p)
		s.mu.Unlock()
		return p, nil
	}
}

func (s *pipelineSpy) count() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return len(s.pipelines)
}

func (s *pipelineSpy) at(i int) *fakePipeline {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.pipelines[i]
}

func (s *pipelineSpy) last() *fakePipeline {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.pipelines[len(s.pipelines)-1]
}

var errFakeFactory = errors.New("fake factory: refusing to connect")

// failingFactory always returns errFakeFactory, for testing that a failed
// start leaves nothing registered.
func failingFactory(ctx context.Context, cfg PipelineConfig) (Pipeline, error) {
	return nil, errFakeFactory
}
