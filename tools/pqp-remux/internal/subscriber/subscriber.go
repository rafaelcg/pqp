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
	"log"
	"sync"
	"sync/atomic"
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

// AudioSink receives one dynamically-discovered stage microphone's RTP
// packets (see Handlers.OnMicTrackFound) and is told when that one
// publication ends, exactly once, so a caller (internal/session) can tear
// it out of a mix without this package needing to know anything about
// mixing, decoding or muxing.
type AudioSink interface {
	HandlePacket(pkt *rtp.Packet)
	Close()
}

// Handlers are the callbacks Connect drives as RTP arrives.
type Handlers struct {
	OnVideoPacket func(pkt *rtp.Packet)
	// OnAudioPacket carries the presenter's screen-share audio (L1.3 mixes
	// this in as one stage source, keyed "screen" by the caller — see
	// internal/session).
	OnAudioPacket func(pkt *rtp.Packet)
	// OnVideoTrackFound/OnAudioTrackFound fire once, when the presenter's
	// screen-share publication is subscribed, before any packet callback:
	// this is where a caller building an idr-log or a keyframe requester
	// gets the participant + track handle it needs.
	OnVideoTrackFound func(s *Session)
	OnAudioTrackFound func(s *Session)
	// OnMicTrackFound fires once per participant microphone publication
	// subscribed: every stage speaker's microphone, not just the
	// presenter's. LiveKit's own SPEAK grant is what gates who can
	// publish a microphone at all (liveKitPublishGrant, server-side), so
	// every mic track this process ever sees already is a stage speaker —
	// the same reasoning isScreenShareVideo's doc comment gives for not
	// re-checking authorization on the screen share. identity is the
	// publishing participant's LiveKit identity (their peer id), stable
	// for that publication's lifetime. Unlike the screen-share slots
	// above, multiple microphones may be found concurrently; each gets
	// its own AudioSink and its own RTP-reading goroutine. A nil
	// OnMicTrackFound (the idr-log mode's Handlers never sets it) means
	// every microphone track is drained and discarded, matching how a nil
	// per-packet callback already behaves elsewhere in this file.
	OnMicTrackFound func(identity string) AudioSink
	// OnVideoTrackEnded fires once the screen-share video track's RTP read
	// loop returns (the publisher stopped sharing, or the room
	// disconnected): the caller's only signal to flush a trailing partial
	// CMAF fragment (session.Session.Finish exists for exactly this).
	// There is no equivalent for screen-share audio or a microphone: the
	// audio pipeline has no per-fragment "trailing partial" to flush the
	// way the video muxer does (see internal/pipeline.AudioFragmenter's
	// doc comment), only a mix that keeps running with one fewer source.
	OnVideoTrackEnded func()
}

// videoBinding is the presenter's participant and screen-share publication,
// always updated together: reading one without the other (a torn read)
// would let RequestKeyframe send a PLI on a stale SSRC for a participant
// that no longer matches it, so both live behind one atomic.Pointer rather
// than two separately-synchronized fields.
type videoBinding struct {
	participant *lksdk.RemoteParticipant
	pub         *lksdk.RemoteTrackPublication
}

// Session is a live hidden-subscriber connection to one room.
type Session struct {
	room *lksdk.Room

	// video is set exactly once, by whichever screen-share video track is
	// subscribed first (see Connect's OnTrackSubscribed): a second
	// concurrent screen share in the same room must not be allowed to
	// rebind it, since Session.HandleVideoPacket's depacketizer/fragmenter
	// pair assumes a single RTP source (interleaving two streams into one
	// depacketizer produces invalid fragments). This matches how the
	// conventional Track Composite egress already picks a presenter
	// (`pickHlsSharer` in hls-egress.ts: sharing state, not a
	// server-held identity, is the authorization signal throughout pqp's
	// screen-share code) — L1.5's API control plane is where a
	// designated-presenter concept, if ever needed, would be added.
	video atomic.Pointer[videoBinding]

	// audioBound guards the same single-track invariant for the
	// screen-share audio track, so two concurrent audio publications
	// cannot both start a reader against the caller's OnAudioPacket.
	audioBound atomic.Bool

	// videoWG is held for the video track's entire readRTP call: Add(1)
	// runs synchronously in OnTrackSubscribed's video case, strictly
	// before that case starts readRTP, and Done() runs only after
	// readRTP returns -- which itself only happens after it has already
	// called Handlers.OnVideoTrackEnded (session.Session.Finish in
	// production). Close waits on it after disconnecting, which is what
	// makes "the video track has fully ended, including its caller
	// callback" something Close's RETURN can be trusted to mean, instead
	// of merely "disconnect was requested" -- see Close's own doc
	// comment for the race this closes (Farol review, PR #584).
	videoWG sync.WaitGroup
}

// VideoSSRC returns the subscribed screen-share video track's SSRC, for a
// caller that wants to send a PLI directly (see RequestKeyframe, which does
// this for you); ok is false before the track is found.
func (s *Session) VideoSSRC() (webrtc.SSRC, bool) {
	b := s.video.Load()
	if b == nil || b.pub == nil {
		return 0, false
	}
	track := b.pub.TrackRemote()
	if track == nil {
		return 0, false
	}
	return track.SSRC(), true
}

// RequestKeyframe sends one RTCP PLI for the subscribed screen-share video
// track: the only lever section 3 of the plan found for asking a WebRTC
// publisher for an IDR. A no-op before the track is found.
func (s *Session) RequestKeyframe() {
	b := s.video.Load()
	if b == nil || b.participant == nil {
		return
	}
	ssrc, ok := s.VideoSSRC()
	if !ok {
		return
	}
	b.participant.WritePLI(ssrc)
}

// Close disconnects from the room and waits for the video track's readRTP
// goroutine to fully finish -- including having already called
// Handlers.OnVideoTrackEnded -- before returning. Safe to call more than
// once (the second call's Wait returns immediately: videoWG's counter is
// already back at zero).
//
// This closes a real race Farol caught in review (PR #584): a caller that
// tears an old pipeline down and then immediately reads its Health() (see
// managed_session.go's restart, which does exactly this to compute the
// replacement's starting segment index) used to be able to observe
// session.Session's fragmenter mid-flush. Disconnect makes the room's
// track end, but the goroutine that notices that and calls
// OnVideoTrackEnded is the LiveKit SDK's own track-subscription dispatch
// goroutine (see readRTP's doc comment: it "blocks reading RTP packets...
// until the track ends... then calls onEnded"), which this call was never
// joined with before -- Disconnect returning said nothing about whether
// that goroutine, and the Session.Finish it runs, had reached its own end
// yet. A slow or merely-not-yet-scheduled Finish could still be flushing
// the trailing fragment (advancing the very segment index restart() was
// about to read) after Close had already returned. videoWG makes "Close
// returned" and "the video track's own teardown, callback included, is
// fully done" the same fact: Wait cannot return before Done does, and
// Done runs only after OnVideoTrackEnded has already returned.
//
// A video track that never bound at all (e.g. Close called on a session
// still in its StateWaiting phase, before any presenter ever shared) means
// videoWG's counter was never incremented, so Wait returns immediately --
// this never blocks callers with nothing to wait for.
func (s *Session) Close() {
	if s.room != nil {
		s.room.Disconnect()
	}
	s.videoWG.Wait()
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
			bound := sess.video.CompareAndSwap(nil, &videoBinding{participant: rp, pub: pub})
			if !bound {
				log.Printf("subscriber: ignoring an additional screen-share video track from %q in room %q; already bound to a presenter", rp.Identity(), cfg.Room)
				return
			}
			if h.OnVideoTrackFound != nil {
				h.OnVideoTrackFound(sess)
			}
			// Add BEFORE readRTP starts (never concurrently with a
			// Close that could be racing in from another goroutine
			// right now): this case runs at most once per Session
			// (guarded by the CompareAndSwap above), so this is the
			// only place that ever calls videoWG.Add, and it happens
			// strictly before the Done below -- see Close's own doc
			// comment for what this pairing guarantees callers.
			sess.videoWG.Add(1)
			defer sess.videoWG.Done()
			readRTP(track, h.OnVideoPacket, h.OnVideoTrackEnded)
		case isScreenShareAudio(pub):
			if !sess.audioBound.CompareAndSwap(false, true) {
				log.Printf("subscriber: ignoring an additional screen-share audio track from %q in room %q; already bound", rp.Identity(), cfg.Room)
				return
			}
			if h.OnAudioTrackFound != nil {
				h.OnAudioTrackFound(sess)
			}
			readRTP(track, h.OnAudioPacket, nil)
		case isMicrophone(pub):
			if h.OnMicTrackFound == nil {
				readRTP(track, nil, nil) // drain and discard; see Handlers.OnMicTrackFound's doc comment
				return
			}
			sink := h.OnMicTrackFound(rp.Identity())
			readRTP(track, sink.HandlePacket, sink.Close)
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
// disconnected), then calls onEnded exactly once if it is non-nil. It is
// meant to run in its own goroutine, one per subscribed track; Connect
// starts it directly rather than handing the caller a raw
// *webrtc.TrackRemote; a nil cb still drains the track so a caller that
// only wants the video (no OnAudioPacket set) does not leave a buffer
// filling up unread.
func readRTP(track *webrtc.TrackRemote, cb func(*rtp.Packet), onEnded func()) {
	for {
		pkt, _, err := track.ReadRTP()
		if err != nil {
			break
		}
		if cb != nil {
			cb(pkt)
		}
	}
	if onEnded != nil {
		onEnded()
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

// isMicrophone matches a stage speaker's microphone: any participant, not
// just the presenter (unlike isScreenShareVideo/isScreenShareAudio, which
// bind to one presenter's publication). See Handlers.OnMicTrackFound for
// why no further authorization check belongs here.
func isMicrophone(p hasSourceAndKind) bool {
	return p.Kind() == lksdk.TrackKindAudio && p.Source() == livekit.TrackSource_MICROPHONE
}
