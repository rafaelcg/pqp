// Package idrlog is the L0.2 keyframe-cadence logger the plan asks the
// remux to double as: `--idr-log` runs the subscriber passively (zero
// PLIs, regardless of KEYFRAME_POLICY — see internal/keyframe's doc
// comment) and writes one CSV line per IDR arrival, then a summary once
// --duration elapses.
package idrlog

import (
	"fmt"
	"io"
	"sort"
	"time"
)

// Logger records IDR arrivals and computes the inter-IDR distribution
// docs/plans/LL_HLS.md §"L0.2" asks for: p50/p95/p99/max, and counts of
// intervals above 4s, 8s and 12s.
//
// Not safe for concurrent use without external locking; the depacketizer
// this feeds already serializes one track's IDRs onto one goroutine.
type Logger struct {
	w io.Writer

	started   time.Time
	haveFirst bool
	prevIDR   time.Time

	// intervals excludes the very first IDR's arrival gap on purpose:
	// L0.1's finding item 5 is that the SFU sends a keyframe request on
	// every subscribe, so the first IDR arrives fast for a reason that has
	// nothing to do with the publisher's steady-state cadence, and
	// counting it would bias the distribution optimistic.
	intervals []time.Duration
}

// New returns a Logger writing CSV lines to w as IDRs arrive.
func New(w io.Writer) *Logger {
	return &Logger{w: w}
}

// OnIDR records one IDR: pts is the access unit's media timestamp (ticks),
// sizeBytes its AVCC sample size, now its wall-clock arrival time. It
// writes one CSV line immediately: `ts_ms,pts,size_bytes,interval_ms`.
func (l *Logger) OnIDR(pts int64, sizeBytes int, now time.Time) {
	if !l.haveFirst {
		l.haveFirst = true
		l.started = now
		l.prevIDR = now
		fmt.Fprintf(l.w, "%d,%d,%d,%d\n", 0, pts, sizeBytes, 0)
		return
	}

	interval := now.Sub(l.prevIDR)
	l.intervals = append(l.intervals, interval)
	l.prevIDR = now

	tsMs := now.Sub(l.started).Milliseconds()
	fmt.Fprintf(l.w, "%d,%d,%d,%d\n", tsMs, pts, sizeBytes, interval.Milliseconds())
}

// Stats is the L0.2 distribution: every field is a duration except the
// three threshold counts, which count intervals (not IDRs) strictly
// above the named boundary.
type Stats struct {
	Count   int
	P50     time.Duration
	P95     time.Duration
	P99     time.Duration
	Max     time.Duration
	Over4s  int
	Over8s  int
	Over12s int
}

// Stats computes the current distribution over every interval recorded so
// far (the first IDR's arrival gap excluded, see the Logger doc comment).
// Safe to call with zero recorded intervals (Count == 0, every duration
// field zero).
func (l *Logger) Stats() Stats {
	n := len(l.intervals)
	if n == 0 {
		return Stats{}
	}
	sorted := make([]time.Duration, n)
	copy(sorted, l.intervals)
	sort.Slice(sorted, func(i, j int) bool { return sorted[i] < sorted[j] })

	s := Stats{
		Count: n,
		P50:   percentile(sorted, 0.50),
		P95:   percentile(sorted, 0.95),
		P99:   percentile(sorted, 0.99),
		Max:   sorted[n-1],
	}
	for _, d := range sorted {
		if d > 4*time.Second {
			s.Over4s++
		}
		if d > 8*time.Second {
			s.Over8s++
		}
		if d > 12*time.Second {
			s.Over12s++
		}
	}
	return s
}

// percentile uses the nearest-rank method on an already-sorted slice: for
// p in (0,1], the value at position ceil(p*n)-1. This is the same
// convention most monitoring systems use for a handful of samples, and it
// needs no interpolation to reason about with n in the tens-to-hundreds
// range L0.2's ten-minute runs produce.
func percentile(sorted []time.Duration, p float64) time.Duration {
	n := len(sorted)
	if n == 0 {
		return 0
	}
	rank := int(float64(n)*p + 0.9999999) // ceil, tolerant of float error
	if rank < 1 {
		rank = 1
	}
	if rank > n {
		rank = n
	}
	return sorted[rank-1]
}

// Summary renders Stats as the one-line report the L0.2 PR description
// wants beside the raw per-run timestamps.
func (s Stats) Summary() string {
	return fmt.Sprintf(
		"idr-log: n=%d p50=%s p95=%s p99=%s max=%s over4s=%d over8s=%d over12s=%d",
		s.Count, s.P50, s.P95, s.P99, s.Max, s.Over4s, s.Over8s, s.Over12s,
	)
}
