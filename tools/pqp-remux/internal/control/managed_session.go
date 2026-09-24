package control

import (
	"context"
	"errors"
	"log"
	"net/http"
	"sync"
	"sync/atomic"
	"time"

	"github.com/rafaelcg/pqp/tools/pqp-remux/internal/r2"
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
	// ctx is the supervisor's own lifetime context, carried from
	// Registry (see its own doc comment) and reused, unchanged, for
	// every factory call this session ever makes -- the initial build in
	// newManagedSession AND every watchdog-triggered restart (restart,
	// below) -- so a restart's replacement pipeline is just as
	// cancelable by process shutdown as the session's first one was.
	ctx         context.Context
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
	// presenterIdentity is who the session follows: the start request's,
	// then the latest rebind's. Guarded by mu, and handed to every pipeline
	// a watchdog restart builds, so a restart never binds the identity the
	// presenter had before they reconnected.
	presenterIdentity string
	// rebindsBefore is the screen-track rebinds earlier pipelines of this
	// session made, so GET /sessions counts them across a restart.
	rebindsBefore atomic.Uint64

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
func newManagedSession(ctx context.Context, req StartSessionRequest, startedAtMs int64, global GlobalConfig, watchdogCfg WatchdogConfig, factory PipelineFactory) (*ManagedSession, error) {
	if ctx == nil {
		ctx = context.Background()
	}
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

		PresenterIdentity: req.PresenterIdentity,
	}
	// ONE INDEX PER SESSION, built here rather than in the factory, because
	// the factory runs again on every watchdog restart and the replay is the
	// whole show, not the part after the last stall. Only when there is a
	// bucket to write it to; r2.VodIndex's methods are all nil-safe, so the
	// pipeline needs no second branch for the unconfigured case.
	if global.LiveHlsS3Configured() {
		cfg.VodIndex = r2.NewVodIndex()
	}

	// The part target is per session, so the part-stuck threshold cannot
	// be derived from GlobalConfig alone -- see
	// WatchdogConfig.partStuckThreshold for what it is derived FOR.
	watchdogCfg.PartMs = int64(req.PartMs)

	p, err := factory(ctx, cfg)
	if err != nil {
		return nil, err
	}

	return &ManagedSession{
		ctx:               ctx,
		req:               req,
		startedAtMs:       startedAtMs,
		cfg:               cfg,
		factory:           factory,
		watchdogCfg:       watchdogCfg,
		current:           p,
		presenterIdentity: req.PresenterIdentity,
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

	// Every verdict carries its detail (watchdog.go's stallDetail): which
	// clocks stopped, how long ago, and what the source was doing. The
	// 2026-09-15 incident logged `restarting (part-stuck)` and nothing
	// else, which is exactly as much as `restarting` on its own would
	// have been worth.
	switch result.action {
	case actionNone:
	case actionLog:
		log.Printf("pqp-remux: control: session %s: %s: %s", m.req.SessionID, result.reason, result.detail)
	case actionRestart:
		log.Printf("pqp-remux: control: session %s: restarting (%s): %s", m.req.SessionID, result.reason, result.detail)
		m.restart()
	case actionDemote:
		log.Printf("pqp-remux: control: session %s: demoting (%s): %s", m.req.SessionID, result.reason, result.detail)
		m.demote(result.reason)
	}
}

// restart closes the OLD pipeline FIRST and only then builds its
// replacement (Farol review round 2, PR #584 -- this inverts the "new up
// before old down" ordering an earlier revision used, which minimized the
// viewer-visible gap but was wrong: see the segment-index reasoning
// below). If the factory call itself fails (e.g. LiveKit unreachable), the
// session is left with no active pipeline and this attempt is only
// logged: the next tick re-evaluates against evaluateWatchdog's own
// ladder, which demotes rather than retrying forever once the demote
// window has already been consumed by this attempt (see evaluateWatchdog's
// doc comment). That failure mode is new too -- the old ordering kept the
// stalled pipeline alive on a failed restart, but keeping it alive is
// exactly the "still active" state this fix removes, so a failed factory
// call now demotes on the next tick instead of silently continuing to
// serve a pipeline whose segment numbering this method has already
// promised to a replacement that never got built.
//
// The new pipeline's config is m.cfg with StartVideoSegmentIndex/
// StartAudioSegmentIndex (and, since PR #621, StartVideoPartSeq/
// StartAudioPartSeq) overridden to the OLD pipeline's own final (now
// sealed) segment index and part sequence **plus one** (Farol review,
// PR #584) -- never the
// bare index, and never left at m.cfg's original zero value. "Plus one"
// matters because the old pipeline's own teardown (old.Close, below)
// finalizes and enqueues an R2 upload for whatever segment was still open
// on it: closing the subscriber disconnects the room, which (per
// internal/subscriber's own readRTP doc comment: a track "ends" on either
// the publisher stopping OR the session disconnecting) fires
// OnVideoTrackEnded asynchronously, running session.Session.Finish, which
// uploads the video track's current segment; session.Session.Close does
// the same synchronously for audio's own tail segment. If the replacement
// pipeline started at that SAME index instead, its own first sealed
// segment would eventually PUT the identical R2 key the old pipeline's
// teardown independently uploads -- a second write to a key already used,
// silently overwriting real (if truncated) content, exactly what this fix
// exists to prevent.
//
// Reading that final index requires old to actually BE final first. An
// earlier revision read old.Health() while old was still subscribed and
// only called old.Close() afterward, once the replacement was already
// live -- built by m.factory(cfg), which for the production Pipeline
// (NewRemuxPipeline) means connecting a brand new subscriber.Session to
// LiveKit, real network time old keeps running through. A stalled
// pipeline's segment boundary is exactly as likely to fall inside that
// window as any other moment, and old's own natural rollover during it
// seals a segment index one past the one Health() already reported --
// old.Close() then uploads THAT index, colliding with the replacement's
// reserved start. Closing old before reading its index (and before
// building the replacement) removes the window: nothing can advance old's
// fragmenter once its subscriber is disconnected and its context
// cancelled, so the Health() read below is the true final value, not a
// snapshot a concurrent rollover can invalidate. The cost is a real gap
// (the replacement's own subscriber connect time) with no active pipeline
// serving new media; acceptable because a watchdog restart is already a
// stall-recovery path, and a never-collide guarantee on R2 keys matters
// more here than shaving that gap.
func (m *ManagedSession) restart() {
	m.mu.Lock()
	old := m.current
	m.mu.Unlock()

	cfg := m.cfg
	m.mu.Lock()
	cfg.PresenterIdentity = m.presenterIdentity
	m.mu.Unlock()
	if old != nil {
		old.Close()
		oldHealth := old.Health()
		m.rebindsBefore.Add(oldHealth.VideoRebinds)
		cfg.StartVideoSegmentIndex = oldHealth.VideoSegmentIndex + 1
		cfg.StartAudioSegmentIndex = oldHealth.AudioSegmentIndex + 1
		// And the same handoff one level down, for PART names. Segment
		// indices were carried across from the start because an R2 key
		// collision overwrote real content; part sequence numbers were
		// not, because nothing outside this process could see a part's
		// name. state.json changed that: the edge Worker advertises
		// "part-<seq>.m4s" to players and caches it by path with the
		// token dropped, so a replacement starting back at 1 would serve
		// its predecessor's bytes under its own names for as long as
		// that cache lives (Farol review, PR #621).
		cfg.StartVideoPartSeq = oldHealth.VideoPartSeq + 1
		cfg.StartAudioPartSeq = oldHealth.AudioPartSeq + 1
		// Not +1: the generation is a count, and the replacement's first
		// init increments it before naming the object.
		cfg.StartVideoInitGeneration = oldHealth.VideoInitGeneration

		m.mu.Lock()
		m.current = nil
		m.mu.Unlock()
	}

	newP, err := m.factory(m.ctx, cfg)
	if err != nil {
		log.Printf("pqp-remux: control: session %s: restart failed: %v", m.req.SessionID, err)
		return
	}

	m.mu.Lock()
	m.current = newP
	m.pipelineStartedAt = time.Now()
	m.mu.Unlock()
}

// demote is terminal: the pipeline is closed and the session is marked
// demoted, permanently, until an explicit Stop (DELETE /sessions/:id)
// removes it from the registry. The last real Health() this session ever
// reported is cached so GET /sessions still shows meaningful counters for
// a demoted session rather than resetting to zero.
// errSessionDemoted is Rebind's answer for a session the watchdog already
// gave up on: there is no pipeline to rebind, and pqp-api's demotion sweep
// owns what happens next.
var errSessionDemoted = errors.New("session is demoted")

// Rebind makes the session follow identity from now on: pqp-api's answer to
// the same presenter coming back under a new peer id (a reconnect that could
// not resume), and its nudge when it sees the presenter's screen track
// replaced. Everything that makes the session the SAME session is kept: the
// id, the R2 prefix, part and segment numbering, the PROGRAM-DATE-TIME
// anchor, the replay index. Only the screen-share track the subscriber reads
// changes (internal/subscriber's binder). The result is RebindResponse's.
//
// A pipeline that cannot rebind (a test fake) answers "unsupported"; one
// between the two halves of a watchdog restart answers "pending", and the
// replacement is built following identity.
func (m *ManagedSession) Rebind(identity string) (string, error) {
	if m.demoted.Load() {
		return "", errSessionDemoted
	}
	m.mu.Lock()
	previous := m.presenterIdentity
	m.presenterIdentity = identity
	p := m.current
	m.mu.Unlock()

	result := "pending"
	if p != nil {
		if r, ok := p.(Rebinder); ok {
			result = r.Rebind(identity)
		} else {
			result = "unsupported"
		}
	}
	log.Printf("pqp-remux: control: session %s: rebind presenter %q -> %q: %s", m.req.SessionID, previous, identity, result)
	return result, nil
}

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

	m.mu.Lock()
	info.PresenterIdentity = m.presenterIdentity
	m.mu.Unlock()
	info.VideoRebinds = m.rebindsBefore.Load()
	if haveHealth {
		info.VideoRebinds += h.VideoRebinds
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
