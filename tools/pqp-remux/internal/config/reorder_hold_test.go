package config

import (
	"strings"
	"testing"
)

func TestFromEnv_ReorderHoldDefaultAndOverride(t *testing.T) {
	var c Config
	var err error
	withEnv(t, baseEnv(), func() { c, err = FromEnv() })
	if err != nil {
		t.Fatalf("FromEnv: %v", err)
	}
	if c.ReorderHoldMS != DefaultReorderHoldMS {
		t.Fatalf("ReorderHoldMS = %d, want the default %d", c.ReorderHoldMS, DefaultReorderHoldMS)
	}

	env := baseEnv()
	env["REORDER_HOLD_MS"] = "120"
	withEnv(t, env, func() { c, err = FromEnv() })
	if err != nil {
		t.Fatalf("FromEnv with an override: %v", err)
	}
	if c.ReorderHoldMS != 120 {
		t.Fatalf("ReorderHoldMS = %d, want 120", c.ReorderHoldMS)
	}
}

// Zero is the documented rollback ("hold nothing, hand every gap straight
// to the depacketizer"), so it has to be accepted rather than treated as
// "unset, use the default" -- the mistake VIDEO_IDLE_MAX_MS's own comment
// warns about.
func TestFromEnv_ReorderHoldZeroIsAllowed(t *testing.T) {
	env := baseEnv()
	env["REORDER_HOLD_MS"] = "0"
	var c Config
	var err error
	withEnv(t, env, func() { c, err = FromEnv() })
	if err != nil {
		t.Fatalf("REORDER_HOLD_MS=0 was refused: %v", err)
	}
	if c.ReorderHoldMS != 0 {
		t.Fatalf("ReorderHoldMS = %d, want 0", c.ReorderHoldMS)
	}
}

func TestFromEnv_ReorderHoldOutOfRange(t *testing.T) {
	for _, v := range []string{"-1", "5000"} {
		env := baseEnv()
		env["REORDER_HOLD_MS"] = v
		var err error
		withEnv(t, env, func() { _, err = FromEnv() })
		if err == nil {
			t.Fatalf("REORDER_HOLD_MS=%s was accepted", v)
		}
		if !strings.Contains(err.Error(), "REORDER_HOLD_MS") {
			t.Fatalf("REORDER_HOLD_MS=%s: error does not name the knob: %v", v, err)
		}
	}
}
