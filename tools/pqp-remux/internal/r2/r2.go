// Package r2 asynchronously PUTs closed CMAF segments (and each track's
// init segment) to the same S3-compatible bucket the conventional HLS
// egress already writes into (Cloudflare R2 in production, MinIO locally),
// using the identical key layout, so hls-cleanup.ts's retention sweep and
// keep_replay collect an LL-HLS session's objects exactly like a
// conventional rendition's. This is L1.4 of docs/plans/LL_HLS.md.
//
// Why a hand-rolled SigV4 client instead of aws-sdk-go-v2: this mirrors
// the choice server/src/lib/s3.ts already made on the Node side (its own
// signRequest is hand-written, not the AWS JS SDK) for the same reasons
// internal/cmaf's README gives for not adopting a general-purpose MP4
// library -- this package's whole job is one HTTP verb (PUT) against one
// well-documented, stable algorithm (AWS Signature Version 4), and pulling
// in a multi-hundred-package SDK to get it would be a large, frequently
// updated dependency for a task this small. See sigv4.go.
package r2

import "fmt"

// Config names the bucket and credentials this writer PUTs to. Field
// names mirror the LIVE_HLS_S3_* environment variables exactly (see
// internal/config and the README's config table), which themselves mirror
// server/src/voice/hls-egress.ts's liveHlsStorageConfig().
type Config struct {
	Endpoint        string // e.g. https://<account>.r2.cloudflarestorage.com, or http://localhost:9000 for MinIO
	Bucket          string
	Region          string // "auto" for R2; MinIO ignores this but a value is still required to sign
	AccessKeyID     string
	SecretAccessKey string
	ForcePathStyle  bool // true for MinIO; R2 also accepts path-style, unlike some AWS regions
}

// Configured reports whether every field New/NewUploader needs is
// present, the same "not configured means off, not an error" shape
// hls-egress.ts's liveHlsStorageConfig() uses.
func (c Config) Configured() bool {
	return c.Endpoint != "" && c.Bucket != "" && c.AccessKeyID != "" && c.SecretAccessKey != ""
}

// ObjectPrefix mirrors hlsObjectPrefix() in server/src/voice/hls-egress.ts
// byte for byte: "live/<channelId>/<startedAtMs>-<rung>". Keeping the two
// implementations' output identical is what lets hls-cleanup.ts's
// sessionPrefixPattern (a SQL LIKE built from this same string) find and
// delete an LL session's objects the same way it finds a conventional
// rendition's -- the sweep matches on the literal key prefix and does not
// care what comes after it or what shape the bytes underneath are.
func ObjectPrefix(channelID string, startedAtMs int64, rung string) string {
	return fmt.Sprintf("live/%s/%d-%s", channelID, startedAtMs, rung)
}
