package keyframe

import (
	"sync"
	"testing"
	"time"
)

type fakeSender struct{ calls int }

func (f *fakeSender) RequestKeyframe() { f.calls++ }

func TestRequester_TickSendsWhenGateSatisfied(t *testing.T) {
	sender := &fakeSender{}
	r := NewRequester(Config{Policy: PolicyPLI, SegmentTargetMs: 4000, GateFactor: 1.5}, sender)

	cur := at(0)
	r.now = func() time.Time { return cur }
	r.OnIDR(cur)

	r.tick() // t=0, well inside the gate window
	if sender.calls != 0 {
		t.Fatalf("expected no PLI yet, got %d", sender.calls)
	}

	cur = at(6000) // exactly the gate window
	r.tick()
	if sender.calls != 1 {
		t.Fatalf("expected 1 PLI at the gate window, got %d", sender.calls)
	}

	cur = at(6100) // inside the pace floor since the last PLI
	r.tick()
	if sender.calls != 1 {
		t.Fatalf("expected still 1 PLI (paced), got %d", sender.calls)
	}

	cur = at(6600) // past the 500ms pace floor
	r.tick()
	if sender.calls != 2 {
		t.Fatalf("expected a second PLI once paced, got %d", sender.calls)
	}
}

func TestRequester_OnIDRResetsGate(t *testing.T) {
	sender := &fakeSender{}
	r := NewRequester(Config{Policy: PolicyPLI, SegmentTargetMs: 4000, GateFactor: 1.5}, sender)

	cur := at(0)
	r.now = func() time.Time { return cur }
	r.OnIDR(cur)

	cur = at(6000)
	r.tick()
	if sender.calls != 1 {
		t.Fatalf("expected 1 PLI, got %d", sender.calls)
	}

	// A real IDR arrives: the gate must not fire again immediately even
	// though a PLI was sent a long time ago by wall clock, because OnIDR
	// resets the window from this fresh IDR.
	cur = at(6050)
	r.OnIDR(cur)
	r.tick()
	if sender.calls != 1 {
		t.Fatalf("expected no new PLI right after a fresh IDR, got %d", sender.calls)
	}
}

// TestRequester_ConcurrentOnIDRAndTick is the regression test for the data
// race Farol caught: OnIDR (called from the depacketizer's goroutine) and
// tick (called from Run's ticker goroutine) touch the same state. Run under
// `go test -race` (the project's `make test` target always does), this
// fails without the mutex in requester.go.
func TestRequester_ConcurrentOnIDRAndTick(t *testing.T) {
	sender := &fakeSender{}
	r := NewRequester(Config{Policy: PolicyPLI, SegmentTargetMs: 4000, GateFactor: 1.5}, sender)

	var wg sync.WaitGroup
	wg.Add(2)
	go func() {
		defer wg.Done()
		for i := 0; i < 200; i++ {
			r.OnIDR(time.Now())
		}
	}()
	go func() {
		defer wg.Done()
		for i := 0; i < 200; i++ {
			r.tick()
		}
	}()
	wg.Wait()
}

func TestRequester_NaturalPolicyNeverSends(t *testing.T) {
	sender := &fakeSender{}
	r := NewRequester(Config{Policy: PolicyNatural, SegmentTargetMs: 4000}, sender)
	cur := at(1_000_000)
	r.now = func() time.Time { return cur }
	for i := 0; i < 10; i++ {
		r.tick()
	}
	if sender.calls != 0 {
		t.Fatalf("PolicyNatural must never send a PLI, got %d calls", sender.calls)
	}
}

func TestRequester_OnLossSendsImmediatelyAndIsPaced(t *testing.T) {
	sender := &fakeSender{}
	r := NewRequester(Config{Policy: PolicyPLI, SegmentTargetMs: 4000}, sender)
	cur := at(0)
	r.now = func() time.Time { return cur }
	r.OnIDR(cur)

	if !r.OnLoss(at(100)) || sender.calls != 1 {
		t.Fatalf("first loss must send a PLI at once: calls=%d", sender.calls)
	}
	if r.OnLoss(at(200)) || sender.calls != 1 {
		t.Fatalf("a second loss 100ms later must be paced: calls=%d", sender.calls)
	}
	if !r.OnLoss(at(500)) || sender.calls != 2 {
		t.Fatalf("a loss past the pace must send again: calls=%d", sender.calls)
	}
	st := r.Stats()
	if st.LossPLIs != 2 || st.PLIsSent != 2 || st.PLIsSinceIDR != 2 {
		t.Fatalf("stats = %+v", st)
	}
	// The periodic gate paces off the loss PLI too: no burst right after.
	cur = at(600)
	r.tick()
	if sender.calls != 2 {
		t.Fatalf("periodic tick right after a loss PLI must not double up: calls=%d", sender.calls)
	}
	var nilReq *Requester
	if nilReq.OnLoss(at(0)) {
		t.Fatal("nil requester must be a no-op")
	}
}

func TestRequester_RetriesEverySecondWhileAnIDRIsOwedAfterLoss(t *testing.T) {
	sender := &fakeSender{}
	r := NewRequester(Config{Policy: PolicyPLI, SegmentTargetMs: 4000}, sender)
	cur := at(0)
	r.now = func() time.Time { return cur }
	r.OnIDR(cur)

	cur = at(500)
	if !r.OnLoss(cur) || sender.calls != 1 {
		t.Fatalf("loss PLI: calls=%d", sender.calls)
	}
	cur = at(1000)
	r.tick()
	if sender.calls != 1 {
		t.Fatalf("500ms after the loss PLI nothing should re-send: calls=%d", sender.calls)
	}
	cur = at(500 + int(lossRetryInterval/time.Millisecond))
	r.tick()
	if sender.calls != 2 {
		t.Fatalf("a second past the loss PLI with no IDR must re-send: calls=%d", sender.calls)
	}
	cur = at(500 + 2*int(lossRetryInterval/time.Millisecond))
	r.tick()
	if sender.calls != 3 {
		t.Fatalf("and again: calls=%d", sender.calls)
	}
	// The IDR arrives: the retry stops, the periodic gate is back in charge.
	r.OnIDR(cur)
	cur = cur.Add(2 * lossRetryInterval)
	r.tick()
	if sender.calls != 3 {
		t.Fatalf("after the IDR the loss retry must stop: calls=%d", sender.calls)
	}
	if st := r.Stats(); st.LossPLIs != 3 {
		t.Fatalf("LossPLIs = %d, want 3 (one loss PLI + two retries)", st.LossPLIs)
	}
}
