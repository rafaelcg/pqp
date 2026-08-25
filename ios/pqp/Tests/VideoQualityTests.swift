import XCTest
@testable import pqp

/**
 The quality ladder, pinned where it can be pinned without a phone.

 THE BUG THIS EXISTS FOR is the one the web ladder shipped with and a person
 caught by eye: every rung below the top set a bitrate ceiling and nothing else,
 so a picture chosen as 360p still arrived at full size and merely looked worse.
 A ceiling with nothing behind it does not make a smaller picture. So the
 assertions below are about the *divisor*, which is the only field that changes
 a size, and the load-bearing one is
 `testEveryRungBelowTheSourceActuallyShrinksThePicture`.

 WHAT THESE CANNOT SAY. Nothing here proves what an encoder produces. That
 number only exists on a live connection and is read back through
 `VideoSendStats`, which is why that type exists at all.
 */
final class VideoQualityTests: XCTestCase {

    // MARK: - Parsing

    func testUnknownStoredValuesFallBackToAuto() {
        XCTAssertEqual(VideoQuality.parse(nil), .auto)
        XCTAssertEqual(VideoQuality.parse(""), .auto)
        XCTAssertEqual(VideoQuality.parse("4k"), .auto)
        XCTAssertEqual(VideoQuality.parse("720p"), .p720)
    }

    /// The raw values are the web's strings, and they are what a stored choice
    /// is written as. Renaming one silently resets everybody to auto.
    func testRawValuesMatchTheWebLadder() {
        XCTAssertEqual(
            VideoQuality.allCases.map(\.rawValue),
            ["auto", "1080p", "720p", "480p", "360p"]
        )
    }

    // MARK: - The divisor

    /// Auto is the one rung that names no size, so it pins nothing and leaves
    /// the encoder free to climb and fall with the link.
    func testAutoNeverScales() {
        XCTAssertEqual(videoScaleFactor(for: .auto, sourceLines: 1080, fallbackLines: 720), 1)
        XCTAssertEqual(videoScaleFactor(for: .auto, sourceLines: 240, fallbackLines: 720), 1)
    }

    /// THE ONE THAT WOULD HAVE CAUGHT IT. Every fixed rung below the source has
    /// to come back with a divisor greater than one, or the label is a promise
    /// about a size that nothing acts on.
    func testEveryRungBelowTheSourceActuallyShrinksThePicture() {
        for quality in VideoQuality.allCases where quality != .auto {
            guard let lines = quality.lines else { continue }
            let source = 1080
            let scale = videoScaleFactor(
                for: quality, sourceLines: source, fallbackLines: source
            )
            if lines < source {
                XCTAssertGreaterThan(
                    scale, 1,
                    "\(quality.rawValue) on a \(source) line source must shrink the picture"
                )
                // And it has to shrink it to the size on the label, not merely
                // to something smaller.
                XCTAssertEqual(Double(source) / scale, Double(lines), accuracy: 6)
            } else {
                XCTAssertEqual(scale, 1)
            }
        }
    }

    /// Never an upscale. Somebody sharing a small window and choosing 1080p
    /// gets their window unchanged, which is the honest reading of the label.
    func testASourceSmallerThanTheChoiceIsLeftAlone() {
        XCTAssertEqual(videoScaleFactor(for: .p1080, sourceLines: 720, fallbackLines: 1080), 1)
        XCTAssertEqual(videoScaleFactor(for: .p720, sourceLines: 720, fallbackLines: 1080), 1)
        XCTAssertEqual(videoScaleFactor(for: .p720, sourceLines: 360, fallbackLines: 1080), 1)
    }

    /// The divisor is solved against the source it divides, which is the whole
    /// reason it is not a constant: the same label has to mean the same picture
    /// on a phone screen and on a desk monitor.
    func testTheSameLabelMeansTheSameSizeOnDifferentSources() {
        let fromPhone = videoScaleFactor(for: .p360, sourceLines: 1280, fallbackLines: 1280)
        let fromMonitor = videoScaleFactor(for: .p360, sourceLines: 1440, fallbackLines: 1280)
        XCTAssertEqual(1280 / fromPhone, 360, accuracy: 6)
        XCTAssertEqual(1440 / fromMonitor, 360, accuracy: 6)
        XCTAssertNotEqual(fromPhone, fromMonitor)
    }

    /// A capture reports nothing in its first moments. Assuming the size we
    /// asked for beats assuming "no scaling", which would send full size to
    /// somebody who chose 360p until something happened to re-tune the sender.
    func testAnUnknownSourceUsesTheFallbackRatherThanGivingUp() {
        XCTAssertEqual(
            videoScaleFactor(for: .p360, sourceLines: nil, fallbackLines: 1080),
            3, accuracy: 0.001
        )
        XCTAssertEqual(
            videoScaleFactor(for: .p360, sourceLines: 0, fallbackLines: 1080),
            3, accuracy: 0.001
        )
    }

    /// Two decimals: enough for every rung on every panel, and short of the
    /// float noise that would make a re-tune look like a change when nothing
    /// moved.
    func testTheDivisorIsRoundedToTwoDecimals() {
        XCTAssertEqual(
            videoScaleFactor(for: .p720, sourceLines: 1280, fallbackLines: 1280),
            1.78, accuracy: 0.0001
        )
    }

    // MARK: - Rotation

    /// ReplayKit swaps the buffer's axes and reports the rotation beside it, so
    /// a landscape phone screen arrives as a buffer whose width is the picture's
    /// height. The label promises picture lines, so that is what gets counted.
    func testUprightLinesFollowTheRotation() {
        XCTAssertEqual(uprightVideoLines(width: 590, height: 1280, rotation: 0), 1280)
        XCTAssertEqual(uprightVideoLines(width: 1280, height: 590, rotation: 90), 1280)
        XCTAssertEqual(uprightVideoLines(width: 1280, height: 590, rotation: 270), 1280)
        XCTAssertEqual(uprightVideoLines(width: 590, height: 1280, rotation: 180), 1280)
    }

    // MARK: - The numbers themselves

    /// A ladder whose rungs are not ordered is not a ladder. Both halves are
    /// checked because they are separate tables on purpose: the same word costs
    /// about twice as much on a screen as on a face, and somebody tidying them
    /// into one would keep the labels honest and the shared screen blurry.
    func testBitratesDescendWithTheLadder() {
        let ordered: [VideoQuality] = [.p1080, .p720, .p480, .p360]
        for (higher, lower) in zip(ordered, ordered.dropFirst()) {
            XCTAssertGreaterThan(
                higher.cameraProfile.maxBitrate, lower.cameraProfile.maxBitrate
            )
            XCTAssertGreaterThan(higher.screenBitrate, lower.screenBitrate)
        }
    }

    /// A screen costs more than a face at the same label, because full-frame
    /// motion and hard-edged text are not a talking head.
    func testAScreenIsAllowedMoreThanACameraAtTheSameLabel() {
        for quality in VideoQuality.allCases {
            XCTAssertGreaterThan(
                quality.screenBitrate, quality.cameraProfile.maxBitrate,
                "\(quality.rawValue) should not hand the screen the camera's allowance"
            )
        }
    }

    /// Auto asks for 720p and not for the old 640x480, which was the ceiling a
    /// mesh call could never climb out of. Its allowance sits between the fixed
    /// rungs either side of it rather than at either extreme.
    func testAutoAsksFor720AndSpendsSomethingSensibleOnAScreen() {
        XCTAssertEqual(VideoQuality.auto.cameraProfile.lines, 720)
        XCTAssertEqual(
            VideoQuality.auto.cameraProfile.maxBitrate,
            VideoQuality.p720.cameraProfile.maxBitrate
        )
        XCTAssertGreaterThan(VideoQuality.auto.screenBitrate, VideoQuality.p720.screenBitrate)
        XCTAssertLessThan(VideoQuality.auto.screenBitrate, VideoQuality.p1080.screenBitrate)
    }

    func testEveryRungNamesTheLinesItsLabelPromises() {
        XCTAssertNil(VideoQuality.auto.lines)
        XCTAssertEqual(VideoQuality.p1080.lines, 1080)
        XCTAssertEqual(VideoQuality.p720.lines, 720)
        XCTAssertEqual(VideoQuality.p480.lines, 480)
        XCTAssertEqual(VideoQuality.p360.lines, 360)
    }

    // MARK: - The mesh budget

    /// A mesh uploads a copy per peer, so a per-peer rate multiplies by the
    /// room. Without the split a six-way call asks one domestic uplink for six
    /// times the chosen ceiling and gets congestion collapse rather than video.
    func testTheBudgetIsSplitAcrossTheRoom() {
        let alone = meshScreenBitrate(peerCount: 1, quality: .p1080)
        let crowded = meshScreenBitrate(peerCount: 4, quality: .p1080)
        XCTAssertGreaterThan(alone, crowded)
        XCTAssertEqual(crowded, 5_000_000 / 4)
    }

    /// The chosen ceiling is the outermost bound. An empty room is not a licence
    /// to overrule somebody who deliberately picked 480p.
    func testAnEmptyRoomCannotOverruleTheChoice() {
        XCTAssertEqual(
            meshScreenBitrate(peerCount: 1, quality: .p480),
            VideoQuality.p480.screenBitrate
        )
        XCTAssertEqual(
            meshScreenBitrate(peerCount: 0, quality: .p360),
            VideoQuality.p360.screenBitrate
        )
    }

    /// The floor lifts the *share*, never the chosen ceiling, so a crowded room
    /// cannot divide its way down to something unwatchable and cannot spend more
    /// than the user asked for either.
    func testTheFloorLiftsTheShareAndNotTheChoice() {
        // 5 Mbps over twenty peers is 250 kbps, which the floor lifts to 600.
        XCTAssertEqual(meshScreenBitrate(peerCount: 20, quality: .p1080), 600_000)
        // But the same crowd cannot lift somebody who chose 360p above 360p.
        XCTAssertEqual(
            meshScreenBitrate(peerCount: 20, quality: .p360),
            VideoQuality.p360.screenBitrate
        )
    }

    // MARK: - The frame rate

    /// THE ONE RAFAEL ASKED FOR. 12 was reported unusable from a phone; a
    /// default user has to get 30, and every consumer of this number derives
    /// from it rather than repeating it, so this single assertion covers the
    /// wire clock, the source adaptation and the sender's `maxFramerate`.
    func testTheScreenRunsAtThirty() {
        XCTAssertEqual(ScreenShareWire.defaultFrameRate, 30)
    }

    /// The rungs trade rate against size, which is what makes the picker a real
    /// answer for somebody whose link or phone cannot carry 720p30 rather than a
    /// reason to go back to sampling everybody at 12 Hz.
    func testALowerRungAtThirtyCostsAboutWhatTheOldRateCostAt720p() {
        let oldPixelRate = 1280 * 720 * 12
        let newPixelRate = 854 * 480 * Int(ScreenShareWire.defaultFrameRate)
        XCTAssertEqual(Double(newPixelRate) / Double(oldPixelRate), 1, accuracy: 0.2)
    }

    // MARK: - Storage

    /// Device-local and remembered, which is the whole contract with the
    /// picker. A suite of its own so the test never reads or writes the real
    /// one.
    @MainActor
    func testTheChoiceIsRememberedOnThisDevice() throws {
        let suite = "pqp.tests.videoQuality.\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }

        let settings = VideoQualitySettings(defaults: defaults)
        XCTAssertEqual(settings.quality, .auto)
        settings.quality = .p480
        XCTAssertEqual(
            defaults.string(forKey: VideoQualitySettings.defaultsKey), "480p"
        )
        XCTAssertEqual(VideoQualitySettings(defaults: defaults).quality, .p480)
    }

    /// A live call has to hear about a change made on a screen it cannot see.
    @MainActor
    func testListenersAreToldAndCanBeRemoved() throws {
        let suite = "pqp.tests.videoQuality.\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }

        let settings = VideoQualitySettings(defaults: defaults)
        var heard: [VideoQuality] = []
        settings.addListener("test") { heard.append($0) }
        settings.quality = .p360
        // Setting the same value again is not a change and must not re-tune
        // every sender in the room for nothing.
        settings.quality = .p360
        settings.removeListener("test")
        settings.quality = .p1080
        XCTAssertEqual(heard, [.p360])
    }
}
