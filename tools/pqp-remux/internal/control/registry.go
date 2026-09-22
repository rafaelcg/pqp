package control

import (
	"context"
	"sort"
	"sync"
	"time"
)

// startingEntry tracks one in-flight StartOrGet call: the ONLY reason
// StartOrGet needs to hold anything beyond the finished ManagedSession map
// is to serialize a genuinely concurrent pair of POSTs for the identical
// sessionId (a retried start whose first attempt is still in flight) rather
// than let both call the (slow, network-bound) PipelineFactory at once for
// what must end up being one session. In practice pqp-api's own
// llReconcileQueue already serializes every operation for one channel, so
// two truly concurrent POSTs for the same id are not expected to happen --
// this exists to make the contract's own "idempotent restart-safety"
// promise true regardless, not because the real caller is known to race.
type startingEntry struct {
	done   chan struct{}
	result *ManagedSession
	err    error
}

// Registry holds every session this control server currently knows about,
// keyed by sessionId. Registry itself never touches LiveKit or HTTP; it is
// exercised directly by registry_test.go with a fake PipelineFactory.
type Registry struct {
	// ctx is the supervisor's own lifetime context (cmd/pqp-remuxd/main.go),
	// handed unchanged to every factory call this Registry ever makes --
	// see PipelineFactory's own doc comment for why: a process shutdown
	// (main cancelling this ctx) reaches a session even while it is still
	// being built, not only the ones already registered.
	ctx         context.Context
	factory     PipelineFactory
	global      GlobalConfig
	watchdogCfg WatchdogConfig
	now         func() time.Time

	mu       sync.Mutex
	sessions map[string]*ManagedSession
	starting map[string]*startingEntry
}

// NewRegistry builds an empty Registry. ctx is the supervisor's own
// lifetime context (see Registry's own doc comment); factory builds a
// Pipeline for every session this registry ever starts (including a
// watchdog-triggered restart); global and watchdogCfg are shared by every
// session; now defaults to time.Now if nil (tests substitute a fixed/fake
// clock only for StartedAtMs bookkeeping -- evaluateWatchdog's own clock is
// controlled independently in watchdog_test.go, not through this).
func NewRegistry(ctx context.Context, factory PipelineFactory, global GlobalConfig, watchdogCfg WatchdogConfig, now func() time.Time) *Registry {
	if now == nil {
		now = time.Now
	}
	if ctx == nil {
		ctx = context.Background()
	}
	return &Registry{
		ctx:         ctx,
		factory:     factory,
		global:      global,
		watchdogCfg: watchdogCfg,
		now:         now,
		sessions:    make(map[string]*ManagedSession),
		starting:    make(map[string]*startingEntry),
	}
}

// StartOrGet implements POST /sessions's idempotency contract: if
// req.SessionID already names a session (finished or still starting),
// its current info is returned with isNew=false (the caller answers 409);
// otherwise a new Pipeline is built and, on success, registered and its
// watchdog started, and isNew=true (the caller answers 201). A non-nil err
// means the Pipeline could not be built at all (e.g. LiveKit unreachable)
// -- nothing is registered in that case, so a retried POST with the same id
// tries again cleanly.
func (reg *Registry) StartOrGet(req StartSessionRequest) (info SessionInfo, isNew bool, err error) {
	reg.mu.Lock()
	if ms, ok := reg.sessions[req.SessionID]; ok {
		reg.mu.Unlock()
		return ms.Info(), false, nil
	}
	if se, ok := reg.starting[req.SessionID]; ok {
		reg.mu.Unlock()
		<-se.done
		if se.err != nil {
			return SessionInfo{}, false, se.err
		}
		return se.result.Info(), false, nil
	}
	se := &startingEntry{done: make(chan struct{})}
	reg.starting[req.SessionID] = se
	reg.mu.Unlock()

	// THE CALLER'S CLOCK WINS WHEN IT SENT ONE. `startedAtMs` is what
	// internal/r2.ObjectPrefix embeds in every key this session writes, and
	// pqp-api has already written that same number into
	// `hls_sessions.object_prefix`. Stamping our own here (which is all this
	// did until 2026-09-22) guaranteed the two strings differed -- see
	// StartSessionRequest.StartedAtMs for what that cost. Falling back to
	// reg.now() keeps an older API, and every test that builds a request
	// without the field, behaving exactly as before.
	startedAtMs := req.StartedAtMs
	if startedAtMs <= 0 {
		startedAtMs = reg.now().UnixMilli()
	}
	ms, buildErr := newManagedSession(reg.ctx, req, startedAtMs, reg.global, reg.watchdogCfg, reg.factory)

	reg.mu.Lock()
	delete(reg.starting, req.SessionID)
	if buildErr != nil {
		se.err = buildErr
		close(se.done)
		reg.mu.Unlock()
		return SessionInfo{}, false, buildErr
	}
	reg.sessions[req.SessionID] = ms
	se.result = ms
	close(se.done)
	reg.mu.Unlock()

	go ms.runWatchdog()
	return ms.Info(), true, nil
}

// Stop implements DELETE /sessions/:id: idempotent, so an unknown id is not
// an error -- see the contract's own doc comment ("also on 'already gone'
// -- stopping is idempotent)". Removes the session from the registry
// BEFORE tearing it down, so a concurrent GET /sessions never observes a
// session that is simultaneously "found" and "already closed".
func (reg *Registry) Stop(id string) {
	reg.mu.Lock()
	ms, ok := reg.sessions[id]
	if ok {
		delete(reg.sessions, id)
	}
	reg.mu.Unlock()
	if ok {
		ms.Stop()
	}
}

// Get returns the session with this id, for server.go's media proxy.
func (reg *Registry) Get(id string) (*ManagedSession, bool) {
	reg.mu.Lock()
	defer reg.mu.Unlock()
	ms, ok := reg.sessions[id]
	return ms, ok
}

// List returns every session's current info for GET /sessions, sorted by
// sessionId so the response is deterministic (and easy to diff/test)
// regardless of map iteration order.
func (reg *Registry) List() []SessionInfo {
	reg.mu.Lock()
	sessions := make([]*ManagedSession, 0, len(reg.sessions))
	for _, ms := range reg.sessions {
		sessions = append(sessions, ms)
	}
	reg.mu.Unlock()

	infos := make([]SessionInfo, len(sessions))
	for i, ms := range sessions {
		infos[i] = ms.Info()
	}
	sort.Slice(infos, func(i, j int) bool { return infos[i].SessionID < infos[j].SessionID })
	return infos
}

// StopAll tears down every currently-registered session -- process
// shutdown's job (cmd/pqp-remuxd/main.go), so a killed supervisor does not
// leave a live LiveKit subscription or ffmpeg subprocess behind it.
func (reg *Registry) StopAll() {
	reg.mu.Lock()
	sessions := make([]*ManagedSession, 0, len(reg.sessions))
	for id, ms := range reg.sessions {
		sessions = append(sessions, ms)
		delete(reg.sessions, id)
	}
	reg.mu.Unlock()

	for _, ms := range sessions {
		ms.Stop()
	}
}
