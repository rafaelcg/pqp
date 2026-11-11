import AVFoundation
import Foundation

/**
 THE PLAYBACK ENGINE: one `AVAudioEngine`, one `AVAudioPlayerNode` per stem.

 WHY THIS AND NOT `AVPlayer`s. A jam is the same song heard as several files
 that were recorded apart, and the whole product is that they line up. Several
 `AVPlayer`s are independent clocks that can only be nudged into agreement; one
 engine renders every stem into one buffer cycle, so two stems that are meant
 to start together do, to the frame, because they are summed by the same
 callback.

 HOW A STEM IS PLACED. Every player is scheduled with a SEGMENT of its file
 (`scheduleSegment`, which streams from disk, so a ten minute stem costs no
 memory) at a SAMPLE time relative to the transport start, and then every
 player is started at ONE host time. The frames come from `JamAlignment`, the
 only place a track's numbers are arithmetic: the file's first sample sits at
 `offsetMs` and a trim hides audio without moving it, as the web recorder
 writes it. A negative `offsetMs` is not special: the transport's zero is the
 earliest heard sample of any stem.

 WHAT IT PROVES AND WHAT IT CANNOT. `renderOffline` runs the same graph in
 manual rendering mode, which has no hardware and no clock, so a test can say
 exactly which output frame each stem's first sample lands on (`JamEngineTests`).
 What it cannot say is anything about the device: output latency, a Bluetooth
 route, the host clock against the DAC. Those are the real-device checklist.

 GAIN. A track's `gain` is 0 to 2 (+6 dB), the user's own volume slider is
 0 to 1, and a player node's `volume` is capped at 1, so the product goes into
 a one-band EQ's `globalGain` (dB) and the player's own volume is only the
 mute and solo switch. Every stem has the same chain, so none is later than
 another.
 */
@MainActor
final class JamEngine {
    enum EngineError: Error, Equatable {
        /// CoreAudio cannot decode this stem (a WebM or an Ogg Opus file, for
        /// instance). The others still play.
        case unsupported(String)
    }

    struct Stem: Equatable, Sendable {
        let id: String
        let url: URL
        let offsetMs: Double
        let trimStartMs: Double
        let trimEndMs: Double

        var spec: JamStemSpec {
            JamStemSpec(id: id, offsetMs: offsetMs, trimStartMs: trimStartMs, trimEndMs: trimEndMs)
        }
    }

    /// What a person does to a stem, all of it local to this phone.
    struct Mix: Equatable, Sendable {
        /// The track's own `gain`, 0 to 2.
        var gain: Double = 1
        /// The slider, 0 to 1.
        var volume: Double = 1
        var muted = false
    }

    private struct Voice {
        let stem: Stem
        let player = AVAudioPlayerNode()
        let eq = AVAudioUnitEQ(numberOfBands: 1)
        let file: AVAudioFile
        let rate: Double
        var mix = Mix()
        var isAudible = true
    }

    private let engine = AVAudioEngine()
    private var voices: [String: Voice] = [:]
    private var order: [String] = []

    /// The earliest heard sample of any loaded stem, in song ms.
    private(set) var originMs: Double = 0
    /// The mix length in ms.
    private(set) var durationMs: Double = 0
    private(set) var isPlaying = false

    /// The position the transport was last started or paused at, and when.
    private var anchorPositionMs: Double = 0
    private var anchorHostTime: UInt64 = 0
    private nonisolated(unsafe) var configObserver: NSObjectProtocol?

    /// Told when the engine stops by itself: a route change or a media-services
    /// reset. The model pauses, keeping the position.
    var onInterruption: (@MainActor () -> Void)?

    init() {
        configObserver = NotificationCenter.default.addObserver(
            forName: .AVAudioEngineConfigurationChange, object: engine, queue: .main
        ) { [weak self] _ in
            MainActor.assumeIsolated { self?.handleConfigurationChange() }
        }
    }

    deinit {
        if let configObserver { NotificationCenter.default.removeObserver(configObserver) }
    }

    // MARK: - Loading

    /// Make these the stems in the mix. A stem whose id and source are
    /// unchanged keeps its player (and its place in the song); a new one is
    /// opened; one that is gone is detached. Returns the stems CoreAudio could
    /// not open, by id.
    @discardableResult
    func load(_ stems: [Stem]) -> [String: EngineError] {
        var failures: [String: EngineError] = [:]
        let wanted = Set(stems.map(\.id))
        for id in voices.keys where !wanted.contains(id) { detach(id) }

        for stem in stems {
            if let existing = voices[stem.id], existing.stem == stem { continue }
            if voices[stem.id] != nil { detach(stem.id) }
            do {
                let file = try AVAudioFile(forReading: stem.url)
                var voice = Voice(stem: stem, file: file, rate: file.processingFormat.sampleRate)
                voice.eq.bands[0].bypass = true
                engine.attach(voice.player)
                engine.attach(voice.eq)
                engine.connect(voice.player, to: voice.eq, format: file.processingFormat)
                engine.connect(voice.eq, to: engine.mainMixerNode, format: file.processingFormat)
                voices[stem.id] = voice
                apply(mix: voice.mix, to: stem.id)
            } catch {
                failures[stem.id] = .unsupported(String(describing: error))
            }
        }
        order = stems.map(\.id).filter { voices[$0] != nil }
        recompute()
        return failures
    }

    private func detach(_ id: String) {
        guard let voice = voices.removeValue(forKey: id) else { return }
        voice.player.stop()
        engine.detach(voice.player)
        engine.detach(voice.eq)
    }

    private func recompute() {
        let specs = order.compactMap { voices[$0]?.stem.spec }
        let lengths = order.compactMap { id -> Double? in
            guard let v = voices[id] else { return nil }
            return Double(v.file.length) / v.rate * 1000
        }
        originMs = JamAlignment.originMs(specs)
        durationMs = JamAlignment.durationMs(specs, lengthsMs: lengths)
    }

    // MARK: - The mix

    func setMix(_ mix: Mix, for id: String) {
        guard voices[id] != nil else { return }
        voices[id]?.mix = mix
        apply(mix: mix, to: id)
    }

    /// Whether a stem is heard right now (solo and mute are decided above this
    /// and arrive as one bit).
    func setAudible(_ audible: Bool, for id: String) {
        guard voices[id] != nil else { return }
        voices[id]?.isAudible = audible
        if let voice = voices[id] { apply(mix: voice.mix, to: id) }
    }

    private func apply(mix: Mix, to id: String) {
        guard let voice = voices[id] else { return }
        let linear = max(0, min(JamLimits.gainMax, mix.gain)) * max(0, min(1, mix.volume))
        // 20 log10, floored where the EQ's range ends. Zero is the player's
        // own volume below, so the floor is never what a person hears.
        let db = linear > 0.0001 ? Float(20 * log10(linear)) : -96
        voice.eq.globalGain = max(-96, min(24, db))
        voice.player.volume = (mix.muted || !voice.isAudible) ? 0 : 1
    }

    // MARK: - Transport

    /// Where the transport is, in ms from the origin.
    var positionMs: Double {
        guard isPlaying else { return anchorPositionMs }
        let elapsed = hostSeconds(from: anchorHostTime, to: mach_absolute_time()) * 1000
        return min(durationMs, max(anchorPositionMs, anchorPositionMs + elapsed))
    }

    /// Start (or resume) at `positionMs` from the origin. The audio reaches the
    /// output a little after `hostTime`; the caller aligns a video to the same
    /// instant, which is why it is returned.
    @discardableResult
    func play(from positionMs: Double, leadSeconds: Double = 0.12) throws -> UInt64 {
        stopPlayers()
        let position = max(0, min(positionMs, durationMs))
        if !engine.isRunning {
            engine.prepare()
            try engine.start()
        }
        schedule(from: position)

        let startHost = mach_absolute_time() + hostTicks(forSeconds: leadSeconds)
        let when = AVAudioTime(hostTime: startHost)
        for voice in voices.values { voice.player.play(at: when) }
        anchorPositionMs = position
        anchorHostTime = startHost
        isPlaying = true
        return startHost
    }

    /// Stop where we are and say where that was.
    @discardableResult
    func pause() -> Double {
        let position = positionMs
        stopPlayers()
        anchorPositionMs = position
        isPlaying = false
        engine.pause()
        return position
    }

    /// Move the transport. Playing: restart at the new place; paused: only the
    /// position moves.
    func seek(to positionMs: Double) throws {
        let clamped = max(0, min(positionMs, durationMs))
        if isPlaying {
            try play(from: clamped)
        } else {
            anchorPositionMs = clamped
        }
    }

    /// The end of the song was reached: stopped, parked at the end.
    func finish() {
        stopPlayers()
        anchorPositionMs = durationMs
        isPlaying = false
        engine.pause()
    }

    func tearDown() {
        stopPlayers()
        for id in Array(voices.keys) { detach(id) }
        if engine.isRunning { engine.stop() }
        isPlaying = false
        anchorPositionMs = 0
        originMs = 0
        durationMs = 0
        order = []
    }

    private func stopPlayers() {
        for voice in voices.values { voice.player.stop() }
    }

    private func schedule(from positionMs: Double) {
        for id in order {
            guard let voice = voices[id] else { continue }
            guard let plan = JamAlignment.plan(
                stem: voice.stem.spec, fileFrames: voice.file.length, rate: voice.rate,
                originMs: originMs, positionMs: positionMs
            ), let frames = AVAudioFrameCount(exactly: plan.frameCount) else { continue }
            let at = plan.delayFrames > 0
                ? AVAudioTime(sampleTime: plan.delayFrames, atRate: voice.rate)
                : nil
            voice.player.scheduleSegment(
                voice.file, startingFrame: plan.startFrame, frameCount: frames, at: at,
                completionHandler: nil
            )
        }
    }

    private func handleConfigurationChange() {
        // The route changed under the engine (headphones out, a Bluetooth
        // speaker joined) and it has stopped itself. Keep the place; the next
        // tap on play starts a fresh graph at it.
        guard isPlaying else { return }
        let position = positionMs
        stopPlayers()
        anchorPositionMs = position
        isPlaying = false
        onInterruption?()
    }

    // MARK: - Offline rendering (the proof)

    /// Render the mix from `positionMs` with no hardware and return the left
    /// channel. Stems keep their own sample rates; the render is at `rate`.
    /// A test's way to ask "which output frame did each stem's first sample
    /// land on", which no real-time run can answer exactly.
    func renderOffline(
        fromPositionMs positionMs: Double, frameCount: Int, rate: Double = 48_000,
        chunk: AVAudioFrameCount = 4096
    ) throws -> [Float] {
        stopPlayers()
        if engine.isRunning { engine.stop() }
        guard let format = AVAudioFormat(standardFormatWithSampleRate: rate, channels: 2) else { return [] }
        try engine.enableManualRenderingMode(.offline, format: format, maximumFrameCount: chunk)
        defer { engine.disableManualRenderingMode() }
        engine.prepare()
        try engine.start()
        schedule(from: max(0, min(positionMs, durationMs)))
        for voice in voices.values { voice.player.play() }

        guard let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: chunk) else { return [] }
        var out: [Float] = []
        out.reserveCapacity(frameCount)
        while out.count < frameCount {
            let want = AVAudioFrameCount(min(Int(chunk), frameCount - out.count))
            let status = try engine.renderOffline(want, to: buffer)
            guard status == .success || status == .insufficientDataFromInputNode else { break }
            if let channel = buffer.floatChannelData?[0] {
                out.append(contentsOf: UnsafeBufferPointer(start: channel, count: Int(buffer.frameLength)))
            }
            if buffer.frameLength == 0 { break }
        }
        stopPlayers()
        engine.stop()
        return out
    }

    /// Where every stem has been summed: a test taps it to hear what the
    /// speaker gets (`JamWebTakeAlignmentTests`).
    var outputMixer: AVAudioMixerNode { engine.mainMixerNode }

    // MARK: - Host time

    private static let timebase: mach_timebase_info_data_t = {
        var info = mach_timebase_info_data_t()
        mach_timebase_info(&info)
        return info
    }()

    private func hostTicks(forSeconds seconds: Double) -> UInt64 {
        let t = Self.timebase
        return UInt64(seconds * 1_000_000_000 * Double(t.denom) / Double(t.numer))
    }

    private func hostSeconds(from start: UInt64, to end: UInt64) -> Double {
        guard end > start else { return -hostSeconds(from: end, to: start) }
        let t = Self.timebase
        return Double(end - start) * Double(t.numer) / Double(t.denom) / 1_000_000_000
    }
}
