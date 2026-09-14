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
//
// NonceHeader is an EXTENSION to that contract this file's own review
// (Farol, PR #584) adds: a per-request random value the caller generates
// and this box remembers for 2xClockSkewMs (nonceCache, nonce_cache.go),
// refusing an exact repeat. hls-remux-control.ts's own doc comment names
// the gap this closes: "there is no nonce store on either side... the skew
// window is what turns a captured request into something that stops
// working shortly after capture." A nonce makes that immediate rather
// than "eventually": within the skew window, a captured request now fails
// on its SECOND use, not merely its first use after the window closes.
// THIS IS A BREAKING CONTRACT CHANGE the TS side (PR #580,
// server/src/voice/hls-remux.ts) has not picked up yet -- every request
// from an unpatched client is refused as "missing nonce" until it does.
// See the PR description for the coordination and the follow-up comment
// left on #580 asking it to send X-Pqp-Remux-Nonce (any sufficiently
// random per-request string, e.g. a UUID or 16+ bytes of hex) as part of
// the signed payload, in the exact position signaturePayload defines
// below.
const (
	TimestampHeader = "X-Pqp-Remux-Timestamp"
	SignatureHeader = "X-Pqp-Remux-Signature"
	NonceHeader     = "X-Pqp-Remux-Nonce"
)

// ClockSkewMs is byte-for-byte REMUX_CONTROL_CLOCK_SKEW_MS: how far a
// signed request's timestamp may drift from this box's own clock before it
// is refused.
const ClockSkewMs = 60_000

// maxNonceLen bounds a nonce's length: nonceCache holds one map entry per
// distinct nonce for up to 2xClockSkewMs, so an unbounded value is a
// memory-growth knob for a field that only ever needs to be "random
// enough not to repeat by accident" -- 16 bytes of hex (32 chars) or a
// UUID (36 chars) both fit many times over.
const maxNonceLen = 256

// signaturePayload is remuxControlSignaturePayload in
// packages/shared/src/hls-remux-control.ts, EXTENDED with a nonce segment
// (see NonceHeader's doc comment above -- not yet reflected in that file
// itself):
//
//	${method.toUpperCase()}\n${path}\n${timestampMs}\n${nonce}\n${rawBody}
//
// method must already be upper-cased by the caller (verifySignature does
// this once, so both the "build the expected payload" and "this is what we
// received" call sites agree on it without each repeating the transform).
func signaturePayload(method, path, timestampMs, nonce, rawBody string) string {
	return method + "\n" + path + "\n" + timestampMs + "\n" + nonce + "\n" + rawBody
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
	errMissingSignatureHeaders = errors.New("control: missing " + TimestampHeader + ", " + SignatureHeader + " or " + NonceHeader)
	errNonceTooLong            = errors.New("control: " + NonceHeader + " exceeds the maximum allowed length")
	errMalformedTimestamp      = errors.New("control: " + TimestampHeader + " is not an integer number of milliseconds")
	errClockSkew               = errors.New("control: timestamp is outside the allowed clock skew")
	errSignatureMismatch       = errors.New("control: signature does not match")
	errMalformedSignature      = errors.New("control: signature is not valid hex")
)

// verifySignature checks a request against secret: recompute the payload
// (now including nonce -- see signaturePayload) from what was actually
// received, HMAC it, and compare in constant time; then separately check
// the timestamp is within ClockSkewMs of now. Both checks run (the
// signature check first) so a bad secret and a stale timestamp each
// produce their own distinguishable error for logging, even though the
// HTTP response never reveals which one failed.
//
// This does NOT check whether nonce has been seen before -- that is
// server.go's withSigning's job (via nonceCache), run only after a
// signature verifies, so an attacker cannot pollute the replay cache with
// nonces from requests that were never actually valid.
//
// path is the request's literal path (method + "/sessions/abc123" for
// example), never including a query string -- these routes take none, per
// the contract's own doc comment.
func verifySignature(secret []byte, method, path, timestampMs, nonce string, rawBody []byte, signatureHex string, now time.Time) error {
	if timestampMs == "" || signatureHex == "" || nonce == "" {
		return errMissingSignatureHeaders
	}
	if len(nonce) > maxNonceLen {
		return errNonceTooLong
	}

	given, err := hex.DecodeString(strings.ToLower(strings.TrimSpace(signatureHex)))
	if err != nil {
		return errMalformedSignature
	}
	payload := signaturePayload(strings.ToUpper(method), path, timestampMs, nonce, string(rawBody))
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
