package control

import (
	"log"
	"net/http"
	"sync"
	"sync/atomic"
	"time"
)

// watchdogTick is how often a session's watchdog goroutine evaluates its
// pipeline's health. Far finer than PartStuckMs's own default (3000ms) so
// detection latency is dominated by the configured threshold, not by this
// interval.
const watchdogTick = 500 * time.Millisecond

// ManagedSession is one session this control server holds: its fixed
// identity and config (from StartSessionRequest, immutable for the
// session's whole lifetime, even across an internal restart), the
// currently-active Pipeline (swapped in place by a restart, nilled out by
// demotion or Stop), and the watchdog goroutine driving evaluateWatchdog
// against it.
type ManagedSession struct {
	req         StartSessionRequest
	startedAtMs int64
	cfg         PipelineConfig
	factory     PipelineFactory
	watchdogCfg WatchdogConfig

	mu                sync.Mutex
	current           Pipeline
	pipelineStartedAt time.Time
	// lastHealth is a copy of the last real Health() this session's
	// pipeline ever reported, kept so GET /sessions still shows meaningful
	// numbers for a demoted session instead of resetting to zero the
	// moment its pipeline is closed -- see demote and Info.
	lastHealth  PipelineHealth
	haveHealth  bool
	bytesServed atomic.Uint64

	wdMu sync.Mutex
	wd   watchdogState

	demoted       atomic.Bool
	demotedReason atomic.Value // string

	stopCh   chan struct{}
	stopOnce sync.Once
	wdDone   chan struct{}
}

// newManagedSession registers req with a freshly built Pipeline (via
// factory) but does NOT start its watchdog goroutine -- the caller
// (registry.go's StartOrGet) does that only once the session is actually in
// the registry, so a watchdog can never fire against a session nothing can
// look up yet.
func newManagedSession(req StartSessionRequest, startedAtMs int64, global GlobalConfig, watchdogCfg WatchdogConfig, factory PipelineFactory) (*ManagedSession, error) {
	cfg := PipelineConfig{
		SessionID:      req.SessionID,
		Room:           req.Room,
		ChannelID:      req.ChannelID,
		StartedAtMs:    startedAtMs,
		PartMs:         req.PartMs,
		SegmentMs:      req.SegmentMs,
		RingSegments:   req.RingSegments,
		KeyframePolicy: req.KeyframePolicy,
		PliPaceMs:      req.PliPaceMs,
		PliGateFactor:  req.PliGateFactor,
		Global:         global,
	}

	p, err := factory(cfg)
	if err != nil {
		return nil, err
	}

	return &ManagedSession{
		req:               req,
		startedAtMs:       startedAtMs,
		cfg:               cfg,
		factory:           factory,
		watchdogCfg:       watchdogCfg,
		current:           p,
		pipelineStartedAt: time.Now(),
		stopCh:            make(chan struct{}),
		wdDone:            make(chan struct{}),
	}, nil
}

// runWatchdog is the session's own goroutine: tick, evaluate, act, repeat,
// until Stop closes stopCh. Exactly one of these runs per registered
// session (started once, by registry.go's StartOrGet, immediately after
// insertion).
func (m *ManagedSession) runWatchdog() {
	defer close(m.wdDone)
	ticker := time.NewTicker(watchdogTick)
	defer ticker.Stop()
	for {
		select {
		case <-m.stopCh:
			return
		case now := <-ticker.C:
			m.evaluateTick(now)
		}
	}
}

func (m *ManagedSession) evaluateTick(now time.Time) {
	if m.demoted.Load() {
		return // terminal; nothing left to evaluate or act on
	}

	m.mu.Lock()
	p := m.current
	pStart := m.pipelineStartedAt
	m.mu.Unlock()
	if p == nil {
		return
	}
	h := p.Health()

	m.wdMu.Lock()
	result := evaluateWatchdog(h, m.cfg.SegmentMs, m.watchdogCfg, pStart, &m.wd, now)
	m.wdMu.Unlock()

	switch result.action {
	case actionNone:
	case actionLog:
		log.Printf("pqp-remux: control: session %s: %s", m.req.SessionID, result.reason)
	case actionRestart:
		log.Printf("pqp-remux: control: session %s: restarting (%s)", m.req.SessionID, result.reason)
		m.restart()
	case actionDemote:
		log.Printf("pqp-remux: control: session %s: demoting (%s)", m.req.SessionID, result.reason)
		m.demote(result.reason)
	}
}

// restart builds a fresh Pipeline and swaps it in, closing the old one only
// once the new one is already live -- the same "new up before old down"
// ordering internal/session's own shutdown-order doc comments favor
// elsewhere in this module, minimizing the gap with no viewer-visible
// player rebuild (this task's own acceptance bar). If the factory call
// itself fails (e.g. LiveKit unreachable), the old (stalled) pipeline is
// left in place and this attempt is only logged: the next tick
// re-evaluates against evaluateWatchdog's own ladder, which demotes rather
// than retrying forever once the demote window has already been consumed
// by this attempt (see evaluateWatchdog's doc comment).
//
// The new pipeline's config is m.cfg with StartVideoSegmentIndex/
// StartAudioSegmentIndex overridden to the OLD pipeline's own current
// (open) segment index **plus one** (Farol review, PR #584) -- never the
// bare current index, and never left at m.cfg's original zero value.
// "Plus one" matters because the old pipeline's own teardown (old.Close,
// below) finalizes and enqueues an R2 upload for whatever segment was
// still open on it: closing the subscriber disconnects the room, which
// (per internal/subscriber's own readRTP doc comment: a track "ends" on
// either the publisher stopping OR the session disconnecting) fires
// OnVideoTrackEnded asynchronously, running session.Session.Finish, which
// uploads the video track's current segment; session.Session.Close does
// the same synchronously for audio's own tail segment. If the replacement
// pipeline started at that SAME index instead, its own first sealed
// segment would eventually PUT the identical R2 key the old pipeline's
// teardown is independently in the middle of uploading -- a second write
// to a key already used, silently overwriting real (if truncated) content,
// exactly what this fix exists to prevent. Reserving index+1 for the
// replacement makes the two pipelines' key ranges disjoint by construction,
// regardless of exactly when the old pipeline's async teardown finishes.
func (m *ManagedSession) restart() {
	m.mu.Lock()
	old := m.current
	m.mu.Unlock()

	cfg := m.cfg
	if old != nil {
		oldHealth := old.Health()
		cfg.StartVideoSegmentIndex = oldHealth.VideoSegmentIndex + 1
		cfg.StartAudioSegmentIndex = oldHealth.AudioSegmentIndex + 1
	}

	newP, err := m.factory(cfg)
	if err != nil {
		log.Printf("pqp-remux: control: session %s: restart failed: %v", m.req.SessionID, err)
		return
	}

	m.mu.Lock()
	m.current = newP
	m.pipelineStartedAt = time.Now()
	m.mu.Unlock()

	if old != nil {
		old.Close()
	}
}

// demote is terminal: the pipeline is closed and the session is marked
// demoted, permanently, until an explicit Stop (DELETE /sessions/:id)
// removes it from the registry. The last real Health() this session ever
// reported is cached so GET /sessions still shows meaningful counters for
// a demoted session rather than resetting to zero.
func (m *ManagedSession) demote(reason string) {
	m.demoted.Store(true)
	m.demotedReason.Store(reason)

	m.mu.Lock()
	p := m.current
	if p != nil {
		m.lastHealth = p.Health()
		m.haveHealth = true
	}
	m.current = nil
	m.mu.Unlock()

	if p != nil {
		p.Close()
	}
}

// Stop ends this session for good: signals the watchdog goroutine to exit
// and waits for it (so a tick already in flight can never race this
// call's own teardown -- the same reasoning internal/session.Session.Close
// documents for its own audioMu), then closes whatever pipeline is
// currently active, if any. Idempotent (safe to call more than once, or on
// an already-demoted session whose pipeline is already nil).
func (m *ManagedSession) Stop() {
	m.stopOnce.Do(func() { close(m.stopCh) })
	<-m.wdDone

	m.mu.Lock()
	p := m.current
	m.current = nil
	m.mu.Unlock()

	if p != nil {
		p.Close()
	}
}

// ServeHTTP answers this session's media routes, counting every byte
// actually written to the response (BytesServed on GET /sessions) via
// countingResponseWriter (server.go). Answers 503 once the session has no
// active pipeline (demoted, or torn down by Stop) -- a session id that has
// never existed at all is server.go's handleMedia's own 404, before this
// method is ever reached.
func (m *ManagedSession) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	m.mu.Lock()
	p := m.current
	m.mu.Unlock()
	if p == nil {
		http.Error(w, "session is not active (demoted or stopped)", http.StatusServiceUnavailable)
		return
	}
	cw := &countingResponseWriter{ResponseWriter: w, n: &m.bytesServed}
	p.ServeHTTP(cw, r)
}

// Info builds this session's SessionInfo for GET /sessions (and POST
// /sessions's 201/409 response body).
func (m *ManagedSession) Info() SessionInfo {
	m.mu.Lock()
	p := m.current
	last := m.lastHealth
	haveLast := m.haveHealth
	m.mu.Unlock()

	info := SessionInfo{
		SessionID:   m.req.SessionID,
		Room:        m.req.Room,
		ChannelID:   m.req.ChannelID,
		StartedAtMs: m.startedAtMs,
		Demoted:     m.demoted.Load(),
	}
	if reason, ok := m.demotedReason.Load().(string); ok {
		info.DemotedReason = reason
	}

	var h PipelineHealth
	haveHealth := false
	if p != nil {
		h = p.Health()
		haveHealth = true
	} else if haveLast {
		h = last
		haveHealth = true
	}

	if haveHealth {
		info.Subscribed = h.Subscribed && p != nil // a demoted/stopped session is never "subscribed" even if its last snapshot was
		info.PartsWritten = h.PartsWritten
		if !h.LastPartAt.IsZero() {
			ms := h.LastPartAt.UnixMilli()
			info.LastPartAtMs = &ms
		}
		if !h.LastIdrAt.IsZero() {
			ms := h.LastIdrAt.UnixMilli()
			info.LastIdrAtMs = &ms
			age := time.Since(h.LastIdrAt).Milliseconds()
			info.LastIdrAgeMs = &age
		}
		if h.OpenSegmentOK && p != nil {
			// A stopped/demoted pipeline has no "currently open segment"
			// any more -- only report it while a pipeline is actually
			// live, even though the cached lastHealth snapshot still
			// carries the value it had a moment before closing.
			v := h.OpenSegmentMs
			info.OpenSegmentMs = &v
		}
		info.AudioHealth = AudioHealth{Enabled: h.AudioEnabled, Dead: h.AudioDead, Restarts: h.AudioRestarts}
	}

	info.BytesServed = m.bytesServed.Load()
	info.State = m.stateFor(p, info.Demoted)
	return info
}

// stateFor mirrors evaluateWatchdog's own "has a part ever arrived" phase
// boundary exactly (watchdog.go): PartsWritten > 0 is what separates
// StateWaiting from StateRunning there, so the state this method reports
// is not just a cosmetic summary but the ACTUAL phase the watchdog is
// currently applying its rules from.
func (m *ManagedSession) stateFor(p Pipeline, demoted bool) SessionState {
	if demoted {
		return StateDemoted
	}
	if p == nil {
		return StateWaiting
	}
	h := p.Health()
	if h.PartsWritten > 0 {
		return StateRunning
	}
	return StateWaiting
}

// countingResponseWriter wraps an http.ResponseWriter, counting bytes
// actually written -- BytesServed, "NOT bytes written into the ring", the
// same distinction internal/serve.Health's own doc comment draws for the
// single-session local test surface (which does not count this at all).
type countingResponseWriter struct {
	http.ResponseWriter
	n *atomic.Uint64
}

func (w *countingResponseWriter) Write(b []byte) (int, error) {
	n, err := w.ResponseWriter.Write(b)
	if n > 0 {
		w.n.Add(uint64(n))
	}
	return n, err
}
