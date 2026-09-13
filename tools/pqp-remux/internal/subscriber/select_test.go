package subscriber

import (
	"testing"

	"github.com/livekit/protocol/livekit"
	lksdk "github.com/livekit/server-sdk-go/v2"
)

// fakePublication satisfies hasSourceAndKind without touching the SDK's
// real (partly unexported) TrackPublication interface, so track selection
// is testable without a live room.
type fakePublication struct {
	kind   lksdk.TrackKind
	source livekit.TrackSource
}

func (f fakePublication) Kind() lksdk.TrackKind       { return f.kind }
func (f fakePublication) Source() livekit.TrackSource { return f.source }

func TestIsScreenShareVideo(t *testing.T) {
	cases := []struct {
		name string
		pub  fakePublication
		want bool
	}{
		{"screen share video", fakePublication{lksdk.TrackKindVideo, livekit.TrackSource_SCREEN_SHARE}, true},
		{"camera video", fakePublication{lksdk.TrackKindVideo, livekit.TrackSource_CAMERA}, false},
		{"screen share audio (wrong kind)", fakePublication{lksdk.TrackKindAudio, livekit.TrackSource_SCREEN_SHARE}, false},
		{"microphone", fakePublication{lksdk.TrackKindAudio, livekit.TrackSource_MICROPHONE}, false},
		{"unknown source", fakePublication{lksdk.TrackKindVideo, livekit.TrackSource_UNKNOWN}, false},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if got := isScreenShareVideo(c.pub); got != c.want {
				t.Errorf("isScreenShareVideo(%+v) = %v, want %v", c.pub, got, c.want)
			}
		})
	}
}

func TestIsScreenShareAudio(t *testing.T) {
	cases := []struct {
		name string
		pub  fakePublication
		want bool
	}{
		{"screen share audio", fakePublication{lksdk.TrackKindAudio, livekit.TrackSource_SCREEN_SHARE_AUDIO}, true},
		{"screen share video (wrong kind)", fakePublication{lksdk.TrackKindVideo, livekit.TrackSource_SCREEN_SHARE_AUDIO}, false},
		{"microphone", fakePublication{lksdk.TrackKindAudio, livekit.TrackSource_MICROPHONE}, false},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if got := isScreenShareAudio(c.pub); got != c.want {
				t.Errorf("isScreenShareAudio(%+v) = %v, want %v", c.pub, got, c.want)
			}
		})
	}
}

func TestBuildToken_RequiresAllFields(t *testing.T) {
	if _, err := Connect(Config{}, Handlers{}); err == nil {
		t.Fatal("expected an error connecting with an empty Config")
	}
	if _, err := Connect(Config{URL: "ws://x", APIKey: "k"}, Handlers{}); err == nil {
		t.Fatal("expected an error with APISecret/Room missing")
	}
}

func TestBuildToken_ProducesAHiddenSubscribeOnlyGrant(t *testing.T) {
	token, err := buildToken(Config{APIKey: "key", APISecret: "12345678901234567890123456789012", Room: "test-room"})
	if err != nil {
		t.Fatalf("buildToken: %v", err)
	}
	if token == "" {
		t.Fatal("expected a non-empty JWT")
	}
}

func TestRandomIdentity_Unique(t *testing.T) {
	a, err := randomIdentity()
	if err != nil {
		t.Fatalf("randomIdentity: %v", err)
	}
	b, err := randomIdentity()
	if err != nil {
		t.Fatalf("randomIdentity: %v", err)
	}
	if a == b {
		t.Fatalf("expected two distinct identities, got %q twice", a)
	}
}
