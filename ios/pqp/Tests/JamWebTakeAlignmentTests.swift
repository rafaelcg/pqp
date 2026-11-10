import AVFoundation
import XCTest
@testable import pqp

/// THE SYNC PROOF FOR SONGS AS THEY EXIST. Every track in production was
/// recorded and uploaded by the web engine, so the measurement plays three takes
/// shaped exactly the way the web recorder uploads them: FLAC from the web's own
/// encoder (`client/src/lib/jam/flac.ts`, no SEEKTABLE, 4096-frame blocks), a
/// negative `offsetMs` and a `trimStartMs` that hides the count-in and the round
/// trip, a head trim made in the editor, a tail trim, and one take at 44.1 kHz.
/// `ios/Scripts/make-jam-web-fixtures.sh` makes the files and documents them.
///
/// Each stem is silence with one-sample clicks at known SONG times: guitar on
/// every second, bass on every second + 250 ms, keys on every second + 500 ms.
/// Played in sync, every click lands at `songMs * 48` frames of a 48 kHz render
/// (the transport's zero is the earliest audible sample, song time 0 here).
/// What decides where a click lands is the web player's arithmetic
/// (`planSegment` in `client/src/lib/jam/timeline.ts`): buffer sample `j` of a
/// stem sounds at song time `offsetMs + j / rate`, whatever the trims. That is
/// what the person who recorded the song heard in Chrome.
///
/// Tolerances: one frame (21 µs) for the 48 kHz stems, which take no rate
/// conversion; the web suite asserts 1.5 samples. Half a millisecond (24 frames)
/// for the 44.1 kHz stem, which the mixer converts with a filter whose group
/// delay was measured at 17 frames (`JamEngineTests`).
@MainActor
final class JamWebTakeAlignmentTests: XCTestCase {
    // The recorder's numbers for the three fixtures (see the script).
    struct Take {
        let id: String
        let file: String
        let rate: Double
        let offsetMs: Double
        let trimStartMs: Double
        let trimEndMs: Double
        let durationMs: Double
        /// Where within each second this stem clicks, in ms.
        let phaseMs: Double
        /// Song times of every click in the stored file, audible or not.
        let clicks: [Double]

        var audibleFromMs: Double { offsetMs + trimStartMs }
        var audibleToMs: Double { offsetMs + durationMs - trimEndMs }
        var heard: [Double] { clicks.filter { $0 >= audibleFromMs && $0 < audibleToMs } }
    }

    static let guitar = Take(
        id: "guitar", file: "web-guitar-48000", rate: 48_000, offsetMs: -2023, trimStartMs: 2023, trimEndMs: 0,
        durationMs: 11_617_104 / 48.0, phaseMs: 0, clicks: [-1000] + (0...239).map { Double($0) * 1000 }
    )
    static let bass = Take(
        id: "bass", file: "web-bass-48000", rate: 48_000, offsetMs: -137, trimStartMs: 637, trimEndMs: 1000,
        durationMs: 11_526_576 / 48.0, phaseMs: 250, clicks: (0...239).map { Double($0) * 1000 + 250 }
    )
    static let keys = Take(
        id: "keys", file: "web-keys-44100", rate: 44_100, offsetMs: -2050, trimStartMs: 2050, trimEndMs: 0,
        durationMs: 10_674_405 / 44.1, phaseMs: 500, clicks: (0...239).map { Double($0) * 1000 + 500 }
    )
    static let takes = [guitar, bass, keys]

    static func url(_ take: Take) -> URL {
        URL(fileURLWithPath: #filePath)            // …/ios/pqp/Tests/JamWebTakeAlignmentTests.swift
            .deletingLastPathComponent()
            .appendingPathComponent("Fixtures/jam/\(take.file).flac")
    }

    private func loadedEngine(_ takes: [Take] = takes) throws -> JamEngine {
        let engine = JamEngine()
        let failures = engine.load(takes.map {
            JamEngine.Stem(id: $0.id, url: Self.url($0), offsetMs: $0.offsetMs,
                           trimStartMs: $0.trimStartMs, trimEndMs: $0.trimEndMs)
        })
        XCTAssertTrue(failures.isEmpty, "every fixture opens: \(failures)")
        return engine
    }

    func testTheFixturesAreWhatTheScriptSays() throws {
        for take in Self.takes {
            let file = try AVAudioFile(forReading: Self.url(take))
            XCTAssertEqual(file.processingFormat.sampleRate, take.rate, take.id)
            XCTAssertEqual(Double(file.length) / take.rate * 1000, take.durationMs, accuracy: 0.001, take.id)
        }
    }

    // MARK: What each codec does to time

    /// The Android suite's burst fixtures (a 10 ms Hann-windowed 3 kHz burst
    /// starting at exactly 0.5 s, `make-fixtures.sh`), opened the way the
    /// engine opens a stem. The burst's energy centroid against where it was
    /// written says how far a codec moved it. FLAC, what the web uploads, must
    /// not move at all; the others are reported, and pinned where CoreAudio
    /// removes the priming itself.
    func testWhereEachCodecPutsAKnownBurst() throws {
        let dir = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
            .appendingPathComponent("android/app/src/androidTest/assets/jam")
        let exact: Set<String> = ["burst-48000.wav", "burst-48000.flac", "burst-44100.wav", "burst-44100.flac", "burst-48000.m4a", "burst-44100.m4a"]
        let names = ["burst-48000.wav", "burst-48000.flac", "burst-48000.m4a", "burst-48000.mp3", "burst-48000-fragmented.mp4",
                     "burst-48000.ogg", "burst-48000.webm", "burst-44100.wav", "burst-44100.flac", "burst-44100.m4a", "burst-44100.mp3"]
        for name in names {
            guard let file = try? AVAudioFile(forReading: dir.appendingPathComponent(name)) else {
                print("JAM-CODEC \(name): CoreAudio does not open it")
                XCTAssertTrue(name.hasSuffix(".webm"), "\(name) should open")
                continue
            }
            let rate = file.processingFormat.sampleRate
            let buffer = AVAudioPCMBuffer(pcmFormat: file.processingFormat, frameCapacity: AVAudioFrameCount(file.length))!
            try file.read(into: buffer)
            let data = buffer.floatChannelData![0]
            var weighted = 0.0, energy = 0.0
            for i in 0..<Int(buffer.frameLength) {
                let e = Double(data[i] * data[i])
                weighted += Double(i) * e
                energy += e
            }
            let written = rate * 0.5 + (Double(Int(rate * 0.010)) - 1) / 2
            let shift = weighted / energy - written
            print(String(format: "JAM-CODEC %@: %.1f frames (%.2f ms), %lld frames long", name, shift, shift / rate * 1000, file.length))
            if exact.contains(name) { XCTAssertEqual(shift, 0, accuracy: 1, name) }
        }
    }

    // MARK: Where the clicks land

    struct Click: CustomStringConvertible {
        let frame: Int
        let amplitude: Float
        var description: String { "\(frame)" }
    }

    /// Local maxima of |x| above a threshold, at most one per 40 frames (a
    /// converted click rings for a few frames either side of its peak).
    static func clicks(in render: [Float], threshold: Float = 0.05) -> [Click] {
        var out: [Click] = []
        var i = 0
        while i < render.count {
            guard abs(render[i]) > threshold else { i += 1; continue }
            let end = min(render.count, i + 40)
            let peak = (i..<end).max { abs(render[$0]) < abs(render[$1]) }!
            out.append(Click(frame: peak, amplitude: abs(render[peak])))
            i = end
        }
        return out
    }

    /// For each click found, which take made it (by where it falls inside its
    /// second) and how far, in frames, it is from where that take's click at
    /// that song time belongs. `startSongMs` is the song time of render frame 0.
    struct Placement {
        var byTake: [String: [(songMs: Double, errorFrames: Double)]] = [:]
        var strays: [Int] = []
    }

    static func place(_ found: [Click], startSongMs: Double, rate: Double = 48_000) -> Placement {
        var result = Placement()
        for click in found {
            let songMs = startSongMs + Double(click.frame) / rate * 1000
            // The nearest click of any take, wherever it is.
            var best: (take: Take, songMs: Double, distance: Double)?
            for take in takes {
                let k = ((songMs - take.phaseMs) / 1000).rounded()
                let nominal = k * 1000 + take.phaseMs
                let distance = abs(songMs - nominal)
                if best == nil || distance < best!.distance { best = (take, nominal, distance) }
            }
            guard let best, best.distance < 125 else { result.strays.append(click.frame); continue }
            let expectedFrame = (best.songMs - startSongMs) / 1000 * rate
            result.byTake[best.take.id, default: []].append((best.songMs, Double(click.frame) - expectedFrame))
        }
        return result
    }

    /// Every audible click of every take in `[fromMs, toMs)` is found, within
    /// tolerance, and nothing else is.
    private func assertInSync(
        _ placement: Placement, fromMs: Double, toMs: Double, label: String,
        file: StaticString = #filePath, line: UInt = #line
    ) {
        XCTAssertEqual(placement.strays, [], "\(label): clicks that belong to no take", file: file, line: line)
        for take in Self.takes {
            let expected = take.heard.filter { $0 >= fromMs && $0 < toMs }
            let got = placement.byTake[take.id] ?? []
            let errors = got.map(\.errorFrames)
            let worst = errors.map(abs).max() ?? 0
            print(String(
                format: "JAM-WEB %@ %@: %d of %d clicks, error %@ frames (worst %.1f frames, %.2f ms)",
                label, take.id, got.count, expected.count,
                Self.summary(errors), worst, worst / 48
            ))
            XCTAssertEqual(got.map(\.songMs), expected, "\(label): \(take.id) clicks heard at the right song times", file: file, line: line)
            let tolerance = take.rate == 48_000 ? 1.0 : 24.0
            XCTAssertLessThanOrEqual(worst, tolerance, "\(label): \(take.id) off by \(worst) frames", file: file, line: line)
        }
    }

    static func summary(_ errors: [Double]) -> String {
        guard let first = errors.first else { return "none" }
        let lo = errors.min()!, hi = errors.max()!
        return lo == hi ? String(format: "%.1f", first) : String(format: "%.1f..%.1f", lo, hi)
    }

    // MARK: Offline: start, seek, the end of a long file

    func testWebTakesPlayInTimeFromTheTop() throws {
        let engine = try loadedEngine()
        // Song time 0 is the earliest audible sample (guitar and keys start
        // there; bass is trimmed to 500 ms), and the mix ends at 240 s.
        XCTAssertEqual(engine.originMs, 0, accuracy: 0.001)
        XCTAssertEqual(engine.durationMs, 240_000, accuracy: 0.05)
        let render = try engine.renderOffline(fromPositionMs: 0, frameCount: 48_000 * 4)
        assertInSync(Self.place(Self.clicks(in: render), startSongMs: 0), fromMs: 0, toMs: 4000, label: "from 0")
    }

    func testEachWebTakeAloneStartsAtItsFirstHeardClick() throws {
        // Each take soloed, so nothing has to be told apart: its first click
        // heard against the first click the web player plays for it. This is
        // the number a listener hears as "out of sync".
        let engine = try loadedEngine()
        for take in Self.takes {
            for other in Self.takes { engine.setAudible(other.id == take.id, for: other.id) }
            let render = try engine.renderOffline(fromPositionMs: 0, frameCount: 48_000 * 5)
            guard let first = Self.clicks(in: render).first, let due = take.heard.first else {
                XCTFail("\(take.id): no click in the first five seconds")
                continue
            }
            let heardMs = engine.originMs + Double(first.frame) / 48
            let shiftMs = heardMs - due
            print(String(format: "JAM-WEB solo %@: first click heard at %.3f ms of the song, due at %.0f ms: %+.3f ms", take.id, heardMs, due, shiftMs))
            XCTAssertEqual(shiftMs, 0, accuracy: take.rate == 48_000 ? 1 / 48 : 0.5, take.id)
        }
    }

    func testWebTakesStayInTimeAfterASeek() throws {
        let engine = try loadedEngine()
        // Inside every slice, off any block boundary of the FLAC files.
        let from = 61_237.0
        let render = try engine.renderOffline(fromPositionMs: from - engine.originMs, frameCount: 48_000 * 3)
        assertInSync(
            Self.place(Self.clicks(in: render), startSongMs: from), fromMs: from, toMs: from + 3000,
            label: "after a seek to 61.237 s"
        )
    }

    func testWebTakesStayInTimeToTheEndOfAFourMinuteSong() throws {
        // One continuous render of the whole song: a stem whose conversion or
        // clock ran at the wrong rate would walk away from the others, by a
        // growing amount, and the last minute shows it.
        let engine = try loadedEngine()
        let render = try engine.renderOffline(fromPositionMs: 0, frameCount: 48_000 * 241)
        let placement = Self.place(Self.clicks(in: render), startSongMs: 0)
        assertInSync(placement, fromMs: 0, toMs: 241_000, label: "whole song")
        for take in Self.takes {
            let got = placement.byTake[take.id] ?? []
            guard let first = got.first, let last = got.last else { continue }
            print(String(format: "JAM-WEB drift %@: first click %.1f frames, last click %.1f frames", take.id, first.errorFrames, last.errorFrames))
            XCTAssertEqual(last.errorFrames, first.errorFrames, accuracy: 1, "\(take.id) drifted over four minutes")
        }
    }

    // MARK: Real time: one start, a pause, a resume

    /// Samples from a tap on the engine's main mixer, the point where every stem
    /// has been summed, so what it shows is what the speaker gets. The rate is
    /// the buffer's own (the hardware's, which on a simulator is the Mac's
    /// output and may be 44.1 kHz), and the first buffer's host time anchors
    /// the run: the tap is continuous, so frame `i` is `i / rate` after it.
    final class Tap: @unchecked Sendable {
        private let lock = NSLock()
        private var samples: [Float] = []
        private var firstHost: UInt64?
        private var rate: Double = 0
        private var waiting: (seconds: Double, expectation: XCTestExpectation)?

        func append(_ buffer: AVAudioPCMBuffer, _ when: AVAudioTime) {
            guard let data = buffer.floatChannelData?[0] else { return }
            lock.lock()
            if firstHost == nil, when.isHostTimeValid {
                firstHost = when.hostTime
                rate = buffer.format.sampleRate
            }
            if firstHost != nil {
                samples.append(contentsOf: UnsafeBufferPointer(start: data, count: Int(buffer.frameLength)))
            }
            var fulfil: XCTestExpectation?
            if let w = waiting, rate > 0, Double(samples.count) >= w.seconds * rate {
                fulfil = w.expectation
                waiting = nil
            }
            lock.unlock()
            fulfil?.fulfill()
        }

        /// Starts a new run and answers an expectation fulfilled once `seconds`
        /// of it have arrived: the test waits on the audio, not on a timer.
        func expect(seconds: Double, _ name: String) -> XCTestExpectation {
            let e = XCTestExpectation(description: name)
            lock.lock()
            samples = []
            firstHost = nil
            rate = 0
            waiting = (seconds, e)
            lock.unlock()
            return e
        }

        func take() -> (samples: [Float], firstHost: UInt64, rate: Double) {
            lock.lock()
            defer { lock.unlock() }
            return (samples, firstHost ?? 0, rate)
        }
    }

    /// Nonisolated, so the block runs on the render thread without the main
    /// actor's isolation check (which traps there).
    nonisolated private static func install(_ tap: Tap, on mixer: AVAudioMixerNode) {
        mixer.installTap(onBus: 0, bufferSize: 2048, format: nil) { buffer, when in tap.append(buffer, when) }
    }

    private static let timebase: mach_timebase_info_data_t = {
        var info = mach_timebase_info_data_t()
        mach_timebase_info(&info)
        return info
    }()

    private static func seconds(fromHost a: UInt64, to b: UInt64) -> Double {
        let t = timebase
        let ticks = b >= a ? Double(b - a) : -Double(a - b)
        return ticks * Double(t.numer) / Double(t.denom) / 1_000_000_000
    }

    struct LiveRun {
        /// Per take: the song time of each click and where it was heard, in
        /// ms after the first frame of the run, by counting samples.
        var clicks: [String: [(songMs: Double, atMs: Double)]] = [:]
        /// Host time of the run's first tapped frame minus the host time
        /// `play` returned, in ms. It moves with where the first tapped
        /// buffer happens to begin; the clock check below removes that.
        var startResidualMs: Double = 0
        var rate: Double = 0
        var fromMs: Double = 0
    }

    /// Plays from song time `fromMs` until `seconds` of output have been
    /// tapped, and answers where every click landed. Which take a click is
    /// comes from where it falls in its second (0, 250 or 500 ms), read
    /// against the engine's own clock.
    private func playLive(_ engine: JamEngine, tap: Tap, fromMs: Double, seconds: Double) throws -> LiveRun {
        let arrived = tap.expect(seconds: seconds, "\(seconds) s of live output")
        let startHost: UInt64
        do {
            startHost = try engine.play(from: fromMs - engine.originMs)
        } catch {
            throw XCTSkip("the engine cannot start here (no audio device): \(error)")
        }
        guard XCTWaiter().wait(for: [arrived], timeout: seconds * 4 + 10) == .completed else {
            throw XCTSkip("the engine produced no output here (no audio device)")
        }
        let (samples, firstHost, rate) = tap.take()
        var run = LiveRun()
        run.rate = rate
        run.fromMs = fromMs
        let firstFrameSeconds = Self.seconds(fromHost: startHost, to: firstHost)
        run.startResidualMs = firstFrameSeconds * 1000
        for click in Self.clicks(in: samples) {
            let atMs = Double(click.frame) / rate * 1000
            // Song time by the engine's clock (start position plus elapsed).
            let songMs = fromMs + firstFrameSeconds * 1000 + atMs
            var best: (take: Take, nominal: Double, distance: Double)?
            for take in Self.takes {
                let nominal = ((songMs - take.phaseMs) / 1000).rounded() * 1000 + take.phaseMs
                let distance = abs(songMs - nominal)
                if best == nil || distance < best!.distance { best = (take, nominal, distance) }
            }
            guard let best else { continue }
            run.clicks[best.take.id, default: []].append((best.nominal, atMs))
        }
        return run
    }

    func testLivePlaybackStartsEveryStemTogetherAndAResumeKeepsThemThere() throws {
        let engine = try loadedEngine()
        let mixer = engine.outputMixer
        let tap = Tap()
        Self.install(tap, on: mixer)
        defer {
            mixer.removeTap(onBus: 0)
            engine.tearDown()
        }

        let first = try playLive(engine, tap: tap, fromMs: 10_100, seconds: 3)
        let pausedAt = engine.pause() + engine.originMs
        let resumed = try playLive(engine, tap: tap, fromMs: pausedAt, seconds: 3)

        for (label, run) in [("live from 10.1 s", first), ("live after pause and resume", resumed)] {
            // Stem against stem, by counting samples: a guitar click at song
            // time g and another take's click at song time s must be heard
            // s - g apart. One and a half output frames of slack, plus the
            // converter's half millisecond for the 44.1 kHz stem.
            guard let anchor = run.clicks["guitar"]?.first else {
                XCTFail("\(label): no guitar click")
                continue
            }
            let frameMs = 1000 / run.rate
            for take in Self.takes {
                let got = run.clicks[take.id] ?? []
                XCTAssertGreaterThanOrEqual(got.count, 2, "\(label): \(take.id) clicks")
                let errors = got.map { ($0.atMs - anchor.atMs) - ($0.songMs - anchor.songMs) }
                let worst = errors.map(abs).max() ?? 0
                print(String(
                    format: "JAM-WEB %@ (output %.0f Hz) %@: %d clicks, %.3f..%.3f ms against guitar's first, worst %.3f ms",
                    label, run.rate, take.id, got.count, errors.min() ?? 0, errors.max() ?? 0, worst
                ))
                let tolerance = take.rate == 48_000 ? 1.5 * frameMs : 0.5 + frameMs
                XCTAssertLessThanOrEqual(worst, tolerance, "\(label): \(take.id) apart from guitar")
            }
        }
        // The audio against the transport's clock (what the playhead and the
        // video follow): a guitar click's host time minus the host time the
        // engine's clock gives its song time. A constant is the tap's own
        // position in the output path; a resume must not move it.
        func clockResidual(_ run: LiveRun) -> Double? {
            guard let click = run.clicks["guitar"]?.first else { return nil }
            // Heard (ms after play()'s host time) minus due (song time after
            // the start position).
            return (run.startResidualMs + click.atMs) - (click.songMs - run.fromMs)
        }
        if let before = clockResidual(first), let after = clockResidual(resumed) {
            print(String(format: "JAM-WEB live audio vs transport clock: %.3f ms, after the resume %.3f ms", before, after))
            XCTAssertEqual(before, after, accuracy: 3, "a resume moved the audio against the clock the video follows")
        }
    }
}
