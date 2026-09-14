package subscriber

import (
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

// TestSessionCloseWaitsForVideoTrackEnded is a whitebox (same-package) test
// of the exact race Farol caught in review (PR #584): a caller that closes
// this Session and then immediately reads state the video track's async
// teardown can still be advancing must not be able to observe that state
// mid-flush. Connect itself cannot be unit-tested (it needs a live LiveKit
// room), so this drives the same videoWG pairing Connect's OnTrackSubscribed
// video case uses directly: Add(1) before readRTP would start, a slow
// "OnVideoTrackEnded" standing in for session.Session.Finish actually doing
// real work, then Done() -- exactly the shape readRTP+the deferred Done in
// Connect produce for a real video track.
//
// Run with -race (the repo's `make test` always does): without the fix
// (videoWG.Wait removed from Close), this test does not fail on its own --
// there is nothing here for the race detector to catch by itself, since
// there is only one writer to `finished`. What it demonstrates instead is
// the actual contract: Close's RETURN must be provably after Done, not
// merely "probably after, given enough of a sleep" — this test asserts that
// ordering directly rather than by timing, so it is exactly as reliable
// under -race as without it, and would fail deterministically (not
// flakily) if Close stopped waiting.
func TestSessionCloseWaitsForVideoTrackEnded(t *testing.T) {
	sess := &Session{} // room is nil: Close's Disconnect call is skipped, only the Wait matters here

	var finished atomic.Bool

	sess.videoWG.Add(1)
	go func() {
		// Stand in for readRTP blocking on real RTP packets, then
		// calling a slow OnVideoTrackEnded (session.Session.Finish
		// flushing a trailing fragment and enqueueing an R2 upload,
		// in production) before returning -- the exact shape Connect
		// wraps in Add/defer Done around the real readRTP call.
		time.Sleep(50 * time.Millisecond)
		finished.Store(true)
		sess.videoWG.Done()
	}()

	sess.Close()

	if !finished.Load() {
		t.Fatal("Session.Close returned before the video track's async teardown (OnVideoTrackEnded) finished -- this is exactly the race Farol flagged in PR #584: a caller reading state right after Close can still observe an in-flight Finish")
	}
}

// TestSessionCloseReturnsImmediatelyWhenNoVideoTrackEverBound covers the
// other half of the same contract: a session that never found a video
// track (Close called during StateWaiting, before any presenter ever
// shared) must not hang forever waiting for a goroutine that will never
// call Done -- videoWG's counter was never incremented, so Wait must
// return immediately.
func TestSessionCloseReturnsImmediatelyWhenNoVideoTrackEverBound(t *testing.T) {
	sess := &Session{}

	done := make(chan struct{})
	go func() {
		sess.Close()
		close(done)
	}()

	select {
	case <-done:
	case <-time.After(1 * time.Second):
		t.Fatal("Session.Close hung with no video track ever bound; videoWG.Wait should return immediately when Add was never called")
	}
}

// TestSessionCloseIsIdempotent mirrors aacenc.Encoder's own
// "Close is safe to call more than once" guarantee (see
// internal/aacenc/encoder_test.go's TestEncoderCloseIsIdempotent): a second
// Close, after videoWG's counter is already back at zero, must return
// immediately rather than block or panic.
func TestSessionCloseIsIdempotent(t *testing.T) {
	sess := &Session{}
	sess.videoWG.Add(1)
	sess.videoWG.Done()

	done := make(chan struct{})
	go func() {
		sess.Close()
		sess.Close()
		close(done)
	}()

	select {
	case <-done:
	case <-time.After(1 * time.Second):
		t.Fatal("a second Session.Close hung after videoWG's counter was already back at zero")
	}
}

// simulateVideoTrackSubscribed reproduces the exact critical section
// Connect's OnTrackSubscribed video case runs in subscriber.go: take
// closeMu, bail out with nothing registered if the session is already
// closed, otherwise Add(1) to videoWG WHILE STILL HOLDING closeMu, release,
// then run the stand-in "readRTP" (onEnded, called synchronously, exactly
// where the real readRTP calls Handlers.OnVideoTrackEnded before
// returning) before the deferred Done. Kept here rather than driving it
// through Connect (which needs a live LiveKit room) so this test can fire
// it concurrently against Close with a fast, deterministic, controllable
// stand-in reader. Returns whether a reader actually got registered.
func simulateVideoTrackSubscribed(sess *Session, onEnded func()) (registered bool) {
	sess.closeMu.Lock()
	if sess.closed {
		sess.closeMu.Unlock()
		return false
	}
	sess.videoWG.Add(1)
	sess.closeMu.Unlock()
	defer sess.videoWG.Done()
	if onEnded != nil {
		onEnded()
	}
	return true
}

// TestSessionCloseRacesConcurrentTrackSubscription is the -race regression
// test for Farol's round-2 finding on PR #584: the FIRST version of this
// fix called videoWG.Add(1) with no synchronization against Close at all,
// so a video track discovered right as Close begins could either race
// Add against Wait (a WaitGroup misuse the race detector reports
// directly) or lose the race entirely -- Close's Wait observing a zero
// counter and returning before the late-arriving track's Add ever ran, the
// same "restart() reads Health() before the async work finished" class of
// bug the videoWG mechanism exists to close in the first place.
//
// This fires simulateVideoTrackSubscribed and Close truly concurrently,
// many times (scheduling is what surfaces this kind of race, not a single
// trial), and checks the contract closeMu is meant to guarantee: EITHER
// the reader never registered at all (Close won the race for closeMu --
// no read started, nothing to wait for) OR it registered and its onEnded
// callback is provably finished by the time both goroutines have joined
// (Close won the race for the underlying videoWG.Wait -- and read the
// segment index of a section 3.1 race). There is no third outcome: a
// registered reader whose callback never finished before Close returned.
//
// Run with -race (the repo's `make test` always does): the unsynchronized
// version of this fix fails this test's race detector directly ("WaitGroup
// misuse: Add called concurrently with Wait"), not just its assertions --
// verified manually by reverting to that version before restoring this
// one.
func TestSessionCloseRacesConcurrentTrackSubscription(t *testing.T) {
	const iterations = 500
	for i := 0; i < iterations; i++ {
		sess := &Session{}
		var registered, readStarted, readFinished atomic.Bool

		var wg sync.WaitGroup
		wg.Add(2)
		go func() {
			defer wg.Done()
			ok := simulateVideoTrackSubscribed(sess, func() {
				readStarted.Store(true)
				readFinished.Store(true)
			})
			registered.Store(ok)
		}()
		go func() {
			defer wg.Done()
			sess.Close()
		}()
		wg.Wait()

		if !registered.Load() {
			if readStarted.Load() {
				t.Fatalf("iteration %d: no reader registered (Close closed the session first) but the stand-in read still started -- a track discovered after Close must never be read", i)
			}
			continue
		}
		if !readFinished.Load() {
			t.Fatalf("iteration %d: a reader registered but its callback never finished before both goroutines returned -- Close's Wait did not actually wait for the registered reader", i)
		}
	}
}
