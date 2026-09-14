package control

import "testing"

func withEnv(t *testing.T, kv map[string]string) {
	t.Helper()
	for k, v := range kv {
		t.Setenv(k, v)
	}
}

func TestLoadGlobalConfig_RefusesWithoutSecret(t *testing.T) {
	withEnv(t, map[string]string{
		"LIVEKIT_URL":          "wss://example",
		"LIVEKIT_API_KEY":      "key",
		"LIVEKIT_API_SECRET":   "sec",
		"REMUX_CONTROL_SECRET": "",
	})
	if _, err := LoadGlobalConfig(); err == nil {
		t.Fatal("expected LoadGlobalConfig to refuse to start without REMUX_CONTROL_SECRET")
	}
}

func TestLoadGlobalConfig_RefusesWithoutLiveKitCreds(t *testing.T) {
	withEnv(t, map[string]string{
		"REMUX_CONTROL_SECRET": "s",
		"LIVEKIT_URL":          "",
		"LIVEKIT_API_KEY":      "",
		"LIVEKIT_API_SECRET":   "",
	})
	if _, err := LoadGlobalConfig(); err == nil {
		t.Fatal("expected LoadGlobalConfig to refuse to start without LiveKit credentials")
	}
}

func TestLoadGlobalConfig_DefaultsAndOverrides(t *testing.T) {
	withEnv(t, map[string]string{
		"REMUX_CONTROL_SECRET": "s",
		"LIVEKIT_URL":          "wss://example",
		"LIVEKIT_API_KEY":      "key",
		"LIVEKIT_API_SECRET":   "sec",
		"CONTROL_LISTEN":       "",
		"PART_STUCK_MS":        "",
		"DEMOTE_WINDOW_MS":     "",
	})
	cfg, err := LoadGlobalConfig()
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if cfg.Listen != DefaultListen {
		t.Fatalf("expected default listen %q, got %q", DefaultListen, cfg.Listen)
	}
	if cfg.PartStuckMs != DefaultPartStuckMs {
		t.Fatalf("expected default PartStuckMs %d, got %d", DefaultPartStuckMs, cfg.PartStuckMs)
	}
	if cfg.DemoteWindowMs != DefaultDemoteWindowMs {
		t.Fatalf("expected default DemoteWindowMs %d, got %d", DefaultDemoteWindowMs, cfg.DemoteWindowMs)
	}
	if cfg.LiveHlsS3Configured() {
		t.Fatal("expected LiveHlsS3Configured to be false with no LIVE_HLS_S3_* set")
	}

	t.Setenv("PART_STUCK_MS", "1234")
	t.Setenv("DEMOTE_WINDOW_MS", "99999")
	t.Setenv("CONTROL_LISTEN", "0.0.0.0:9999")
	cfg2, err := LoadGlobalConfig()
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if cfg2.PartStuckMs != 1234 || cfg2.DemoteWindowMs != 99999 || cfg2.Listen != "0.0.0.0:9999" {
		t.Fatalf("expected overrides to take effect, got %+v", cfg2)
	}
}

func TestLoadGlobalConfig_RejectsMalformedIntegers(t *testing.T) {
	withEnv(t, map[string]string{
		"REMUX_CONTROL_SECRET": "s",
		"LIVEKIT_URL":          "wss://example",
		"LIVEKIT_API_KEY":      "key",
		"LIVEKIT_API_SECRET":   "sec",
		"PART_STUCK_MS":        "not-a-number",
	})
	if _, err := LoadGlobalConfig(); err == nil {
		t.Fatal("expected a malformed PART_STUCK_MS to be refused")
	}
}
