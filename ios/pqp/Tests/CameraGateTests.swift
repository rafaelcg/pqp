import XCTest
import WebRTC
@testable import pqp

/**
 The camera control, pinned around the bug it was written for.

 THE REPORT was "I turned my camera on and it worked, then another time it did
 not turn on". No error, no alert, nothing in the UI: the button went green and
 the far end saw black. Two things made that possible and both are checked here.

 FIRST, THE MESH CLAIMED SUCCESS IT HAD NOT HAD.
 `VoiceClient.startCamera` ran `try? await capturer.startCapture(…)` and then
 carried on regardless — it built the track, published it to every peer and
 returned a stream id whether or not `AVCaptureSession` had opened. WebRTC's
 `startCaptureWithDevice:format:fps:completionHandler:` hands back a real
 `NSError` and it was being thrown away. `startCamera` now throws, and the two
 models turn that into a sentence.

 SECOND, NOTHING STOPPED A SECOND TAP. Opening a capture device and
 renegotiating with every peer is not instant, and the button stayed live
 throughout, so two `enableCamera` runs could be in flight against one
 `AVCaptureDevice`. `CameraGate.act` is the guard, and it is what these tests
 mostly are.

 WHAT A SIMULATOR CANNOT DO is open a camera — there is no capture device on
 it at all — so no test here (or anywhere) exercises the AVFoundation half.
 What is testable is every decision around it: which way a tap resolves, that a
 failure has copy, and that the frame probe counts what passes through it
 without eating frames. The device half is in the PR body as a manual script.
 */
final class CameraGateTests: XCTestCase {

    // MARK: - What a tap means

    func testATapOnAnIdleLiveCallStartsTheCamera() {
        XCTAssertEqual(
            CameraGate.act(isOn: false, isBusy: false, isLive: true, canPublish: true),
            .start
        )
    }

    func testATapOnARunningCameraStopsIt() {
        XCTAssertEqual(
            CameraGate.act(isOn: true, isBusy: false, isLive: true, canPublish: true),
            .stop
        )
    }

    /// The regression this file exists for. A second tap while the first start
    /// is still opening the device must do nothing at all: two capture
    /// sessions against one camera is how neither of them ends up running.
    func testASecondTapWhileAStartIsInFlightIsIgnored() {
        XCTAssertEqual(
            CameraGate.act(isOn: false, isBusy: true, isLive: true, canPublish: true),
            .ignore
        )
    }

    /// And the same the other way. A stop landing on top of a start leaves the
    /// device held by a capture nobody has a reference to any more.
    func testATapWhileAStopIsInFlightIsIgnored() {
        XCTAssertEqual(
            CameraGate.act(isOn: true, isBusy: true, isLive: true, canPublish: true),
            .ignore
        )
    }

    func testTheCameraCannotBeStartedBeforeTheRoomIsUp() {
        XCTAssertEqual(
            CameraGate.act(isOn: false, isBusy: false, isLive: false, canPublish: true),
            .ignore
        )
    }

    /// A listen-only seat publishes nothing, camera included. Same rule the
    /// microphone follows. See `VoiceSpeakRule`.
    func testAListenOnlySeatCannotStartACamera() {
        XCTAssertEqual(
            CameraGate.act(isOn: false, isBusy: false, isLive: true, canPublish: false),
            .ignore
        )
    }

    /// The asymmetry is deliberate: losing SPEAK, or the room dropping, must
    /// never trap a capture in the on position. The light has to be closeable.
    func testARunningCameraCanAlwaysBeTurnedOff() {
        XCTAssertEqual(
            CameraGate.act(isOn: true, isBusy: false, isLive: false, canPublish: false),
            .stop
        )
    }

    // MARK: - Every refusal says something

    /// The whole point of the change. A camera that does not come on has to
    /// produce a sentence, in whichever language the phone is in, for every
    /// way it can fail — silence is the one outcome nobody can act on.
    func testEveryFailureCarriesDistinctNonEmptyCopy() {
        let all: [CameraFailure] = [.permission, .noDevice, .captureFailed, .noFrames]
        let messages = all.map(\.message)
        for message in messages {
            XCTAssertFalse(message.isEmpty, "A camera failure with no message is the bug.")
        }
        XCTAssertEqual(Set(messages).count, all.count, "Two failures share one sentence.")
    }

    /// `String(localized:)` answers with the *key* when the catalogue has no
    /// entry, so a missing translation and a correct English build look
    /// identical from inside the app. The catalogue itself is the only place
    /// that can say. Read from the source tree the way `NoEmDashTests` reads
    /// it, and for the same reason: a test bundle holds compiled code, not the
    /// JSON being asserted about.
    func testEveryFailureIsTranslatedIntoPortuguese() throws {
        let catalogue = URL(fileURLWithPath: #filePath)   // …/ios/pqp/Tests/CameraGateTests.swift
            .deletingLastPathComponent()                  // …/ios/pqp/Tests
            .deletingLastPathComponent()                  // …/ios/pqp
            .appendingPathComponent("Resources/Localizable.xcstrings")
        let json = try JSONSerialization.jsonObject(with: Data(contentsOf: catalogue))
        let strings = try XCTUnwrap((json as? [String: Any])?["strings"] as? [String: Any])

        for failure in [CameraFailure.permission, .noDevice, .captureFailed, .noFrames] {
            // The test host runs in English, so `message` is the English
            // source, which is the catalogue key.
            let entry = try XCTUnwrap(
                strings[failure.message] as? [String: Any],
                "Camera copy that never reached the catalogue: \(failure.message)"
            )
            let localizations = entry["localizations"] as? [String: Any]
            let brazilian = localizations?["pt-BR"] as? [String: Any]
            let unit = brazilian?["stringUnit"] as? [String: Any]
            let value = unit?["value"] as? String
            XCTAssertNotNil(value, "No pt-BR for: \(failure.message)")
            XCTAssertNotEqual(value, failure.message, "pt-BR for \(failure.message) is the English.")
        }
    }

    /// Long enough that a cold camera on an old phone is not called broken,
    /// short enough that somebody staring at a black tile is told before they
    /// give up on it.
    func testTheFirstFrameDeadlineIsSecondsNotMinutes() {
        XCTAssertGreaterThanOrEqual(CameraFailure.firstFrameDeadline, .seconds(2))
        XCTAssertLessThanOrEqual(CameraFailure.firstFrameDeadline, .seconds(15))
    }

    // MARK: - The frame probe

    /// It sits between the capturer and the `RTCVideoSource`, which means a
    /// mistake here is not a bad message, it is no video at all. So: it counts
    /// what it is given, and it passes every frame on.
    func testTheProbeCountsFramesAndForwardsEveryOne() {
        let downstream = CountingCapturerDelegate()
        let probe = CameraFrameProbe(forwardingTo: downstream)
        let capturer = RTCVideoCapturer(delegate: probe)

        XCTAssertEqual(probe.frameCount, 0, "A probe that has seen nothing must say so.")

        for _ in 0..<3 {
            probe.capturer(capturer, didCapture: Self.frame())
        }

        XCTAssertEqual(probe.frameCount, 3)
        XCTAssertEqual(
            downstream.received, 3,
            "The probe swallowed a frame. Nothing may sit between the camera and the encoder."
        )
    }

    /// A 2x2 buffer is enough: nothing here looks at the pixels.
    private static func frame() -> RTCVideoFrame {
        var pixelBuffer: CVPixelBuffer?
        CVPixelBufferCreate(kCFAllocatorDefault, 2, 2, kCVPixelFormatType_32BGRA, nil, &pixelBuffer)
        let buffer = RTCCVPixelBuffer(pixelBuffer: pixelBuffer!)
        return RTCVideoFrame(buffer: buffer, rotation: ._0, timeStampNs: 0)
    }
}

/// Stands in for the `RTCVideoSource` the probe forwards to.
private final class CountingCapturerDelegate: NSObject, RTCVideoCapturerDelegate, @unchecked Sendable {
    private(set) var received = 0

    func capturer(_ capturer: RTCVideoCapturer, didCapture frame: RTCVideoFrame) {
        received += 1
    }
}
