package subscriber

import (
	"errors"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/pion/rtp"
)

// --- the policy, on its own ---

func TestBinder_FirstComeWithNoPresenterThenFollowsThatPerson(t *testing.T) {
	b := newBinder("")
	b.addVideo("TR_a1", "alice")
	b.addVideo("TR_b1", "bob")
	v, _ := b.desired()
	if v != "TR_a1" {
		t.Fatalf("no presenter named: bound %q, want the first track seen (TR_a1)", v)
	}
	b.bind(v, "")
	// Alice republishes: the new track wins, whether or not the old one has
	// gone yet.
	b.addVideo("TR_a2", "alice")
	if v, _ := b.desired(); v != "TR_a2" {
		t.Fatalf("alice republished: bound %q, want TR_a2", v)
	}
	b.bind("TR_a2", "")
	b.remove("TR_a1")
	b.remove("TR_a2")
	// Alice stopped entirely. Bob is sharing, but the session follows alice:
	// a different person is pqp-api's decision to make, not this box's.
	if v, _ := b.desired(); v != "" {
		t.Fatalf("alice gone: bound %q, want nothing (bob is someone else)", v)
	}
	b.bind("", "")
	b.addVideo("TR_a3", "alice")
	if v, _ := b.desired(); v != "TR_a3" {
		t.Fatalf("alice back: bound %q, want TR_a3", v)
	}
}

func TestBinder_NamedPresenterIsNeverSomebodyElse(t *testing.T) {
	b := newBinder("peer-1")
	b.addVideo("TR_x", "cohost")
	if v, _ := b.desired(); v != "" {
		t.Fatalf("presenter named, only a co-host sharing: bound %q, want nothing", v)
	}
	b.addVideo("TR_p", "peer-1")
	v, _ := b.desired()
	if v != "TR_p" {
		t.Fatalf("bound %q, want the presenter's TR_p", v)
	}
	b.bind(v, "")
}

func TestBinder_ReconnectHoldsThePictureUntilTheNewIdentityPublishes(t *testing.T) {
	b := newBinder("peer-1")
	b.addVideo("TR_1", "peer-1")
	b.bind("TR_1", "")
	// pqp-api says the same person is now peer-2, before peer-2 has
	// published anything: keep showing peer-1's share.
	b.setPresenter("peer-2")
	if v, _ := b.desired(); v != "TR_1" {
		t.Fatalf("rebind before the new identity published: bound %q, want TR_1 held", v)
	}
	b.addVideo("TR_2", "peer-2")
	if v, _ := b.desired(); v != "TR_2" {
		t.Fatalf("new identity published: bound %q, want TR_2", v)
	}
	b.bind("TR_2", "")
	// And the old identity's late republish (a ghost socket) is ignored.
	b.addVideo("TR_1b", "peer-1")
	if v, _ := b.desired(); v != "TR_2" {
		t.Fatalf("old identity republished after the rebind: bound %q, want TR_2", v)
	}
}

func TestBinder_AudioFollowsTheBoundVideosOwner(t *testing.T) {
	b := newBinder("peer-1")
	b.addAudio("TR_a_cohost", "cohost")
	b.addVideo("TR_v1", "peer-1")
	b.addAudio("TR_a1", "peer-1")
	v, a := b.desired()
	if v != "TR_v1" || a != "TR_a1" {
		t.Fatalf("bound video %q audio %q, want TR_v1/TR_a1", v, a)
	}
	b.bind(v, a)
	b.addAudio("TR_a2", "peer-1")
	if _, a := b.desired(); a != "TR_a2" {
		t.Fatalf("republished audio: bound %q, want TR_a2", a)
	}
	b.remove("TR_a1")
	b.remove("TR_a2")
	if _, a := b.desired(); a != "" {
		t.Fatalf("presenter's audio gone: bound %q, want nothing (never the co-host's)", a)
	}
}

// --- the switching, with fake tracks ---

// fakeTrack is an RTP source a test can push into and end.
type fakeTrack struct {
	ch chan *rtp.Packet
}

func newFakeTrack() *fakeTrack { return &fakeTrack{ch: make(chan *rtp.Packet, 64)} }

func (f *fakeTrack) read() (*rtp.Packet, error) {
	p, ok := <-f.ch
	if !ok {
		return nil, errors.New("track ended")
	}
	return p, nil
}

func (f *fakeTrack) end() { close(f.ch) }

// recorder notes, in order, every packet delivered and every source change.
type recorder struct {
	mu     sync.Mutex
	events []string
}

func (r *recorder) note(e string) {
	r.mu.Lock()
	r.events = append(r.events, e)
	r.mu.Unlock()
}

func (r *recorder) snapshot() []string {
	r.mu.Lock()
	defer r.mu.Unlock()
	return append([]string(nil), r.events...)
}

func waitUntil(t *testing.T, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	for !cond() {
		if time.Now().After(deadline) {
			t.Fatal("condition never became true")
		}
		time.Sleep(2 * time.Millisecond)
	}
}

func startReader(s *Session, sid, identity string, tr *fakeTrack, video bool) {
	go s.readScreenTrack(sid, identity, screenTrack{}, tr.read, video)
}

// TestSession_RepublishSwitchesTheStreamWithNoOldPacketAfterTheChange is the
// production shape of 2026-09-24: the presenter's client republishes the
// screen on a new track, the old one ends a moment later. The session must
// be told the stream changed, and after that it must never see a packet of
// the old track again (internal/session would feed it to a depacketizer
// that has just been reset for the new one).
func TestSession_RepublishSwitchesTheStreamWithNoOldPacketAfterTheChange(t *testing.T) {
	rec := &recorder{}
	var changes atomic.Int32
	s := newSession(Config{PresenterIdentity: "peer-1"}, Handlers{
		OnVideoPacket:        func(p *rtp.Packet) { rec.note("pkt:" + string(rune('A'+p.SSRC))) },
		OnVideoSourceChanged: func() { changes.Add(1); rec.note("change") },
	})
	old := newFakeTrack()
	startReader(s, "TR_1", "peer-1", old, true)
	waitUntil(t, func() bool { return changes.Load() == 1 })
	old.ch <- &rtp.Packet{Header: rtp.Header{SSRC: 0}}
	waitUntil(t, func() bool { return len(rec.snapshot()) == 2 })

	repl := newFakeTrack()
	startReader(s, "TR_2", "peer-1", repl, true)
	waitUntil(t, func() bool { return changes.Load() == 2 })
	// The old track is still up for a moment and still sending: dropped.
	for i := 0; i < 20; i++ {
		old.ch <- &rtp.Packet{Header: rtp.Header{SSRC: 0}}
		repl.ch <- &rtp.Packet{Header: rtp.Header{SSRC: 1}}
	}
	old.end()
	waitUntil(t, func() bool {
		n := 0
		for _, e := range rec.snapshot() {
			if e == "pkt:B" {
				n++
			}
		}
		return n == 20
	})
	events := rec.snapshot()
	seenSecondChange := false
	changesSeen := 0
	for _, e := range events {
		switch e {
		case "change":
			changesSeen++
			seenSecondChange = changesSeen == 2
		case "pkt:A":
			if seenSecondChange {
				t.Fatalf("a packet of the replaced track reached the session after the change: %v", events)
			}
		case "pkt:B":
			if !seenSecondChange {
				t.Fatalf("a packet of the new track reached the session before the change: %v", events)
			}
		}
	}
	if got := s.Rebinds(); got != 1 {
		t.Fatalf("Rebinds() = %d, want 1", got)
	}
	repl.end()
	s.Close()
}

// TestSession_SetPresenterBindsAnAlreadySubscribedTrack: the reconnected
// presenter's track can be subscribed BEFORE pqp-api's rebind arrives (it is
// simply unbound until then), and the rebind must pick it up at once.
func TestSession_SetPresenterBindsAnAlreadySubscribedTrack(t *testing.T) {
	var changes atomic.Int32
	var delivered atomic.Int32
	s := newSession(Config{PresenterIdentity: "peer-1"}, Handlers{
		OnVideoPacket:        func(*rtp.Packet) { delivered.Add(1) },
		OnVideoSourceChanged: func() { changes.Add(1) },
	})
	first := newFakeTrack()
	startReader(s, "TR_1", "peer-1", first, true)
	waitUntil(t, func() bool { return changes.Load() == 1 })
	first.end() // the old socket went away with its track

	next := newFakeTrack()
	startReader(s, "TR_2", "peer-2", next, true)
	next.ch <- &rtp.Packet{}
	time.Sleep(20 * time.Millisecond)
	if delivered.Load() != 0 || changes.Load() != 1 {
		t.Fatalf("an unnamed identity's track was bound before the rebind (delivered=%d changes=%d)", delivered.Load(), changes.Load())
	}
	if got := s.SetPresenter("peer-2"); got != BindBound {
		t.Fatalf("SetPresenter = %q, want %q", got, BindBound)
	}
	if got := s.SetPresenter("peer-2"); got != BindUnchanged {
		t.Fatalf("second SetPresenter = %q, want %q", got, BindUnchanged)
	}
	next.ch <- &rtp.Packet{}
	waitUntil(t, func() bool { return delivered.Load() == 1 })
	if got := s.SetPresenter("peer-3"); got != BindWaiting {
		t.Fatalf("SetPresenter for an identity with no track = %q, want %q", got, BindWaiting)
	}
	next.end()
	s.Close()
}

func TestSession_ScreenAudioReplacementIsAnnouncedOnlyForAReplacement(t *testing.T) {
	var swaps atomic.Int32
	s := newSession(Config{PresenterIdentity: "peer-1"}, Handlers{
		OnScreenAudioChanged: func() { swaps.Add(1) },
	})
	v := newFakeTrack()
	a1 := newFakeTrack()
	startReader(s, "TR_v", "peer-1", v, true)
	startReader(s, "TR_a1", "peer-1", a1, false)
	waitUntil(t, func() bool { s.mu.Lock(); defer s.mu.Unlock(); return s.activeAudio == "TR_a1" })
	if swaps.Load() != 0 {
		t.Fatal("the first screen-audio track was announced as a replacement")
	}
	a2 := newFakeTrack()
	startReader(s, "TR_a2", "peer-1", a2, false)
	waitUntil(t, func() bool { return swaps.Load() == 1 })
	v.end()
	a1.end()
	a2.end()
	s.Close()
}
