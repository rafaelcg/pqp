import XCTest
@testable import pqp

/**
 What a moderator's mute does to the person it lands on, as pure rules.

 The receiving half lives in `RemoteAudioTests` (the mixer plays them at zero
 and leaves the slider alone). This file is the target's half: the control
 goes off, the mic goes off, and the two glyphs stay two glyphs. Kept as
 functions on `ServerMute` so `VoiceModel` and `CallModel` read one rule
 rather than each re-deriving it by eye, and so the unit-test target, which
 cannot open a microphone, can pin it.
 */
final class ServerMuteTests: XCTestCase {
    /// The server refuses the target's `set-muted false` and snaps the roster
    /// back, so the button must not pretend. A button that toggles and
    /// un-toggles itself reads as a bug rather than a mute.
    func testSelfServerMutedDisablesTheUnmuteControl() {
        XCTAssertFalse(ServerMute.muteControlIsEnabled(connected: true, selfServerMuted: true))
        XCTAssertTrue(ServerMute.muteControlIsEnabled(connected: true, selfServerMuted: false))
    }

    /// The room's own gate still applies: a voice channel that has not been
    /// welcomed yet keeps every control off whatever the roster says.
    func testAnUnconnectedRoomKeepsTheControlOff() {
        XCTAssertFalse(ServerMute.muteControlIsEnabled(connected: false, selfServerMuted: false))
        XCTAssertFalse(ServerMute.muteControlIsEnabled(connected: false, selfServerMuted: true))
    }

    /// Muted by a moderator means the mic goes off, whatever we had chosen: on
    /// mesh our own client is the only thing that can stop the bytes leaving,
    /// and every receiver is already playing us at zero.
    func testBeingServerMutedMutesTheMicrophone() {
        XCTAssertTrue(ServerMute.selfMuted(currentlyMuted: false, serverMuted: true))
        XCTAssertTrue(ServerMute.selfMuted(currentlyMuted: true, serverMuted: true))
    }

    /// The flag clearing does NOT unmute. Coming back live the instant a
    /// moderator lets go would put whatever is being said mid-sentence into
    /// the room; unmuting is the person's own tap, which the re-enabled
    /// control now allows.
    func testTheFlagClearingLeavesTheMicrophoneWhereItWas() {
        XCTAssertTrue(ServerMute.selfMuted(currentlyMuted: true, serverMuted: false))
        XCTAssertFalse(ServerMute.selfMuted(currentlyMuted: false, serverMuted: false))
    }

    /// "They stepped away" and "they were silenced" are different facts, and a
    /// room that draws them the same cannot tell them apart.
    func testTheModeratorGlyphIsNotTheSelfMutedGlyph() {
        XCTAssertNotEqual(ServerMute.glyph, ServerMute.selfMutedGlyph)
    }

    /// The notice is copy, and copy is looked up rather than shown verbatim.
    func testTheNoticeIsNonEmpty() {
        XCTAssertFalse(ServerMute.notice.isEmpty)
    }
}
