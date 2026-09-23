package r2

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"time"
)

// ErrNotFound is what ObjectClient answers for a key the bucket does not
// have, so a caller can tell "never written" from "storage is down".
var ErrNotFound = errors.New("r2: object not found")

// ObjectClient is the read-and-write-whole-objects half of this package,
// for work that runs AFTER a session: internal/film reads a finished
// session's segments back and writes one large file beside them. The
// Writer above is the wrong tool for that on purpose: it drops work under
// pressure and holds every body in memory, both right for a live pipeline
// and both wrong for a one-gigabyte film.
//
// No client-wide timeout: a multi-gigabyte PUT down an ordinary link takes
// minutes, so every call is bounded by its caller's context instead.
type ObjectClient struct {
	cfg    Config
	client *http.Client
}

// NewObjectClient returns a client for cfg.
func NewObjectClient(cfg Config) *ObjectClient {
	return &ObjectClient{cfg: cfg, client: &http.Client{}}
}

// emptySHA256 is the SigV4 payload hash of a request with no body.
const emptySHA256 = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"

func (c *ObjectClient) newRequest(ctx context.Context, method, key, payloadHash string, body io.Reader) (*http.Request, error) {
	signed, requestURL, err := sigv4SignPayloadHash(c.cfg, method, key, payloadHash, time.Now())
	if err != nil {
		return nil, err
	}
	req, err := http.NewRequestWithContext(ctx, method, requestURL, body)
	if err != nil {
		return nil, fmt.Errorf("r2: building request: %w", err)
	}
	req.Host = signed.Host
	req.Header.Set("X-Amz-Date", signed.AmzDate)
	req.Header.Set("X-Amz-Content-Sha256", signed.ContentSHA256Hex)
	req.Header.Set("Authorization", signed.Authorization)
	return req, nil
}

// Get opens one object for reading. The caller closes the body. A missing
// key is ErrNotFound; any other non-2xx answer is an error naming the status.
func (c *ObjectClient) Get(ctx context.Context, key string) (io.ReadCloser, error) {
	req, err := c.newRequest(ctx, http.MethodGet, key, emptySHA256, nil)
	if err != nil {
		return nil, err
	}
	resp, err := c.client.Do(req)
	if err != nil {
		return nil, fmt.Errorf("r2: GET %s: %w", key, err)
	}
	if resp.StatusCode == http.StatusNotFound {
		resp.Body.Close()
		return nil, fmt.Errorf("%w: %s", ErrNotFound, key)
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		msg, _ := io.ReadAll(io.LimitReader(resp.Body, 4096))
		resp.Body.Close()
		return nil, fmt.Errorf("r2: GET %s: HTTP %d: %s", key, resp.StatusCode, string(msg))
	}
	return resp.Body, nil
}

// Exists reports whether key is in the bucket (a HEAD).
func (c *ObjectClient) Exists(ctx context.Context, key string) (bool, error) {
	req, err := c.newRequest(ctx, http.MethodHead, key, emptySHA256, nil)
	if err != nil {
		return false, err
	}
	resp, err := c.client.Do(req)
	if err != nil {
		return false, fmt.Errorf("r2: HEAD %s: %w", key, err)
	}
	resp.Body.Close()
	switch {
	case resp.StatusCode == http.StatusNotFound:
		return false, nil
	case resp.StatusCode >= 200 && resp.StatusCode < 300:
		return true, nil
	default:
		return false, fmt.Errorf("r2: HEAD %s: HTTP %d", key, resp.StatusCode)
	}
}

// Put writes a small in-memory object.
func (c *ObjectClient) Put(ctx context.Context, key string, body []byte, contentType string) error {
	return (&s3Uploader{cfg: c.cfg, client: c.client}).PutObject(ctx, key, body, contentType)
}

// MaxSinglePutBytes is the largest object one S3 PUT may carry (5 GiB on
// both R2 and AWS). A film past it would need a multipart upload, which a
// show would have to run for most of a day at the film's bitrate to reach.
const MaxSinglePutBytes = 5 << 30

// PutFile streams a file from disk into one object. The file is read twice:
// once to hash it for the signature, once to send it, so it is never held
// in memory whatever its size.
func (c *ObjectClient) PutFile(ctx context.Context, key, path, contentType string) error {
	f, err := os.Open(path)
	if err != nil {
		return err
	}
	defer f.Close()
	info, err := f.Stat()
	if err != nil {
		return err
	}
	if info.Size() > MaxSinglePutBytes {
		return fmt.Errorf("r2: %s is %d bytes, past the %d a single PUT may carry", path, info.Size(), int64(MaxSinglePutBytes))
	}
	h := sha256.New()
	if _, err := io.Copy(h, f); err != nil {
		return fmt.Errorf("r2: hashing %s: %w", path, err)
	}
	if _, err := f.Seek(0, io.SeekStart); err != nil {
		return err
	}
	req, err := c.newRequest(ctx, http.MethodPut, key, hex.EncodeToString(h.Sum(nil)), f)
	if err != nil {
		return err
	}
	req.ContentLength = info.Size()
	if contentType != "" {
		req.Header.Set("Content-Type", contentType)
	}
	resp, err := c.client.Do(req)
	if err != nil {
		return fmt.Errorf("r2: PUT %s: %w", key, err)
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		msg, _ := io.ReadAll(io.LimitReader(resp.Body, 4096))
		return fmt.Errorf("r2: PUT %s: HTTP %d: %s", key, resp.StatusCode, string(msg))
	}
	return nil
}
