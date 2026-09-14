package control

import "testing"

// TestStartSessionRequest_Validate_RejectsMsValuesThatOverflowTicks pins
// exceedsTicksBound's use in Validate (Farol review, PR #584):
// PartMs/SegmentMs are attacker-controlled (this is the signed but
// otherwise unchecked body of POST /sessions) and feed NewRemuxPipeline's
// msToTicks, which multiplies by h264.ClockRate into a uint32. A "positive
// integer" check alone lets a caller send a value large enough to wrap
// through that uint32 truncation and land on a tiny or zero tick count --
// exactly the boundary internal/config's own analogous check already
// closes for the env-configured single-session binary.
func TestStartSessionRequest_Validate_RejectsMsValuesThatOverflowTicks(t *testing.T) {
	base := testStartReq(sessA, chanA, chanA)

	tests := []struct {
		name    string
		mutate  func(*StartSessionRequest)
		wantErr bool
	}{
		{
			name:    "default part/segment ms are valid",
			mutate:  func(*StartSessionRequest) {},
			wantErr: false,
		},
		{
			name: "partMs at the safe bound is valid",
			mutate: func(r *StartSessionRequest) {
				r.PartMs = int(maxTicksSafeMs)
			},
			wantErr: false,
		},
		{
			name: "partMs one past the safe bound is rejected",
			mutate: func(r *StartSessionRequest) {
				r.PartMs = int(maxTicksSafeMs) + 1
			},
			wantErr: true,
		},
		{
			name: "segmentMs one past the safe bound is rejected",
			mutate: func(r *StartSessionRequest) {
				r.SegmentMs = int(maxTicksSafeMs) + 1
			},
			wantErr: true,
		},
		{
			name: "partMs large enough to wrap a uint32 tick count is rejected",
			mutate: func(r *StartSessionRequest) {
				// Comfortably past maxTicksSafeMs -- would silently wrap
				// to a small or zero tick count if this bound did not
				// exist, rather than the obviously-huge duration a caller
				// asked for.
				r.PartMs = 1 << 40
			},
			wantErr: true,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			req := base
			tt.mutate(&req)
			err := req.Validate()
			if tt.wantErr && err == nil {
				t.Fatalf("expected Validate to reject %+v, got nil error", req)
			}
			if !tt.wantErr && err != nil {
				t.Fatalf("expected Validate to accept %+v, got: %v", req, err)
			}
		})
	}
}
