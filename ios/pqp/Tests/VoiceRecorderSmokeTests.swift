import AVFoundation
import XCTest
@testable import pqp

/// Records one second with the recorder's real settings and checks the file is
/// what the upload contract expects. Needs a microphone grant, so it SKIPS
/// where there is none (CI's simulator is never granted one). Locally:
///
///     xcrun simctl privacy booted grant microphone gg.pqp.app
final class VoiceRecorderSmokeTests: XCTestCase {
    @MainActor
    func testTheRecorderSettingsProduceAMonoAACMP4WithinTheByteBudget() async throws {
        try XCTSkipUnless(
            AVAudioApplication.shared.recordPermission == .granted,
            "No microphone grant on this simulator"
        )
        let saved = try VoiceNoteAudioSession.beginRecording()
        defer { VoiceNoteAudioSession.endRecording(restoring: saved) }

        let url = FileManager.default.temporaryDirectory.appendingPathComponent("smoke-\(UUID().uuidString).m4a")
        defer { try? FileManager.default.removeItem(at: url) }
        let recorder = try AVAudioRecorder(url: url, settings: VoiceRecorder.settings)
        recorder.isMeteringEnabled = true
        XCTAssertTrue(recorder.prepareToRecord())
        XCTAssertTrue(recorder.record())
        try await Task.sleep(for: .milliseconds(1_500))
        recorder.updateMeters()
        let reading = recorder.averagePower(forChannel: 0)
        recorder.stop()

        XCTAssertTrue(reading.isFinite || reading == -.infinity, "metering answers a number")

        // An MP4 container: `ftyp` at byte 4.
        let head = try Data(contentsOf: url).prefix(12)
        XCTAssertEqual(String(data: head.subdata(in: 4..<8), encoding: .ascii), "ftyp")

        let file = try AVAudioFile(forReading: url)
        XCTAssertEqual(file.fileFormat.channelCount, 1)
        XCTAssertEqual(file.fileFormat.sampleRate, 24_000)

        let asset = AVURLAsset(url: url)
        let seconds = try await asset.load(.duration).seconds
        XCTAssertEqual(seconds, 1.5, accuracy: 0.35)
        let playable = try await asset.load(.isPlayable)
        XCTAssertTrue(playable)

        // The mint refuses a file bigger than 16 KiB a second plus 32 KiB.
        let size = try url.resourceValues(forKeys: [.fileSizeKey]).fileSize ?? .max
        XCTAssertLessThan(size, 16 * 1024 * Int(seconds.rounded(.up)) + 32 * 1024)
    }
}
