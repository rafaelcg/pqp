import AVFoundation
import Foundation

/// MEASURING THE ROUND TRIP: play known sounds, record them through the
/// microphone, find them. The same path a take travels (one engine, the tap on
/// the input node, host-time stamps), so what is measured is exactly what a take
/// is compensated by. The arithmetic and the judging are `JamLatencyAnalysis`;
/// this plays and listens.
///
/// A click that left the graph at host time P comes back stamped P + L, and L is
/// the round trip `JamTakeClock` subtracts.
@MainActor
final class JamCalibrator {
    enum Method: Equatable, Sendable { case loopback, tapAlong }

    enum CalibrationError: Error, Equatable {
        case noInput
        case engine(String)
    }

    /// Sweeps in a loopback and the time between them. The longest round trip
    /// looked for must be shorter than the period.
    nonisolated static let loopbackPulses = 10
    nonisolated static let loopbackPeriodMs = 600.0
    nonisolated static let loopbackMaxLatencyMs = 550.0
    nonisolated static let loopbackFirstSeconds = 0.3
    nonisolated static let tapClicks = 12
    nonisolated static let tapBpm = 100.0
    nonisolated static let tapFirstSeconds = 0.5

    /// How long a measurement takes, for the progress the sheet draws.
    nonisolated static func durationSeconds(_ method: Method) -> Double {
        switch method {
        case .loopback:
            loopbackFirstSeconds + Double(loopbackPulses) * loopbackPeriodMs / 1000 + 0.9
        case .tapAlong:
            tapFirstSeconds + Double(tapClicks) * 60 / tapBpm + 0.7
        }
    }

    private var engine: AVAudioEngine?
    private var cancelled = false

    func cancel() {
        cancelled = true
        stopEngine()
    }

    private func stopEngine() {
        guard let engine else { return }
        engine.inputNode.removeTap(onBus: 0)
        engine.stop()
        self.engine = nil
    }

    /// Run one measurement. `reportedOutputMs` rides on the result so a later
    /// change of the route's reported latency can mark it stale.
    func measure(_ method: Method, reportedOutputMs: Double) async throws -> JamLatencyResult {
        cancelled = false
        let engine = AVAudioEngine()
        self.engine = engine
        defer { stopEngine() }

        let input = engine.inputNode
        let format = input.outputFormat(forBus: 0)
        guard format.sampleRate > 0, format.channelCount > 0 else { throw CalibrationError.noInput }
        let sink = JamCaptureSink(fileURL: nil, keepInMemory: true)
        JamCaptureSink.install(on: input, format: format, into: sink)

        let outputRate = engine.outputNode.outputFormat(forBus: 0).sampleRate
        let rate = outputRate > 0 ? outputRate : format.sampleRate
        // What leaves the graph, and at which frames of the train.
        let (train, at, reference) = Self.signal(method, rate: rate)
        guard let mono = AVAudioFormat(standardFormatWithSampleRate: rate, channels: 1),
              let buffer = AVAudioPCMBuffer(pcmFormat: mono, frameCapacity: AVAudioFrameCount(train.count)),
              let data = buffer.floatChannelData
        else { throw CalibrationError.engine("no buffer") }
        buffer.frameLength = AVAudioFrameCount(train.count)
        train.withUnsafeBufferPointer { data[0].update(from: $0.baseAddress!, count: train.count) }
        let player = AVAudioPlayerNode()
        engine.attach(player)
        engine.connect(player, to: engine.mainMixerNode, format: mono)
        Self.schedule(buffer, on: player)

        engine.prepare()
        do { try engine.start() } catch { throw CalibrationError.engine(String(describing: error)) }
        let t0 = JamHostClock.nowSeconds + 0.25
        player.play(at: AVAudioTime(hostTime: JamHostClock.ticks(fromSeconds: t0)))

        let wait = Self.durationSeconds(method) + 0.25
        try await Task.sleep(for: .seconds(wait))
        if cancelled { throw CancellationError() }
        input.removeTap(onBus: 0)
        guard let capture = sink.finish(), !capture.memory.isEmpty else {
            return JamLatencyAnalysis.judge(
                method == .loopback ? .loopback : .tapAlong, lags: [], played: at.count,
                reportedOutputMs: reportedOutputMs, now: Date(),
                thresholds: .init(highSpread: 0, mediumSpread: 0, outlierMs: 0)
            )
        }
        // Each sound's frame on the CAPTURE's own timeline.
        let captureRate = capture.sampleRate
        let emitted = at.map { Int(((t0 + Double($0) / rate) - capture.startHostSeconds) * captureRate) }
        let channels = capture.memory
        let samples = JamMono.choose(channels).samples
        return await Task.detached(priority: .userInitiated) {
            switch method {
            case .loopback:
                JamLatencyAnalysis.loopback(
                    captured: samples, emittedFrames: emitted, reference: reference, sampleRate: captureRate,
                    maxLatencyMs: Self.loopbackMaxLatencyMs, reportedOutputMs: reportedOutputMs
                )
            case .tapAlong:
                JamLatencyAnalysis.tapAlong(
                    captured: samples, clickFrames: emitted, sampleRate: captureRate,
                    reportedOutputMs: reportedOutputMs
                )
            }
        }.value
    }

    /// Synchronous, so the completion-handler form of `scheduleBuffer` is not
    /// mistaken for the awaiting one (which would wait for the sound to finish).
    private nonisolated static func schedule(_ buffer: AVAudioPCMBuffer, on player: AVAudioPlayerNode) {
        player.scheduleBuffer(buffer, at: nil, options: [], completionHandler: nil)
    }

    /// The signal for a method: the whole train, the frames each sound starts
    /// at, and (for a loopback) the reference to look for.
    nonisolated static func signal(_ method: Method, rate: Double) -> (train: [Float], at: [Int], reference: [Float]) {
        switch method {
        case .loopback:
            let reference = JamSignals.sweep(sampleRate: rate, amplitude: 0.5)
            let first = Int((loopbackFirstSeconds * rate).rounded())
            let period = Int((loopbackPeriodMs / 1000 * rate).rounded())
            let at = (0..<loopbackPulses).map { first + $0 * period }
            return (JamSignals.pulseTrain(length: first + loopbackPulses * period, pulse: reference, at: at), at, reference)
        case .tapAlong:
            let beat = Int((60 / tapBpm * rate).rounded())
            let first = Int((tapFirstSeconds * rate).rounded())
            let at = (0..<tapClicks).map { first + $0 * beat }
            let accent = JamSignals.metronomeClick(sampleRate: rate, accent: true)
            let plain = JamSignals.metronomeClick(sampleRate: rate, accent: false)
            var train = [Float](repeating: 0, count: first + tapClicks * beat)
            for (k, frame) in at.enumerated() {
                let click = k % 4 == 0 ? accent : plain
                for i in 0..<click.count where frame + i < train.count { train[frame + i] += click[i] }
            }
            return (train, at, [])
        }
    }
}
