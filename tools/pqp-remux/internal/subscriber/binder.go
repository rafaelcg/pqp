package subscriber

// binder decides which screen-share tracks feed the session. It is the whole
// of the rebind policy and nothing else: no LiveKit handle, no lock, no
// goroutine, so every rule below is unit tested (binder_test.go) without a
// room. Session holds one under its own mutex and applies what it answers.
//
// WHY IT EXISTS. Until 2026-09-24 the subscriber bound the FIRST screen-share
// track it saw and never looked at another one for the life of the session.
// A watch party's presenter republishes their screen far more often than that
// allowed for: the web client does it on every resume after an API deploy,
// and again whenever the presenter changes what they share. The replacement
// track was ignored, the session's parts stopped, the watchdog restarted the
// pipeline once, and the second republish in a party demoted it to the
// conventional ladder. And a presenter who came back under a NEW identity (a
// reconnect that could not resume) was a new LL session altogether.
//
// THE RULES.
//
//   - The session follows ONE person, the presenter identity. pqp-api names it
//     (StartSessionRequest.PresenterIdentity, and POST /sessions/:id/rebind
//     when the same person comes back under a new peer id); LiveKit
//     identities are pqp peer ids, so that is exact.
//   - The newest screen-share track from that identity wins. A republish
//     publishes the new track and unpublishes the old one in either order,
//     and in both orders the new one is the one the presenter is looking at.
//   - A track from anyone else is never bound while the presenter is known.
//     A co-host sharing at the same moment must not take over the audience's
//     picture; that is pqp-api's decision (a different presenter is a new
//     session), not this box's.
//   - Named presenter with no track yet (the rebind arrived before the new
//     identity published): keep whatever is bound until theirs arrives, so
//     the picture holds rather than going dark.
//   - No named presenter (an older pqp-api that does not send one): the first
//     track seen is bound, exactly as before, and from then on the session
//     follows THAT identity, so its own republish is picked up too.
//   - Screen-share audio follows the bound video's identity: newest audio
//     track from the same participant, or none.
type binder struct {
	presenter string
	// followed is the identity the session is bound to when no presenter
	// was named: the first track's owner, remembered after that track ends
	// so the same person's republish is recognised.
	followed string

	videos map[string]trackRef
	audios map[string]trackRef
	order  uint64

	activeVideo string // sid, "" for none
	activeAudio string
}

// trackRef is one subscribed screen-share publication as the binder sees it.
type trackRef struct {
	sid      string
	identity string
	order    uint64
}

func newBinder(presenter string) *binder {
	return &binder{
		presenter: presenter,
		videos:    make(map[string]trackRef),
		audios:    make(map[string]trackRef),
	}
}

// addVideo/addAudio register a subscribed track. The caller then asks
// desired() what should be bound.
func (b *binder) addVideo(sid, identity string) {
	b.order++
	b.videos[sid] = trackRef{sid: sid, identity: identity, order: b.order}
}

func (b *binder) addAudio(sid, identity string) {
	b.order++
	b.audios[sid] = trackRef{sid: sid, identity: identity, order: b.order}
}

// remove forgets a track whose RTP stream ended (unpublished, or the
// participant left). If it was bound, nothing is bound in its place until
// desired() says what is.
func (b *binder) remove(sid string) {
	delete(b.videos, sid)
	delete(b.audios, sid)
	if b.activeVideo == sid {
		b.activeVideo = ""
	}
	if b.activeAudio == sid {
		b.activeAudio = ""
	}
}

// setPresenter names the identity to follow from now on.
func (b *binder) setPresenter(identity string) { b.presenter = identity }

// target is the identity the session should be showing, or "" for "whoever
// shares first" (no presenter named and nothing ever bound).
func (b *binder) target() string {
	if b.presenter != "" {
		return b.presenter
	}
	return b.followed
}

// desired answers which video and audio sids should be bound now ("" for
// none), given every track currently subscribed.
func (b *binder) desired() (video, audio string) {
	want := b.target()
	var pick trackRef
	found := false
	for _, t := range b.videos {
		if want == "" {
			// First come: the OLDEST track, which is the one an older
			// subscriber would have bound.
			if !found || t.order < pick.order {
				pick, found = t, true
			}
			continue
		}
		if t.identity == want && (!found || t.order > pick.order) {
			pick, found = t, true
		}
	}
	if found {
		video = pick.sid
	} else if cur, ok := b.videos[b.activeVideo]; ok {
		// The presenter named has not published yet: hold what is showing.
		video = cur.sid
	}

	owner := want
	if v, ok := b.videos[video]; ok {
		owner = v.identity
	}
	var apick trackRef
	afound := false
	for _, t := range b.audios {
		if owner == "" {
			if !afound || t.order < apick.order {
				apick, afound = t, true
			}
			continue
		}
		if t.identity == owner && (!afound || t.order > apick.order) {
			apick, afound = t, true
		}
	}
	if afound {
		audio = apick.sid
	}
	return video, audio
}

// bind records what the caller actually bound, after applying desired().
func (b *binder) bind(video, audio string) {
	b.activeVideo = video
	b.activeAudio = audio
	if v, ok := b.videos[video]; ok && b.presenter == "" && b.followed == "" {
		b.followed = v.identity
	}
}

// identityOf is the owner of a subscribed track, "" if unknown.
func (b *binder) identityOf(sid string) string {
	if t, ok := b.videos[sid]; ok {
		return t.identity
	}
	if t, ok := b.audios[sid]; ok {
		return t.identity
	}
	return ""
}
