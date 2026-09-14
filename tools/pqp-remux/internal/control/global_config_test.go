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
	// A non-loopback CONTROL_LISTEN also needs MEDIA_ORIGIN_KEY -- see
	// TestLoadGlobalConfig_RefusesNonLoopbackListenWithoutOriginKey for
	// that refusal on its own; this override test sets both so it keeps
	// testing PartStuckMs/DemoteWindowMs/Listen overrides, not that rule.
	t.Setenv("CONTROL_LISTEN", "0.0.0.0:9999")
	t.Setenv("MEDIA_ORIGIN_KEY", "some-shared-key")
	cfg2, err := LoadGlobalConfig()
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if cfg2.PartStuckMs != 1234 || cfg2.DemoteWindowMs != 99999 || cfg2.Listen != "0.0.0.0:9999" {
		t.Fatalf("expected overrides to take effect, got %+v", cfg2)
	}
}

// TestLoadGlobalConfig_RefusesNonLoopbackListenWithoutOriginKey is the
// HIGH finding from Farol's review of PR #584: CONTROL_LISTEN bound
// beyond loopback with no MEDIA_ORIGIN_KEY would leave the unsigned
// /s/:id/* media routes reachable by anyone who can reach the port.
func TestLoadGlobalConfig_RefusesNonLoopbackListenWithoutOriginKey(t *testing.T) {
	withEnv(t, map[string]string{
		"REMUX_CONTROL_SECRET": "s",
		"LIVEKIT_URL":          "wss://example",
		"LIVEKIT_API_KEY":      "key",
		"LIVEKIT_API_SECRET":   "sec",
		"CONTROL_LISTEN":       "0.0.0.0:8090",
		"MEDIA_ORIGIN_KEY":     "",
	})
	if _, err := LoadGlobalConfig(); err == nil {
		t.Fatal("expected LoadGlobalConfig to refuse a non-loopback CONTROL_LISTEN with no MEDIA_ORIGIN_KEY")
	}

	t.Setenv("MEDIA_ORIGIN_KEY", "a-real-shared-key")
	if _, err := LoadGlobalConfig(); err != nil {
		t.Fatalf("expected a non-loopback CONTROL_LISTEN with MEDIA_ORIGIN_KEY set to be accepted, got %v", err)
	}
}

// TestLoadGlobalConfig_LoopbackListenNeverRequiresOriginKey pins the
// default posture: a loopback CONTROL_LISTEN (the default, or an explicit
// one) never requires MEDIA_ORIGIN_KEY.
func TestLoadGlobalConfig_LoopbackListenNeverRequiresOriginKey(t *testing.T) {
	for _, listen := range []string{"", "127.0.0.1:8090", "localhost:8090", "[::1]:8090"} {
		withEnv(t, map[string]string{
			"REMUX_CONTROL_SECRET": "s",
			"LIVEKIT_URL":          "wss://example",
			"LIVEKIT_API_KEY":      "key",
			"LIVEKIT_API_SECRET":   "sec",
			"CONTROL_LISTEN":       listen,
			"MEDIA_ORIGIN_KEY":     "",
		})
		if _, err := LoadGlobalConfig(); err != nil {
			t.Fatalf("CONTROL_LISTEN=%q: expected no error with no MEDIA_ORIGIN_KEY, got %v", listen, err)
		}
	}
}

func TestIsLoopbackAddr(t *testing.T) {
	cases := map[string]bool{
		"127.0.0.1:8090": true,
		"localhost:8090": true,
		"[::1]:8090":     true,
		"127.0.0.1":      true,
		"0.0.0.0:8090":   false,
		":8090":          false,
		"192.168.1.5:80": false,
		"example.com:80": false,
	}
	for addr, want := range cases {
		if got := isLoopbackAddr(addr); got != want {
			t.Errorf("isLoopbackAddr(%q) = %v, want %v", addr, got, want)
		}
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

// baseR2Env is the minimal env every R2-validation test below layers its
// one bad value onto -- everything else must be valid so the failure each
// test expects is provably about R2_UPLOAD_QUEUE_DEPTH/R2_UPLOAD_MAX_RETRIES
// specifically, not some other missing required var.
func baseR2Env() map[string]string {
	return map[string]string{
		"REMUX_CONTROL_SECRET": "s",
		"LIVEKIT_URL":          "wss://example",
		"LIVEKIT_API_KEY":      "key",
		"LIVEKIT_API_SECRET":   "sec",
	}
}

func TestLoadGlobalConfig_RefusesZeroR2QueueDepth(t *testing.T) {
	env := baseR2Env()
	env["R2_UPLOAD_QUEUE_DEPTH"] = "0"
	withEnv(t, env)
	if _, err := LoadGlobalConfig(); err == nil {
		t.Fatal("expected R2_UPLOAD_QUEUE_DEPTH=0 to be refused (Farol review, PR #584: a session must never start with upload config that cannot work)")
	}
}

func TestLoadGlobalConfig_RefusesNegativeR2QueueDepth(t *testing.T) {
	env := baseR2Env()
	env["R2_UPLOAD_QUEUE_DEPTH"] = "-1"
	withEnv(t, env)
	if _, err := LoadGlobalConfig(); err == nil {
		t.Fatal("expected a negative R2_UPLOAD_QUEUE_DEPTH to be refused")
	}
}

func TestLoadGlobalConfig_RefusesNegativeR2MaxRetries(t *testing.T) {
	env := baseR2Env()
	env["R2_UPLOAD_MAX_RETRIES"] = "-1"
	withEnv(t, env)
	if _, err := LoadGlobalConfig(); err == nil {
		t.Fatal("expected a negative R2_UPLOAD_MAX_RETRIES to be refused")
	}
}

// TestLoadGlobalConfig_AllowsZeroR2MaxRetries pins the other half of this
// task's own bound ("retries >= 0"): zero is a legitimate, deliberate
// "never retry an upload, fail fast" choice, not a value to refuse the
// way a negative or zero queue depth is.
func TestLoadGlobalConfig_AllowsZeroR2MaxRetries(t *testing.T) {
	env := baseR2Env()
	env["R2_UPLOAD_MAX_RETRIES"] = "0"
	withEnv(t, env)
	cfg, err := LoadGlobalConfig()
	if err != nil {
		t.Fatalf("expected R2_UPLOAD_MAX_RETRIES=0 to be accepted, got error: %v", err)
	}
	if cfg.R2UploadMaxRetries != 0 {
		t.Fatalf("expected R2UploadMaxRetries to be 0, got %d", cfg.R2UploadMaxRetries)
	}
}

func TestLoadGlobalConfig_DefaultR2SettingsAreValid(t *testing.T) {
	withEnv(t, baseR2Env())
	cfg, err := LoadGlobalConfig()
	if err != nil {
		t.Fatalf("unexpected error with default R2 settings: %v", err)
	}
	if cfg.R2UploadQueueDepth != DefaultR2QueueDepth {
		t.Fatalf("expected default R2UploadQueueDepth %d, got %d", DefaultR2QueueDepth, cfg.R2UploadQueueDepth)
	}
	if cfg.R2UploadMaxRetries != DefaultR2MaxRetries {
		t.Fatalf("expected default R2UploadMaxRetries %d, got %d", DefaultR2MaxRetries, cfg.R2UploadMaxRetries)
	}
}
