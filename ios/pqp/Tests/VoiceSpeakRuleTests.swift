import XCTest
@testable import pqp

/// The SPEAK rule, pinned against `applySpeakRule` in
/// `client/src/hooks/use-voice.ts`. The two clients meet in the same call, so
/// they must agree on what a listen-only seat does with its own media.
final class VoiceSpeakRuleTests: XCTestCase {

    // MARK: - Where the bit is read from

    func testTopLevelWinsOverSelf() {
        XCTAssertFalse(VoiceSpeakRule.resolve(topLevel: false, selfPeer: true))
        XCTAssertTrue(VoiceSpeakRule.resolve(topLevel: true, selfPeer: false))
    }

    func testSelfIsTheFallback() {
        XCTAssertFalse(VoiceSpeakRule.resolve(topLevel: nil, selfPeer: false))
        XCTAssertTrue(VoiceSpeakRule.resolve(topLevel: nil, selfPeer: true))
    }

    /// Absent on both is a server that predates SPEAK enforcement, where
    /// everyone could speak. Refusing there would mute every self-host.
    func testAbsentEverywhereIsAllowed() {
        XCTAssertTrue(VoiceSpeakRule.resolve(topLevel: nil, selfPeer: nil))
    }

    // MARK: - What a denial does

    /// A listen-only welcome mutes, publishes nothing, and says so once.
    func testDeniedOnWelcomeMutesAndExplains() {
        let outcome = VoiceSpeakRule.apply(
            canSpeak: false, canStream: false, wasSpeak: true, wasStream: true, source: .welcome
        )
        XCTAssertEqual(outcome, VoiceSpeakRule.Outcome(
            canSpeak: false, canStream: false, mute: true, stopPublishing: true, notice: .listenOnly
        ))
    }

    /// A revoke mid-call is the safety half: the mic closes and any share or
    /// camera comes down, because the roster no longer carries them.
    func testRevokedMidCallMutesAndExplains() {
        let outcome = VoiceSpeakRule.apply(
            canSpeak: false, canStream: false, wasSpeak: true, wasStream: true, source: .change
        )
        XCTAssertTrue(outcome.mute)
        XCTAssertTrue(outcome.stopPublishing)
        XCTAssertEqual(outcome.notice, .listenOnly)
    }

    /// The server re-sends the same bit on every resume `welcome`. Muting
    /// again is harmless; the sentence is not repeated for a rule that did
    /// not change, except on `welcome`, where it is the first thing said.
    func testRepeatedDenialOnChangeIsQuiet() {
        let outcome = VoiceSpeakRule.apply(
            canSpeak: false, canStream: false, wasSpeak: false, wasStream: false, source: .change
        )
        XCTAssertTrue(outcome.mute)
        XCTAssertNil(outcome.notice)
    }

    // MARK: - What a grant does

    /// `true` after `false` unlocks the control and leaves the unmute to the
    /// person. Never an automatic unmute: they were silent a moment ago and
    /// may be mid-sentence to somebody in the room.
    func testGrantedMidCallUnlocksWithoutUnmuting() {
        let outcome = VoiceSpeakRule.apply(
            canSpeak: true, canStream: true, wasSpeak: false, wasStream: false, source: .change
        )
        XCTAssertEqual(outcome, VoiceSpeakRule.Outcome(
            canSpeak: true, canStream: true, mute: false, stopPublishing: false, notice: .speakGranted
        ))
    }

    /// An ordinary welcome, which is every call today, says nothing at all.
    func testAllowedOnWelcomeIsSilent() {
        let outcome = VoiceSpeakRule.apply(
            canSpeak: true, canStream: true, wasSpeak: true, wasStream: true, source: .welcome
        )
        XCTAssertFalse(outcome.mute)
        XCTAssertNil(outcome.notice)
    }
}
