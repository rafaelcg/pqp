package control

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"strconv"
	"strings"
	"time"
)

// TimestampHeader/SignatureHeader are byte-for-byte
// REMUX_CONTROL_TIMESTAMP_HEADER/REMUX_CONTROL_SIGNATURE_HEADER in
// packages/shared/src/hls-remux-control.ts. HTTP header names are
// case-insensitive on both sides (Go's net/http.Header canonicalizes on
// Set/Get; fetch()/undici do the same on the TS side), so the exact case
// here is cosmetic, kept as the canonical MIME form for readability.
const (
	TimestampHeader = "X-Pqp-Remux-Timestamp"
	SignatureHeader = "X-Pqp-Remux-Signature"
)

// ClockSkewMs is byte-for-byte REMUX_CONTROL_CLOCK_SKEW_MS: how far a
// signed request's timestamp may drift from this box's own clock before it
// is refused. There is no nonce store on either side (see
// hls-remux-control.ts's file header) -- this window is the only thing
// that makes a captured request eventually stop working.
const ClockSkewMs = 60_000

// signaturePayload is byte-for-byte remuxControlSignaturePayload in
// packages/shared/src/hls-remux-control.ts:
//
//	${method.toUpperCase()}\n${path}\n${timestampMs}\n${rawBody}
//
// method must already be upper-cased by the caller (verifySignature does
// this once, so both the "build the expected payload" and "this is what we
// received" call sites agree on it without each repeating the transform).
func signaturePayload(method, path, timestampMs, rawBody string) string {
	return method + "\n" + path + "\n" + timestampMs + "\n" + rawBody
}

// hmacSHA256Hex returns lowercase hex HMAC-SHA256 of payload under secret,
// matching createHmac("sha256", secret).update(payload, "utf8").digest("hex")
// on the TS side.
func hmacSHA256Hex(secret []byte, payload string) string {
	mac := hmac.New(sha256.New, secret)
	mac.Write([]byte(payload))
	return hex.EncodeToString(mac.Sum(nil))
}

var (
	errMissingSignatureHeaders = errors.New("control: missing " + TimestampHeader + " or " + SignatureHeader)
	errMalformedTimestamp      = errors.New("control: " + TimestampHeader + " is not an integer number of milliseconds")
	errClockSkew               = errors.New("control: timestamp is outside the allowed clock skew")
	errSignatureMismatch       = errors.New("control: signature does not match")
	errMalformedSignature      = errors.New("control: signature is not valid hex")
)

// verifySignature checks a request against secret exactly the way
// hls-remux-control.ts's doc comment specifies: recompute the payload from
// what was actually received, HMAC it, and compare in constant time; then
// separately check the timestamp is within ClockSkewMs of now. Both checks
// run (the signature check first) so a bad secret and a stale timestamp
// each produce their own distinguishable error for logging, even though the
// HTTP response never reveals which one failed (see server.go's
// handleSigningError).
//
// path is the request's literal path (method + "/sessions/abc123" for
// example), never including a query string -- these routes take none, per
// the contract's own doc comment.
func verifySignature(secret []byte, method, path, timestampMs string, rawBody []byte, signatureHex string, now time.Time) error {
	if timestampMs == "" || signatureHex == "" {
		return errMissingSignatureHeaders
	}

	given, err := hex.DecodeString(strings.ToLower(strings.TrimSpace(signatureHex)))
	if err != nil {
		return errMalformedSignature
	}
	payload := signaturePayload(strings.ToUpper(method), path, timestampMs, string(rawBody))
	expected, err := hex.DecodeString(hmacSHA256Hex(secret, payload))
	if err != nil {
		// hmacSHA256Hex's own output is always valid hex; unreachable in
		// practice, but a decode error must never be treated as "matches".
		return errMalformedSignature
	}
	if !hmac.Equal(expected, given) {
		return errSignatureMismatch
	}

	tsMs, err := strconv.ParseInt(strings.TrimSpace(timestampMs), 10, 64)
	if err != nil {
		return errMalformedTimestamp
	}
	skew := now.UnixMilli() - tsMs
	if skew < 0 {
		skew = -skew
	}
	if skew > ClockSkewMs {
		return errClockSkew
	}
	return nil
}
