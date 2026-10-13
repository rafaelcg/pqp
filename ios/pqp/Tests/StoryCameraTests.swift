import AVFoundation
import UIKit
import XCTest
@testable import pqp

/// The story camera's decisions, and the scripted camera the simulator and the
/// UI tests run on. The AVFoundation half (a real `AVCaptureSession`) cannot
/// run on a simulator; everything the screen decides around it can.
@MainActor
final class StoryCameraTests: XCTestCase {
    // MARK: - Shutter

    func testAQuickPressIsAPhoto() {
        var press = StoryShutterPress()
        let t0 = Date()
        press.down(at: t0)
        XCTAssertFalse(press.holdElapsed(at: t0.addingTimeInterval(0.1)), "Too early to be a hold")
        XCTAssertEqual(press.up(at: t0.addingTimeInterval(0.12)), .photo)
        XCTAssertFalse(press.isDown)
    }

    func testAHoldStartsRecordingUnderTheFingerAndReleaseStopsIt() {
        var press = StoryShutterPress()
        let t0 = Date()
        press.down(at: t0)
        XCTAssertTrue(press.holdElapsed(at: t0.addingTimeInterval(0.36)))
        XCTAssertTrue(press.isRecording)
        XCTAssertFalse(press.holdElapsed(at: t0.addingTimeInterval(0.5)), "It starts once")
        XCTAssertEqual(press.up(at: t0.addingTimeInterval(4)), .recordingStopped)
        XCTAssertFalse(press.isRecording)
    }

    /// The 30 s limit ends the recording with the finger still down; lifting it
    /// afterwards must not fire the shutter.
    func testReleasingAfterTheLimitTakesNoPhoto() {
        var press = StoryShutterPress()
        let t0 = Date()
        press.down(at: t0)
        XCTAssertTrue(press.holdElapsed(at: t0.addingTimeInterval(0.4)))
        press.recordingEnded()
        XCTAssertEqual(press.up(at: t0.addingTimeInterval(31)), .nothing)
    }

    func testALongPressThatNeverStartedRecordingTakesNoPhoto() {
        var press = StoryShutterPress()
        let t0 = Date()
        press.down(at: t0)
        // The camera was busy, so the hold timer never started anything.
        XCTAssertEqual(press.up(at: t0.addingTimeInterval(2)), .nothing)
    }

    // MARK: - Zoom

    func testZoomLabelDropsAWholeDecimal() {
        XCTAssertEqual(StoryZoom.label(1), "1x")
        XCTAssertEqual(StoryZoom.label(0.5), "0.5x")
        XCTAssertEqual(StoryZoom.label(2.449), "2.4x")
        XCTAssertEqual(StoryZoom.label(3.0004), "3x")
    }

    func testAPinchStaysInsideWhatTheLensCanDo() {
        let range = 0.5...5.0
        XCTAssertEqual(StoryZoom.pinched(from: 1, scale: 2, range: range), 2)
        XCTAssertEqual(StoryZoom.pinched(from: 1, scale: 40, range: range), 5)
        XCTAssertEqual(StoryZoom.pinched(from: 1, scale: 0.1, range: range), 0.5)
    }

    func testDraggingUpWhileRecordingZoomsInAndDownZoomsOut() {
        let range = 1.0...8.0
        XCTAssertEqual(StoryZoom.dragged(from: 1, translationY: 0, range: range), 1, accuracy: 0.001)
        let up = StoryZoom.dragged(from: 1, translationY: -130, range: range)
        XCTAssertGreaterThan(up, 1.5)
        XCTAssertLessThan(up, 8)
        XCTAssertEqual(StoryZoom.dragged(from: 1, translationY: -400, range: range), 8, accuracy: 0.001, "Past full travel it stops at the top")
        XCTAssertEqual(StoryZoom.dragged(from: 4, translationY: 200, range: range), 1.8, accuracy: 0.9, "Down goes back toward the bottom")
        XCTAssertGreaterThanOrEqual(StoryZoom.dragged(from: 4, translationY: 900, range: range), 1)
    }

    func testThePillOnlyShowsWhereThereIsSomewhereToGo() {
        XCTAssertFalse(StoryZoom.isZoomable(1...1))
        XCTAssertTrue(StoryZoom.isZoomable(0.5...5))
    }

    // MARK: - Flash

    func testFlashCyclesOffOnAuto() {
        XCTAssertEqual(StoryFlash.off.next, .on)
        XCTAssertEqual(StoryFlash.on.next, .auto)
        XCTAssertEqual(StoryFlash.auto.next, .off)
        XCTAssertFalse(StoryFlash.off.torchesVideo)
        XCTAssertTrue(StoryFlash.on.torchesVideo)
        XCTAssertTrue(StoryFlash.auto.torchesVideo)
        XCTAssertEqual(Set(StoryFlash.allCases.map(\.symbol)).count, 3, "Three states, three icons")
    }

    // MARK: - Clock

    func testTheRingFillsOverThirtySeconds() {
        XCTAssertEqual(StoryRecordingClock.progress(elapsed: 0), 0)
        XCTAssertEqual(StoryRecordingClock.progress(elapsed: 15), 0.5, accuracy: 0.001)
        XCTAssertEqual(StoryRecordingClock.progress(elapsed: 45), 1)
        XCTAssertEqual(StoryRecordingClock.label(7.9), "0:07")
        XCTAssertEqual(StoryRecordingClock.label(75), "1:15")
        XCTAssertFalse(StoryRecordingClock.isOverLimit(29.9))
        XCTAssertTrue(StoryRecordingClock.isOverLimit(30))
    }

    // MARK: - Access

    func testEveryPermissionStateHasAScreen() {
        XCTAssertEqual(StoryCameraAccess.resolve(status: .authorized, hasDevice: true), .ready)
        XCTAssertEqual(StoryCameraAccess.resolve(status: .authorized, hasDevice: false), .noDevice)
        XCTAssertEqual(StoryCameraAccess.resolve(status: .notDetermined, hasDevice: true), .needsPrompt)
        XCTAssertEqual(StoryCameraAccess.resolve(status: .notDetermined, hasDevice: false), .noDevice)
        XCTAssertEqual(StoryCameraAccess.resolve(status: .denied, hasDevice: true), .denied)
        XCTAssertEqual(StoryCameraAccess.resolve(status: .restricted, hasDevice: true), .restricted)
    }

    func testOnlyARefusalThePersonCanUndoOffersSettings() {
        XCTAssertTrue(StoryCameraAccess.denied.offersSettings)
        XCTAssertFalse(StoryCameraAccess.restricted.offersSettings)
        XCTAssertFalse(StoryCameraAccess.noDevice.offersSettings)
        XCTAssertFalse(StoryCameraAccess.busyInCall.offersSettings)
        for state in [StoryCameraAccess.denied, .restricted, .noDevice, .busyInCall] {
            XCTAssertFalse(state.title.isEmpty)
            XCTAssertFalse(state.detail.isEmpty, "Every refusal says what to do instead")
        }
    }

    // MARK: - Trim

    func testATrimIsOnlyAskedForPastTheLimitPlusSlack() {
        XCTAssertFalse(StoryTrim.needsTrim(durationMs: 30_000))
        XCTAssertFalse(StoryTrim.needsTrim(durationMs: 30_900), "A recording that stopped a frame late is not a long video")
        XCTAssertTrue(StoryTrim.needsTrim(durationMs: 31_500))
        XCTAssertTrue(StoryTrim.needsTrim(durationMs: 120_000))
    }

    func testTheWindowNeverLeavesTheClip() {
        XCTAssertEqual(StoryTrim.maxStartMs(durationMs: 72_000), 42_000)
        XCTAssertEqual(StoryTrim.clampedStartMs(-5, durationMs: 72_000), 0)
        XCTAssertEqual(StoryTrim.clampedStartMs(60_000, durationMs: 72_000), 42_000)
        XCTAssertEqual(StoryTrim.maxStartMs(durationMs: 20_000), 0)
        let kept = StoryTrim.keptRange(startMs: 10_000, durationMs: 72_000)
        XCTAssertEqual(kept.startMs, 10_000)
        XCTAssertEqual(kept.lengthMs, 30_000)
        let tail = StoryTrim.keptRange(startMs: 99_000, durationMs: 72_000)
        XCTAssertEqual(tail.startMs, 42_000)
        XCTAssertEqual(tail.lengthMs, 30_000)
        XCTAssertEqual(StoryTrim.keptRange(startMs: 0, durationMs: 12_000).lengthMs, 12_000)
        XCTAssertEqual(StoryTrim.label(startMs: 12_000, lengthMs: 30_000), "0:12 to 0:42")
    }

    // MARK: - The scripted camera

    func testFlippingSwapsTheCameraAndResetsZoom() async throws {
        let camera = MockStoryCameraEngine()
        try await camera.start()
        XCTAssertEqual(camera.position, .back)
        camera.setZoom(3)
        XCTAssertEqual(camera.zoom, 3)
        await camera.flip()
        XCTAssertEqual(camera.position, .front)
        XCTAssertEqual(camera.zoom, 1)
        XCTAssertFalse(camera.hasFlash, "A front camera has no flash")
        await camera.flip()
        XCTAssertEqual(camera.position, .back)
    }

    func testTheScriptedCameraHandsBackAFullHeightPhoto() async throws {
        let camera = MockStoryCameraEngine()
        let image = try await camera.capturePhoto(flash: .on)
        XCTAssertEqual(image.size, CGSize(width: 1080, height: 1920))
        XCTAssertEqual(camera.lastFlash, .on)
        // A shot goes through the same preparation as a picked photo.
        let draft = try XCTUnwrap(StoryMediaPrep.image(image))
        XCTAssertLessThanOrEqual(max(draft.width, draft.height), Int(StoryLimits.imageMaxEdge))
        XCTAssertEqual(draft.contentType, "image/jpeg")
    }

    func testTheScriptedCameraRecordsARealPlayableFile() async throws {
        let camera = MockStoryCameraEngine()
        try await camera.startRecording(torch: false)
        try await Task.sleep(for: .milliseconds(1200))
        let url = try await camera.stopRecording()
        let seconds = try await AVURLAsset(url: url).load(.duration).seconds
        XCTAssertEqual(seconds, 1.2, accuracy: 0.5)
        let tracks = try await AVURLAsset(url: url).loadTracks(withMediaType: .video)
        XCTAssertFalse(tracks.isEmpty)
    }

    func testTheRealEngineIsTheDefaultOffADebugFlag() {
        XCTAssertTrue(StoryCameraEngineFactory.make(recordsAudio: true) is AVStoryCameraEngine)
    }

    // MARK: - Trimming a long video

    func testALongVideoIsCutToTheWindowTheTrimmerChose() async throws {
        let long = try await StoryTestVideo.write(duration: 36, size: CGSize(width: 90, height: 160), fps: 5)
        let draft = try await StoryMediaPrep.video(at: long, trimStartMs: 4_000, maxVideoMs: StoryLimits.maxVideoMs)
        XCTAssertEqual(draft.durationMs, 30_000)
        XCTAssertTrue(draft.isVideo)
        XCTAssertLessThanOrEqual(draft.data.count, StoryLimits.maxBytes)
        // The bytes that go up really are 30 s, not the whole 36.
        let probe = FileManager.default.temporaryDirectory.appendingPathComponent("probe-\(UUID().uuidString).mp4")
        try draft.data.write(to: probe)
        let seconds = try await AVURLAsset(url: probe).load(.duration).seconds
        XCTAssertEqual(seconds, 30, accuracy: 0.6)
    }

    func testALongVideoWithNoChosenWindowIsStillRefusedWithTheReason() async throws {
        let long = try await StoryTestVideo.write(duration: 36, size: CGSize(width: 90, height: 160), fps: 5)
        do {
            _ = try await StoryMediaPrep.video(at: long, maxVideoMs: StoryLimits.maxVideoMs)
            XCTFail("A 36 s clip with no window chosen must not upload")
        } catch let failure as StoryMediaPrep.Failure {
            XCTAssertFalse(failure.message.isEmpty)
        }
    }

    func testARecordingThatStoppedAFrameLateIsNotRefused() async throws {
        let slightlyLong = try await StoryTestVideo.write(duration: 30.6, size: CGSize(width: 90, height: 160), fps: 5)
        let draft = try await StoryMediaPrep.video(at: slightlyLong, maxVideoMs: StoryLimits.maxVideoMs)
        XCTAssertEqual(draft.durationMs, 30_000, "Cut to the limit, not sent away")
    }

    func testAShortVideoKeepsItsOwnLength() async throws {
        let short = try await StoryTestVideo.write(duration: 4, size: CGSize(width: 90, height: 160), fps: 5)
        let draft = try await StoryMediaPrep.video(at: short, maxVideoMs: StoryLimits.maxVideoMs)
        XCTAssertEqual(Double(draft.durationMs ?? 0), 4_000, accuracy: 300)
    }
}
