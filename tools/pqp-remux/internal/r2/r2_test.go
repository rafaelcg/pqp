package r2

import (
	"strings"
	"testing"
	"time"
)

func TestConfig_SigningRegionDefaultsWhenEmpty(t *testing.T) {
	c := Config{Endpoint: "http://localhost:9000", Bucket: "b", AccessKeyID: "k", SecretAccessKey: "s"}
	if got := c.SigningRegion(); got != DefaultRegion {
		t.Fatalf("SigningRegion() = %q, want DefaultRegion %q", got, DefaultRegion)
	}
	if !c.Configured() {
		t.Fatal("a Config with no Region set must still be Configured (SigningRegion covers the gap)")
	}
}

func TestConfig_SigningRegionRespectsExplicitValue(t *testing.T) {
	c := Config{Region: "us-east-1"}
	if got := c.SigningRegion(); got != "us-east-1" {
		t.Fatalf("SigningRegion() = %q, want the explicit region", got)
	}
}

// TestSigv4SignNeverEmitsAnEmptyRegionInTheCredentialScope is the
// regression test for the "Configured but the region is empty" trap
// Farol found: a signature computed with credentialScope
// "<date>//s3/aws4_request" (an empty region segment) is syntactically
// well-formed SigV4 but rejected by both R2 and MinIO at request time,
// so this asserts the scope actually embedded in the Authorization
// header never has that shape.
func TestSigv4SignNeverEmitsAnEmptyRegionInTheCredentialScope(t *testing.T) {
	cfg := Config{
		Endpoint:        "http://localhost:9000",
		Bucket:          "b",
		AccessKeyID:     "k",
		SecretAccessKey: "s",
		ForcePathStyle:  true,
		// Region left empty on purpose.
	}
	signed, _, err := sigv4Sign(cfg, "PUT", "key", []byte("body"), time.Now())
	if err != nil {
		t.Fatalf("sigv4Sign: %v", err)
	}
	if containsEmptyRegionScope(signed.Authorization) {
		t.Fatalf("Authorization header carries an empty-region credential scope: %s", signed.Authorization)
	}
}

func containsEmptyRegionScope(auth string) bool {
	// A well-formed scope segment is "<date>/<region>/s3/aws4_request";
	// an empty region collapses the two slashes together.
	return strings.Contains(auth, "//s3/aws4_request")
}
