import AVFoundation
import XCTest
@testable import pqp

/// The decisions behind the Baú video player: whose audio session it may
/// touch, what scrolling away does, and which video holds the floor. The
/// player itself needs a screen and a network, so only the rules are pinned.
final class BauPlaybackPolicyTests: XCTestCase {

    // MARK: Audio session

    func testOutsideACallAVideoTakesPlayback() {
        XCTAssertEqual(
            BauPlaybackPolicy.audioPlan(callActive: false, category: .soloAmbient),
            .takePlayback
        )
        XCTAssertEqual(
            BauPlaybackPolicy.audioPlan(callActive: false, category: .playback),
            .takePlayback
        )
    }

    func testALiveCallKeepsItsSessionWhateverTheCategorySays() {
        for category in [AVAudioSession.Category.playAndRecord, .playback, .soloAmbient] {
            XCTAssertEqual(
                BauPlaybackPolicy.audioPlan(callActive: true, category: category),
                .leaveSessionAlone, "\(category)"
            )
        }
    }

    func testARecordingCategoryIsACallEvenWhenTheModelDoesNotKnow() {
        // A call mid-setup, a voice note being recorded: the session says so
        // before our own state does.
        XCTAssertEqual(
            BauPlaybackPolicy.audioPlan(callActive: false, category: .playAndRecord),
            .leaveSessionAlone
        )
        XCTAssertEqual(
            BauPlaybackPolicy.audioPlan(callActive: false, category: .record),
            .leaveSessionAlone
        )
    }

    // MARK: Scrolling away

    func testAPlayingCardThatScrollsAwayGoesToPictureInPicture() {
        XCTAssertEqual(plan(isPlaying: true), .pictureInPicture)
    }

    func testWithoutPictureInPictureAPlayingCardPauses() {
        XCTAssertEqual(plan(isPlaying: true, pipSupported: false), .pause)
    }

    func testAPausedCardIsLeftAlone() {
        XCTAssertEqual(plan(isPlaying: false), .leaveAlone)
    }

    func testFullScreenIsNotScrollingAway() {
        XCTAssertEqual(plan(isPlaying: true, isFullScreen: true), .leaveAlone)
    }

    func testAWindowAlreadyUpIsNotStartedTwice() {
        XCTAssertEqual(plan(isPlaying: true, pipAlreadyRunning: true), .leaveAlone)
    }

    private func plan(
        isPlaying: Bool, pipSupported: Bool = true, isFullScreen: Bool = false,
        pipAlreadyRunning: Bool = false
    ) -> BauScrollAwayPlan {
        BauPlaybackPolicy.scrollAwayPlan(
            isPlaying: isPlaying, pipSupported: pipSupported,
            isFullScreen: isFullScreen, pipAlreadyRunning: pipAlreadyRunning
        )
    }
}

final class BauActivePlayerTests: XCTestCase {
    func testTheFirstVideoDisplacesNobody() {
        var floor = BauActivePlayer()
        XCTAssertNil(floor.claim(UUID()))
    }

    func testASecondVideoDisplacesTheFirst() {
        var floor = BauActivePlayer()
        let first = UUID(), second = UUID()
        _ = floor.claim(first)
        XCTAssertEqual(floor.claim(second), first)
        XCTAssertEqual(floor.current, second)
    }

    func testClaimingAgainDisplacesNobody() {
        var floor = BauActivePlayer()
        let only = UUID()
        _ = floor.claim(only)
        XCTAssertNil(floor.claim(only))
    }

    func testOnlyTheHolderCanGiveTheFloorUp() {
        var floor = BauActivePlayer()
        let first = UUID(), second = UUID()
        _ = floor.claim(first)
        _ = floor.claim(second)
        floor.release(first)
        XCTAssertEqual(floor.current, second)
        floor.release(second)
        XCTAssertNil(floor.current)
    }
}

/// Full screen turns with the phone, and only while it is up.
@MainActor
final class BauVideoOrientationTests: XCTestCase {
    func testFullScreenUnlocksLandscapeAndLeavingLocksItAgain() {
        let id = UUID()
        XCTAssertFalse(WatchOrientation.holds(.bauVideo(id)))
        WatchOrientation.enterBauVideo(id)
        XCTAssertTrue(WatchOrientation.holds(.bauVideo(id)))
        XCTAssertTrue(WatchOrientation.allowed.contains(.landscapeLeft))
        WatchOrientation.leaveBauVideo(id)
        XCTAssertFalse(WatchOrientation.holds(.bauVideo(id)))
    }

    func testItDoesNotStandInForTheWatchPartyOrAShare() {
        let bau = UUID(), share = UUID()
        WatchOrientation.enterBauVideo(bau)
        WatchOrientation.enterScreenShare(share)
        WatchOrientation.leaveBauVideo(bau)
        XCTAssertTrue(WatchOrientation.holds(.screenShare(share)))
        WatchOrientation.leaveScreenShare(share)
    }
}
