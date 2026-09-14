package subscriber

import (
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
