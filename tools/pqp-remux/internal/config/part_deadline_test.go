package config

import (
	"strings"
	"testing"
)

func TestFromEnv_PartDeadlineGraceDefaultOverrideAndBounds(t *testing.T) {
	var c Config
	var err error
	withEnv(t, baseEnv(), func() { c, err = FromEnv() })
	if err != nil {
		t.Fatalf("FromEnv: %v", err)
	}
	if c.PartDeadlineGraceMS != DefaultPartDeadlineGraceMS {
		t.Fatalf("PartDeadlineGraceMS = %d, want the default %d", c.PartDeadlineGraceMS, DefaultPartDeadlineGraceMS)
	}

	// 0 (cut the moment the part's end passes) and 1000 (the documented
	// rollback: never before the idle allowance) are both real settings.
	for _, v := range []struct {
		env  string
		want int
	}{{"0", 0}, {"1000", 1000}} {
		env := baseEnv()
		env["PART_DEADLINE_GRACE_MS"] = v.env
		withEnv(t, env, func() { c, err = FromEnv() })
		if err != nil {
			t.Fatalf("PART_DEADLINE_GRACE_MS=%s was refused: %v", v.env, err)
		}
		if c.PartDeadlineGraceMS != v.want {
			t.Fatalf("PartDeadlineGraceMS = %d, want %d", c.PartDeadlineGraceMS, v.want)
		}
	}

	for _, v := range []string{"-1", "10001"} {
		env := baseEnv()
		env["PART_DEADLINE_GRACE_MS"] = v
		withEnv(t, env, func() { _, err = FromEnv() })
		if err == nil || !strings.Contains(err.Error(), "PART_DEADLINE_GRACE_MS") {
			t.Fatalf("PART_DEADLINE_GRACE_MS=%s: want an error naming the knob, got %v", v, err)
		}
	}
}
