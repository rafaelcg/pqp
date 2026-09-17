package control

import (
	"context"
	"testing"
	"time"
)

// THE RELATIONSHIP, PINNED. A part boundary is decided by the arrival of
// the next access unit, so the longest a HEALTHY pipeline can go without
// publishing a part is one part target plus whatever the video reorder
// buffer adds (at most REORDER_HOLD_MS plus one monitor tick --
// internal/session's reorderDelayBound). The part-stuck threshold has to
// sit above that or it does not detect stalls, it manufactures them: that
// is exactly what happened on 2026-09-17, when a 3000ms threshold met a
// reorder buffer that could serialise its 300ms hold once per hole.
func TestPartStuckThresholdClearsTheWorstLegitimateGap(t *testing.T) {
	for _, tc := range []struct {
		name          string
		partStuckMs   int64
		partMs        int64
		reorderHoldMs int64
		want          time.Duration
	}{
		{
			// The shipped defaults: the derived floor is 1800ms, well
			// under PART_STUCK_MS, so production behaviour is unchanged
			// by this whole mechanism.
			name: "shipped defaults keep PART_STUCK_MS", partStuckMs: DefaultPartStuckMs, partMs: 500, reorderHoldMs: DefaultReorderHoldMs,
			want: 3000 * time.Millisecond,
		},
		{
			// An operator who lowers PART_STUCK_MS below the worst
			// legitimate gap no longer gets a watchdog that fires on a
			// healthy stream.
			name: "a too-low PART_STUCK_MS is raised to the derived floor", partStuckMs: 1000, partMs: 500, reorderHoldMs: 300,
			want: 1800 * time.Millisecond,
		},
		{
			// And so does one who raises the hold.
			name: "a long hold raises the floor past PART_STUCK_MS", partStuckMs: DefaultPartStuckMs, partMs: 500, reorderHoldMs: 1000,
			want: 3200 * time.Millisecond,
		},
		{
			// Holding off entirely: the floor is just the part target
			// plus the tick, doubled.
			name: "REORDER_HOLD_MS=0 still clears the part target", partStuckMs: 500, partMs: 500, reorderHoldMs: 0,
			want: 1200 * time.Millisecond,
		},
		{
			// A WatchdogConfig built by hand with neither number (every
			// older test in this package) behaves exactly as it did
			// before the floor existed.
			name: "neither supplied is PART_STUCK_MS exactly", partStuckMs: 250, partMs: 0, reorderHoldMs: 0,
			want: 250 * time.Millisecond,
		},
	} {
		t.Run(tc.name, func(t *testing.T) {
			cfg := WatchdogConfig{PartStuckMs: tc.partStuckMs, PartMs: tc.partMs, ReorderHoldMs: tc.reorderHoldMs}
			got := cfg.partStuckThreshold()
			if got != tc.want {
				t.Fatalf("partStuckThreshold() = %s, want %s", got, tc.want)
			}
			if tc.partMs == 0 && tc.reorderHoldMs == 0 {
				return
			}
			// The property the table above is only examples of: the
			// threshold must always be strictly greater than one part
			// target plus the buffer's own worst-case delay.
			worst := time.Duration(tc.partMs+tc.reorderHoldMs+reorderCheckSlackMs) * time.Millisecond
			if got <= worst {
				t.Fatalf("partStuckThreshold() = %s, which is not past the worst legitimate gap %s", got, worst)
			}
		})
	}
}

// A session's own part target reaches the watchdog: it is per session
// (StartSessionRequest.PartMs), not global, so GlobalConfig alone cannot
// supply it and newManagedSession has to copy it in.
func TestManagedSessionCopiesPartMsIntoTheWatchdogConfig(t *testing.T) {
	req := StartSessionRequest{
		SessionID: "s1", Room: "r1", ChannelID: "c1",
		PartMs: 750, SegmentMs: 4000, RingSegments: 6,
	}
	// PART_STUCK_MS deliberately below the derived floor, so the
	// threshold this session ends up with can only come from its own
	// PartMs.
	global := GlobalConfig{PartStuckMs: 1000, ReorderHoldMs: 400}
	m, err := newManagedSession(context.Background(), req, 1, global, global.WatchdogConfig(), func(context.Context, PipelineConfig) (Pipeline, error) {
		return newFakePipeline(PipelineHealth{}), nil
	})
	if err != nil {
		t.Fatalf("newManagedSession: %v", err)
	}
	// Not m.Stop(): that waits on the watchdog goroutine, which only
	// registry.StartOrGet starts and this test deliberately does not.
	defer func() {
		if p := m.current; p != nil {
			p.Close()
		}
	}()

	if m.watchdogCfg.PartMs != 750 {
		t.Fatalf("watchdogCfg.PartMs = %d, want the session's own 750", m.watchdogCfg.PartMs)
	}
	if m.watchdogCfg.ReorderHoldMs != 400 {
		t.Fatalf("watchdogCfg.ReorderHoldMs = %d, want the process's own 400", m.watchdogCfg.ReorderHoldMs)
	}
	if got, want := m.watchdogCfg.partStuckThreshold(), 2500*time.Millisecond; got != want {
		t.Fatalf("partStuckThreshold() = %s, want %s", got, want)
	}
}
