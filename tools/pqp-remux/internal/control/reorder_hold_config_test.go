package control

import (
	"strings"
	"testing"
)

func reorderBaseEnv() map[string]string {
	return map[string]string{
		"REMUX_CONTROL_SECRET": "s",
		"LIVEKIT_URL":          "wss://example",
		"LIVEKIT_API_KEY":      "key",
		"LIVEKIT_API_SECRET":   "sec",
	}
}

// REORDER_HOLD_MS has to be read HERE, not only in internal/config:
// production runs pqp-remuxd, which loads GlobalConfig, so a knob only the
// single-session binary read would be inert on the box that matters. That
// is repo pitfall 12 exactly (a flag tested with the code path it does not
// take).
func TestLoadGlobalConfig_ReorderHoldDefaultAndOverride(t *testing.T) {
	withEnv(t, reorderBaseEnv())
	c, err := LoadGlobalConfig()
	if err != nil {
		t.Fatalf("LoadGlobalConfig: %v", err)
	}
	if c.ReorderHoldMs != DefaultReorderHoldMs {
		t.Fatalf("ReorderHoldMs = %d, want the default %d", c.ReorderHoldMs, DefaultReorderHoldMs)
	}
	// And it reaches the watchdog, which sizes its own threshold off it.
	if c.WatchdogConfig().ReorderHoldMs != DefaultReorderHoldMs {
		t.Fatalf("WatchdogConfig().ReorderHoldMs = %d", c.WatchdogConfig().ReorderHoldMs)
	}

	t.Setenv("REORDER_HOLD_MS", "0")
	c, err = LoadGlobalConfig()
	if err != nil {
		t.Fatalf("REORDER_HOLD_MS=0 was refused: %v", err)
	}
	if c.ReorderHoldMs != 0 {
		t.Fatalf("ReorderHoldMs = %d, want 0 (the documented rollback)", c.ReorderHoldMs)
	}
}

func TestLoadGlobalConfig_ReorderHoldOutOfRange(t *testing.T) {
	for _, v := range []string{"-1", "5000"} {
		t.Run(v, func(t *testing.T) {
			withEnv(t, reorderBaseEnv())
			t.Setenv("REORDER_HOLD_MS", v)
			_, err := LoadGlobalConfig()
			if err == nil {
				t.Fatalf("REORDER_HOLD_MS=%s was accepted", v)
			}
			if !strings.Contains(err.Error(), "REORDER_HOLD_MS") {
				t.Fatalf("error does not name the knob: %v", err)
			}
		})
	}
}
