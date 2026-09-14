package control

import (
	"fmt"
	"net"
	"os"
	"strconv"
)

// Default* mirror internal/config's own defaults where a name overlaps
// (LiveKit credentials, AAC bitrate, R2 upload tuning): an operator running
// both the single-session pqp-remux binary and this control-plane
// supervisor on the same box gets the same defaults from the same env var
// names either way. PartStuckMs/DemoteWindowMs are new to this package --
// see the README's env table.
const (
	// DefaultListen binds loopback only, for the identical reason
	// internal/config.DefaultListen does (see control.go's package
	// comment): nothing under CONTROL_LISTEN authenticates a viewer, only
	// pqp-api's own signed control calls are authenticated (signing.go).
	DefaultListen = "127.0.0.1:8090"

	// DefaultFirstPartTimeoutMs bounds "waiting for a part that has never
	// arrived yet" (StateWaiting), a phase PartStuckMs must NOT govern:
	// a party that has just gone live but whose presenter has not yet
	// clicked "share screen" looks identical, from PartsWritten's point
	// of view, to a genuinely broken pipeline (Farol review, PR #584). 60s
	// is this task's own considered default -- long enough for an
	// ordinary "go live, then share" sequence, short enough that a truly
	// dead room does not sit registered forever.
	DefaultFirstPartTimeoutMs = 60_000
	// DefaultPartStuckMs is docs/plans/LL_HLS.md §5's own number: "the LL
	// path uses PART_STUCK_MS = 3000 (six parts)", six times faster than
	// the conventional path's 20s PLAYLIST_STUCK_MS because giving up
	// here is cheap (an ABR rendition switch, not an outage). Applies only
	// once at least one part has already been produced -- see
	// FirstPartTimeoutMs above for before that.
	DefaultPartStuckMs = 3000
	// DefaultDemoteWindowMs: how long after the one allowed restart a
	// second stall still counts as "the same episode" and demotes,
	// rather than being treated as a fresh problem worth one more
	// restart. Sized after the conventional path's own restart-cooldown
	// family (claim 9 in section 5: "3 restarts per 5 min then a 5 min
	// cooldown") -- there is no equivalent number in the plan text for
	// this specific ladder, so this is this task's own considered
	// default, not a measured or specified value.
	DefaultDemoteWindowMs = 5 * 60 * 1000

	DefaultAACBitrateKbps  = 128
	DefaultR2QueueDepth    = 64
	DefaultR2MaxRetries    = 3
	DefaultLiveHlsS3Region = "auto"
)

// GlobalConfig is this process's own env, loaded once at startup --
// everything a session needs that ISN'T carried in StartSessionRequest:
// LiveKit credentials, the R2/S3 bucket, AAC/ffmpeg settings, and the
// watchdog's two timers. Never sent to any session's POST body; every
// session started by this process shares one GlobalConfig.
type GlobalConfig struct {
	Listen string
	Secret string
	// MediaOriginKey gates the unsigned /s/:id/* media routes (server.go's
	// withOriginKey): empty means off, matching every other optional
	// access-control layer in this repo's own "not configured, not an
	// error" shape -- but see LoadGlobalConfig's own validation, which
	// refuses to start with a non-loopback Listen and an empty
	// MediaOriginKey (Farol review, PR #584): the loopback default is the
	// ONLY thing protecting those routes until this is set, so a box
	// configured to listen beyond loopback with nothing here would
	// disclose a live presenter's media to anyone who can reach the port.
	MediaOriginKey string

	LiveKitURL    string
	LiveKitAPIKey string
	LiveKitAPISec string

	FirstPartTimeoutMs int64
	PartStuckMs        int64
	DemoteWindowMs     int64

	AACBitrateKbps int
	FFmpegPath     string

	LiveHlsS3Endpoint        string
	LiveHlsS3Bucket          string
	LiveHlsS3Region          string
	LiveHlsS3AccessKeyID     string
	LiveHlsS3SecretAccessKey string
	LiveHlsS3ForcePathStyle  bool

	R2UploadQueueDepth int
	R2UploadMaxRetries int
}

// LiveHlsS3Configured mirrors internal/config.Config.LiveHlsS3Configured
// exactly: the same "not configured means off, not an error" shape as
// every other optional bucket in this repo.
func (c GlobalConfig) LiveHlsS3Configured() bool {
	return c.LiveHlsS3Endpoint != "" && c.LiveHlsS3Bucket != "" &&
		c.LiveHlsS3AccessKeyID != "" && c.LiveHlsS3SecretAccessKey != ""
}

// WatchdogConfig extracts just the two timers watchdog.go's evaluateWatchdog
// needs, so that package need not import all of GlobalConfig.
func (c GlobalConfig) WatchdogConfig() WatchdogConfig {
	return WatchdogConfig{
		FirstPartTimeoutMs: c.FirstPartTimeoutMs,
		PartStuckMs:        c.PartStuckMs,
		DemoteWindowMs:     c.DemoteWindowMs,
	}
}

// LoadGlobalConfig reads CONTROL_LISTEN, REMUX_CONTROL_SECRET,
// LIVEKIT_URL/LIVEKIT_API_KEY/LIVEKIT_API_SECRET, PART_STUCK_MS,
// DEMOTE_WINDOW_MS, AAC_BITRATE_KBPS, FFMPEG_PATH, the LIVE_HLS_S3_* family
// and R2_UPLOAD_QUEUE_DEPTH/R2_UPLOAD_MAX_RETRIES -- see the README's env
// table for the full list and defaults. Refuses to start (a non-nil error)
// without LIVEKIT_URL/LIVEKIT_API_KEY/LIVEKIT_API_SECRET (no session could
// ever connect to anything) or without REMUX_CONTROL_SECRET (per this
// task's own explicit instruction: "Refuse to start without
// REMUX_CONTROL_SECRET" -- an unsigned control API on a box that can
// disclose a live presenter's media is not a mode this package offers).
func LoadGlobalConfig() (GlobalConfig, error) {
	c := GlobalConfig{
		Listen:         envOr("CONTROL_LISTEN", DefaultListen),
		Secret:         os.Getenv("REMUX_CONTROL_SECRET"),
		MediaOriginKey: os.Getenv("MEDIA_ORIGIN_KEY"),
		LiveKitURL:     os.Getenv("LIVEKIT_URL"),
		LiveKitAPIKey:  os.Getenv("LIVEKIT_API_KEY"),
		LiveKitAPISec:  os.Getenv("LIVEKIT_API_SECRET"),

		AACBitrateKbps: DefaultAACBitrateKbps,
		FFmpegPath:     os.Getenv("FFMPEG_PATH"),

		LiveHlsS3Endpoint:        os.Getenv("LIVE_HLS_S3_ENDPOINT"),
		LiveHlsS3Bucket:          os.Getenv("LIVE_HLS_S3_BUCKET"),
		LiveHlsS3Region:          envOr("LIVE_HLS_S3_REGION", DefaultLiveHlsS3Region),
		LiveHlsS3AccessKeyID:     os.Getenv("LIVE_HLS_S3_ACCESS_KEY_ID"),
		LiveHlsS3SecretAccessKey: os.Getenv("LIVE_HLS_S3_SECRET_ACCESS_KEY"),
		LiveHlsS3ForcePathStyle:  os.Getenv("LIVE_HLS_S3_FORCE_PATH_STYLE") == "true",
	}

	var err error
	if c.FirstPartTimeoutMs, err = envInt64Or("FIRST_PART_TIMEOUT_MS", DefaultFirstPartTimeoutMs); err != nil {
		return GlobalConfig{}, err
	}
	if c.PartStuckMs, err = envInt64Or("PART_STUCK_MS", DefaultPartStuckMs); err != nil {
		return GlobalConfig{}, err
	}
	if c.DemoteWindowMs, err = envInt64Or("DEMOTE_WINDOW_MS", DefaultDemoteWindowMs); err != nil {
		return GlobalConfig{}, err
	}
	if v := os.Getenv("AAC_BITRATE_KBPS"); v != "" {
		n, err := strconv.Atoi(v)
		if err != nil || n <= 0 {
			return GlobalConfig{}, fmt.Errorf("control: AAC_BITRATE_KBPS=%q must be a positive integer", v)
		}
		c.AACBitrateKbps = n
	}
	if c.R2UploadQueueDepth, err = envIntOr("R2_UPLOAD_QUEUE_DEPTH", DefaultR2QueueDepth); err != nil {
		return GlobalConfig{}, err
	}
	if c.R2UploadMaxRetries, err = envIntOr("R2_UPLOAD_MAX_RETRIES", DefaultR2MaxRetries); err != nil {
		return GlobalConfig{}, err
	}

	if c.LiveKitURL == "" || c.LiveKitAPIKey == "" || c.LiveKitAPISec == "" {
		return GlobalConfig{}, fmt.Errorf("control: LIVEKIT_URL, LIVEKIT_API_KEY and LIVEKIT_API_SECRET are all required")
	}
	if c.Secret == "" {
		return GlobalConfig{}, fmt.Errorf("control: REMUX_CONTROL_SECRET is required")
	}
	if !isLoopbackAddr(c.Listen) && c.MediaOriginKey == "" {
		return GlobalConfig{}, fmt.Errorf(
			"control: CONTROL_LISTEN=%q is not loopback; MEDIA_ORIGIN_KEY is required to bind a non-loopback address (see the README's \"Access control\" section) -- without it, the unsigned /s/:id/* media routes would be reachable by anyone who can reach this port",
			c.Listen,
		)
	}
	if c.FirstPartTimeoutMs <= 0 {
		return GlobalConfig{}, fmt.Errorf("control: FIRST_PART_TIMEOUT_MS must be positive, got %d", c.FirstPartTimeoutMs)
	}
	if c.PartStuckMs <= 0 {
		return GlobalConfig{}, fmt.Errorf("control: PART_STUCK_MS must be positive, got %d", c.PartStuckMs)
	}
	if c.DemoteWindowMs <= 0 {
		return GlobalConfig{}, fmt.Errorf("control: DEMOTE_WINDOW_MS must be positive, got %d", c.DemoteWindowMs)
	}

	return c, nil
}

func envOr(key, def string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return def
}

func envIntOr(key string, def int) (int, error) {
	v := os.Getenv(key)
	if v == "" {
		return def, nil
	}
	n, err := strconv.Atoi(v)
	if err != nil {
		return 0, fmt.Errorf("control: %s=%q is not an integer", key, v)
	}
	return n, nil
}

func envInt64Or(key string, def int64) (int64, error) {
	v := os.Getenv(key)
	if v == "" {
		return def, nil
	}
	n, err := strconv.ParseInt(v, 10, 64)
	if err != nil {
		return 0, fmt.Errorf("control: %s=%q is not an integer", key, v)
	}
	return n, nil
}

// isLoopbackAddr reports whether addr (a net.Listen-style "host:port", or
// a bare host) resolves to loopback: "localhost" literally, or an IP
// address for which net.IP.IsLoopback is true (127.0.0.0/8, ::1). An empty
// host (the ":8090" shorthand for "every interface") and any other host
// (a real hostname, 0.0.0.0, a LAN/public IP) are NOT loopback -- this is
// deliberately conservative: anything this function cannot positively
// identify as loopback is treated as reachable from beyond this box,
// which is the safer direction to be wrong in for a function that gates
// whether MEDIA_ORIGIN_KEY is required (LoadGlobalConfig).
func isLoopbackAddr(addr string) bool {
	host, _, err := net.SplitHostPort(addr)
	if err != nil {
		host = addr
	}
	if host == "localhost" {
		return true
	}
	ip := net.ParseIP(host)
	return ip != nil && ip.IsLoopback()
}
