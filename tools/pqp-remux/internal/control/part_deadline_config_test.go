package control

import (
	"strings"
	"testing"
)

// Read HERE as well as in internal/config, because production runs
// pqp-remuxd (repo pitfall 12, the same reason REORDER_HOLD_MS is).
func TestLoadGlobalConfig_PartDeadlineGrace(t *testing.T) {
	withEnv(t, reorderBaseEnv())
	c, err := LoadGlobalConfig()
	if err != nil {
		t.Fatalf("LoadGlobalConfig: %v", err)
	}
	if c.PartDeadlineGraceMs != DefaultPartDeadlineGraceMs {
		t.Fatalf("PartDeadlineGraceMs = %d, want the default %d", c.PartDeadlineGraceMs, DefaultPartDeadlineGraceMs)
	}

	t.Setenv("PART_DEADLINE_GRACE_MS", "1000")
	if c, err = LoadGlobalConfig(); err != nil || c.PartDeadlineGraceMs != 1000 {
		t.Fatalf("PART_DEADLINE_GRACE_MS=1000 (the rollback): got %d, %v", c.PartDeadlineGraceMs, err)
	}

	for _, v := range []string{"-1", "10001"} {
		t.Setenv("PART_DEADLINE_GRACE_MS", v)
		_, err := LoadGlobalConfig()
		if err == nil || !strings.Contains(err.Error(), "PART_DEADLINE_GRACE_MS") {
			t.Fatalf("PART_DEADLINE_GRACE_MS=%s: want an error naming the knob, got %v", v, err)
		}
	}
}
