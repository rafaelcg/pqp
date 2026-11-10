import AVFoundation
import XCTest
@testable import pqp

/// THE ALIGNMENT PROOF. Stems are written as real files (WAV, and FLAC, which
/// is what the web recorder uploads), the real `JamEngine` graph is rendered
/// OFFLINE (manual rendering mode: no hardware, no clock), and the test says
/// exactly which output frame each stem's first played sample lands on.
///
/// Each stem is an impulse train: one-sample spikes at chosen frames of the
/// STORED file. A spike inside the played slice must appear at the frame the
/// contract's timeline predicts; a spike just outside a trim must not appear
/// at all. Independent of `JamAlignment`: the expectations below are written
/// out by hand from the contract (`offsetMs` places the first PLAYED sample).
@MainActor
final class JamEngineTests: XCTestCase {
    private var directory: URL!

    override func setUpWithError() throws {
        directory = FileManager.default.temporaryDirectory.appendingPathComponent("jam-engine-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    }

    override func tearDown() {
        try? FileManager.default.removeItem(at: directory)
    }

    /// A mono stem of `length` frames at `rate` that is silent except for the
    /// given spikes (frame, amplitude).
    private func writeStem(
        _ name: String, rate: Double = 48_000, length: Int, spikes: [(Int, Float)], flac: Bool = false
    ) throws -> URL {
        let url = directory.appendingPathComponent(name + (flac ? ".flac" : ".wav"))
        let format = AVAudioFormat(standardFormatWithSampleRate: rate, channels: 1)!
        let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: AVAudioFrameCount(length))!
        buffer.frameLength = AVAudioFrameCount(length)
        let data = buffer.floatChannelData![0]
        for i in 0..<length { data[i] = 0 }
        for (frame, amplitude) in spikes { data[frame] = amplitude }
        let settings: [String: Any] = flac
            ? [AVFormatIDKey: kAudioFormatFLAC, AVSampleRateKey: rate, AVNumberOfChannelsKey: 1,
               AVLinearPCMBitDepthKey: 16]
            : [AVFormatIDKey: kAudioFormatLinearPCM, AVSampleRateKey: rate, AVNumberOfChannelsKey: 1,
               AVLinearPCMBitDepthKey: 32, AVLinearPCMIsFloatKey: true, AVLinearPCMIsBigEndianKey: false]
        let file = try AVAudioFile(forWriting: url, settings: settings, commonFormat: .pcmFormatFloat32, interleaved: false)
        try file.write(from: buffer)
        return url
    }

    /// Frames where the render has a spike, ascending.
    private func spikes(in render: [Float], above threshold: Float = 0.02) -> [Int] {
        render.indices.filter { abs(render[$0]) > threshold }
    }

    private func stem(_ id: String, _ url: URL, offset: Double, start: Double = 0, end: Double = 0) -> JamEngine.Stem {
        JamEngine.Stem(id: id, url: url, offsetMs: offset, trimStartMs: start, trimEndMs: end)
    }

    // MARK: The contract's three cases at once

    func testEachStemsFirstPlayedSampleLandsWhereTheTimelineSaysIncludingANegativeOffsetAndBothTrims() throws {
        // A: offset 0, no trims. Spikes on its first and last frame.
        let a = try writeStem("a", length: 48_000, spikes: [(0, 0.9), (47_999, 0.6)])
        // B: offset -250 ms (a count-in), stored as FLAC like the web recorder's upload.
        let b = try writeStem("b", length: 48_000, spikes: [(0, 0.7)], flac: true)
        // C: offset 100 ms, 200 ms cut from the head (9600 frames) and 300 ms
        // from the tail (14400). Spikes just outside both trims, and on the
        // first and last PLAYED frames.
        let c = try writeStem("c", length: 48_000, spikes: [(9_599, 0.31), (9_600, 0.5), (33_599, 0.4), (33_600, 0.2)])

        let engine = JamEngine()
        let failures = engine.load([
            stem("a", a, offset: 0),
            stem("b", b, offset: -250),
            stem("c", c, offset: 100, start: 200, end: 300),
        ])
        XCTAssertTrue(failures.isEmpty, "\(failures)")

        // The transport's zero is the earliest start: B's, at -250 ms.
        XCTAssertEqual(engine.originMs, -250)
        // Latest end is A's, at 1000 ms, so the mix is 1250 ms long.
        XCTAssertEqual(engine.durationMs, 1_250, accuracy: 0.01)

        let render = try engine.renderOffline(fromPositionMs: 0, frameCount: 70_000)
        XCTAssertEqual(render.count, 70_000)
        let found = spikes(in: render)

        // By hand, at 48 kHz (48 frames per ms), relative to the origin:
        //   B frame 0         at (-250 - -250) * 48        = 0
        //   A frame 0         at (   0 - -250) * 48        = 12_000
        //   C frame 9_600     at ( 100 - -250) * 48        = 16_800   (first played)
        //   C frame 33_599    at 16_800 + (33_599 - 9_600) = 40_799   (last played)
        //   A frame 47_999    at 12_000 + 47_999           = 59_999
        // and C's frames 9_599 and 33_600 sit just outside the trims: silent.
        XCTAssertEqual(found, [0, 12_000, 16_800, 40_799, 59_999])
    }

    func testStartingInTheMiddleSkipsWhatIsBehindAndKeepsTheRest() throws {
        let a = try writeStem("a", length: 48_000, spikes: [(0, 0.9), (47_999, 0.6)])
        let b = try writeStem("b", length: 48_000, spikes: [(0, 0.7), (40_000, 0.5)])
        let engine = JamEngine()
        engine.load([stem("a", a, offset: 0), stem("b", b, offset: -250)])

        // 500 ms after the origin is song time 250 ms: A has played 250 ms
        // (its frame 12_000 is now); B has played 500 ms (its frame 24_000).
        let render = try engine.renderOffline(fromPositionMs: 500, frameCount: 60_000)
        let found = spikes(in: render)
        // A's last frame: 47_999 - 12_000 = 35_999. B's frame 40_000: 40_000 - 24_000 = 16_000.
        // The spikes at A's frame 0 and B's frame 0 are behind the playhead.
        XCTAssertEqual(found, [16_000, 35_999])
    }

    func testAStemThatStartsLaterWaitsExactlyThatManyFrames() throws {
        let a = try writeStem("a", length: 4_800, spikes: [(0, 0.9)])
        let b = try writeStem("b", length: 4_800, spikes: [(0, 0.8)])
        let engine = JamEngine()
        engine.load([stem("a", a, offset: 0), stem("b", b, offset: 37)])
        let found = spikes(in: try engine.renderOffline(fromPositionMs: 0, frameCount: 9_600))
        XCTAssertEqual(found, [0, 37 * 48])
    }

    // MARK: A stem at another sample rate

    func testAStemAt44100IsPlacedAtTheSameFrameWithinTheMixersOwnLatency() throws {
        let reference = try writeStem("ref", length: 48_000, spikes: [(0, 0.9)])
        let slow = try writeStem("slow", rate: 44_100, length: 44_100, spikes: [(0, 0.8)])
        let engine = JamEngine()
        engine.load([stem("ref", reference, offset: 0), stem("slow", slow, offset: 500)])
        let render = try engine.renderOffline(fromPositionMs: 0, frameCount: 48_000)
        let found = spikes(in: render, above: 0.005)
        XCTAssertEqual(found.first, 0)
        // The 44.1 kHz stem is sample-rate converted by the mixer, whose
        // filter delays a one-sample spike by its group delay. Measured:
        // 17 frames, 0.35 ms, the same on every run. The bound is half a
        // millisecond (24 frames), far under anything a listener or a video
        // frame (33 ms) can tell; web stems are 48 kHz and take no conversion.
        let strongest = render.indices.dropFirst(100).max { abs(render[$0]) < abs(render[$1]) }!
        let shift = strongest - 24_000
        print("JAM-ALIGN 44.1kHz stem at 500 ms lands at frame \(strongest), shift \(shift) frames (\(Double(shift) / 48.0) ms)")
        XCTAssertLessThanOrEqual(abs(shift), 24)
    }

    // MARK: Gain

    func testGainAndTheVolumeSliderMultiplyAndMuteSilences() throws {
        let a = try writeStem("a", length: 4_800, spikes: [(100, 0.5)])
        let engine = JamEngine()
        engine.load([stem("a", a, offset: 0)])

        engine.setMix(.init(gain: 1, volume: 1, muted: false), for: "a")
        let unity = try engine.renderOffline(fromPositionMs: 0, frameCount: 4_800)[100]

        engine.setMix(.init(gain: 2, volume: 0.5, muted: false), for: "a")
        let product = try engine.renderOffline(fromPositionMs: 0, frameCount: 4_800)[100]
        XCTAssertEqual(product, unity, accuracy: unity * 0.02, "gain 2 and a half-way slider is unity")

        engine.setMix(.init(gain: 2, volume: 1, muted: false), for: "a")
        let boosted = try engine.renderOffline(fromPositionMs: 0, frameCount: 4_800)[100]
        XCTAssertEqual(boosted / unity, 2, accuracy: 0.05, "+6 dB")

        engine.setMix(.init(gain: 1, volume: 1, muted: true), for: "a")
        XCTAssertTrue(try engine.renderOffline(fromPositionMs: 0, frameCount: 4_800).allSatisfy { abs($0) < 0.0001 })

        engine.setMix(.init(), for: "a")
        engine.setAudible(false, for: "a")
        XCTAssertTrue(try engine.renderOffline(fromPositionMs: 0, frameCount: 4_800).allSatisfy { abs($0) < 0.0001 }, "solo elsewhere")
    }

    // MARK: A file that cannot be opened

    func testAStemCoreAudioCannotOpenIsReportedAndTheOthersStillPlay() throws {
        let good = try writeStem("good", length: 4_800, spikes: [(10, 0.9)])
        let bad = directory.appendingPathComponent("bad.webm")
        try Data("not audio".utf8).write(to: bad)
        let engine = JamEngine()
        let failures = engine.load([stem("good", good, offset: 0), stem("bad", bad, offset: 0)])
        XCTAssertEqual(Set(failures.keys), ["bad"])
        XCTAssertEqual(spikes(in: try engine.renderOffline(fromPositionMs: 0, frameCount: 4_800)), [10])
    }

    func testReloadingKeepsAnUnchangedStemAndDropsAGoneOne() throws {
        let a = try writeStem("a", length: 4_800, spikes: [(0, 0.9)])
        let b = try writeStem("b", length: 4_800, spikes: [(0, 0.8)])
        let engine = JamEngine()
        engine.load([stem("a", a, offset: 0), stem("b", b, offset: 10)])
        engine.load([stem("a", a, offset: 0)])
        XCTAssertEqual(spikes(in: try engine.renderOffline(fromPositionMs: 0, frameCount: 4_800)), [0])
        // A stem whose offset moved is re-placed, not duplicated.
        engine.load([stem("a", a, offset: 5)])
        XCTAssertEqual(spikes(in: try engine.renderOffline(fromPositionMs: 0, frameCount: 4_800)), [0])
        engine.load([stem("a", a, offset: 0), stem("b", b, offset: 20)])
        XCTAssertEqual(spikes(in: try engine.renderOffline(fromPositionMs: 0, frameCount: 4_800)), [0, 960])
    }
}

/// The pure arithmetic under the engine, restated so a change to it is a red test
/// even before an engine is built.
final class JamAlignmentTests: XCTestCase {
    private func spec(offset: Double, start: Double = 0, end: Double = 0) -> JamStemSpec {
        JamStemSpec(id: "x", offsetMs: offset, trimStartMs: start, trimEndMs: end)
    }

    func testPlanForAStemThatStartsAfterTheTransport() {
        let plan = JamAlignment.plan(stem: spec(offset: 100, start: 200, end: 300), fileFrames: 48_000, rate: 48_000, originMs: -250, positionMs: 0)
        XCTAssertEqual(plan, JamStemPlan(delayFrames: 16_800, startFrame: 9_600, frameCount: 24_000))
    }

    func testPlanForATransportStartedInsideTheSlice() {
        let plan = JamAlignment.plan(stem: spec(offset: 0), fileFrames: 48_000, rate: 48_000, originMs: -250, positionMs: 500)
        XCTAssertEqual(plan, JamStemPlan(delayFrames: 0, startFrame: 12_000, frameCount: 36_000))
    }

    func testPlanIsNilOnceTheStemHasFinishedOrHasNothingToPlay() {
        XCTAssertNil(JamAlignment.plan(stem: spec(offset: 0), fileFrames: 48_000, rate: 48_000, originMs: 0, positionMs: 1_000))
        XCTAssertNil(JamAlignment.plan(stem: spec(offset: 0, start: 600, end: 400), fileFrames: 48_000, rate: 48_000, originMs: 0, positionMs: 0))
    }

    func testMillisecondsBecomeWholeFramesRoundedToNearest() {
        XCTAssertEqual(JamAlignment.frames(forMs: 1, rate: 48_000), 48)
        XCTAssertEqual(JamAlignment.frames(forMs: 1, rate: 44_100), 44)
        XCTAssertEqual(JamAlignment.frames(forMs: 10, rate: 44_100), 441)
        XCTAssertEqual(JamAlignment.frames(forMs: -250, rate: 48_000), -12_000)
    }

    func testOriginAndDuration() {
        let stems = [spec(offset: -250), spec(offset: 100, start: 200, end: 300)]
        XCTAssertEqual(JamAlignment.originMs(stems), -250)
        // Ends: -250 + 1000 = 750 and 100 + (1000 - 500) = 600, so 750 - -250.
        XCTAssertEqual(JamAlignment.durationMs(stems, lengthsMs: [1000, 1000]), 1_000)
        XCTAssertEqual(JamAlignment.durationMs([], lengthsMs: []), 0)
    }
}
