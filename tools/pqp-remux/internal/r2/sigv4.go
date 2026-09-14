package r2

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"net/url"
	"strings"
	"time"
)

const service = "s3"
const algorithm = "AWS4-HMAC-SHA256"

// signedRequest is everything sigv4Sign computes for one request: the
// caller (PutObject) copies these directly onto its *http.Request.
type signedRequest struct {
	Host             string
	AmzDate          string
	ContentSHA256Hex string
	Authorization    string
}

// sigv4Sign implements AWS Signature Version 4 (the same algorithm
// server/src/lib/s3.ts's signRequest implements in TypeScript) for a PUT
// of body to key, against cfg. now is threaded in (rather than read from
// time.Now() internally) so tests can pin it and check exact string
// output instead of only "it didn't error".
//
// Only what PutObject needs is signed: host, x-amz-content-sha256 and
// x-amz-date. Content-Type is sent but deliberately NOT in
// SignedHeaders -- R2 and MinIO both accept this (SignedHeaders is a
// floor, not a checklist of every header present), and leaving it out
// keeps this function ignorant of whether the caller happens to set a
// content type, rather than needing every header threaded through the
// signature.
func sigv4Sign(cfg Config, method, key string, body []byte, now time.Time) (signedRequest, string, error) {
	u, err := url.Parse(cfg.Endpoint)
	if err != nil {
		return signedRequest{}, "", fmt.Errorf("r2: parsing endpoint %q: %w", cfg.Endpoint, err)
	}

	canonicalURI, host, requestURL := buildURL(u, cfg.Bucket, key, cfg.ForcePathStyle)

	amzDate := now.UTC().Format("20060102T150405Z")
	dateStamp := now.UTC().Format("20060102")
	payloadHash := sha256Hex(body)

	canonicalHeaders := fmt.Sprintf("host:%s\nx-amz-content-sha256:%s\nx-amz-date:%s\n", host, payloadHash, amzDate)
	signedHeaders := "host;x-amz-content-sha256;x-amz-date"

	canonicalRequest := strings.Join([]string{
		method,
		canonicalURI,
		"", // canonical query string: PutObject never has one
		canonicalHeaders,
		signedHeaders,
		payloadHash,
	}, "\n")

	region := cfg.SigningRegion()
	credentialScope := fmt.Sprintf("%s/%s/%s/aws4_request", dateStamp, region, service)
	stringToSign := strings.Join([]string{
		algorithm,
		amzDate,
		credentialScope,
		sha256Hex([]byte(canonicalRequest)),
	}, "\n")

	signingKey := deriveSigningKey(cfg.SecretAccessKey, dateStamp, region)
	signature := hex.EncodeToString(hmacSHA256(signingKey, []byte(stringToSign)))

	authorization := fmt.Sprintf("%s Credential=%s/%s, SignedHeaders=%s, Signature=%s",
		algorithm, cfg.AccessKeyID, credentialScope, signedHeaders, signature)

	return signedRequest{
		Host:             host,
		AmzDate:          amzDate,
		ContentSHA256Hex: payloadHash,
		Authorization:    authorization,
	}, requestURL, nil
}

// buildURL returns (canonicalURI, host, fullURL) for key against bucket,
// honoring ForcePathStyle exactly like server/src/lib/s3.ts's own
// objectTarget: path-style is "<endpoint>/<bucket>/<key>" (what MinIO and
// R2 both accept, and what a self-hosted MinIO with a bare IP endpoint
// requires, since virtual-hosted style needs DNS wildcarding a raw
// endpoint doesn't have); virtual-hosted is "<bucket>.<endpoint-host>/<key>".
func buildURL(endpoint *url.URL, bucket, key string, forcePathStyle bool) (canonicalURI, host, fullURL string) {
	escapedKey := escapeS3Path(key)
	if forcePathStyle {
		host = endpoint.Host
		canonicalURI = "/" + bucket + "/" + escapedKey
	} else {
		host = bucket + "." + endpoint.Host
		canonicalURI = "/" + escapedKey
	}
	fullURL = endpoint.Scheme + "://" + host + canonicalURI
	return
}

// escapeS3Path percent-encodes a key the way SigV4's canonical URI wants:
// every character URL-escaped except the unreserved set (RFC 3986) and
// "/", which must stay literal to remain a path separator rather than
// becoming a literal-slash-shaped segment name.
func escapeS3Path(key string) string {
	var b strings.Builder
	for _, r := range key {
		if r == '/' || isUnreservedURLChar(r) {
			b.WriteRune(r)
			continue
		}
		for _, c := range []byte(string(r)) {
			fmt.Fprintf(&b, "%%%02X", c)
		}
	}
	return b.String()
}

func isUnreservedURLChar(r rune) bool {
	switch {
	case r >= 'A' && r <= 'Z', r >= 'a' && r <= 'z', r >= '0' && r <= '9':
		return true
	case r == '-' || r == '.' || r == '_' || r == '~':
		return true
	default:
		return false
	}
}

func sha256Hex(b []byte) string {
	sum := sha256.Sum256(b)
	return hex.EncodeToString(sum[:])
}

func hmacSHA256(key, data []byte) []byte {
	mac := hmac.New(sha256.New, key)
	mac.Write(data)
	return mac.Sum(nil)
}

// deriveSigningKey is AWS SigV4's key-derivation chain (Signature Version
// 4 spec, "Derive a Signing Key"): four nested HMACs binding the secret to
// a date, region and service, so the final key is valid only for signing
// requests to this service, in this region, on this UTC day.
func deriveSigningKey(secretKey, dateStamp, region string) []byte {
	kDate := hmacSHA256([]byte("AWS4"+secretKey), []byte(dateStamp))
	kRegion := hmacSHA256(kDate, []byte(region))
	kService := hmacSHA256(kRegion, []byte(service))
	return hmacSHA256(kService, []byte("aws4_request"))
}
