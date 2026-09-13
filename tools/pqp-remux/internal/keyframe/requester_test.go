package keyframe

import (
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
