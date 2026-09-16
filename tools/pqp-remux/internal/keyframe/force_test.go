package keyframe

import (
	"testing"
	"time"
)

type countSender struct{ n int }

func (c *countSender) RequestKeyframe() { c.n++ }

func TestForcePLI_SendsOutsideGateButPaced(t *testing.T) {
	send := &countSender{}
	now := time.Unix(1000, 0)
	r := NewRequester(Config{Policy: PolicyPLI, PaceMs: 500}, send)
	r.now = func() time.Time { return now }

	// Fresh IDR just arrived: the gate would NOT send a PLI yet, but a discard
	// forces one immediately.
	r.OnIDR(now)
	if !r.ForcePLI("discard") {
		t.Fatal("first ForcePLI after an IDR should send")
	}
	if send.n != 1 {
		t.Fatalf("RequestKeyframe calls = %d, want 1", send.n)
	}

	// A second force 100ms later is inside the pace floor: no extra PLI.
	now = now.Add(100 * time.Millisecond)
	if r.ForcePLI("discard") {
		t.Fatal("a force within Pace() must be suppressed")
	}
	if send.n != 1 {
		t.Fatalf("RequestKeyframe calls = %d, want still 1", send.n)
	}

	// Past the pace floor: it sends again.
	now = now.Add(500 * time.Millisecond)
	if !r.ForcePLI("discard") {
		t.Fatal("a force past Pace() should send")
	}
	if send.n != 2 {
		t.Fatalf("RequestKeyframe calls = %d, want 2", send.n)
	}
}

func TestForcePLI_NoopUnderNatural(t *testing.T) {
	send := &countSender{}
	r := NewRequester(Config{Policy: PolicyNatural}, send)
	if r.ForcePLI("discard") || send.n != 0 {
		t.Fatal("ForcePLI must be a no-op under PolicyNatural")
	}
	var nilReq *Requester
	if nilReq.ForcePLI("discard") {
		t.Fatal("ForcePLI on a nil Requester must be a safe no-op")
	}
}
