// Package subscriber joins a LiveKit room as a hidden, publish-nothing
// participant and hands the presenter's screen-share RTP packets to the
// caller. It never decodes a frame: this is the WebRTC plumbing L1.1 calls
// for, everything downstream of an *rtp.Packet is internal/h264 and
// internal/pipeline's job.
//
// Which screen-share track feeds the caller is binder.go's decision, and it
// can change inside one session (a republish, a presenter back under a new
// identity): see Handlers.OnVideoSourceChanged and Session.SetPresenter.
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
	// PresenterIdentity is the LiveKit identity (a pqp peer id) whose screen
	// share this session shows. Empty means "whoever shares first, and then
	// that same person", which is what every session did before pqp-api
	// started naming one. See binder.go.
	PresenterIdentity string
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
	// OnVideoTrackFound/OnAudioTrackFound fire every time a screen-share
	// track is BOUND (the first, and each replacement), before any of its
	// packets: this is where a caller building an idr-log or a keyframe
	// requester gets the participant + track handle it needs.
	OnVideoTrackFound func(s *Session)
	OnAudioTrackFound func(s *Session)
	// OnVideoSourceChanged fires, with no video packet in flight, every
	// time the bound screen-share video track changes to another one:
	// the packets OnVideoPacket receives after it come from a different RTP
	// stream (new SSRC, new sequence numbers, a new timestamp base) than
	// the ones before. internal/session.Session.BeginVideoSource is what
	// production passes. It also fires for the session's first track; the
	// callee tells the two apart. Nil is fine for a caller that only ever
	// expects one stream.
	OnVideoSourceChanged func()
	// OnScreenAudioChanged is OnVideoSourceChanged's twin for the
	// screen-share audio track (internal/session.Session.ReplaceScreenAudio).
	// It fires only for a replacement, not for the first audio track.
	OnScreenAudioChanged func()
	// OnMicTrackFound fires once per participant microphone publication
	// subscribed: every stage speaker's microphone, not just the
	// presenter's. LiveKit's own SPEAK grant is what gates who can
	// publish a microphone at all (liveKitPublishGrant, server-side), so
	// every mic track this process ever sees already is a stage speaker.
	// identity is the publishing participant's LiveKit identity (their peer
	// id), stable for that publication's lifetime. Multiple microphones may
	// be found concurrently; each gets its own AudioSink and its own
	// RTP-reading goroutine. A nil OnMicTrackFound means every microphone
	// track is drained and discarded.
	OnMicTrackFound func(identity string) AudioSink
	// OnVideoTrackEnded fires ONCE, when the session closes (Session.Close),
	// if any screen-share video track was ever bound: the caller's signal to
	// flush a trailing partial CMAF fragment (session.Session.Finish exists
	// for exactly this).
	//
	// It used to fire when the bound track's read loop returned, which was
	// also the end of the session in practice, because nothing was ever
	// bound after it. Now a track ending mid-session is a presenter between
	// two shares, and flushing the fragmenter there would end a segment the
	// replacement has to continue; the keep-alive publishes the held frame
	// in the meantime (internal/session's idleTick).
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

// screenTrack is one subscribed screen-share publication, bound or not.
type screenTrack struct {
	participant *lksdk.RemoteParticipant
	pub         *lksdk.RemoteTrackPublication
}

// setEnabled asks the SFU to forward (or stop forwarding) this track's media
// to us. A no-op without a real publication (tests).
func (t screenTrack) setEnabled(on bool) {
	if t.pub != nil {
		t.pub.SetEnabled(on)
	}
}

// Session is a live hidden-subscriber connection to one room.
type Session struct {
	room *lksdk.Room
	cfg  Config
	h    Handlers

	// mu guards the binder and the tracks map: which screen-share tracks
	// exist and which of them is bound. Never held while a packet is
	// delivered.
	mu     sync.Mutex
	b      *binder
	tracks map[string]screenTrack
	// enabled is whether each subscribed screen-share track is currently
	// being forwarded to us. Only the bound ones are: a co-host's share, or
	// the presenter's old track while it lingers, stays subscribed (so a
	// rebind can bind it at once) but disabled, so the SFU sends it no media
	// and this box pays nothing for it (Farol review, PR #813). Guarded by mu.
	enabled map[string]bool

	// switchMu is what makes a rebind atomic with respect to packets.
	// Every screen-share reader holds it for READ around one packet's
	// check-and-deliver; a rebind holds it for WRITE while it changes the
	// bound sid AND tells the caller (OnVideoSourceChanged), so no packet
	// of the old track can reach OnVideoPacket after the caller has been
	// told the stream changed, and none of the new one before. Lock order:
	// mu, then switchMu, then whatever the callbacks take
	// (internal/session's videoMu); a reader holds only switchMu.
	switchMu    sync.RWMutex
	activeVideo string
	activeAudio string

	// video is the bound screen share, for RequestKeyframe/VideoSSRC.
	video atomic.Pointer[videoBinding]
	// videoEverBound says OnVideoTrackEnded is owed at Close.
	videoEverBound atomic.Bool
	rebinds        atomic.Uint64
	// audioEverBound says a screen-share audio track has been bound before,
	// so the next one is a replacement (OnScreenAudioChanged). Guarded by mu.
	audioEverBound bool

	// closeMu pairs "am I closed" with "register a screen-share reader"
	// into one atomic decision (Farol review round 2, PR #584): readersWG.Add
	// runs under it, strictly before Close's Wait can observe a zero
	// counter, or never at all once closed is set.
	closeMu sync.Mutex
	closed  bool
	// readersWG is held for every screen-share reader's entire read loop.
	// Close waits on it after disconnecting, and only then fires
	// OnVideoTrackEnded, which is what makes "Close returned" mean "the
	// video track's teardown, callback included, is fully done" (Farol
	// review, PR #584; restart() in internal/control reads the old
	// pipeline's final indices the instant Close returns).
	readersWG   sync.WaitGroup
	endedOnce   sync.Once
	onEndedHook func()
}

// VideoSSRC returns the bound screen-share video track's SSRC, for a
// caller that wants to send a PLI directly (see RequestKeyframe, which does
// this for you); ok is false while nothing is bound.
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

// RequestKeyframe sends one RTCP PLI for the bound screen-share video
// track: the only lever section 3 of the plan found for asking a WebRTC
// publisher for an IDR. A no-op while nothing is bound.
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

// Rebinds is how many times the bound screen-share video track was replaced
// by another inside this session (the first bind is not counted).
func (s *Session) Rebinds() uint64 { return s.rebinds.Load() }

// BindResult is SetPresenter's answer.
type BindResult string

const (
	// BindUnchanged: the presenter's newest screen track was already bound.
	BindUnchanged BindResult = "unchanged"
	// BindBound: a screen track from the presenter was bound by this call.
	BindBound BindResult = "bound"
	// BindWaiting: the presenter has no screen track in the room yet; it is
	// bound the moment one is subscribed, and whatever is showing keeps
	// showing until then.
	BindWaiting BindResult = "waiting"
)

// SetPresenter names the identity this session follows from now on and
// binds that identity's newest screen share if one is already subscribed:
// POST /sessions/:id/rebind, for a presenter who came back under a new peer
// id. Idempotent.
func (s *Session) SetPresenter(identity string) BindResult {
	s.mu.Lock()
	defer s.mu.Unlock()
	before := s.b.activeVideo
	s.b.setPresenter(identity)
	s.reconcileLocked()
	after := s.b.activeVideo
	switch {
	case after == "" || s.b.identityOf(after) != identity:
		return BindWaiting
	case after == before:
		return BindUnchanged
	default:
		return BindBound
	}
}

// Presenter is the identity currently followed ("" before any is named and
// before a first track was bound).
func (s *Session) Presenter() string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.b.target()
}

// Close disconnects from the room, waits for every screen-share reader to
// finish, and then -- once, and only if a screen-share video track was ever
// bound -- calls Handlers.OnVideoTrackEnded, before returning. Safe to call
// more than once.
//
// closed is set FIRST, under closeMu, before Disconnect and before Wait
// (Farol review round 2, PR #584): a reader registers (readersWG.Add) under
// the same mutex, so every Add either fully precedes Wait or never happens.
//
// Do not call Close from inside a Handlers callback that a reader invokes:
// it would wait on its own caller.
func (s *Session) Close() {
	s.closeMu.Lock()
	s.closed = true
	s.closeMu.Unlock()

	if s.room != nil {
		s.room.Disconnect()
	}
	s.readersWG.Wait()
	if s.videoEverBound.Load() {
		s.endedOnce.Do(func() {
			if s.onEndedHook != nil {
				s.onEndedHook()
			}
		})
	}
}

var errMissingConfig = errors.New("subscriber: URL, APIKey, APISecret and Room are all required")

func newSession(cfg Config, h Handlers) *Session {
	return &Session{
		cfg:         cfg,
		h:           h,
		b:           newBinder(cfg.PresenterIdentity),
		tracks:      make(map[string]screenTrack),
		enabled:     make(map[string]bool),
		onEndedHook: h.OnVideoTrackEnded,
	}
}

// Connect joins cfg.Room as a hidden (Hidden: true), publish-nothing,
// subscribe-only participant, and wires h up to the presenter's
// screen-share video track and (if present) its screen-share audio track.
// It returns once the room connection itself succeeds; tracks are found
// asynchronously as OnTrackSubscribed fires; h.OnVideoTrackFound tells the
// caller when one has been bound.
func Connect(cfg Config, h Handlers) (*Session, error) {
	if cfg.URL == "" || cfg.APIKey == "" || cfg.APISecret == "" || cfg.Room == "" {
		return nil, errMissingConfig
	}

	token, err := buildToken(cfg)
	if err != nil {
		return nil, fmt.Errorf("subscriber: building the hidden-subscriber token: %w", err)
	}

	sess := newSession(cfg, h)

	cb := lksdk.NewRoomCallback()
	cb.OnTrackSubscribed = func(track *webrtc.TrackRemote, pub *lksdk.RemoteTrackPublication, rp *lksdk.RemoteParticipant) {
		switch {
		case isScreenShareVideo(pub), isScreenShareAudio(pub):
			sid := pub.SID()
			if sid == "" {
				sid = track.ID()
			}
			read := func() (*rtp.Packet, error) {
				pkt, _, err := track.ReadRTP()
				return pkt, err
			}
			sess.readScreenTrack(sid, rp.Identity(), screenTrack{participant: rp, pub: pub}, read, isScreenShareVideo(pub))
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

// readScreenTrack runs one screen-share track (video or audio) for as long
// as it is published: registers it with the binder, reads every packet and
// delivers the ones from the bound track, and on the way out lets the binder
// pick whatever should be bound instead. Every screen-share track is read,
// bound or not, so an unbound one never backs a receive buffer up; the SFU
// forwards media only for the bound ones (reconcileLocked's SetEnabled), so
// reading an unbound one costs nothing while it stays unbound.
//
// read is the track's ReadRTP; a function rather than the *webrtc.TrackRemote
// so the switching can be tested without a room (rebind_test.go).
func (s *Session) readScreenTrack(sid, identity string, st screenTrack, read func() (*rtp.Packet, error), video bool) {
	s.closeMu.Lock()
	if s.closed {
		s.closeMu.Unlock()
		return
	}
	s.readersWG.Add(1)
	s.closeMu.Unlock()
	defer s.readersWG.Done()

	s.mu.Lock()
	s.tracks[sid] = st
	if video {
		s.b.addVideo(sid, identity)
	} else {
		s.b.addAudio(sid, identity)
	}
	s.reconcileLocked()
	s.mu.Unlock()

	deliver := s.h.OnAudioPacket
	if video {
		deliver = s.h.OnVideoPacket
	}
	for {
		pkt, err := read()
		if err != nil {
			break
		}
		s.switchMu.RLock()
		bound := s.activeAudio == sid
		if video {
			bound = s.activeVideo == sid
		}
		if bound && deliver != nil {
			deliver(pkt)
		}
		s.switchMu.RUnlock()
	}

	s.closeMu.Lock()
	closing := s.closed
	s.closeMu.Unlock()

	s.mu.Lock()
	defer s.mu.Unlock()
	wasBound := s.b.activeVideo == sid || s.b.activeAudio == sid
	delete(s.tracks, sid)
	delete(s.enabled, sid)
	s.b.remove(sid)
	if closing {
		// The session is being torn down and every track is ending with
		// it: nothing is to be bound in anything's place.
		return
	}
	if wasBound {
		kind := "audio"
		if video {
			kind = "video"
		}
		log.Printf("subscriber: bound screen-share %s track %s from %q ended in room %q; waiting for a replacement", kind, sid, identity, s.cfg.Room)
	}
	s.reconcileLocked()
}

// reconcileLocked applies the binder's answer: switches the bound video
// and audio track when it changed, with no packet of either in flight, and
// then does the per-bind work (pin the top simulcast layer, ask for a
// keyframe, tell the caller). Called with mu held.
func (s *Session) reconcileLocked() {
	wantV, wantA := s.b.desired()
	s.b.bind(wantV, wantA)
	// Forward only what is bound. A track is subscribed from the moment it
	// is published (auto-subscribe), which is what lets a rebind bind it
	// without a round trip; disabling the rest is what keeps that from
	// costing the box a second stream's bandwidth and reader work.
	for sid, t := range s.tracks {
		want := sid == wantV || sid == wantA
		if on, known := s.enabled[sid]; !known || on != want {
			t.setEnabled(want)
			s.enabled[sid] = want
		}
	}
	videoChanged := wantV != s.activeVideo
	audioChanged := wantA != s.activeAudio
	if !videoChanged && !audioChanged {
		return
	}
	newV := s.tracks[wantV]
	firstVideo := !s.videoEverBound.Load()
	audioReplaced := audioChanged && wantA != "" && s.audioEverBound

	s.switchMu.Lock()
	s.activeVideo, s.activeAudio = wantV, wantA
	if videoChanged {
		if wantV != "" {
			s.video.Store(&videoBinding{participant: newV.participant, pub: newV.pub})
			if s.h.OnVideoSourceChanged != nil {
				s.h.OnVideoSourceChanged()
			}
		} else {
			s.video.Store(nil)
		}
	}
	if audioReplaced && s.h.OnScreenAudioChanged != nil {
		s.h.OnScreenAudioChanged()
	}
	s.switchMu.Unlock()

	if audioChanged && wantA != "" {
		s.audioEverBound = true
		log.Printf("subscriber: bound screen-share audio track %s from %q in room %q (replacement=%t)", wantA, s.b.identityOf(wantA), s.cfg.Room, audioReplaced)
		if s.h.OnAudioTrackFound != nil {
			s.h.OnAudioTrackFound(s)
		}
	}
	if !videoChanged || wantV == "" {
		return
	}
	s.videoEverBound.Store(true)
	n := uint64(0)
	if !firstVideo {
		n = s.rebinds.Add(1)
	}
	log.Printf("subscriber: bound screen-share video track %s from %q in room %q (rebind %d)", wantV, s.b.identityOf(wantV), s.cfg.Room, n)
	// PIN THE TOP SIMULCAST LAYER. A watch-party screen share is
	// published as simulcast with dynacast on (client
	// livekit-session.ts), and this is a passive "hidden" subscriber that
	// otherwise expresses no quality preference. With dynacast, the SFU
	// pauses or downgrades any layer no subscriber has asked for at HIGH,
	// so whichever layer it settles on is what this subscriber is fed --
	// and it flips between layers, changing the resolution (and therefore
	// the H.264 parameter set) under us. Every flip is a new init segment,
	// and an HLS viewer's decoder dies on that churn (production channel
	// d5559e70, 2026-09-16: 11 resolution changes in 46 minutes). Asking
	// for HIGH keeps the top, size-pinned layer always live and
	// forwarded. Best-effort: a non-simulcast track makes this a harmless
	// no-op on the SFU side, so a failure here is logged, not fatal. Every
	// bound track needs it, a replacement as much as the first.
	if newV.pub != nil {
		if err := newV.pub.SetVideoQuality(livekit.VideoQuality_HIGH); err != nil {
			log.Printf("subscriber: could not pin screen-share to HIGH quality in room %q: %v", s.cfg.Room, err)
		}
	}
	if s.h.OnVideoTrackFound != nil {
		s.h.OnVideoTrackFound(s)
	}
	// A replacement's first keyframe is what the session is waiting for;
	// the SFU asks the publisher for one on a new subscription anyway, and
	// one PLI more costs nothing.
	s.RequestKeyframe()
}

// readRTP blocks reading RTP packets off track and forwards each to cb,
// until the track ends (the publisher stopped publishing, or the session
// disconnected), then calls onEnded exactly once if it is non-nil. Used for
// microphones; screen-share tracks go through readScreenTrack. A nil cb
// still drains the track so an unread buffer never fills up.
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
