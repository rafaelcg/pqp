import AVFoundation
import XCTest
@testable import pqp

/// RECORDING A PART, PROVED WITHOUT A MICROPHONE. The recorder stamps the first
/// captured sample with a host time and places the take from the band's host
/// start and the round trip (`JamTakeClock`); everything from the stamp onward is
/// arithmetic and file work, so a synthetic capture exercises it exactly:
///
///  - a player who plays a click N ms into the song, over a band whose own click
///    is at N ms, through a chain with L ms of round trip, is captured with the
///    click `L` after it left the graph;
///  - the take is built from that capture (`JamTakeBuilder`, the real code: mono
///    16-bit FLAC, whole-millisecond offset, head trim) and sent with the same
///    fields the web writes (`JamUploadPlan.body`);
///  - it is checked two ways: through the web's own formula (buffer sample `j`
///    sounds at `offsetMs + j / rate`, the contract) and through the phone's
///    engine, rendered offline against the band's click.
///
/// What this cannot say is anything about the device: what stamp the hardware
/// gives the first tap buffer, what its latencies really are. That is the
/// real-device checklist in `docs/IOS.md`.
@MainActor
final class JamRecordingPlacementTests: XCTestCase {
    private var directory: URL!

    override func setUpWithError() throws {
        directory = FileManager.default.temporaryDirectory.appendingPathComponent("jam-rec-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    }

    override func tearDownWithError() throws {
        try? FileManager.default.removeItem(at: directory)
    }

    // MARK: Helpers

    /// A raw capture file: float32 CAF, one array per channel.
    func writeRaw(_ channels: [[Float]], rate: Double) throws -> URL {
        let url = directory.appendingPathComponent("\(UUID().uuidString)-raw.caf")
        do {
            let format = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: rate, channels: AVAudioChannelCount(channels.count), interleaved: false)!
            let file = try AVAudioFile(forWriting: url, settings: format.settings)
            let buffer = AVAudioPCMBuffer(pcmFormat: file.processingFormat, frameCapacity: AVAudioFrameCount(channels[0].count))!
            buffer.frameLength = AVAudioFrameCount(channels[0].count)
            for c in 0..<channels.count {
                for i in 0..<channels[c].count { buffer.floatChannelData![c][i] = channels[c][i] }
            }
            try file.write(from: buffer)
        }
        return url
    }

    func readMono(_ url: URL) throws -> (samples: [Float], rate: Double) {
        let file = try AVAudioFile(forReading: url)
        let buffer = AVAudioPCMBuffer(pcmFormat: file.processingFormat, frameCapacity: AVAudioFrameCount(file.length))!
        try file.read(into: buffer)
        return (Array(UnsafeBufferPointer(start: buffer.floatChannelData![0], count: Int(buffer.frameLength))), file.processingFormat.sampleRate)
    }

    func peakIndex(_ samples: [Float], above threshold: Float = 0.2) -> Int? {
        var best: (Int, Float)?
        for (i, v) in samples.enumerated() where abs(v) > threshold {
            if best == nil || abs(v) > best!.1 { best = (i, abs(v)) }
        }
        return best?.0
    }

    /// One impulse of `amplitude` at `index`, silence elsewhere, written as a stem.
    func writeBandStem(clickAtFileMs: Double, lengthSeconds: Double, rate: Double = 48_000) throws -> URL {
        let url = directory.appendingPathComponent("band-\(UUID().uuidString).wav")
        let frames = Int(lengthSeconds * rate)
        var samples = [Float](repeating: 0, count: frames)
        samples[Int((clickAtFileMs * rate / 1000).rounded())] = 0.8
        do {
            let format = AVAudioFormat(standardFormatWithSampleRate: rate, channels: 1)!
            let file = try AVAudioFile(forWriting: url, settings: format.settings)
            let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: AVAudioFrameCount(frames))!
            buffer.frameLength = AVAudioFrameCount(frames)
            for i in 0..<frames { buffer.floatChannelData![0][i] = samples[i] }
            try file.write(from: buffer)
        }
        return url
    }

    struct Scenario {
        var name: String
        var rate: Double
        /// Song time the band starts from.
        var fromMs: Double
        /// How far into the part the player's note is (song time = from + this).
        var intoMs: Double
        var roundTripMs: Double
        var countInSeconds: Double
        /// How long before the count-in the capture's first sample was taken.
        var leadSeconds: Double = 0.18
    }

    /// The capture a recorder would have made of a perfect player.
    func capture(_ s: Scenario, hostStart h0: Double = 5_000.0) throws -> (raw: JamRecorder.Raw, clickIndex: Int) {
        let captureStart = h0 - s.countInSeconds - s.leadSeconds
        let seconds = s.countInSeconds + s.leadSeconds + s.intoMs / 1000 + 1.5
        let frames = Int(seconds * s.rate)
        var samples = [Float](repeating: 0, count: frames)
        // The count-in's clicks leak into the microphone (and are hidden by the head trim).
        let beat = s.countInSeconds > 0 ? s.countInSeconds / 4 : 0
        if beat > 0 {
            for k in 0..<4 {
                let stamp = h0 - s.countInSeconds + Double(k) * beat + s.roundTripMs / 1000
                let i = Int(((stamp - captureStart) * s.rate).rounded())
                if i >= 0, i < frames { samples[i] = 0.5 }
            }
        }
        // The note leaves the graph at H0 + into, is heard and played, and is
        // stamped round-trip later.
        let stamp = h0 + s.intoMs / 1000 + s.roundTripMs / 1000
        let index = Int(((stamp - captureStart) * s.rate).rounded())
        samples[index] = 0.8
        let url = try writeRaw([samples], rate: s.rate)
        let sink = JamCaptureSink.Capture(
            url: url, memory: [], sampleRate: s.rate, channels: 1, startHostSeconds: captureStart,
            hostTimeEstimated: false, frames: frames, gapFrames: 0, loudest: 0.8
        )
        return (JamRecorder.Raw(capture: sink, fromMs: s.fromMs, backingStartSeconds: h0), index)
    }

    func latency(_ ms: Double) -> JamLatencyResult {
        JamLatencyResult(
            method: .loopback, roundTripMs: ms, confidence: .high, spreadMs: 0.1, accepted: 10, played: 10,
            at: Date(), reportedOutputMs: 12
        )
    }

    static let scenarios: [Scenario] = [
        Scenario(name: "no band, no latency", rate: 48_000, fromMs: 0, intoMs: 0, roundTripMs: 0, countInSeconds: 0),
        Scenario(name: "1 s in, 33 ms, count-in", rate: 48_000, fromMs: 0, intoMs: 1000, roundTripMs: 33, countInSeconds: 2.4),
        Scenario(name: "1337 ms in, 87.5 ms, count-in", rate: 48_000, fromMs: 0, intoMs: 1337, roundTripMs: 87.5, countInSeconds: 2.4),
        Scenario(name: "5 s in, 12.25 ms, no count-in", rate: 48_000, fromMs: 0, intoMs: 5000, roundTripMs: 12.25, countInSeconds: 0),
        Scenario(name: "band starts at 500 ms", rate: 48_000, fromMs: 500, intoMs: 2000, roundTripMs: 41, countInSeconds: 2.4),
        Scenario(name: "44.1 kHz capture", rate: 44_100, fromMs: 0, intoMs: 3000, roundTripMs: 29.7, countInSeconds: 2.4),
        Scenario(name: "round trip of a Bluetooth route", rate: 48_000, fromMs: 0, intoMs: 2500, roundTripMs: 187, countInSeconds: 2.4),
    ]

    // MARK: The contract, directly

    func testATakeRecordedNMsIntoTheSongIsStoredWhereTheWebWouldPlayIt() throws {
        for s in Self.scenarios {
            let (raw, index) = try capture(s)
            let out = directory.appendingPathComponent("\(UUID().uuidString).flac")
            let take = try JamTakeBuilder.build(raw: raw, latency: latency(s.roundTripMs), outputURL: out)

            // Fields: whole milliseconds, the count-in hidden, nothing else touched.
            XCTAssertEqual(take.timing.offsetMs, take.timing.offsetMs.rounded(), s.name)
            XCTAssertEqual(take.timing.trimEndMs, 0, s.name)
            XCTAssertEqual(
                take.timing.trimStartMs, s.fromMs - take.timing.offsetMs, accuracy: 1e-9,
                "\(s.name): the head trim hides everything before the song time the band started from"
            )

            // The web's formula: buffer sample j sounds at offsetMs + j / rate.
            let stored = try readMono(out)
            XCTAssertEqual(stored.rate, s.rate, s.name)
            guard let click = peakIndex(stored.samples) else { return XCTFail("\(s.name): the click is not in the file") }
            // The hidden head holds the count-in's leaked clicks: look at the loudest, which is the note.
            let songMs = JamTakePlacement.songMs(ofSample: click, offsetMs: take.timing.offsetMs, sampleRate: s.rate)
            let expected = s.fromMs + s.intoMs
            XCTAssertEqual(songMs, expected, accuracy: 1000 / s.rate + 1e-6, "\(s.name): the note lands at song time \(expected) ms")

            // And the raw capture says the same in its own terms, so the
            // drop-to-a-whole-millisecond moved nothing.
            XCTAssertEqual(
                JamTakePlacement.songMs(ofSample: index, offsetMs: take.clock.rawOffsetMs, sampleRate: s.rate),
                expected, accuracy: 1000 / s.rate + 1e-6, s.name
            )
            XCTAssertFalse(take.isSilent, s.name)
        }
    }

    // MARK: Through the phone's engine

    func testAnIPhoneTakePlaysAtTheSongTimeItWasRecordedAt() throws {
        for s in Self.scenarios {
            let (raw, _) = try capture(s)
            let out = directory.appendingPathComponent("\(UUID().uuidString).flac")
            let take = try JamTakeBuilder.build(raw: raw, latency: latency(s.roundTripMs), outputURL: out)
            let expectedMs = s.fromMs + s.intoMs

            // The band: its own click at the same song time (a stem starting at
            // `fromMs`, with the click `intoMs` into the file).
            let band = try writeBandStem(clickAtFileMs: s.intoMs, lengthSeconds: s.intoMs / 1000 + 2)
            let engine = JamEngine()
            let failures = engine.load([
                JamEngine.Stem(id: "band", url: band, offsetMs: s.fromMs, trimStartMs: 0, trimEndMs: 0),
                JamEngine.Stem(
                    id: "take", url: out, offsetMs: take.timing.offsetMs,
                    trimStartMs: take.timing.trimStartMs, trimEndMs: take.timing.trimEndMs
                ),
            ])
            XCTAssertTrue(failures.isEmpty, "\(s.name): \(failures)")
            // The transport's zero is the earliest heard sample: the band's
            // start, which is also where the take's heard slice begins.
            XCTAssertEqual(engine.originMs, s.fromMs, accuracy: 1e-6, "\(s.name): the take does not move the song's start")

            var heard: [String: Int] = [:]
            for solo in ["band", "take"] {
                engine.setAudible(solo == "band", for: "band")
                engine.setAudible(solo == "take", for: "take")
                let frames = Int((s.intoMs / 1000 + 1.5) * 48_000)
                let render = try engine.renderOffline(fromPositionMs: 0, frameCount: frames)
                guard let index = peakIndex(render) else { return XCTFail("\(s.name): \(solo) is silent") }
                heard[solo] = index
            }
            let expectedFrame = (expectedMs - engine.originMs) * 48
            // 48 kHz takes go through no rate conversion; 44.1 kHz through the
            // mixer's converter, whose group delay is a few frames (`JamEngineTests`).
            let tolerance = s.rate == 48_000 ? 1.0 : 24.0
            XCTAssertEqual(Double(heard["band"]!), expectedFrame, accuracy: 1, "\(s.name): the band's click is where it should be")
            XCTAssertEqual(
                Double(heard["take"]!), expectedFrame, accuracy: tolerance,
                "\(s.name): the take's click lands at \(expectedMs) ms, with the band"
            )
            XCTAssertEqual(
                Double(heard["take"]!), Double(heard["band"]!), accuracy: tolerance,
                "\(s.name): the take and the band click together"
            )
        }
    }

    func testANudgeMovesTheTakeByExactlyThatManyMilliseconds() throws {
        let s = Self.scenarios[1]
        let (raw, _) = try capture(s)
        let out = directory.appendingPathComponent("\(UUID().uuidString).flac")
        let take = try JamTakeBuilder.build(raw: raw, latency: latency(s.roundTripMs), outputURL: out)
        for nudge in [-20.0, 0, 35] {
            let edits = JamTakeEdits(nudgeMs: nudge)
            let placed = edits.placed(take.timing)
            let engine = JamEngine()
            engine.load([JamEngine.Stem(
                id: "take", url: out, offsetMs: placed.offsetMs, trimStartMs: placed.trimStartMs, trimEndMs: placed.trimEndMs
            )])
            // Alone, the transport's zero is the take's own heard start, which the nudge
            // moves, so the answer is read as SONG time (origin plus frames), not as frames.
            let render = try engine.renderOffline(fromPositionMs: 0, frameCount: 48_000 * 4)
            guard let index = peakIndex(render) else { return XCTFail("silent") }
            XCTAssertEqual(
                engine.originMs + Double(index) / 48, s.fromMs + s.intoMs + nudge, accuracy: 1 / 48.0 + 1e-6,
                "nudge \(nudge) ms is heard \(nudge) ms away"
            )
        }
    }

    // MARK: What is sent

    func testTheTrackIsClaimedWithTheFieldsTheWebWrites() throws {
        let s = Self.scenarios[2]
        let (raw, _) = try capture(s)
        let out = directory.appendingPathComponent("\(UUID().uuidString).flac")
        let take = try JamTakeBuilder.build(raw: raw, latency: latency(s.roundTripMs), outputURL: out)
        let body = JamUploadPlan.body(
            timing: take.timing, edits: JamTakeEdits(nudgeMs: 12), instrument: .bass, label: nil,
            audioUploadId: "11111111-1111-1111-1111-111111111111", peaks: take.peaks
        )
        let json = try JSONSerialization.jsonObject(with: JSONEncoder().encode(body)) as! [String: Any]
        // The keys of `addJamTrackSchema`, and nothing the server would refuse.
        XCTAssertEqual(
            Set(json.keys),
            ["instrument", "label", "audioUploadId", "videoUploadId", "durationMs", "offsetMs", "trimStartMs", "trimEndMs", "gain", "peaks"]
        )
        XCTAssertEqual(json["instrument"] as? String, "bass")
        XCTAssertTrue(json["videoUploadId"] is NSNull)
        XCTAssertTrue(json["label"] is NSNull)
        XCTAssertEqual(json["gain"] as? Double, 1)
        // Whole milliseconds where the server stores integers.
        XCTAssertEqual(json["durationMs"] as? Int, Int(take.timing.durationMs.rounded()))
        XCTAssertEqual(json["trimStartMs"] as? Int, Int(take.timing.trimStartMs.rounded()))
        XCTAssertEqual(json["trimEndMs"] as? Int, 0)
        XCTAssertEqual(json["offsetMs"] as? Double, take.timing.offsetMs + 12, "a nudge moves the offset and nothing else")
        XCTAssertEqual((json["peaks"] as? [Double])?.count, take.peaks.count)
        // The server's refinements: trims leave something to play, peaks bounded.
        XCTAssertLessThan(body.trimStartMs + body.trimEndMs, body.durationMs)
        XCTAssertLessThanOrEqual(body.peaks.count, 400)
        XCTAssertTrue(body.peaks.allSatisfy { (0...1).contains($0) })
        XCTAssertLessThanOrEqual(abs(body.offsetMs), 600_000)
        XCTAssertEqual(JamUploadPlan.contentType, "audio/flac")
        XCTAssertLessThan(take.byteSize, JamUploadPlan.maxBytes)
    }

    func testTheUploadTicketRequestIsAnAcceptedAudioType() throws {
        // `JAM_AUDIO_CONTENT_TYPES` in the contract.
        XCTAssertTrue(["audio/flac", "audio/webm", "audio/ogg", "audio/mp4", "audio/mpeg"].contains(JamUploadPlan.contentType))
        let request = JamUploadRequest.audio(contentType: JamUploadPlan.contentType, byteSize: 1234)
        let json = try JSONSerialization.jsonObject(with: JSONEncoder().encode(request)) as! [String: Any]
        XCTAssertEqual(json["kind"] as? String, "audio")
        XCTAssertEqual(json["byteSize"] as? Int, 1234)
        XCTAssertEqual(Set(json.keys), ["kind", "contentType", "byteSize"])
    }

    func testUploadLimits() {
        XCTAssertEqual(JamUploadPlan.problem(durationMs: 100, byteSize: 10), .tooShort)
        XCTAssertNil(JamUploadPlan.problem(durationMs: 300, byteSize: 10))
        XCTAssertEqual(JamUploadPlan.problem(durationMs: 600_001, byteSize: 10), .tooLong)
        XCTAssertEqual(JamUploadPlan.problem(durationMs: 5000, byteSize: 32 * 1024 * 1024 + 1), .tooBig)
        XCTAssertEqual(JamUploadPlan.autoStopMs, 595_000, "a take stops itself before the ceiling")
    }

    // MARK: The file

    func testTheFlacIs16BitMonoLosslessAndFrameExact() throws {
        let rate = 48_000.0
        var samples = [Float](repeating: 0, count: 96_000)
        samples[24_000] = 0.5
        samples[70_001] = -0.25
        let url = try writeRaw([samples], rate: rate)
        let capture = JamCaptureSink.Capture(
            url: url, memory: [], sampleRate: rate, channels: 1, startHostSeconds: 100.0,
            hostTimeEstimated: false, frames: samples.count, gapFrames: 0, loudest: 0.5
        )
        // Back-dated so the offset is a whole millisecond already (no frames dropped).
        let raw = JamRecorder.Raw(capture: capture, fromMs: 0, backingStartSeconds: 100.0)
        let out = directory.appendingPathComponent("exact.flac")
        let take = try JamTakeBuilder.build(raw: raw, latency: latency(0), outputURL: out)
        XCTAssertEqual(take.timing.offsetMs, 0)
        XCTAssertEqual(take.frames, 96_000)
        let stored = try readMono(out)
        XCTAssertEqual(stored.samples.count, 96_000, "no frame lost or added")
        XCTAssertEqual(stored.samples[24_000], 0.5, accuracy: 1.0 / 32_768)
        XCTAssertEqual(stored.samples[70_001], -0.25, accuracy: 1.0 / 32_768)
        XCTAssertEqual(stored.samples[24_001], 0)
        // It is a FLAC file, 16 bit.
        let head = try Data(contentsOf: out).prefix(4)
        XCTAssertEqual(String(decoding: head, as: UTF8.self), "fLaC")
        XCTAssertEqual(take.byteSize, try FileManager.default.attributesOfItem(atPath: out.path)[.size] as? Int)
        XCTAssertFalse(FileManager.default.fileExists(atPath: url.path), "the raw capture is removed once the take is built")
    }

    func testLeadingSamplesAreDroppedToLandOnAWholeMillisecond() throws {
        // A capture whose first sample belongs at -2023.4 ms: 0.4 ms is 19.2
        // frames at 48 kHz, so 19 are dropped and the offset is -2023.
        let rate = 48_000.0
        let frames = 200_000
        var samples = [Float](repeating: 0, count: frames)
        // The click is at song time 0 + 1 s.
        let h0 = 1000.0
        let captureStart = h0 - 2.0234
        let index = Int(((h0 + 1.0 - captureStart) * rate).rounded())
        samples[index] = 0.9
        let url = try writeRaw([samples], rate: rate)
        let capture = JamCaptureSink.Capture(
            url: url, memory: [], sampleRate: rate, channels: 1, startHostSeconds: captureStart,
            hostTimeEstimated: false, frames: frames, gapFrames: 0, loudest: 0.9
        )
        let raw = JamRecorder.Raw(capture: capture, fromMs: 0, backingStartSeconds: h0)
        let out = directory.appendingPathComponent("whole.flac")
        let take = try JamTakeBuilder.build(raw: raw, latency: latency(0), outputURL: out)
        XCTAssertEqual(take.timing.offsetMs, -2023)
        XCTAssertEqual(take.frames, frames - 19)
        XCTAssertEqual(take.timing.trimStartMs, 2023)
        let stored = try readMono(out)
        let click = peakIndex(stored.samples)!
        XCTAssertEqual(JamTakePlacement.songMs(ofSample: click, offsetMs: -2023, sampleRate: rate), 1000, accuracy: 1 / 48.0 + 1e-6)
    }

    func testAnInterfaceThatPutsTheGuitarOnOneSideKeepsThatSide() throws {
        let rate = 48_000.0
        var left = [Float](repeating: 0, count: 48_000)
        let right = [Float](repeating: 0.0001, count: 48_000)
        left[1000] = 0.6
        let url = try writeRaw([left, right], rate: rate)
        let capture = JamCaptureSink.Capture(
            url: url, memory: [], sampleRate: rate, channels: 2, startHostSeconds: 50, hostTimeEstimated: false,
            frames: 48_000, gapFrames: 0, loudest: 0.6
        )
        let out = directory.appendingPathComponent("stereo.flac")
        let take = try JamTakeBuilder.build(
            raw: JamRecorder.Raw(capture: capture, fromMs: 0, backingStartSeconds: 50), latency: latency(0), outputURL: out
        )
        XCTAssertEqual(take.monoChoice, "left")
        let stored = try readMono(out)
        XCTAssertEqual(stored.samples[1000], 0.6, accuracy: 1.0 / 32_768)
    }

    func testTheCountInIsHiddenSoItsClicksDoNotMakeASilentTakeLookAlive() throws {
        let rate = 48_000.0
        var samples = [Float](repeating: 0, count: 48_000 * 6)
        // Loud clicks in the first 2.4 s (the count-in leaking into the microphone), nothing after.
        for k in 0..<4 { samples[Int(Double(k) * 0.6 * rate) + 5000] = 0.7 }
        let url = try writeRaw([samples], rate: rate)
        let h0 = 200.0
        let capture = JamCaptureSink.Capture(
            url: url, memory: [], sampleRate: rate, channels: 1, startHostSeconds: h0 - 2.4 - 0.1,
            hostTimeEstimated: false, frames: samples.count, gapFrames: 0, loudest: 0.7
        )
        let take = try JamTakeBuilder.build(
            raw: JamRecorder.Raw(capture: capture, fromMs: 0, backingStartSeconds: h0), latency: latency(20),
            outputURL: directory.appendingPathComponent("silent.flac")
        )
        XCTAssertTrue(take.isSilent, "the part that is heard is silent")
        XCTAssertLessThan(take.loudestHeard, JamTakePeaks.silentPeak)
        XCTAssertGreaterThan(take.peaks.max() ?? 0, 0.6, "the peaks of the WHOLE take still show the count-in, greyed out in the lane")
    }

    // MARK: The capture sink

    func testTheSinkStampsTheFirstSampleAndFillsAGapWithSilence() throws {
        let sink = JamCaptureSink(fileURL: nil, keepInMemory: true)
        let format = AVAudioFormat(standardFormatWithSampleRate: 48_000, channels: 1)!
        func buffer(_ value: Float, frames: Int) -> AVAudioPCMBuffer {
            let b = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: AVAudioFrameCount(frames))!
            b.frameLength = AVAudioFrameCount(frames)
            for i in 0..<frames { b.floatChannelData![0][i] = value }
            return b
        }
        let ticks = JamHostClock.ticks(fromSeconds: 77.5)
        sink.append(buffer(0.1, frames: 1024), when: AVAudioTime(hostTime: ticks, sampleTime: 10_000, atRate: 48_000))
        // The next buffer should start at 11_024: a device that dropped 976 frames.
        sink.append(buffer(0.2, frames: 1024), when: AVAudioTime(hostTime: ticks + 1, sampleTime: 12_000, atRate: 48_000))
        let capture = try XCTUnwrap(sink.finish())
        XCTAssertEqual(capture.startHostSeconds, 77.5, accuracy: 1e-6)
        XCTAssertFalse(capture.hostTimeEstimated)
        XCTAssertEqual(capture.gapFrames, 976)
        XCTAssertEqual(capture.frames, 1024 + 976 + 1024)
        XCTAssertEqual(capture.memory[0].count, capture.frames)
        XCTAssertEqual(capture.memory[0][1023], 0.1, accuracy: 1e-6)
        XCTAssertEqual(capture.memory[0][1024], 0, "the gap is silence, not closed up")
        XCTAssertEqual(capture.memory[0][1024 + 975], 0)
        XCTAssertEqual(capture.memory[0][2000], 0.2, accuracy: 1e-6)
        XCTAssertEqual(capture.loudest, 0.2, accuracy: 1e-6)
    }

    func testTheSinkWritesAFileAsItGoes() throws {
        let url = directory.appendingPathComponent("sink.caf")
        let sink = JamCaptureSink(fileURL: url, keepInMemory: false)
        let format = AVAudioFormat(standardFormatWithSampleRate: 48_000, channels: 1)!
        for n in 0..<10 {
            let b = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: 480)!
            b.frameLength = 480
            for i in 0..<480 { b.floatChannelData![0][i] = Float(n) / 10 }
            sink.append(b, when: AVAudioTime(hostTime: JamHostClock.ticks(fromSeconds: 10) + UInt64(n), sampleTime: AVAudioFramePosition(n * 480), atRate: 48_000))
        }
        let capture = try XCTUnwrap(sink.finish())
        XCTAssertEqual(capture.frames, 4800)
        let stored = try readMono(url)
        XCTAssertEqual(stored.samples.count, 4800)
        XCTAssertEqual(stored.samples[480 * 7 + 3], 0.7, accuracy: 1e-6)
        XCTAssertEqual(sink.takeMeterPeak(), 0.9, accuracy: 1e-6)
        XCTAssertEqual(sink.takeMeterPeak(), 0, "reading the meter starts the next window")
    }

    func testALateTapCallbackAfterFinishChangesNothing() throws {
        let sink = JamCaptureSink(fileURL: nil, keepInMemory: true)
        let format = AVAudioFormat(standardFormatWithSampleRate: 48_000, channels: 1)!
        let b = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: 480)!
        b.frameLength = 480
        for i in 0..<480 { b.floatChannelData![0][i] = 0.3 }
        sink.append(b, when: AVAudioTime(hostTime: JamHostClock.ticks(fromSeconds: 5), sampleTime: 0, atRate: 48_000))
        let capture = try XCTUnwrap(sink.finish())
        // The tap was removed while a callback was in flight: it arrives after the capture was handed over.
        sink.append(b, when: AVAudioTime(hostTime: JamHostClock.ticks(fromSeconds: 5.01), sampleTime: 480, atRate: 48_000))
        XCTAssertEqual(sink.capturedFrames, capture.frames, "the capture returned is the capture there is")
        XCTAssertEqual(capture.frames, 480)
    }

    func testTheSinkEstimatesTheStartWhenTheBufferHasNoHostTime() throws {
        let sink = JamCaptureSink(fileURL: nil, keepInMemory: true)
        let format = AVAudioFormat(standardFormatWithSampleRate: 48_000, channels: 1)!
        let b = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: 480)!
        b.frameLength = 480
        sink.append(b, when: AVAudioTime(sampleTime: 0, atRate: 48_000))
        let capture = try XCTUnwrap(sink.finish())
        XCTAssertTrue(capture.hostTimeEstimated, "the studio says to calibrate when the stamp was a guess")
        XCTAssertEqual(capture.startHostSeconds, JamHostClock.nowSeconds, accuracy: 0.5)
    }
}

// MARK: - The arithmetic, alone

final class JamRecordingMathTests: XCTestCase {
    func testTheFormulaFromTheLatencyModel() {
        // Capture began 2.4 s + 0.18 s before the band, 33 ms of round trip:
        // the first sample belongs 2613 ms before the song's start.
        let clock = JamTakeClock(
            sampleRate: 48_000, fromMs: 0, backingStartSeconds: 100, captureStartSeconds: 100 - 2.58, roundTripMs: 33
        )
        XCTAssertEqual(clock.rawOffsetMs, -2613, accuracy: 1e-6)
        // Counted from a band that starts at 500 ms.
        var other = clock
        other.fromMs = 500
        XCTAssertEqual(other.rawOffsetMs, -2113, accuracy: 1e-6)
        // More latency puts the take earlier: it was heard late and played late.
        other.roundTripMs = 133
        XCTAssertEqual(other.rawOffsetMs, -2213, accuracy: 1e-6)
    }

    func testWholeMillisecondDropsFewerThanOneMillisecondOfSamples() {
        for rate in [48_000.0, 44_100.0] {
            for raw in [-2023.4, -2023.0, -0.0004, 0.6, 137.999, 5000.5] {
                let r = JamTakePlacement.wholeMillisecond(offsetMs: raw, sampleRate: rate)
                XCTAssertEqual(r.offsetMs, r.offsetMs.rounded(), "\(raw)")
                XCTAssertGreaterThanOrEqual(r.offsetMs, raw - 1e-6)
                XCTAssertLessThan(r.dropFrames, Int(rate / 1000) + 1)
                // What the dropped frames moved is under a sample.
                let moved = r.offsetMs - raw - Double(r.dropFrames) / rate * 1000
                XCTAssertEqual(moved, 0, accuracy: 1000 / rate, "\(raw) at \(rate)")
            }
        }
        XCTAssertEqual(JamTakePlacement.wholeMillisecond(offsetMs: -2023, sampleRate: 48_000).dropFrames, 0)
    }

    func testTheHeadTrimHidesEverythingBeforeTheBand() {
        XCTAssertEqual(JamTakePlacement.trimStartMs(fromMs: 0, offsetMs: -2023, durationMs: 60_000), 2023)
        XCTAssertEqual(JamTakePlacement.trimStartMs(fromMs: 500, offsetMs: -1523, durationMs: 60_000), 2023)
        XCTAssertEqual(JamTakePlacement.trimStartMs(fromMs: 0, offsetMs: 120, durationMs: 60_000), 0, "never negative")
        XCTAssertEqual(JamTakePlacement.trimStartMs(fromMs: 0, offsetMs: -5000, durationMs: 3000), 3000, "never past the file")
    }

    func testTheCountIn() {
        let c = JamCountIn.standard
        XCTAssertEqual(c.totalBeats, 4)
        XCTAssertEqual(c.beatSeconds, 0.6, accuracy: 1e-9)
        XCTAssertEqual(c.durationSeconds, 2.4, accuracy: 1e-9)
        XCTAssertEqual(c.frames(sampleRate: 48_000), 115_200)
        let clicks = c.clicks(sampleRate: 48_000)
        XCTAssertEqual(clicks.map(\.frame), [0, 28_800, 57_600, 86_400])
        XCTAssertEqual(clicks.map(\.accent), [true, false, false, false])
        let samples = c.samples(sampleRate: 48_000)
        XCTAssertEqual(samples.count, 115_200)
        XCTAssertEqual(samples[0], 0, "a click starts at silence")
        XCTAssertGreaterThan(samples[28_800 + 40], 0.1, "the second beat is audible")
        XCTAssertEqual(samples[28_800 - 1], 0, "and silence is silence between")
        XCTAssertTrue(c.isValid)
        XCTAssertFalse(JamCountIn(bars: 1, beatsPerBar: 4, bpm: 0).isValid, "a tempo of 0 would loop a scheduler forever")
        XCTAssertEqual(JamCountIn(bars: 0, beatsPerBar: 4, bpm: 100).frames(sampleRate: 48_000), 0)
    }

    func testNudge() {
        var e = JamTakeEdits()
        XCTAssertFalse(e.isEdited)
        e = e.nudged(by: 5).nudged(by: 5)
        XCTAssertEqual(e.nudgeMs, 10)
        XCTAssertTrue(e.isEdited)
        XCTAssertEqual(e.nudged(by: 10_000).nudgeMs, 500, "limited either way")
        XCTAssertEqual(e.nudged(by: -10_000).nudgeMs, -500)
        let take = JamTakeTiming(offsetMs: -2023, trimStartMs: 2023, trimEndMs: 0, durationMs: 60_000)
        let placed = e.placed(take)
        XCTAssertEqual(placed.offsetMs, -2013)
        XCTAssertEqual(placed.trimStartMs, 2023, "a nudge moves the audio; a trim never does")
        XCTAssertEqual(placed.durationMs, 60_000)
        XCTAssertEqual(JamTakeEdits.holdStep(afterRepeats: 0), 5)
        XCTAssertGreaterThan(JamTakeEdits.holdStep(afterRepeats: 30), JamTakeEdits.holdStep(afterRepeats: 0))
    }

    func testPeaks() {
        XCTAssertEqual(JamTakePeaks.compute([]), [])
        let samples: [Float] = (0..<4000).map { $0 == 1500 ? -0.5 : 0.001 }
        let peaks = JamTakePeaks.compute(samples, count: 400)
        XCTAssertEqual(peaks.count, 400)
        XCTAssertEqual(peaks[150], 0.5, accuracy: 0.001, "absolute, the loudest sample of its slice")
        XCTAssertEqual(peaks[0], 0.001, accuracy: 0.0005)
        XCTAssertEqual(JamTakePeaks.compute([0.5, 0.5], count: 400).count, 2, "never more buckets than samples")
        XCTAssertLessThanOrEqual(JamTakePeaks.compute([Float](repeating: 1, count: 100_000), count: 9999).count, 400)
        XCTAssertTrue(JamTakePeaks.isSilent(loudest: 0.009))
        XCTAssertFalse(JamTakePeaks.isSilent(loudest: 0.02))
    }

    func testMono() {
        let loud: [Float] = [0.5, -0.5, 0.5, -0.5]
        let quiet: [Float] = [0.001, 0.001, -0.001, 0.001]
        XCTAssertEqual(JamMono.choose([loud, quiet]).choice, .left)
        XCTAssertEqual(JamMono.choose([quiet, loud]).choice, .right)
        let mix = JamMono.choose([loud, loud])
        XCTAssertEqual(mix.choice, .mix)
        XCTAssertEqual(mix.samples, loud)
        XCTAssertEqual(JamMono.choose([loud]).choice, .mono)
    }

    func testStudioTimelineDoesNotJumpAbout() {
        XCTAssertEqual(JamStudioTimeline.recordingSpanMs(bandMs: 0, elapsedMs: 0), 20_000)
        XCTAssertEqual(JamStudioTimeline.recordingSpanMs(bandMs: 0, elapsedMs: 18_000), 20_000)
        XCTAssertEqual(JamStudioTimeline.recordingSpanMs(bandMs: 0, elapsedMs: 19_500), 30_000)
        XCTAssertEqual(JamStudioTimeline.recordingSpanMs(bandMs: 61_000, elapsedMs: 5000), 61_000)
        XCTAssertEqual(JamStudioTimeline.recordingSpanMs(bandMs: 61_000, elapsedMs: 70_000), 80_000)
    }

    func testTheHostClockRoundTrips() {
        let ticks = JamHostClock.ticks(fromSeconds: 12.345678)
        XCTAssertEqual(JamHostClock.seconds(fromTicks: ticks), 12.345678, accuracy: 1e-6)
        XCTAssertEqual(JamHostClock.ticks(fromSeconds: -1), 0)
    }
}

// MARK: - Latency

final class JamLatencyTests: XCTestCase {
    private func result(_ method: JamLatencyMethod, _ ms: Double, confidence: JamLatencyConfidence = .high, at: Double = 0, out: Double? = 12) -> JamLatencyResult {
        JamLatencyResult(
            method: method, roundTripMs: ms, confidence: confidence, spreadMs: 0.1, accepted: 10, played: 10,
            at: Date(timeIntervalSince1970: at), reportedOutputMs: out
        )
    }

    func testTheEstimateIsWhatTheSessionReports() {
        let e = JamLatencyRules.estimate(outputLatency: 0.012, inputLatency: 0.008)
        XCTAssertEqual(e.roundTripMs, 20, accuracy: 1e-6)
        XCTAssertEqual(e.method, .estimate)
        XCTAssertEqual(e.confidence, .low, "never better than low: no OS promises the two add up")
        XCTAssertEqual(e.reportedOutputMs ?? 0, 12, accuracy: 1e-6)
        // Nothing reported (a simulator): the input is assumed, the output is not invented.
        let blank = JamLatencyRules.estimate(outputLatency: 0, inputLatency: 0)
        XCTAssertEqual(blank.roundTripMs, JamLatencyRules.assumedInputMs)
        XCTAssertEqual(JamLatencyRules.estimate(outputLatency: .nan, inputLatency: -1).roundTripMs, JamLatencyRules.assumedInputMs)
    }

    func testAMeasurementBeatsTheEstimateAndLoopbackBeatsTapping() {
        let estimate = JamLatencyRules.estimate(outputLatency: 0.012, inputLatency: 0.008)
        XCTAssertEqual(JamLatencyRules.choose(stored: [], estimate: estimate, currentOutputMs: 12).method, .estimate)
        let tap = result(.tapAlong, 41, at: 100)
        let loop = result(.loopback, 33, at: 50)
        XCTAssertEqual(JamLatencyRules.choose(stored: [tap, loop], estimate: estimate, currentOutputMs: 12).method, .loopback)
        XCTAssertEqual(JamLatencyRules.choose(stored: [tap], estimate: estimate, currentOutputMs: 12).method, .tapAlong)
        let manual = result(.manual, 60)
        XCTAssertEqual(JamLatencyRules.choose(stored: [tap, loop, manual], estimate: estimate, currentOutputMs: 12).method, .manual)
        // Newest of a kind.
        let newer = result(.loopback, 35, at: 900)
        XCTAssertEqual(JamLatencyRules.choose(stored: [loop, newer], estimate: estimate, currentOutputMs: 12).roundTripMs, 35)
        // A failed one is no answer.
        XCTAssertEqual(JamLatencyRules.choose(stored: [result(.loopback, .nan, confidence: .failed)], estimate: estimate, currentOutputMs: 12).method, .estimate)
    }

    func testACalibrationIsStaleWhenTheOutputPathMovedUnderTheSameRoute() {
        let estimate = JamLatencyRules.estimate(outputLatency: 0.012, inputLatency: 0.008)
        let loop = result(.loopback, 33, out: 12)
        XCTAssertFalse(JamLatencyRules.isStale(loop, currentOutputMs: 15), "inside the drift")
        XCTAssertTrue(JamLatencyRules.isStale(loop, currentOutputMs: 12 + JamLatencyRules.staleOutputDriftMs + 1))
        XCTAssertEqual(JamLatencyRules.choose(stored: [loop], estimate: estimate, currentOutputMs: 80).method, .estimate)
        XCTAssertFalse(JamLatencyRules.isStale(result(.manual, 40), currentOutputMs: 500), "a typed number is never stale")
    }

    func testCalibrationsAreRememberedPerRoute() {
        let suite = UserDefaults(suiteName: "jam-latency-\(UUID().uuidString)")!
        let store = JamLatencyStore(defaults: suite)
        let a = JamAudioRoute(outputKind: .wired, outputName: "Headphones", outputUID: "H1", inputName: "iPhone Microphone", inputUID: "M1", sampleRate: 48_000, reportedOutputMs: 12)
        var b = a
        b.outputName = "AirPods"
        b.outputUID = "AP"
        XCTAssertNotEqual(a.key, b.key)
        XCTAssertEqual(a.key, a.key)
        store.save(result(.loopback, 33), for: a.key)
        store.save(result(.tapAlong, 41), for: a.key)
        store.save(result(.loopback, 35, at: 10), for: a.key)
        XCTAssertEqual(store.results(for: a.key).count, 2, "the newest per method")
        XCTAssertEqual(store.results(for: a.key).first { $0.method == .loopback }?.roundTripMs, 35)
        XCTAssertEqual(store.results(for: b.key).count, 0)
        store.save(result(.loopback, .nan, confidence: .failed), for: b.key)
        store.save(JamLatencyRules.estimate(outputLatency: 0.01, inputLatency: 0.01), for: b.key)
        XCTAssertEqual(store.results(for: b.key).count, 0, "neither a failure nor an estimate is a calibration")
        store.clear(method: .loopback, for: a.key)
        XCTAssertEqual(store.results(for: a.key).map(\.method), [.tapAlong])
        // The sample rate is part of the route.
        var c = a
        c.sampleRate = 44_100
        XCTAssertNotEqual(a.key, c.key)
    }

    func testWhatARouteIs() {
        func route(_ kind: JamRouteKind, out: Double = 12) -> JamAudioRoute {
            JamAudioRoute(outputKind: kind, outputName: "x", outputUID: "x", inputName: "y", inputUID: "y", sampleRate: 48_000, reportedOutputMs: out)
        }
        XCTAssertEqual(route(.wired).assessment, .fine)
        XCTAssertEqual(route(.speaker).assessment, .speaker, "bleed")
        XCTAssertEqual(route(.wireless).assessment, .wireless)
        XCTAssertEqual(route(.wired, out: 180).assessment, .wireless, "what Bluetooth looks like, whatever the port says")
        XCTAssertEqual(JamRouteKind.of(output: .builtInSpeaker), .speaker)
        XCTAssertEqual(JamRouteKind.of(output: .builtInReceiver), .speaker)
        XCTAssertEqual(JamRouteKind.of(output: .headphones), .wired)
        XCTAssertEqual(JamRouteKind.of(output: .usbAudio), .wired)
        XCTAssertEqual(JamRouteKind.of(output: .bluetoothA2DP), .wireless)
        XCTAssertEqual(JamRouteKind.of(output: .bluetoothHFP), .wireless)
        XCTAssertEqual(JamRouteKind.of(output: .airPlay), .wireless)
    }

    func testOnlyAHeadphoneOrADeviceChangeEndsATake() {
        XCTAssertTrue(JamRouteChange.endsATake(.oldDeviceUnavailable))
        XCTAssertTrue(JamRouteChange.endsATake(.newDeviceAvailable))
        XCTAssertFalse(JamRouteChange.endsATake(.categoryChange), "our own category change")
        XCTAssertFalse(JamRouteChange.endsATake(.override))
        XCTAssertFalse(JamRouteChange.endsATake(nil))
    }
}

// MARK: - Measuring it

final class JamCalibrationMeasurementTests: XCTestCase {
    private let rate = 48_000.0

    /// What a loopback records: each sweep again, `lagMs` after it left, with
    /// whatever else is in the room.
    private func recording(
        lagMs: Double, pulses: Int = 10, reflection: (delayMs: Double, gain: Float)? = nil,
        gain: Float = 1, invert: Bool = false, noise: Float = 0.002
    ) -> (captured: [Float], emitted: [Int], reference: [Float]) {
        let reference = JamSignals.sweep(sampleRate: rate)
        let first = Int(0.3 * rate), period = Int(0.6 * rate)
        let emitted = (0..<pulses).map { first + $0 * period }
        var captured = [Float](repeating: 0, count: first + pulses * period + Int(rate))
        var seed: UInt32 = 12345
        for i in 0..<captured.count {
            seed = seed &* 1_664_525 &+ 1_013_904_223
            captured[i] = (Float(seed >> 8) / Float(1 << 24) - 0.5) * 2 * noise
        }
        let lag = Int((lagMs / 1000 * rate).rounded())
        for e in emitted {
            for (i, v) in reference.enumerated() {
                captured[e + lag + i] += (invert ? -1 : 1) * gain * v
                if let r = reflection {
                    captured[e + lag + Int(r.delayMs / 1000 * rate) + i] += r.gain * v
                }
            }
        }
        return (captured, emitted, reference)
    }

    func testALoopbackFindsTheRoundTripToAFractionOfAMillisecond() {
        for lag in [0.0, 5.0, 33.3, 87.5, 187.0, 410.0] {
            let r = recording(lagMs: lag)
            let result = JamLatencyAnalysis.loopback(
                captured: r.captured, emittedFrames: r.emitted, reference: r.reference, sampleRate: rate, maxLatencyMs: 550
            )
            XCTAssertEqual(result.roundTripMs, lag, accuracy: 0.05, "lag \(lag)")
            XCTAssertEqual(result.confidence, .high, "lag \(lag)")
            XCTAssertEqual(result.accepted, 10)
            XCTAssertEqual(result.method, .loopback)
        }
    }

    func testTheDirectSoundWinsOverAnEchoOffAWall() {
        // A wall 1 m away: the echo is 6 ms later and 1.4 times louder at the microphone.
        let r = recording(lagMs: 33, reflection: (6, 1.4), gain: 1)
        let result = JamLatencyAnalysis.loopback(
            captured: r.captured, emittedFrames: r.emitted, reference: r.reference, sampleRate: rate, maxLatencyMs: 550
        )
        XCTAssertEqual(result.roundTripMs, 33, accuracy: 0.1)
    }

    func testAMicrophoneThatInvertsStillMeasures() {
        let r = recording(lagMs: 41, invert: true)
        let result = JamLatencyAnalysis.loopback(
            captured: r.captured, emittedFrames: r.emitted, reference: r.reference, sampleRate: rate, maxLatencyMs: 550
        )
        XCTAssertEqual(result.roundTripMs, 41, accuracy: 0.05)
    }

    func testAMicrophoneThatCannotHearTheOutputFails() {
        let r = recording(lagMs: 33, gain: 0)
        let result = JamLatencyAnalysis.loopback(
            captured: r.captured, emittedFrames: r.emitted, reference: r.reference, sampleRate: rate, maxLatencyMs: 550
        )
        XCTAssertEqual(result.confidence, .failed)
        XCTAssertFalse(result.isUsable)
        XCTAssertTrue(JamLatencyAnalysis.loopback(
            captured: [], emittedFrames: r.emitted, reference: r.reference, sampleRate: rate, maxLatencyMs: 550
        ).confidence == .failed)
    }

    func testASweepThatLeftBeforeTheCaptureBeganIsNotCounted() {
        let r = recording(lagMs: 20)
        let shifted = r.emitted.map { $0 - 20_000 }
        // The captured array is the same, so the first pulses sit at negative frames: skipped, the rest still read.
        let result = JamLatencyAnalysis.loopback(
            captured: Array(r.captured.dropFirst(0)), emittedFrames: shifted + r.emitted, reference: r.reference,
            sampleRate: rate, maxLatencyMs: 550
        )
        XCTAssertEqual(result.played, 20)
    }

    private func taps(lagMs: Double, jitterMs: [Double], missing: Set<Int> = []) -> (captured: [Float], clicks: [Int]) {
        let beat = Int(0.6 * rate), first = Int(0.5 * rate)
        let clicks = (0..<12).map { first + $0 * beat }
        var captured = [Float](repeating: 0, count: first + 12 * beat + Int(rate))
        let tap = JamSignals.metronomeClick(sampleRate: rate, accent: false)
        for (k, click) in clicks.enumerated() where !missing.contains(k) {
            let at = click + Int((lagMs + jitterMs[k % jitterMs.count]) / 1000 * rate)
            for (i, v) in tap.enumerated() { captured[at + i] += v }
        }
        return (captured, clicks)
    }

    func testTappingAlongFindsTheRoundTripAHumanWouldMake() {
        let t = taps(lagMs: 52, jitterMs: [-2, 1.5, 0, 2.5, -1, 0.5])
        let result = JamLatencyAnalysis.tapAlong(captured: t.captured, clickFrames: t.clicks, sampleRate: rate)
        XCTAssertEqual(result.method, .tapAlong)
        XCTAssertEqual(result.roundTripMs, 52, accuracy: 2)
        XCTAssertNotEqual(result.confidence, .failed)
        XCTAssertEqual(result.played, 10, "the first two taps are the player finding the beat")
    }

    func testTappingAlongWithMostTapsMissingFails() {
        let t = taps(lagMs: 52, jitterMs: [0], missing: Set(0..<11))
        let result = JamLatencyAnalysis.tapAlong(captured: t.captured, clickFrames: t.clicks, sampleRate: rate)
        XCTAssertEqual(result.confidence, .failed)
    }

    func testAPlayerWhoAnticipatesTheBeatDoesNotSaveANegativeCalibration() {
        let t = taps(lagMs: -40, jitterMs: [0, 1, -1])
        let result = JamLatencyAnalysis.tapAlong(captured: t.captured, clickFrames: t.clicks, sampleRate: rate)
        XCTAssertEqual(result.confidence, .failed, "a round trip is never negative")
        XCTAssertFalse(result.isUsable)
        let steady = taps(lagMs: 52, jitterMs: [0])
        let ok = JamLatencyAnalysis.tapAlong(captured: steady.captured, clickFrames: steady.clicks, sampleRate: rate)
        XCTAssertNotEqual(ok.confidence, .high, "a tap carries the person's own timing: never better than a rough adjustment")
    }

    func testTheSignalsAreWhatTheMeasurementExpects() {
        for method in [JamCalibrator.Method.loopback, .tapAlong] {
            let s = JamCalibrator.signal(method, rate: rate)
            XCTAssertFalse(s.train.isEmpty)
            XCTAssertTrue(s.at.allSatisfy { $0 >= 0 && $0 < s.train.count })
            XCTAssertEqual(s.at.count, method == .loopback ? 10 : 12)
            XCTAssertLessThan(Double(s.train.count) / rate, JamCalibrator.durationSeconds(method))
        }
        let loop = JamCalibrator.signal(.loopback, rate: rate)
        XCTAssertEqual(Double(loop.at[1] - loop.at[0]) / rate * 1000, JamCalibrator.loopbackPeriodMs, accuracy: 0.05)
        XCTAssertLessThan(JamCalibrator.loopbackMaxLatencyMs, JamCalibrator.loopbackPeriodMs, "the window must be shorter than the period")
        XCTAssertGreaterThan(loop.train.map { abs($0) }.max() ?? 0, 0.4)
    }
}

// MARK: - Who may record, and what a refusal says

final class JamRecordFlowTests: XCTestCase {
    private func song(
        mode: JamJoinMode = .open, wanted: [JamInstrument] = [], present: [JamInstrument] = [], tracks: Int = 1
    ) -> JamSongSummary {
        JamSongSummary(
            id: "s", channelId: "c", serverId: "v", title: "In Bloom", joinMode: mode, wantedInstruments: wanted,
            trackCount: tracks, instruments: present, missingInstruments: mode == .wanted ? wanted.filter { !present.contains($0) } : []
        )
    }

    func testWhyAViewerCannotRecord() {
        let on = JamConfig(enabled: true, uploads: true)
        XCTAssertNil(JamRecordEligibility.cannotRecord(config: on, addable: [.guitar], joinMode: .open))
        XCTAssertEqual(JamRecordEligibility.cannotRecord(config: .off, addable: [.guitar], joinMode: .open), .off)
        XCTAssertEqual(JamRecordEligibility.cannotRecord(config: JamConfig(enabled: true, uploads: false), addable: [.guitar], joinMode: .open), .uploadsOff)
        XCTAssertEqual(JamRecordEligibility.cannotRecord(config: on, addable: [], joinMode: .closed), .closed)
        XCTAssertEqual(JamRecordEligibility.cannotRecord(config: on, addable: [], joinMode: .open), .other)
    }

    func testTheStudioPreselectsWhatTheSongAsksFor() {
        let all = JamInstrument.allCases
        let wanting = song(mode: .wanted, wanted: [.vocals, .bass], present: [.guitar])
        XCTAssertEqual(JamRecordEligibility.pickInstrument(song: wanting, addable: [.vocals, .bass], mine: []), .vocals)
        XCTAssertEqual(JamRecordEligibility.pickInstrument(song: wanting, addable: [.bass], mine: []), .bass, "never one the viewer may not add")
        let open = song(present: [.guitar, .bass])
        XCTAssertEqual(JamRecordEligibility.pickInstrument(song: open, addable: all, mine: []), .drums, "the first one nobody plays yet")
        let mine = JamTrack(id: "t", songId: "s", authorId: "me", instrument: .drums)
        XCTAssertEqual(JamRecordEligibility.pickInstrument(song: open, addable: all, mine: [mine]), .vocals)
        XCTAssertNil(JamRecordEligibility.pickInstrument(song: open, addable: [], mine: []))
        XCTAssertEqual(JamRecordEligibility.pickInstrument(song: song(tracks: 0), addable: all, mine: []), .guitar)
    }

    func testTheServersRefusalsAreToldInThePersonsTerms() {
        XCTAssertEqual(JamErrorKind.of(APIError.server(status: 403, message: "jam_channels_off")), .off)
        XCTAssertEqual(JamErrorKind.of(APIError.server(status: 403, message: "jam_song_closed")), .closed)
        XCTAssertEqual(JamErrorKind.of(APIError.server(status: 403, message: "jam_instrument_not_wanted")), .instrumentNotWanted)
        XCTAssertEqual(JamErrorKind.of(APIError.server(status: 409, message: "jam_song_full")), .songFull)
        XCTAssertEqual(JamErrorKind.of(APIError.server(status: 409, message: "jam_author_track_limit")), .authorTrackLimit)
        XCTAssertEqual(JamErrorKind.of(APIError.server(status: 413, message: "whatever")), .tooLarge)
        XCTAssertEqual(JamErrorKind.of(APIError.server(status: 503, message: "jam_storage_off")), .storageOff)
        XCTAssertEqual(JamErrorKind.of(APIError.rateLimited(retryAfter: 4)), .rateLimited)
        XCTAssertEqual(JamErrorKind.of(APIError.notFound("jam_song_not_found")), .gone)
        XCTAssertEqual(JamErrorKind.of(APIError.transport("offline")), .network)
        XCTAssertEqual(JamErrorKind.of(URLError(.notConnectedToInternet)), .network)
        XCTAssertEqual(JamErrorKind.of(APIError.server(status: 500, message: "boom")), .other)
        // What no retry can fix is not offered a retry.
        for kind in [JamErrorKind.off, .closed, .instrumentNotWanted, .songFull, .authorTrackLimit, .tooLarge, .storageOff, .gone] {
            XCTAssertTrue(kind.isFinal, "\(kind)")
        }
        for kind in [JamErrorKind.network, .rateLimited, .other] { XCTAssertFalse(kind.isFinal, "\(kind)") }
    }

    func testANewSongDraft() throws {
        var draft = JamSongDraft()
        XCTAssertEqual(draft.problem, .needTitle)
        draft.title = "  In \n  Bloom "
        XCTAssertEqual(draft.cleanTitle, "In Bloom")
        XCTAssertNil(draft.problem)
        XCTAssertNil(draft.cleanArtist, "empty means an original")
        draft.artist = " Nirvana "
        XCTAssertEqual(draft.cleanArtist, "Nirvana")
        draft.joinMode = .wanted
        XCTAssertEqual(draft.problem, .needWanted)
        draft.wantedInstruments = [.vocals]
        XCTAssertNil(draft.problem)
        draft.title = String(repeating: "x", count: 101)
        XCTAssertEqual(draft.problem, .titleTooLong)
        draft.title = "In Bloom"
        let json = try JSONSerialization.jsonObject(with: JSONEncoder().encode(draft.body)) as! [String: Any]
        XCTAssertEqual(Set(json.keys), ["title", "artist", "joinMode", "wantedInstruments", "nonce"])
        XCTAssertEqual(json["joinMode"] as? String, "wanted")
        XCTAssertEqual(json["wantedInstruments"] as? [String], ["vocals"])
        // Any other mode stores an empty list whatever was picked.
        draft.joinMode = .open
        let open = try JSONSerialization.jsonObject(with: JSONEncoder().encode(draft.body)) as! [String: Any]
        XCTAssertEqual(open["wantedInstruments"] as? [String], [])
        // One nonce per attempt, kept across its retries.
        XCTAssertEqual(draft.body.nonce, draft.body.nonce)
        XCTAssertNotEqual(JamSongDraft().nonce, JamSongDraft().nonce)
    }

    func testAPostKeepsItsTicketAcrossRetries() {
        var state = JamPostState()
        XCTAssertFalse(state.ticketUsable())
        state.ticket = JamUploadTicket(uploadId: "u", uploadUrl: "https://x", expiresAt: Date().addingTimeInterval(600))
        XCTAssertTrue(state.ticketUsable())
        state.ticket = JamUploadTicket(uploadId: "u", uploadUrl: "https://x", expiresAt: Date().addingTimeInterval(30))
        XCTAssertFalse(state.ticketUsable(), "under a minute left is not worth the PUT")
        state.ticket = JamUploadTicket(uploadId: "u", uploadUrl: "https://x", expiresAt: nil)
        XCTAssertTrue(state.ticketUsable())
    }
}

// MARK: - The audio session

@MainActor
final class JamRecordingSessionTests: XCTestCase {
    final class Fake: JamRecordingSessionDriver {
        var category: AVAudioSession.Category = .ambient
        var mode: AVAudioSession.Mode = .default
        var categoryOptions: AVAudioSession.CategoryOptions = []
        var sampleRate = 48_000.0
        var inputLatency = 0.005
        var outputLatency = 0.012
        var ioBufferDuration = 0.005
        var active = false
        var refuseActivation = false
        var calls: [String] = []

        func setCategory(_ category: AVAudioSession.Category, mode: AVAudioSession.Mode, options: AVAudioSession.CategoryOptions) throws {
            calls.append("category \(category.rawValue) \(mode.rawValue)")
            self.category = category
            self.mode = mode
            categoryOptions = options
        }
        func setPreferredSampleRate(_ rate: Double) throws { calls.append("rate \(rate)") }
        func setPreferredIOBufferDuration(_ duration: TimeInterval) throws { calls.append("buffer \(duration)") }
        func setActive(_ active: Bool, options: AVAudioSession.SetActiveOptions) throws {
            if refuseActivation && active { throw NSError(domain: NSOSStatusErrorDomain, code: 561017449) }
            calls.append("active \(active)")
            self.active = active
        }
    }

    func testItRecordsLikeAMusicianAndNotLikeACaller() throws {
        let fake = Fake()
        let session = JamRecordingSession(driver: fake)
        try session.activate()
        XCTAssertEqual(fake.category, .playAndRecord)
        XCTAssertEqual(fake.mode, .default, "no voice processing: it would thin out an instrument and duck the band")
        XCTAssertTrue(fake.categoryOptions.contains(.defaultToSpeaker))
        XCTAssertTrue(fake.categoryOptions.contains(.allowBluetoothA2DP))
        XCTAssertFalse(fake.categoryOptions.contains(.allowBluetooth), "the hands-free profile is a telephone microphone")
        XCTAssertTrue(fake.calls.contains("rate 48000.0"))
        XCTAssertTrue(fake.active)
        XCTAssertTrue(session.isHolding)
    }

    func testItGivesTheSessionBackAsItFoundIt() throws {
        let fake = Fake()
        fake.category = .playback
        let session = JamRecordingSession(driver: fake)
        try session.activate()
        session.deactivate()
        XCTAssertFalse(fake.active)
        XCTAssertEqual(fake.category, .playback, "the previous category is put back")
        XCTAssertFalse(session.isHolding)
    }

    func testItLeavesACallsSessionAlone() throws {
        let fake = Fake()
        let session = JamRecordingSession(driver: fake)
        try session.activate()
        // A call takes the session after the studio did.
        fake.mode = .voiceChat
        fake.calls = []
        session.deactivate()
        XCTAssertEqual(fake.calls, [], "a blind deactivate would end the call's audio")
        XCTAssertEqual(fake.mode, .voiceChat)
    }

    func testAFailedActivationLeavesNothingChanged() {
        let fake = Fake()
        fake.category = .playback
        fake.refuseActivation = true
        let session = JamRecordingSession(driver: fake)
        XCTAssertThrowsError(try session.activate())
        XCTAssertEqual(fake.category, .playback)
        XCTAssertFalse(session.isHolding)
    }

    func testRecordingIsRefusedWhileInACall() {
        XCTAssertEqual(JamRecordingGate.refusal(callActive: true, category: .ambient, studioOwnsSession: false), .inCall)
        XCTAssertEqual(
            JamRecordingGate.refusal(callActive: false, category: .playAndRecord, studioOwnsSession: false), .inCall,
            "the same fact seen from the session: somebody holds the microphone"
        )
        XCTAssertNil(JamRecordingGate.refusal(callActive: false, category: .playback, studioOwnsSession: false))
        XCTAssertNil(JamRecordingGate.refusal(callActive: false, category: .playAndRecord, studioOwnsSession: true))
        XCTAssertNil(JamRecordingGate.refusal(callActive: false, category: .ambient, studioOwnsSession: false))
    }

    /// The voice client leaves `.playAndRecord` behind when a call ends, so the
    /// category must not keep the studio shut after the person left the call.
    func testALeftoverCallCategoryDoesNotKeepTheStudioShut() {
        XCTAssertNil(JamRecordingGate.refusal(
            callActive: false, category: .playAndRecord, studioOwnsSession: false, categoryProvesACall: false
        ))
        XCTAssertEqual(JamRecordingGate.refusal(
            callActive: true, category: .playAndRecord, studioOwnsSession: false, categoryProvesACall: false
        ), .inCall)
    }
}
