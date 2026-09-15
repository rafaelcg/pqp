package r2

import (
	"bytes"
	"context"
	"fmt"
	"io"
	"net/http"
	"time"
)

// Uploader is the minimal surface Writer needs: one signed PUT. The real
// implementation (s3Uploader, below) issues an HTTP request against
// cfg.Endpoint; tests substitute an in-memory fake (see writer_test.go)
// so the queue/retry/counter behaviour is verifiable without a network
// call, and uploader_test.go separately verifies s3Uploader itself
// against a real MinIO container.
type Uploader interface {
	PutObject(ctx context.Context, key string, body []byte, contentType string) error
}

// s3Uploader is the real Uploader: a SigV4-signed HTTP PUT per call.
type s3Uploader struct {
	cfg    Config
	client *http.Client
}

// NewUploader returns the real, network-issuing Uploader for cfg.
func NewUploader(cfg Config) Uploader {
	return &s3Uploader{cfg: cfg, client: &http.Client{Timeout: 30 * time.Second}}
}

func (u *s3Uploader) PutObject(ctx context.Context, key string, body []byte, contentType string) error {
	signed, requestURL, err := sigv4Sign(u.cfg, http.MethodPut, key, body, time.Now())
	if err != nil {
		return err
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodPut, requestURL, bytes.NewReader(body))
	if err != nil {
		return fmt.Errorf("r2: building request: %w", err)
	}
	req.Host = signed.Host
	req.Header.Set("Host", signed.Host)
	req.Header.Set("X-Amz-Date", signed.AmzDate)
	req.Header.Set("X-Amz-Content-Sha256", signed.ContentSHA256Hex)
	req.Header.Set("Authorization", signed.Authorization)
	if contentType != "" {
		req.Header.Set("Content-Type", contentType)
	}
	req.ContentLength = int64(len(body))

	resp, err := u.client.Do(req)
	if err != nil {
		return fmt.Errorf("r2: PUT %s: %w", key, err)
	}
	defer resp.Body.Close()

	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		respBody, _ := io.ReadAll(io.LimitReader(resp.Body, 4096))
		return fmt.Errorf("r2: PUT %s: HTTP %d: %s", key, resp.StatusCode, string(respBody))
	}
	return nil
}
