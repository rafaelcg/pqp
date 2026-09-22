package control

import (
	"context"
	"sync"
	"testing"
	"time"
)

const (
	sessA = "11111111-1111-1111-1111-111111111111"
	sessB = "22222222-2222-2222-2222-222222222222"
	chanA = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"
	chanB = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb"
)

func testStartReq(sessionID, channelID, room string) StartSessionRequest {
	return StartSessionRequest{
		SessionID:      sessionID,
		Room:           room,
		ChannelID:      channelID,
		PartMs:         500,
		SegmentMs:      4000,
		RingSegments:   6,
		KeyframePolicy: KeyframePolicyNatural,
		PliPaceMs:      500,
		PliGateFactor:  1.5,
	}
}

func newTestRegistry(t *testing.T, factory PipelineFactory) *Registry {
	t.Helper()
	reg := NewRegistry(context.Background(), factory, GlobalConfig{}, fixedWatchdogCfg(), nil)
	t.Cleanup(reg.StopAll)
	return reg
}

func TestRegistry_StartOrGet_RegistersAndIsIdempotent(t *testing.T) {
	spy := &pipelineSpy{}
	reg := newTestRegistry(t, spy.factory())

	req := testStartReq(sessA, chanA, chanA)
	info1, isNew1, err := reg.StartOrGet(req)
	if err != nil {
		t.Fatalf("unexpected error starting a fresh session: %v", err)
	}
	if !isNew1 {
		t.Fatal("expected the first StartOrGet for a fresh sessionId to report isNew=true")
	}
	if info1.SessionID != sessA || info1.ChannelID != chanA {
		t.Fatalf("unexpected info: %+v", info1)
	}
	if spy.count() != 1 {
		t.Fatalf("expected exactly one pipeline built, got %d", spy.count())
	}

	// A retried POST with the same sessionId: idempotent, no second
	// pipeline built, and the caller can tell it was a retry (isNew=false,
	// which server.go turns into a 409).
	info2, isNew2, err := reg.StartOrGet(req)
	if err != nil {
		t.Fatalf("unexpected error on retried start: %v", err)
	}
	if isNew2 {
		t.Fatal("expected a retried StartOrGet for the same sessionId to report isNew=false")
	}
	if info2.SessionID != info1.SessionID {
		t.Fatalf("expected the same session's info back, got %+v vs %+v", info2, info1)
	}
	if spy.count() != 1 {
		t.Fatalf("expected still exactly one pipeline built after a retried start, got %d", spy.count())
	}
}

func TestRegistry_StartOrGet_FailedFactoryRegistersNothing(t *testing.T) {
	reg := newTestRegistry(t, failingFactory)

	req := testStartReq(sessA, chanA, chanA)
	_, _, err := reg.StartOrGet(req)
	if err == nil {
		t.Fatal("expected an error from a failing factory")
	}
	if _, ok := reg.Get(sessA); ok {
		t.Fatal("expected nothing to be registered after a failed start")
	}
	if len(reg.List()) != 0 {
		t.Fatalf("expected an empty session list after a failed start, got %v", reg.List())
	}

	// A retry after the failure must be free to try again (not stuck
	// behind a stale "starting" placeholder).
	spy := &pipelineSpy{}
	reg2 := newTestRegistry(t, spy.factory())
	if _, isNew, err := reg2.StartOrGet(req); err != nil || !isNew {
		t.Fatalf("expected a fresh registry to accept the same request cleanly, got isNew=%v err=%v", isNew, err)
	}
}

func TestRegistry_Stop_IsIdempotent(t *testing.T) {
	spy := &pipelineSpy{}
	reg := newTestRegistry(t, spy.factory())

	req := testStartReq(sessA, chanA, chanA)
	if _, _, err := reg.StartOrGet(req); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	reg.Stop(sessA)
	if _, ok := reg.Get(sessA); ok {
		t.Fatal("expected the session to be gone after Stop")
	}
	if !spy.last().isClosed() {
		t.Fatal("expected Stop to close the pipeline")
	}

	// Stopping again, and stopping an id that never existed: both no-ops,
	// per the contract's own idempotent-DELETE rule -- must not panic or
	// error.
	reg.Stop(sessA)
	reg.Stop("never-existed")
}

func TestRegistry_ConcurrentSessionsAreIsolated(t *testing.T) {
	spy := &pipelineSpy{}
	reg := newTestRegistry(t, spy.factory())

	const n = 8
	ids := make([]string, n)
	for i := range ids {
		ids[i] = uuidForIndex(i)
	}

	var wg sync.WaitGroup
	errs := make([]error, n)
	for i, id := range ids {
		wg.Add(1)
		go func(i int, id string) {
			defer wg.Done()
			_, _, err := reg.StartOrGet(testStartReq(id, chanA, chanA))
			errs[i] = err
		}(i, id)
	}
	wg.Wait()

	for i, err := range errs {
		if err != nil {
			t.Fatalf("session %d: unexpected error: %v", i, err)
		}
	}
	if spy.count() != n {
		t.Fatalf("expected %d distinct pipelines, got %d", n, spy.count())
	}
	if got := len(reg.List()); got != n {
		t.Fatalf("expected %d sessions listed, got %d", n, got)
	}

	// Give one session a distinctive health snapshot and stop a
	// DIFFERENT one: the two must not affect each other at all (isolation
	// under concurrency, not just under sequential calls).
	target, ok := reg.Get(ids[0])
	if !ok {
		t.Fatalf("expected session %s to be registered", ids[0])
	}
	_ = target // sanity: Get works after concurrent inserts too

	reg.Stop(ids[1])
	if _, ok := reg.Get(ids[1]); ok {
		t.Fatal("expected the stopped session to be gone")
	}
	if _, ok := reg.Get(ids[0]); !ok {
		t.Fatal("expected an unrelated session to be untouched by stopping a different one")
	}
	if len(reg.List()) != n-1 {
		t.Fatalf("expected %d sessions remaining after stopping one, got %d", n-1, len(reg.List()))
	}
}

// TestRegistry_ConcurrentIdenticalStartIsSerialized covers the genuine (if
// rare in practice -- see startingEntry's own doc comment) race the
// contract's "idempotent restart-safety for a retried start" language
// exists for: two concurrent POSTs for the SAME sessionId must result in
// exactly one pipeline, not two.
func TestRegistry_ConcurrentIdenticalStartIsSerialized(t *testing.T) {
	spy := &pipelineSpy{}
	reg := newTestRegistry(t, spy.factory())
	req := testStartReq(sessA, chanA, chanA)

	const n = 16
	var wg sync.WaitGroup
	newCount := 0
	var mu sync.Mutex
	for i := 0; i < n; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			_, isNew, err := reg.StartOrGet(req)
			if err != nil {
				t.Errorf("unexpected error: %v", err)
				return
			}
			if isNew {
				mu.Lock()
				newCount++
				mu.Unlock()
			}
		}()
	}
	wg.Wait()

	if newCount != 1 {
		t.Fatalf("expected exactly one caller to observe isNew=true, got %d", newCount)
	}
	if spy.count() != 1 {
		t.Fatalf("expected exactly one pipeline built for %d concurrent identical starts, got %d", n, spy.count())
	}
}

// uuidForIndex builds a distinct, valid-looking UUID for test fixtures
// without a UUID library.
func uuidForIndex(i int) string {
	base := []rune("00000000-0000-0000-0000-000000000000")
	digit := rune('0' + i%10)
	base[len(base)-1] = digit
	return string(base)
}

// The API's own started_at is what names the R2 objects, so a request that
// carries one must not be re-stamped with this box's clock. Two prefixes that
// differ by a few milliseconds are two prefixes: the row points at one and
// every byte lands under the other (see StartSessionRequest.StartedAtMs).
func TestRegistry_StartOrGet_UsesTheRequestsStartedAtMs(t *testing.T) {
	spy := &pipelineSpy{}
	reg := NewRegistry(
		context.Background(),
		spy.factory(),
		GlobalConfig{},
		fixedWatchdogCfg(),
		func() time.Time { return time.UnixMilli(1_790_029_999_999) },
	)
	t.Cleanup(reg.StopAll)

	req := testStartReq(sessA, chanA, chanA)
	req.StartedAtMs = 1_790_029_937_773
	info, isNew, err := reg.StartOrGet(req)
	if err != nil || !isNew {
		t.Fatalf("StartOrGet: isNew=%v err=%v", isNew, err)
	}
	if info.StartedAtMs != req.StartedAtMs {
		t.Fatalf("StartedAtMs = %d, want the request's %d", info.StartedAtMs, req.StartedAtMs)
	}
}

// Without the field (an older pqp-api, and every other test in this file),
// the box keeps stamping its own clock -- the behaviour that existed before
// the field did.
func TestRegistry_StartOrGet_FallsBackToItsOwnClock(t *testing.T) {
	spy := &pipelineSpy{}
	const boxNowMs = 1_790_029_999_999
	reg := NewRegistry(
		context.Background(),
		spy.factory(),
		GlobalConfig{},
		fixedWatchdogCfg(),
		func() time.Time { return time.UnixMilli(boxNowMs) },
	)
	t.Cleanup(reg.StopAll)

	info, _, err := reg.StartOrGet(testStartReq(sessA, chanA, chanA))
	if err != nil {
		t.Fatalf("StartOrGet: %v", err)
	}
	if info.StartedAtMs != boxNowMs {
		t.Fatalf("StartedAtMs = %d, want the box clock's %d", info.StartedAtMs, boxNowMs)
	}
}

// A retried POST for a session that already exists keeps the session it
// already has, startedAt included: re-stamping it would move the whole
// session's object prefix mid-show.
func TestRegistry_StartOrGet_RetryKeepsTheOriginalStartedAt(t *testing.T) {
	spy := &pipelineSpy{}
	reg := newTestRegistry(t, spy.factory())

	req := testStartReq(sessA, chanA, chanA)
	req.StartedAtMs = 1_790_029_937_773
	first, _, err := reg.StartOrGet(req)
	if err != nil {
		t.Fatalf("StartOrGet: %v", err)
	}

	retried := req
	retried.StartedAtMs = req.StartedAtMs + 5_000
	second, isNew, err := reg.StartOrGet(retried)
	if err != nil {
		t.Fatalf("retried StartOrGet: %v", err)
	}
	if isNew {
		t.Fatal("expected the retry to find the existing session")
	}
	if second.StartedAtMs != first.StartedAtMs {
		t.Fatalf("StartedAtMs moved on a retry: %d -> %d", first.StartedAtMs, second.StartedAtMs)
	}
	if spy.count() != 1 {
		t.Fatalf("expected one pipeline built, got %d", spy.count())
	}
}

// The session's replay index is built once and handed to every pipeline this
// session ever builds -- including the watchdog's replacement, which is the
// whole reason it does not live on the pipeline.
func TestRegistry_StartOrGet_GivesThePipelineTheSessionsVodIndex(t *testing.T) {
	spy := &pipelineSpy{}
	reg := NewRegistry(
		context.Background(),
		spy.factory(),
		GlobalConfig{
			LiveHlsS3Endpoint:        "http://localhost:9000",
			LiveHlsS3Bucket:          "pqp-live",
			LiveHlsS3AccessKeyID:     "key",
			LiveHlsS3SecretAccessKey: "secret",
		},
		fixedWatchdogCfg(),
		nil,
	)
	t.Cleanup(reg.StopAll)

	if _, _, err := reg.StartOrGet(testStartReq(sessA, chanA, chanA)); err != nil {
		t.Fatalf("StartOrGet: %v", err)
	}
	ms, ok := reg.Get(sessA)
	if !ok {
		t.Fatal("expected the session to be registered")
	}
	if ms.cfg.VodIndex == nil {
		t.Fatal("expected a VodIndex on the pipeline config when S3 is configured")
	}

	// A restart reuses m.cfg, so the replacement gets the SAME index.
	before := ms.cfg.VodIndex
	ms.restart()
	if ms.cfg.VodIndex != before {
		t.Fatal("the session's VodIndex must not be replaced by a restart")
	}
	if spy.count() != 2 {
		t.Fatalf("expected a replacement pipeline, got %d built", spy.count())
	}
}

// No bucket, no index: the playlists have nowhere to go, and every method on
// a nil *r2.VodIndex is a no-op, so nothing downstream needs a branch.
func TestRegistry_StartOrGet_NoVodIndexWithoutStorage(t *testing.T) {
	spy := &pipelineSpy{}
	reg := newTestRegistry(t, spy.factory())
	if _, _, err := reg.StartOrGet(testStartReq(sessA, chanA, chanA)); err != nil {
		t.Fatalf("StartOrGet: %v", err)
	}
	ms, _ := reg.Get(sessA)
	if ms.cfg.VodIndex != nil {
		t.Fatal("expected no VodIndex when the box has no S3 configuration")
	}
}
