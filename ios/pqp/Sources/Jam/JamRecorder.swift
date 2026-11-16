import AVFoundation
import Foundation

/**
 RECORDING A PART: ONE ENGINE, ONE CLOCK.

 The band, the count-in and the microphone are three things that have to agree
 on when they happen, to the sample. They live on ONE `AVAudioEngine` (the
 band's `JamEngine` owns it; the count-in's player node and the input node's tap
 are added to it) and every start is a HOST TIME, the one clock they share:

     T0   the count-in's first click leaves the graph      (host time)
     H0   the band's first sample leaves the graph          (T0 + the count-in)
     Hc   the first captured sample was captured            (the tap's `when`)

 The take is placed on the song from those three and the round trip
 (`JamTakeClock`), never from a wall clock or a timer: a timer in this process is
 off by as much as the main thread is busy. The count-in is a single buffer (a
 click on every beat, silence between) started at T0, not a click per timer tick.

 A recorder lives for ONE take. The engine that recorded has its input node in
 the graph, so it would keep the microphone open for as long as it ran; review
 and the band preview use a fresh engine that never touches the input.

 WHAT THIS CAN AND CANNOT PROVE. Everything above the hardware is tested with a
 synthetic capture (`JamRecordingTests`). What the device does with the stamp it
 gives the tap, and what its latencies really are, can only be measured on one:
 that is what the calibration is for, and why it is offered and stored.
 */
@MainActor
final class JamRecorder {
    enum StartError: Error, Equatable {
        /// The input has no format: no microphone on this route (or no permission).
        case noInput
        case engine(String)
    }

    enum Event: Equatable, Sendable {
        /// Headphones came or went, a Bluetooth device joined or left.
        case routeChanged
        /// A call, an alarm or Siri took the audio session.
        case interrupted
        /// The engine stopped by itself (a media-services reset, a rate change).
        case engineStopped
    }

    /// What `start` did, in seconds on the host clock.
    struct Started: Equatable, Sendable {
        /// The count-in's first click.
        var countInStartSeconds: Double
        /// The band's first sample (the same as the count-in's start with none).
        var backingStartSeconds: Double
    }

    /// What `stop` hands over: the capture and the numbers that place it.
    struct Raw: Sendable {
        var capture: JamCaptureSink.Capture
        var fromMs: Double
        var backingStartSeconds: Double
    }

    private let band = JamEngine()
    private var sink: JamCaptureSink?
    private var clickPlayer: AVAudioPlayerNode?
    private var started: Started?
    private var observers: [NSObjectProtocol] = []
    private(set) var isRunning = false

    var onEvent: (@MainActor (Event) -> Void)?

    // MARK: The band

    /// The stems the take is recorded over. Returns those CoreAudio cannot open
    /// (they are left out of the band, and the studio says so).
    @discardableResult
    func loadBand(_ stems: [JamEngine.Stem]) -> [String: JamEngine.EngineError] {
        band.load(stems)
    }

    /// Where the band starts on the song: its earliest heard sample. The take is
    /// recorded from here (the web's is song time 0; this one starts at the
    /// first sound, so a part never waits through a silent head), and the
    /// number is the song time every offset is counted against.
    var bandOriginMs: Double { band.originMs }
    var bandDurationMs: Double { band.durationMs }
    var startedSeconds: Started? { started }

    // MARK: Start and stop

    func start(countIn: JamCountIn?, rawURL: URL, leadSeconds: Double = 0.25) throws -> Started {
        precondition(!isRunning, "one recorder, one take")
        let engine = band.audioEngine
        let input = engine.inputNode
        let format = input.outputFormat(forBus: 0)
        guard format.sampleRate > 0, format.channelCount > 0 else { throw StartError.noInput }

        let sink = JamCaptureSink(fileURL: rawURL, keepInMemory: false)
        JamCaptureSink.install(on: input, format: format, into: sink)
        self.sink = sink

        // The graph's output rate is the hardware's; the count-in is built at it.
        let outputRate = engine.outputNode.outputFormat(forBus: 0).sampleRate
        let rate = outputRate > 0 ? outputRate : format.sampleRate
        let count = (countIn?.isValid == true && (countIn?.totalBeats ?? 0) > 0) ? countIn : nil
        if let count, let mono = AVAudioFormat(standardFormatWithSampleRate: rate, channels: 1) {
            let samples = count.samples(sampleRate: rate)
            if let buffer = AVAudioPCMBuffer(pcmFormat: mono, frameCapacity: AVAudioFrameCount(samples.count)),
               let data = buffer.floatChannelData {
                buffer.frameLength = AVAudioFrameCount(samples.count)
                samples.withUnsafeBufferPointer { data[0].update(from: $0.baseAddress!, count: samples.count) }
                let player = AVAudioPlayerNode()
                engine.attach(player)
                engine.connect(player, to: engine.mainMixerNode, format: mono)
                Self.schedule(buffer, on: player)
                clickPlayer = player
            }
        }

        engine.prepare()
        do {
            try engine.start()
        } catch {
            teardownGraph()
            throw StartError.engine(String(describing: error))
        }

        let t0 = mach_absolute_time() + JamHostClock.ticks(fromSeconds: leadSeconds)
        let countSeconds = count.map { Double($0.frames(sampleRate: rate)) / rate } ?? 0
        let h0 = t0 + JamHostClock.ticks(fromSeconds: countSeconds)
        clickPlayer?.play(at: AVAudioTime(hostTime: t0))
        do {
            try band.play(from: 0, atHostTime: h0)
        } catch {
            teardownGraph()
            throw StartError.engine(String(describing: error))
        }
        isRunning = true
        observe()
        let result = Started(
            countInStartSeconds: JamHostClock.seconds(fromTicks: t0),
            backingStartSeconds: JamHostClock.seconds(fromTicks: h0)
        )
        started = result
        return result
    }

    private nonisolated static func schedule(_ buffer: AVAudioPCMBuffer, on player: AVAudioPlayerNode) {
        player.scheduleBuffer(buffer, at: nil, options: [], completionHandler: nil)
    }

    /// The loudest sample since the last call: the meter.
    func levelPeak() -> Float { sink?.takeMeterPeak() ?? 0 }

    /// Whether the capture could not be written (the disk is full).
    var captureFailed: Bool { sink?.didFail ?? false }

    /// Stop the take. Nil when nothing was captured.
    func stop() -> Raw? {
        guard isRunning, let sink, let started else {
            teardownGraph()
            return nil
        }
        isRunning = false
        // Before the graph is torn down: the band's origin is gone with it.
        let fromMs = band.originMs
        band.pause()
        teardownGraph()
        guard let capture = sink.finish() else { return nil }
        return Raw(capture: capture, fromMs: fromMs, backingStartSeconds: started.backingStartSeconds)
    }

    /// Drop everything, keeping nothing (the capture file is the caller's to
    /// delete).
    func cancel() {
        isRunning = false
        band.pause()
        teardownGraph()
        _ = sink?.finish()
        sink = nil
    }

    private func teardownGraph() {
        removeObservers()
        let engine = band.audioEngine
        engine.inputNode.removeTap(onBus: 0)
        if let clickPlayer {
            clickPlayer.stop()
            engine.detach(clickPlayer)
            self.clickPlayer = nil
        }
        band.tearDown()
        if engine.isRunning { engine.stop() }
    }

    // MARK: What can interrupt a take

    private func observe() {
        let center = NotificationCenter.default
        band.onInterruption = { [weak self] in self?.report(.engineStopped) }
        observers.append(center.addObserver(
            forName: .AVAudioEngineConfigurationChange, object: band.audioEngine, queue: .main
        ) { [weak self] _ in
            Task { @MainActor in self?.report(.engineStopped) }
        })
        observers.append(center.addObserver(
            forName: AVAudioSession.interruptionNotification, object: nil, queue: .main
        ) { [weak self] note in
            let raw = note.userInfo?[AVAudioSessionInterruptionTypeKey] as? UInt
            guard raw == AVAudioSession.InterruptionType.began.rawValue else { return }
            Task { @MainActor in self?.report(.interrupted) }
        })
        observers.append(center.addObserver(
            forName: AVAudioSession.routeChangeNotification, object: nil, queue: .main
        ) { [weak self] note in
            let raw = note.userInfo?[AVAudioSessionRouteChangeReasonKey] as? UInt
            let reason = raw.flatMap(AVAudioSession.RouteChangeReason.init(rawValue:))
            guard JamRouteChange.endsATake(reason) else { return }
            Task { @MainActor in self?.report(.routeChanged) }
        })
    }

    private func removeObservers() {
        observers.forEach(NotificationCenter.default.removeObserver)
        observers = []
        band.onInterruption = nil
    }

    private func report(_ event: Event) {
        guard isRunning else { return }
        onEvent?(event)
    }
}

/// Which route changes end a take. Headphones pulled out puts the band on the
/// loudspeaker and into the microphone; a device that joined (a Bluetooth
/// headset connecting) changes the latency under a take already placed. A
/// category change is our own (we set it), an override is the speaker button.
enum JamRouteChange {
    static func endsATake(_ reason: AVAudioSession.RouteChangeReason?) -> Bool {
        switch reason {
        case .oldDeviceUnavailable, .newDeviceAvailable: true
        default: false
        }
    }
}

// MARK: - From a capture to a take

/// A recorded take, ready to hear and to send.
struct JamTake: Equatable, Sendable {
    /// The FLAC file: what is heard in review and what is uploaded, byte for
    /// byte, so what a person approves is what the band gets.
    var fileURL: URL
    var byteSize: Int
    var timing: JamTakeTiming
    var sampleRate: Double
    var frames: Int
    var peaks: [Double]
    /// The loudest sample of the part that is HEARD (the hidden count-in is not
    /// counted: the clicks leak into a microphone and would make a silent take
    /// look alive).
    var loudestHeard: Float
    var monoChoice: String
    var gapFrames: Int
    var clock: JamTakeClock
    var hostTimeEstimated: Bool
    var latencyMethod: JamLatencyMethod
    var latencyConfidence: JamLatencyConfidence

    var isSilent: Bool { JamTakePeaks.isSilent(loudest: loudestHeard) }
    /// Whether the recording is longer than the part that is heard.
    var playedMs: Double { timing.playedMs }
}

enum JamTakeBuilder {
    enum BuildError: Error, Equatable { case empty, unreadable, write(String) }

    /// Turn a capture into the take the server stores, in the web recorder's
    /// own terms: mono, 16-bit FLAC at the capture's rate (lossless, so the trip
    /// through the server moves the audio by exactly zero samples), the offset
    /// a whole number of milliseconds reached by dropping fewer than one
    /// millisecond of leading samples, and a head trim that hides the count-in
    /// and the round trip. Streams the file in chunks: a ten minute take is
    /// never in memory whole.
    static func build(
        raw: JamRecorder.Raw, latency: JamLatencyResult, outputURL: URL
    ) throws -> JamTake {
        let capture = raw.capture
        guard let url = capture.url, let source = try? AVAudioFile(forReading: url) else { throw BuildError.unreadable }
        let rate = capture.sampleRate
        let total = Int(min(source.length, Int64(capture.frames)))
        guard total > 0 else { throw BuildError.empty }

        let clock = JamTakeClock(
            sampleRate: rate, fromMs: raw.fromMs, backingStartSeconds: raw.backingStartSeconds,
            captureStartSeconds: capture.startHostSeconds, roundTripMs: latency.roundTripMs
        )
        let whole = JamTakePlacement.wholeMillisecond(offsetMs: clock.rawOffsetMs, sampleRate: rate)
        let drop = min(whole.dropFrames, total)
        let kept = total - drop
        guard kept > 0 else { throw BuildError.empty }
        let durationMs = Double(kept) / rate * 1000
        let trimStart = JamTakePlacement.trimStartMs(fromMs: raw.fromMs, offsetMs: whole.offsetMs, durationMs: durationMs)
        let heardFrom = Int((trimStart / 1000 * rate).rounded())

        // Pass 1: which channel is the part (a two-input interface puts the
        // guitar on one side).
        let channels = Int(source.processingFormat.channelCount)
        let choice = channels > 1 ? try chooseChannel(source, total: total) : JamMono.Choice.mono
        source.framePosition = 0

        // Pass 2: stream to FLAC, computing the peaks and the loudest heard.
        let buckets = max(1, min(JamLimits.peaksMax, kept))
        var peaks = [Float](repeating: 0, count: buckets)
        var loudest: Float = 0
        do {
            let settings: [String: Any] = [
                AVFormatIDKey: kAudioFormatFLAC, AVSampleRateKey: rate, AVNumberOfChannelsKey: 1,
                AVLinearPCMBitDepthKey: 16,
            ]
            try? FileManager.default.removeItem(at: outputURL)
            let out = try AVAudioFile(
                forWriting: outputURL, settings: settings, commonFormat: .pcmFormatInt16, interleaved: true
            )
            let chunk = 65_536
            guard let inBuffer = AVAudioPCMBuffer(pcmFormat: source.processingFormat, frameCapacity: AVAudioFrameCount(chunk)),
                  let outBuffer = AVAudioPCMBuffer(pcmFormat: out.processingFormat, frameCapacity: AVAudioFrameCount(chunk))
            else { throw BuildError.unreadable }
            var globalIndex = 0
            while globalIndex < total {
                let want = AVAudioFrameCount(min(chunk, total - globalIndex))
                try source.read(into: inBuffer, frameCount: want)
                let n = Int(inBuffer.frameLength)
                if n == 0 { break }
                guard let data = inBuffer.floatChannelData, let pcm = outBuffer.int16ChannelData else { break }
                var written = 0
                for i in 0..<n {
                    let gi = globalIndex + i
                    if gi < drop { continue }
                    var sample: Float
                    switch choice {
                    case .mono, .left: sample = data[0][i]
                    case .right: sample = data[min(1, channels - 1)][i]
                    case .mix: sample = 0.5 * (data[0][i] + data[min(1, channels - 1)][i])
                    }
                    if !sample.isFinite { sample = 0 }
                    let oi = gi - drop
                    let magnitude = abs(sample)
                    let bucket = oi * buckets / kept
                    if magnitude > peaks[bucket] { peaks[bucket] = magnitude }
                    if oi >= heardFrom, magnitude > loudest { loudest = magnitude }
                    pcm[0][written] = Int16(max(-1, min(1, sample)) * 32767)
                    written += 1
                }
                outBuffer.frameLength = AVAudioFrameCount(written)
                if written > 0 { try out.write(from: outBuffer) }
                globalIndex += n
            }
            // `out` is released at the end of this scope, which finalises the file.
        } catch let error as BuildError {
            throw error
        } catch {
            throw BuildError.write(String(describing: error))
        }
        try? FileManager.default.removeItem(at: url)

        let size = (try? FileManager.default.attributesOfItem(atPath: outputURL.path)[.size] as? Int) ?? 0
        return JamTake(
            fileURL: outputURL, byteSize: size,
            timing: JamTakeTiming(offsetMs: whole.offsetMs, trimStartMs: trimStart, trimEndMs: 0, durationMs: durationMs),
            sampleRate: rate, frames: kept,
            peaks: peaks.map { (Double(min(1, $0)) * 1000).rounded() / 1000 },
            loudestHeard: loudest, monoChoice: choice.rawValue, gapFrames: capture.gapFrames,
            clock: clock, hostTimeEstimated: capture.hostTimeEstimated,
            latencyMethod: latency.method, latencyConfidence: latency.confidence
        )
    }

    private static func chooseChannel(_ file: AVAudioFile, total: Int) throws -> JamMono.Choice {
        guard let buffer = AVAudioPCMBuffer(pcmFormat: file.processingFormat, frameCapacity: 65_536) else { return .left }
        var sumL = 0.0, sumR = 0.0
        var seen = 0
        while seen < total {
            try file.read(into: buffer, frameCount: AVAudioFrameCount(min(65_536, total - seen)))
            let n = Int(buffer.frameLength)
            if n == 0 { break }
            guard let data = buffer.floatChannelData else { break }
            for i in 0..<n {
                sumL += Double(data[0][i]) * Double(data[0][i])
                sumR += Double(data[1][i]) * Double(data[1][i])
            }
            seen += n
        }
        let a = (sumL / Double(max(1, seen))).squareRoot()
        let b = (sumR / Double(max(1, seen))).squareRoot()
        let ratio = pow(10, 24.0 / 20)
        if a > b * ratio || (b == 0 && a > 0) { return .left }
        if b > a * ratio || (a == 0 && b > 0) { return .right }
        return .mix
    }
}
