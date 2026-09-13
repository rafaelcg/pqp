package idrlog

import (
	"bytes"
	"strings"
	"testing"
	"time"
)

func TestLogger_FirstIDRLine(t *testing.T) {
	var buf bytes.Buffer
	l := New(&buf)
	start := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)

	l.OnIDR(1000, 5000, start)

	got := strings.TrimSpace(buf.String())
	if got != "0,1000,5000,0" {
		t.Fatalf("first IDR line = %q, want %q", got, "0,1000,5000,0")
	}
	if s := l.Stats(); s.Count != 0 {
		t.Fatalf("the first IDR's gap must not enter the distribution, got Count=%d", s.Count)
	}
}

func TestLogger_SubsequentLinesCarryInterval(t *testing.T) {
	var buf bytes.Buffer
	l := New(&buf)
	start := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)

	l.OnIDR(0, 100, start)
	l.OnIDR(360000, 200, start.Add(4*time.Second))
	l.OnIDR(720000, 150, start.Add(9*time.Second))

	lines := strings.Split(strings.TrimSpace(buf.String()), "\n")
	if len(lines) != 3 {
		t.Fatalf("expected 3 lines, got %d: %v", len(lines), lines)
	}
	if lines[1] != "4000,360000,200,4000" {
		t.Fatalf("second line = %q, want ts=4000 interval=4000", lines[1])
	}
	if lines[2] != "9000,720000,150,5000" {
		t.Fatalf("third line = %q, want ts=9000 interval=5000", lines[2])
	}

	s := l.Stats()
	if s.Count != 2 {
		t.Fatalf("expected 2 intervals in the distribution (first IDR excluded), got %d", s.Count)
	}
}

func TestLogger_StatsBeforeAnyIDR(t *testing.T) {
	var buf bytes.Buffer
	l := New(&buf)
	s := l.Stats()
	if s.Count != 0 || s.P50 != 0 || s.Max != 0 {
		t.Fatalf("expected a zero Stats with no IDRs recorded, got %+v", s)
	}
}

func TestLogger_PercentilesAndThresholds(t *testing.T) {
	var buf bytes.Buffer
	l := New(&buf)
	start := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)

	// First IDR seeds the baseline (excluded); then intervals of
	// 1,2,3,...,10 seconds, so p50/p95/max and the threshold counts are
	// all hand-checkable.
	cursor := start
	l.OnIDR(0, 1, cursor)
	for i := 1; i <= 10; i++ {
		cursor = cursor.Add(time.Duration(i) * time.Second)
		l.OnIDR(int64(i), 1, cursor)
	}

	s := l.Stats()
	if s.Count != 10 {
		t.Fatalf("Count = %d, want 10", s.Count)
	}
	if s.Max != 10*time.Second {
		t.Fatalf("Max = %v, want 10s", s.Max)
	}
	// Nearest-rank p50 of 10 sorted values [1..10]s: ceil(0.5*10)=5th value = 5s.
	if s.P50 != 5*time.Second {
		t.Fatalf("P50 = %v, want 5s", s.P50)
	}
	// ceil(0.95*10)=10th value = 10s.
	if s.P95 != 10*time.Second {
		t.Fatalf("P95 = %v, want 10s", s.P95)
	}
	// Strictly above 4s: 5,6,7,8,9,10 => 6 values.
	if s.Over4s != 6 {
		t.Fatalf("Over4s = %d, want 6", s.Over4s)
	}
	// Strictly above 8s: 9,10 => 2.
	if s.Over8s != 2 {
		t.Fatalf("Over8s = %d, want 2", s.Over8s)
	}
	// Strictly above 12s: none.
	if s.Over12s != 0 {
		t.Fatalf("Over12s = %d, want 0", s.Over12s)
	}
}

func TestStats_SummaryDoesNotPanicOnEmpty(t *testing.T) {
	s := Stats{}
	if s.Summary() == "" {
		t.Fatal("expected a non-empty summary even with no data")
	}
}
