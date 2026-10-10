import XCTest
@testable import pqp

/**
 The mesh client makes a new microphone track on every join and every socket
 reconnect, and a new track is enabled. The mute (and deafen) the person chose
 must survive that, or a muted phone is audible while the roster says muted.
 */
final class LocalMicrophoneStateTests: XCTestCase {
    func testAFreshStateSendsAudio() {
        XCTAssertTrue(LocalMicrophoneState().trackEnabled)
    }

    func testMutedKeepsTheTrackOffForEveryNewTrack() {
        var state = LocalMicrophoneState()
        state.muted = true
        // The value `startAudio` writes onto a track it has just created,
        // which is what a reconnect does. It must not depend on a later
        // `setMuted` call.
        XCTAssertFalse(state.trackEnabled)
    }

    func testDeafenedKeepsTheTrackOffEvenIfUnmuted() {
        var state = LocalMicrophoneState()
        state.deafened = true
        XCTAssertFalse(state.trackEnabled)
    }

    func testUnmutingWhileDeafenedStaysSilent() {
        var state = LocalMicrophoneState(muted: true, deafened: true)
        state.muted = false
        XCTAssertFalse(state.trackEnabled)
    }

    func testUndeafeningDoesNotUnmute() {
        var state = LocalMicrophoneState(muted: true, deafened: true)
        state.deafened = false
        XCTAssertFalse(state.trackEnabled)
    }

    func testBothClearedSendsAudio() {
        var state = LocalMicrophoneState(muted: true, deafened: true)
        state.muted = false
        state.deafened = false
        XCTAssertTrue(state.trackEnabled)
    }
}
