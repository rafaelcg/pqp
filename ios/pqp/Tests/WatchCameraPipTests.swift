import CoreGraphics
import Foundation
import XCTest
@testable import pqp

/// The presenter's camera, floating over the film: which URL the corner
/// player is handed and when, the four layouts, where the box sits, and the
/// automatic retry a dropped stream gets before anybody has to press
/// anything. Mirrors `client/src/lib/watch-camera-pip.ts`'s own test file.
final class WatchCameraPipTests: XCTestCase {

    // MARK: - The session key

    func testTheSessionKeyIsTheUrlWithoutItsToken() {
        XCTAssertEqual(
            cameraSessionKey("/api/voice/hls-playlist/c1/1-cam360p30?t=abc"),
            "/api/voice/hls-playlist/c1/1-cam360p30"
        )
    }

    func testAUrlWithNoTokenIsItsOwnKey() {
        XCTAssertEqual(
            cameraSessionKey("https://cdn.example/cam.m3u8"),
            "https://cdn.example/cam.m3u8"
        )
    }

    // MARK: - The swap rule

    func testNothingAttachedAttachesTheCameraAtOnce() {
        let move = WatchCameraStreamSwap.next(
            attached: nil,
            latestUrl: "/api/voice/hls-playlist/c1/1-cam?t=a",
            hasVideo: true, hasVoiceAudio: false, failed: false, now: Date()
        )
        XCTAssertEqual(move, .attach(hlsUrl: "/api/voice/hls-playlist/c1/1-cam?t=a"))
    }

    /**
     THE ONE THAT MATTERS: a restamped `?t=` on the same path must never
     rebuild the player. The server restamps `cameraHlsUrl` on the same
     audience-keyframe clock as the film's, about every 30 seconds, for a
     camera that has not moved at all.
     */
    func testAFreshTokenForTheSameCameraDoesNotRestartThePlayer() {
        let attached = CameraAttachedStream(
            sessionKey: "/api/voice/hls-playlist/c1/1-cam", attachedAt: Date()
        )
        let move = WatchCameraStreamSwap.next(
            attached: attached,
            latestUrl: "/api/voice/hls-playlist/c1/1-cam?t=fresh",
            hasVideo: true, hasVoiceAudio: false, failed: false, now: Date()
        )
        XCTAssertEqual(move, .keep)
    }

    func testARestartedCameraRunIsAttached() {
        let attached = CameraAttachedStream(
            sessionKey: "/api/voice/hls-playlist/c1/1-cam", attachedAt: Date()
        )
        let move = WatchCameraStreamSwap.next(
            attached: attached,
            latestUrl: "/api/voice/hls-playlist/c1/2-cam?t=x",
            hasVideo: true, hasVoiceAudio: false, failed: false, now: Date()
        )
        XCTAssertEqual(move, .attach(hlsUrl: "/api/voice/hls-playlist/c1/2-cam?t=x"))
    }

    func testNoUrlAndNoVoiceDetaches() {
        let move = WatchCameraStreamSwap.next(
            attached: nil, latestUrl: nil,
            hasVideo: true, hasVoiceAudio: false, failed: false, now: Date()
        )
        XCTAssertEqual(move, .detach)
    }

    /// No picture and no voice: nothing worth drawing, whatever the camera
    /// field says. Mirrors the web's "separada with nothing published" case.
    func testNoPictureAndNoVoiceDetachesEvenWithAUrl() {
        let attached = CameraAttachedStream(sessionKey: "/x", attachedAt: Date())
        let move = WatchCameraStreamSwap.next(
            attached: attached, latestUrl: "/x?t=a",
            hasVideo: false, hasVoiceAudio: false, failed: false, now: Date()
        )
        XCTAssertEqual(move, .detach)
    }

    /// A camera carrying only the presenter's voice (no picture) still gets
    /// attached: the audio is the whole point of that shape.
    func testVoiceOnlyStillAttaches() {
        let move = WatchCameraStreamSwap.next(
            attached: nil, latestUrl: "/x?t=a",
            hasVideo: false, hasVoiceAudio: true, failed: false, now: Date()
        )
        XCTAssertEqual(move, .attach(hlsUrl: "/x?t=a"))
    }

    func testAFailureReattachesEvenOnTheSameSession() {
        let attached = CameraAttachedStream(sessionKey: "/x", attachedAt: Date())
        let move = WatchCameraStreamSwap.next(
            attached: attached, latestUrl: "/x?t=fresh",
            hasVideo: true, hasVoiceAudio: false, failed: true, now: Date()
        )
        XCTAssertEqual(move, .attach(hlsUrl: "/x?t=fresh"))
    }

    func testTheTokenIsRenewedInsideTheHour() {
        let attachedAt = Date().addingTimeInterval(-(50 * 60))
        let attached = CameraAttachedStream(sessionKey: "/x", attachedAt: attachedAt)
        let move = WatchCameraStreamSwap.next(
            attached: attached, latestUrl: "/x?t=fresh",
            hasVideo: true, hasVoiceAudio: false, failed: false, now: Date()
        )
        XCTAssertEqual(move, .attach(hlsUrl: "/x?t=fresh"))
    }

    func testARecentAttachIsNotRenewedYet() {
        let attachedAt = Date().addingTimeInterval(-(10 * 60))
        let attached = CameraAttachedStream(sessionKey: "/x", attachedAt: attachedAt)
        let move = WatchCameraStreamSwap.next(
            attached: attached, latestUrl: "/x?t=fresh",
            hasVideo: true, hasVoiceAudio: false, failed: false, now: Date()
        )
        XCTAssertEqual(move, .keep)
    }

    // MARK: - The layout, and when it is offered

    func testALayoutIsOnlyOfferedWithAPicture() {
        XCTAssertTrue(cameraLayoutOffered(cameraSrc: "/x", cameraHasVideo: true))
        XCTAssertFalse(cameraLayoutOffered(cameraSrc: "/x", cameraHasVideo: false))
        XCTAssertFalse(cameraLayoutOffered(cameraSrc: nil, cameraHasVideo: true))
    }

    /// The audio-only shape of "separada" has nothing to lay out: whatever
    /// the viewer's remembered preference says, it reads as the corner.
    func testACameraWithNoPictureAlwaysFallsBackToPip() {
        let pref = CameraPipPref(corner: .topLeading, layout: .camera)
        XCTAssertEqual(
            effectiveCameraLayout(pref: pref, cameraHasVideo: false), .pip
        )
    }

    func testAPictureUsesWhateverTheViewerPicked() {
        let pref = CameraPipPref(corner: .topLeading, layout: .side)
        XCTAssertEqual(
            effectiveCameraLayout(pref: pref, cameraHasVideo: true), .side
        )
    }

    // MARK: - Persistence (`CameraPipPref` as `@AppStorage`'s `RawRepresentable`)

    func testAPreferenceRoundTripsThroughItsRawValue() {
        let pref = CameraPipPref(corner: .topTrailing, layout: .side)
        let restored = CameraPipPref(rawValue: pref.rawValue)
        XCTAssertEqual(restored, pref)
    }

    /// Garbage (nothing stored yet, or a future format `@AppStorage` cannot
    /// parse) reads as the default rather than crashing the stage over a
    /// preference nobody would notice missing.
    func testGarbageFallsBackToTheDefault() {
        XCTAssertEqual(CameraPipPref(rawValue: "not json"), CameraPipPref.default)
        XCTAssertEqual(CameraPipPref(rawValue: "{}"), CameraPipPref.default)
    }

    func testTheDefaultIsBottomTrailingAndPip() {
        XCTAssertEqual(CameraPipPref.default.corner, .bottomTrailing)
        XCTAssertEqual(CameraPipPref.default.layout, .pip)
    }

    // MARK: - The corner

    func testTheNearestCornerIsWhicheverQuadrantTheDragLandedIn() {
        let bounds = CGSize(width: 300, height: 600)
        XCTAssertEqual(
            CameraPipCorner.nearest(to: CGPoint(x: 10, y: 10), in: bounds), .topLeading
        )
        XCTAssertEqual(
            CameraPipCorner.nearest(to: CGPoint(x: 290, y: 10), in: bounds), .topTrailing
        )
        XCTAssertEqual(
            CameraPipCorner.nearest(to: CGPoint(x: 10, y: 590), in: bounds), .bottomLeading
        )
        XCTAssertEqual(
            CameraPipCorner.nearest(to: CGPoint(x: 290, y: 590), in: bounds), .bottomTrailing
        )
    }

    /// Four presses is where you started, the same property the web's
    /// `nextCameraPipCorner` carries.
    func testFourClockwiseStepsReturnToTheStartingCorner() {
        var corner = CameraPipCorner.topLeading
        for _ in 0..<4 { corner = corner.clockwise() }
        XCTAssertEqual(corner, .topLeading)
        // And every step actually moves: no corner is its own successor.
        for start in CameraPipCorner.allCases {
            XCTAssertNotEqual(start.clockwise(), start)
        }
    }

    // MARK: - Where the box sits (`WatchStageView`'s pure geometry helpers)

    func testTheCornerBoxNeverExceedsAThirdOfANarrowStage() {
        let size = WatchStageView.cameraCornerSize(in: CGSize(width: 200, height: 800))
        XCTAssertLessThanOrEqual(size.width, 200 * 0.34)
    }

    func testTheCornerBoxIsCappedOnAWideStage() {
        let size = WatchStageView.cameraCornerSize(in: CGSize(width: 1200, height: 800))
        XCTAssertEqual(size.width, 110)
    }

    func testTheOriginSitsInTheRequestedCornerInsetByTheMargin() {
        let stage = CGSize(width: 400, height: 800)
        let box = CGSize(width: 100, height: 130)
        let topLeft = WatchStageView.cameraCornerOrigin(
            corner: .topLeading, boxSize: box, stageSize: stage, margin: 10
        )
        XCTAssertEqual(topLeft.x, 10 + box.width / 2)
        XCTAssertEqual(topLeft.y, 10 + box.height / 2)

        let bottomRight = WatchStageView.cameraCornerOrigin(
            corner: .bottomTrailing, boxSize: box, stageSize: stage, margin: 10
        )
        XCTAssertEqual(bottomRight.x, stage.width - 10 - box.width / 2)
        XCTAssertEqual(bottomRight.y, stage.height - 10 - box.height / 2)
    }

    // MARK: - Automatic recovery from "the picture stopped" (`WatchDeadRetry`)

    func testTheFirstRetryStaysInsideTheBaseWindow() {
        let delay = WatchDeadRetry.delay(attempt: 0, jitter: { 0 })
        XCTAssertEqual(delay, WatchDeadRetry.minSeconds)
        let delayHigh = WatchDeadRetry.delay(attempt: 0, jitter: { 1 })
        XCTAssertEqual(delayHigh, WatchDeadRetry.maxSeconds)
    }

    func testEachDoublingRoughlyDoublesTheWait() {
        let first = WatchDeadRetry.delay(attempt: 0, jitter: { 0.5 })
        let second = WatchDeadRetry.delay(attempt: 1, jitter: { 0.5 })
        let third = WatchDeadRetry.delay(attempt: 2, jitter: { 0.5 })
        XCTAssertEqual(second, first * 2, accuracy: 0.001)
        XCTAssertEqual(third, first * 4, accuracy: 0.001)
    }

    /// Backoff stops growing past `maxDoublings`, so a decoder that keeps
    /// failing settles into a fixed cadence rather than climbing forever.
    func testBackoffIsCappedPastTheMaxDoublings() {
        let atCap = WatchDeadRetry.delay(attempt: WatchDeadRetry.maxDoublings, jitter: { 0.5 })
        let pastCap = WatchDeadRetry.delay(
            attempt: WatchDeadRetry.maxDoublings + 5, jitter: { 0.5 }
        )
        XCTAssertEqual(atCap, pastCap, accuracy: 0.001)
    }
}
