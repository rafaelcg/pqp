package r2

import (
	"bytes"
	"context"
	"fmt"
	"net"
	"net/http"
	"os"
	"testing"
	"time"
)

// minioTestConfig returns a Config pointed at a local MinIO instance for
// s3Uploader's real, network-issuing SigV4 path, or skips the test.
// R2_TEST_MINIO_ENDPOINT/BUCKET/ACCESS_KEY_ID/SECRET_ACCESS_KEY let a
// developer point this at a locally running MinIO (see the README's "Try
// it against a local bucket") the same way the rest of this repo's own
// test suites are opt-in against real infrastructure (TEST_DATABASE_URL,
// E2E_DATABASE_URL) rather than assumed present. Skipping (not failing)
// when unset keeps `make test`/CI green on a machine with no MinIO
// running, while still giving strong, real-network confidence on one that
// does -- unlike the in-memory fake in writer_test.go, this is the test
// that actually proves the SigV4 signature is correct, not just that this
// package calls an Uploader interface correctly.
func minioTestConfig(t *testing.T) Config {
	t.Helper()
	endpoint := os.Getenv("R2_TEST_MINIO_ENDPOINT")
	bucket := os.Getenv("R2_TEST_MINIO_BUCKET")
	accessKey := os.Getenv("R2_TEST_MINIO_ACCESS_KEY_ID")
	secretKey := os.Getenv("R2_TEST_MINIO_SECRET_ACCESS_KEY")
	if endpoint == "" || bucket == "" || accessKey == "" || secretKey == "" {
		t.Skip("R2_TEST_MINIO_* not set; skipping the real-MinIO SigV4 round trip (see the README)")
	}
	if _, _, err := net.SplitHostPort(mustHost(t, endpoint)); err != nil {
		t.Fatalf("R2_TEST_MINIO_ENDPOINT %q: %v", endpoint, err)
	}
	return Config{
		Endpoint:        endpoint,
		Bucket:          bucket,
		Region:          "us-east-1",
		AccessKeyID:     accessKey,
		SecretAccessKey: secretKey,
		ForcePathStyle:  true, // MinIO with a bare host:port endpoint has no wildcard DNS for virtual-hosted style
	}
}

func mustHost(t *testing.T, endpoint string) string {
	t.Helper()
	// endpoint is a full URL (http://host:port); extract host:port for the
	// sanity check above without pulling in net/url twice.
	i := len("http://")
	if len(endpoint) > len("https://") && endpoint[:len("https://")] == "https://" {
		i = len("https://")
	}
	if i > len(endpoint) {
		t.Fatalf("endpoint %q too short", endpoint)
	}
	return endpoint[i:]
}

func TestS3UploaderPutObjectAgainstRealMinIO(t *testing.T) {
	cfg := minioTestConfig(t)
	uploader := NewUploader(cfg)

	key := fmt.Sprintf("pqp-remux-test/%d/init.mp4", time.Now().UnixNano())
	body := []byte("ftypmoov-fake-init-segment-bytes-for-a-sigv4-round-trip-test")

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if err := uploader.PutObject(ctx, key, body, "video/mp4"); err != nil {
		t.Fatalf("PutObject: %v", err)
	}

	// Read the object back over plain, unauthenticated HTTP path-style GET
	// (MinIO's default test bucket in this repo's docker-compose is
	// public for exactly this kind of check) to prove the PUT actually
	// landed with the right bytes at the right key, not merely that the
	// server returned 2xx.
	getURL := fmt.Sprintf("%s/%s/%s", cfg.Endpoint, cfg.Bucket, key)
	resp, err := http.Get(getURL)
	if err != nil {
		t.Fatalf("GET %s: %v", getURL, err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("GET %s: HTTP %d (bucket may need to be public, or use an authenticated GET)", getURL, resp.StatusCode)
	}
	got := new(bytes.Buffer)
	if _, err := got.ReadFrom(resp.Body); err != nil {
		t.Fatalf("reading response body: %v", err)
	}
	if got.String() != string(body) {
		t.Fatalf("round-tripped body = %q, want %q", got.String(), string(body))
	}
}

func TestS3UploaderRejectsBadSignatureVisibly(t *testing.T) {
	cfg := minioTestConfig(t)
	cfg.SecretAccessKey = "deliberately-wrong-secret"
	uploader := NewUploader(cfg)

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	err := uploader.PutObject(ctx, "pqp-remux-test/should-not-exist.mp4", []byte("x"), "")
	if err == nil {
		t.Fatal("expected an error with a wrong secret key, got nil")
	}
}
