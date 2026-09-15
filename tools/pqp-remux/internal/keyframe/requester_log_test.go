package keyframe

import (
	"fmt"
	"strings"
	"sync"
	"testing"
	"time"
)

type logCollector struct {
	mu    sync.Mutex
	lines []string
}

func (c *logCollector) printf(format string, args ...any) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.lines = append(c.lines, fmt.Sprintf(format, args...))
}

func (c *logCollector) all() []string {
	c.mu.Lock()
	defer c.mu.Unlock()
	return append([]string(nil), c.lines...)
}

func (c *logCollector) containing(substr string) []string {
	var out []string
	for _, l := range c.all() {
		if strings.Contains(l, substr) {
			out = append(out, l)
		}
	}
	return out
}

// The whole PLI path, stated as one test, because the production log of
// 2026-09-15 could not answer any of it: was a PLI ever written, did the
// publisher answer, and how long did it take. Under KEYFRAME_POLICY=pli a
// keyframe request must (1) actually reach the sender, (2) leave a line,
// and (3) leave a second line when the IDR comes back.
func TestRequester_PLIPathIsLoggedAndAnswered(t *testing.T) {
	sender := &fakeSender{}
	logs := &logCollector{}
	r := NewRequester(Config{Policy: PolicyPLI, SegmentTargetMs: 4000, GateFactor: 1.0}, sender)
	r.logf = logs.printf

	cur := at(0)
	r.now = func() time.Time { return cur }
	r.OnIDR(cur)

	// Inside the gate window: nothing asked, nothing logged.
	cur = at(3000)
	r.tick()
	if sender.calls != 0 || len(logs.all()) != 0 {
		t.Fatalf("asked for a keyframe inside the gate window: calls=%d logs=%v", sender.calls, logs.all())
	}

	// The gate window (SEGMENT_MS x 1.0) elapses with no IDR -- what a
	// lost keyframe, or a source that has stopped encoding, looks like.
	cur = at(4000)
	r.tick()
	if sender.calls != 1 {
		t.Fatalf("no PLI written at the gate window: calls=%d", sender.calls)
	}
	sent := logs.containing("PLI sent")
	if len(sent) != 1 {
		t.Fatalf("expected exactly one PLI log line, got %v", logs.all())
	}
	if !strings.Contains(sent[0], "no IDR for 4s") {
		t.Fatalf("the PLI line does not say how long it had been without an IDR: %q", sent[0])
	}

	// Still no answer: the pace floor spaces the retries, and the
	// in-episode throttle keeps the log readable rather than silent.
	for ms := 4500; ms <= 9000; ms += 500 {
		cur = at(ms)
		r.tick()
	}
	if sender.calls < 5 {
		t.Fatalf("expected the requester to keep asking while unanswered, got %d calls", sender.calls)
	}
	if got := len(logs.containing("PLI sent")); got < 2 || got > 3 {
		t.Fatalf("expected the in-episode PLI log to be throttled to a couple of lines, got %d: %v", got, logs.containing("PLI sent"))
	}
	st := r.Stats()
	if st.PLIsSent != uint64(sender.calls) {
		t.Fatalf("Stats().PLIsSent = %d, sender saw %d", st.PLIsSent, sender.calls)
	}
	if st.PLIsSinceIDR != uint64(sender.calls) {
		t.Fatalf("Stats().PLIsSinceIDR = %d, want %d (none answered yet)", st.PLIsSinceIDR, sender.calls)
	}

	// The publisher answers.
	cur = at(9200)
	r.OnIDR(cur)
	answered := logs.containing("IDR after")
	if len(answered) != 1 {
		t.Fatalf("expected exactly one 'IDR after N PLI(s)' line, got %v", logs.all())
	}
	if !strings.Contains(answered[0], "5.2s after the first request") {
		t.Fatalf("the answer line does not carry the round trip: %q", answered[0])
	}
	if st := r.Stats(); st.PLIsSinceIDR != 0 {
		t.Fatalf("PLIsSinceIDR = %d after the IDR, want 0", st.PLIsSinceIDR)
	}

	// A publisher whose own cadence supplies keyframes logs nothing at
	// all: this line exists for the pathological case, not per keyframe.
	before := len(logs.all())
	cur = at(9300)
	r.OnIDR(cur)
	if len(logs.all()) != before {
		t.Fatalf("an unrequested IDR logged a line: %v", logs.all()[before:])
	}
}
