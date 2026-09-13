// Package subscriber joins a LiveKit room as a hidden, publish-nothing
// participant and hands the presenter's screen-share RTP packets to the
// caller. It never decodes a frame: this is the WebRTC plumbing L1.1 calls
// for, everything downstream of an *rtp.Packet is internal/h264 and
// internal/pipeline's job.
package subscriber

import (
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"time"

	"github.com/pion/rtp"
	"github.com/pion/webrtc/v4"

	"github.com/livekit/protocol/auth"
	"github.com/livekit/protocol/livekit"
	lksdk "github.com/livekit/server-sdk-go/v2"
)

// Config is what Connect needs to join cfg.Room as a hidden subscriber.
type Config struct {
	URL       string
	APIKey    string
	APISecret string
	Room      string
	// Identity defaults to "pqp-remux-<8 random hex chars>" when empty.
	Identity string
	// TokenTTL defaults to 24h when zero: long enough that a session
	// spanning an all-day stream never needs a mid-session reconnect just
	// because its own token expired.
	TokenTTL time.Duration
}

// Handlers are the callbacks Connect drives as RTP arrives. OnAudioPacket
// is present because the plan asks this task to select and log the
// presenter's screen-share audio track; nothing mixes or encodes it yet
// (L1.3).
type Handlers struct {
	OnVideoPacket func(pkt *rtp.Packet)
	OnAudioPacket func(pkt *rtp.Packet)
	// OnVideoTrackFound/OnAudioTrackFound fire once, when the presenter's
	// screen-share publication is subscribed, before any packet callback:
	// this is where a caller building an idr-log or a keyframe requester
	// gets the participant + track handle it needs.
	OnVideoTrackFound func(s *Session)
	OnAudioTrackFound func(s *Session)
}

// Session is a live hidden-subscriber connection to one room.
type Session struct {
	room        *lksdk.Room
	participant *lksdk.RemoteParticipant
	videoPub    *lksdk.RemoteTrackPublication
}

// VideoSSRC returns the subscribed screen-share video track's SSRC, for a
// caller that wants to send a PLI directly (see RequestKeyframe, which does
// this for you); ok is false before the track is found.
func (s *Session) VideoSSRC() (webrtc.SSRC, bool) {
	if s.videoPub == nil {
		return 0, false
	}
	track := s.videoPub.TrackRemote()
	if track == nil {
		return 0, false
	}
	return track.SSRC(), true
}

// RequestKeyframe sends one RTCP PLI for the subscribed screen-share video
// track: the only lever section 3 of the plan found for asking a WebRTC
// publisher for an IDR. A no-op before the track is found.
func (s *Session) RequestKeyframe() {
	ssrc, ok := s.VideoSSRC()
	if !ok || s.participant == nil {
		return
	}
	s.participant.WritePLI(ssrc)
}

// Close disconnects from the room. Safe to call more than once.
func (s *Session) Close() {
	if s.room != nil {
		s.room.Disconnect()
	}
}

var errMissingConfig = errors.New("subscriber: URL, APIKey, APISecret and Room are all required")

// Connect joins cfg.Room as a hidden (Hidden: true), publish-nothing,
// subscribe-only participant, and wires h up to the presenter's
// screen-share video track and (if present) its screen-share audio track.
// It returns once the room connection itself succeeds; tracks are found
// asynchronously as OnTrackSubscribed fires; h.OnVideoTrackFound tells the
// caller when that has happened.
func Connect(cfg Config, h Handlers) (*Session, error) {
	if cfg.URL == "" || cfg.APIKey == "" || cfg.APISecret == "" || cfg.Room == "" {
		return nil, errMissingConfig
	}

	token, err := buildToken(cfg)
	if err != nil {
		return nil, fmt.Errorf("subscriber: building the hidden-subscriber token: %w", err)
	}

	sess := &Session{}

	cb := lksdk.NewRoomCallback()
	cb.OnTrackSubscribed = func(track *webrtc.TrackRemote, pub *lksdk.RemoteTrackPublication, rp *lksdk.RemoteParticipant) {
		switch {
		case isScreenShareVideo(pub):
			sess.participant = rp
			sess.videoPub = pub
			if h.OnVideoTrackFound != nil {
				h.OnVideoTrackFound(sess)
			}
			readRTP(track, h.OnVideoPacket)
		case isScreenShareAudio(pub):
			if h.OnAudioTrackFound != nil {
				h.OnAudioTrackFound(sess)
			}
			readRTP(track, h.OnAudioPacket)
		}
	}

	room, err := lksdk.ConnectToRoomWithToken(cfg.URL, token, cb, lksdk.WithAutoSubscribe(true))
	if err != nil {
		return nil, fmt.Errorf("subscriber: connecting to room %q: %w", cfg.Room, err)
	}
	sess.room = room
	return sess, nil
}

// readRTP blocks reading RTP packets off track and forwards each to cb,
// until the track ends (the publisher stopped sharing, or the session
// disconnected). It is meant to run in its own goroutine, one per
// subscribed track; Connect starts it directly rather than handing the
// caller a raw *webrtc.TrackRemote; a nil cb still drains the track so a
// caller that only wants the video (no OnAudioPacket set) does not leave a
// buffer filling up unread.
func readRTP(track *webrtc.TrackRemote, cb func(*rtp.Packet)) {
	for {
		pkt, _, err := track.ReadRTP()
		if err != nil {
			return
		}
		if cb != nil {
			cb(pkt)
		}
	}
}

func buildToken(cfg Config) (string, error) {
	identity := cfg.Identity
	if identity == "" {
		var err error
		identity, err = randomIdentity()
		if err != nil {
			return "", err
		}
	}
	ttl := cfg.TokenTTL
	if ttl == 0 {
		ttl = 24 * time.Hour
	}

	grant := &auth.VideoGrant{RoomJoin: true, Room: cfg.Room, Hidden: true}
	grant.SetCanSubscribe(true)
	grant.SetCanPublish(false)
	grant.SetCanPublishData(false)

	at := auth.NewAccessToken(cfg.APIKey, cfg.APISecret).
		SetIdentity(identity).
		AddGrant(grant).
		SetValidFor(ttl)
	return at.ToJWT()
}

func randomIdentity() (string, error) {
	var b [4]byte
	if _, err := rand.Read(b[:]); err != nil {
		return "", err
	}
	return "pqp-remux-" + hex.EncodeToString(b[:]), nil
}

// hasSourceAndKind is the minimal surface Connect needs to pick the
// presenter's screen-share tracks out of everything published in the room.
// It is a local interface (not lksdk.TrackPublication, which carries an
// unexported method and so cannot be satisfied by a fake outside its own
// package) purely so isScreenShareVideo/isScreenShareAudio are unit
// testable; *lksdk.RemoteTrackPublication already has both methods, so it
// satisfies this structurally with no adapter needed.
type hasSourceAndKind interface {
	Source() livekit.TrackSource
	Kind() lksdk.TrackKind
}

func isScreenShareVideo(p hasSourceAndKind) bool {
	return p.Kind() == lksdk.TrackKindVideo && p.Source() == livekit.TrackSource_SCREEN_SHARE
}

func isScreenShareAudio(p hasSourceAndKind) bool {
	return p.Kind() == lksdk.TrackKindAudio && p.Source() == livekit.TrackSource_SCREEN_SHARE_AUDIO
}
