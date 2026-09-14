package control

import (
	"strconv"
	"testing"
	"time"
)

func sign(secret []byte, method, path, ts, body string) string {
	return hmacSHA256Hex(secret, signaturePayload(method, path, ts, body))
}

func TestVerifySignature_Accepts(t *testing.T) {
	secret := []byte("s3cr3t")
	ts := "1700000000000"
	body := `{"a":1}`
	sig := sign(secret, "POST", "/sessions", ts, body)
	now := time.UnixMilli(1700000000000)

	if err := verifySignature(secret, "POST", "/sessions", ts, []byte(body), sig, now); err != nil {
		t.Fatalf("expected a valid signature to be accepted, got %v", err)
	}
}

// TestVerifySignature_MethodCaseInsensitive mirrors the TS side's own
// method.toUpperCase(): a lowercase HTTP method (net/http itself never
// sends one, but nothing stops a caller from constructing r.Method by
// hand) must sign identically to its uppercase form.
func TestVerifySignature_MethodCaseInsensitive(t *testing.T) {
	secret := []byte("s3cr3t")
	ts := "1700000000000"
	sig := sign(secret, "DELETE", "/sessions/abc", ts, "")
	now := time.UnixMilli(1700000000000)

	if err := verifySignature(secret, "delete", "/sessions/abc", ts, nil, sig, now); err != nil {
		t.Fatalf("expected a lowercase method to verify against an uppercase-signed payload, got %v", err)
	}
}

func TestVerifySignature_RejectsWrongSecret(t *testing.T) {
	ts := "1700000000000"
	body := `{"a":1}`
	sig := sign([]byte("right-secret"), "POST", "/sessions", ts, body)
	now := time.UnixMilli(1700000000000)

	if err := verifySignature([]byte("wrong-secret"), "POST", "/sessions", ts, []byte(body), sig, now); err == nil {
		t.Fatal("expected a signature made with a different secret to be rejected")
	}
}

// TestVerifySignature_RejectsSkewedTimestamp is the exact property
// hls-remux-control.ts's own doc comment describes: "the skew window is
// what turns a captured request into something that stops working shortly
// after capture, since there is no nonce store on either side." A
// perfectly valid signature, replayed unmodified once the clock has moved
// far enough, must be refused.
func TestVerifySignature_RejectsSkewedTimestamp(t *testing.T) {
	secret := []byte("s3cr3t")
	tsInt := int64(1_700_000_000_000)
	ts := strconv.FormatInt(tsInt, 10)
	sig := sign(secret, "GET", "/sessions", ts, "")

	tooLate := time.UnixMilli(tsInt + ClockSkewMs + 1)
	if err := verifySignature(secret, "GET", "/sessions", ts, nil, sig, tooLate); err == nil {
		t.Fatal("expected a timestamp older than the skew window to be rejected")
	}

	tooEarly := time.UnixMilli(tsInt - ClockSkewMs - 1)
	if err := verifySignature(secret, "GET", "/sessions", ts, nil, sig, tooEarly); err == nil {
		t.Fatal("expected a timestamp newer than the skew window to be rejected")
	}

	// Exactly at the boundary (inclusive) still verifies -- ClockSkewMs
	// itself is "may drift this far", not "must be strictly less than".
	atEdge := time.UnixMilli(tsInt + ClockSkewMs)
	if err := verifySignature(secret, "GET", "/sessions", ts, nil, sig, atEdge); err != nil {
		t.Fatalf("expected a timestamp exactly at the skew boundary to be accepted, got %v", err)
	}
}

// TestVerifySignature_RejectsReplayedBody is the other half of "a captured
// request stops working" -- pasting a valid, still-fresh timestamp and
// signature onto a DIFFERENT body must fail, because the signature commits
// to the exact body bytes (rawBody), not just the headers. Without this,
// a signed DELETE with no body could be replayed as a signed POST carrying
// an attacker-chosen StartSessionRequest.
func TestVerifySignature_RejectsReplayedBody(t *testing.T) {
	secret := []byte("s3cr3t")
	ts := "1700000000000"
	now := time.UnixMilli(1700000000000)
	sig := sign(secret, "POST", "/sessions", ts, `{"sessionId":"a"}`)

	if err := verifySignature(secret, "POST", "/sessions", ts, []byte(`{"sessionId":"b"}`), sig, now); err == nil {
		t.Fatal("expected a signature computed for a different body to be rejected")
	}
}

func TestVerifySignature_RejectsMissingHeaders(t *testing.T) {
	secret := []byte("s3cr3t")
	now := time.Now()

	if err := verifySignature(secret, "GET", "/sessions", "", nil, "", now); err == nil {
		t.Fatal("expected a request with no timestamp/signature headers to be rejected")
	}
	sig := sign(secret, "GET", "/sessions", "1700000000000", "")
	if err := verifySignature(secret, "GET", "/sessions", "", nil, sig, now); err == nil {
		t.Fatal("expected a request with a signature but no timestamp to be rejected")
	}
	if err := verifySignature(secret, "GET", "/sessions", "1700000000000", nil, "", now); err == nil {
		t.Fatal("expected a request with a timestamp but no signature to be rejected")
	}
}

func TestVerifySignature_RejectsMalformedSignatureHex(t *testing.T) {
	secret := []byte("s3cr3t")
	now := time.UnixMilli(1700000000000)
	if err := verifySignature(secret, "GET", "/sessions", "1700000000000", nil, "not-hex!!", now); err == nil {
		t.Fatal("expected a non-hex signature to be rejected")
	}
}
