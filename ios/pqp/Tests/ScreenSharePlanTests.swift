import LiveKit
import XCTest
@testable import pqp

/// What a screen share costs the room on the SFU, and when the control is
/// offered at all.
///
/// Both are rules this client shares with the web, and both fail silently
/// when they drift: a phone publishing one uncapped 1080p30 layer is what a
/// roomful of viewers each receives, and a share control offered where the
/// server will refuse it ends in a system broadcast that produces nothing.
/// The numbers must stay equal to `client/src/lib/video-quality.ts`
/// (`SCREEN_SIMULCAST_RUNGS`, `LARGE_ROOM_*`, `screenSimulcastPlan`).
final class ScreenSharePlanTests: XCTestCase {

    // MARK: - The plan

    /// `auto` is the presenter who never opened the menu: 1080 lines at the
    /// web's auto ceiling, with both lower rungs declared beneath it.
    func testAutoPlanMatchesTheWebLadder() {
        let plan = sfuScreenPlan(quality: .auto, participantCount: 3)
        XCTAssertEqual(plan.topHeight, 1080)
        XCTAssertEqual(plan.topBitrate, 3_000_000)
        XCTAssertEqual(plan.lowerLayers.map(\.height), [360, 720])
        XCTAssertFalse(plan.capped)
    }

    /// A chosen rung names its own size and ceiling, and only the rungs
    /// strictly below it are declared: a 720p top with a 720p "lower" layer
    /// would be two copies of the same picture.
    func testChosenQualityDropsTheRungsAtOrAboveIt() {
        let plan = sfuScreenPlan(quality: .p720, participantCount: 3)
        XCTAssertEqual(plan.topHeight, 720)
        XCTAssertEqual(plan.topBitrate, 2_000_000)
        XCTAssertEqual(plan.lowerLayers.map(\.height), [360])
    }

    func testSmallestQualityDeclaresNoLowerLayers() {
        XCTAssertTrue(sfuScreenPlan(quality: .p360, participantCount: 3).lowerLayers.isEmpty)
    }

    /// The 5 Sep 2026 shape: a watch party past twenty people. Nobody chose
    /// 1080p, so the room holds the top at 720p and 1.5 Mbps.
    func testLargeRoomHoldsAnUnchosenShareAt720() {
        let plan = sfuScreenPlan(quality: .auto, participantCount: 40)
        XCTAssertEqual(plan.topHeight, 720)
        XCTAssertEqual(plan.topBitrate, 1_500_000)
        XCTAssertTrue(plan.capped)
    }

    /// Asking for 1080p by name is a decision, and the room does not overrule
    /// it. Same carve-out as `isLargeRoomCapped` on the web.
    func testLargeRoomDoesNotCapAChosen1080p() {
        let plan = sfuScreenPlan(quality: .p1080, participantCount: 40)
        XCTAssertEqual(plan.topHeight, 1080)
        XCTAssertEqual(plan.topBitrate, 4_000_000)
        XCTAssertFalse(plan.capped)
    }

    /// Somebody who picked 720p in a crowded room is sending what they asked
    /// for. `capped` drives the "the room decided" wording, so it must not
    /// claim credit for a choice the person made.
    func testChosen720InALargeRoomIsNotReportedAsCapped() {
        let plan = sfuScreenPlan(quality: .p720, participantCount: 40)
        XCTAssertEqual(plan.topHeight, 720)
        XCTAssertFalse(plan.capped)
        XCTAssertTrue(sfuIsLargeRoomCapped(quality: .p720, participantCount: 40))
    }

    /// The boundary is *past* twenty, not at it, matching
    /// `participantCount > LARGE_ROOM_PARTICIPANTS`.
    func testTwentyPeopleIsNotYetALargeRoom() {
        XCTAssertFalse(sfuIsLargeRoomCapped(quality: .auto, participantCount: 20))
        XCTAssertTrue(sfuIsLargeRoomCapped(quality: .auto, participantCount: 21))
    }

    /// Every declared rung is smaller and cheaper than the top it sits under.
    /// A lower layer that costs more than the top is bandwidth spent on a
    /// picture nobody chooses.
    func testEveryLowerLayerIsCheaperThanItsTop() {
        for quality in VideoQuality.allCases {
            let plan = sfuScreenPlan(quality: quality, participantCount: 3)
            for layer in plan.lowerLayers {
                XCTAssertLessThan(layer.height, plan.topHeight, "\(quality)")
                XCTAssertLessThan(layer.maxBitrate, plan.topBitrate, "\(quality)")
            }
        }
    }

    // MARK: - Whether the control is drawn

    /// Two independent reasons to hide it, and either one is enough.
    func testShareIsOfferedOnlyWhenPossibleAndPermitted() {
        XCTAssertTrue(screenShareIsOffered(isAvailable: true, canSpeak: true))
        // The simulator, or a build with no App Group: the sheet would lead
        // nowhere.
        XCTAssertFalse(screenShareIsOffered(isAvailable: false, canSpeak: true))
        // SPEAK denied: the server answers `screen-share-denied`, after the
        // person has already started a system broadcast.
        XCTAssertFalse(screenShareIsOffered(isAvailable: true, canSpeak: false))
        XCTAssertFalse(screenShareIsOffered(isAvailable: false, canSpeak: false))
    }

    // MARK: - Rotation

    /// ReplayKit's degrees and the SDK's enum both count clockwise, so this
    /// is a rename. It is here because getting it wrong shows a landscape
    /// share upside down at the far end and nowhere else.
    func testRotationMapsDegreesToTheSdkEnum() {
        XCTAssertEqual(liveKitRotation(degrees: 0), ._0)
        XCTAssertEqual(liveKitRotation(degrees: 90), ._90)
        XCTAssertEqual(liveKitRotation(degrees: 180), ._180)
        XCTAssertEqual(liveKitRotation(degrees: 270), ._270)
        // The bridge validates rotation on the wire, so anything else is a
        // bug elsewhere; upright is the safe reading of it.
        XCTAssertEqual(liveKitRotation(degrees: 45), ._0)
    }

    // MARK: - What goes on the wire

    /// `screenShareEncoding`, not `encoding`. The SDK reads a screen's
    /// ceiling from that field alone (`computeVideoEncodings`), and setting
    /// the other one is how every SFU share on the web went up uncapped
    /// until PR #237.
    func testPublishOptionsCarryTheCeilingOnTheScreenField() {
        let plan = sfuScreenPlan(quality: .auto, participantCount: 3)
        let options = LiveKitVoiceClient.screenPublishOptions(for: plan)
        XCTAssertEqual(options.screenShareEncoding?.maxBitrate, 3_000_000)
        XCTAssertEqual(options.screenShareEncoding?.maxFps, 30)
        XCTAssertNil(options.encoding)
    }

    /// The lower rungs are declared as simulcast layers, and the encoder is
    /// told to spend pixels before it spends motion: a shared screen that
    /// holds its resolution and drops to stills is unreadable.
    func testPublishOptionsDeclareTheLowerLayersAndKeepFramerate() {
        let plan = sfuScreenPlan(quality: .auto, participantCount: 3)
        let options = LiveKitVoiceClient.screenPublishOptions(for: plan)
        XCTAssertTrue(options.simulcast)
        XCTAssertEqual(
            options.screenShareSimulcastLayers.map { Int($0.dimensions.height) },
            [360, 720]
        )
        XCTAssertEqual(options.degradationPreference, .maintainFramerate)
    }
}
