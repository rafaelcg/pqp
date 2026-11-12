import Accelerate
import AVFoundation
import Foundation

/// WHERE THE MICROPHONE GOES. The input node's tap hands over a buffer every
/// few tens of milliseconds on its own queue; this keeps every one, in order,
/// with the host time of the FIRST sample (that stamp is what places the take on
/// the song, `JamTakeClock`).
///
/// A take goes to a file as it is captured (float32, the input's own channels up
/// to two) and not into an array: ten minutes at 48 kHz is more than a hundred
/// megabytes of floats, and a take that outlives its screen (a call came in)
/// must still be there. A calibration keeps its few seconds in memory.
///
/// Gaps are filled with silence and counted, never closed up: closing one would
/// move everything after it off the song's grid (the web's `assembleChunks` says
/// the same). The tap does not skip a buffer on a healthy engine, so a nonzero
/// count is a sign the device dropped input.
final class JamCaptureSink: @unchecked Sendable {
    struct Capture: Sendable {
        var url: URL?
        /// Per channel, when kept in memory.
        var memory: [[Float]]
        var sampleRate: Double
        var channels: Int
        /// Host time (s) of the first captured sample.
        var startHostSeconds: Double
        /// The first buffer carried no usable host time, so the start was
        /// guessed from the clock when it arrived. The take is placed less
        /// precisely, and the studio says to calibrate.
        var hostTimeEstimated: Bool
        var frames: Int
        var gapFrames: Int
        /// The loudest absolute sample, over everything captured.
        var loudest: Float
    }

    private let lock = NSLock()
    private let queue = DispatchQueue(label: "gg.pqp.jam.capture", qos: .userInitiated)
    private let fileURL: URL?
    private let keepInMemory: Bool

    // Guarded by `lock`.
    private var started = false
    private var startHostSeconds = 0.0
    private var hostEstimated = false
    private var sampleRate = 0.0
    private var channelCount = 0
    private var firstSampleTime: Double?
    private var nextSampleTime: Double?
    private var frames = 0
    private var gapFrames = 0
    private var loudest: Float = 0
    private var meterPeak: Float = 0
    private var failed = false

    // Touched only on `queue`.
    private var file: AVAudioFile?
    private var memory: [[Float]] = []

    init(fileURL: URL?, keepInMemory: Bool) {
        self.fileURL = fileURL
        self.keepInMemory = keepInMemory
    }

    /// Install the tap on an input node. A NONISOLATED function on purpose: a
    /// closure written inside a main-actor method is itself main-actor
    /// isolated, and AVAudioEngine calls it on its own queue, where Swift traps
    /// the isolation check (the first version of the recorder crashed on the
    /// first buffer).
    nonisolated static func install(on node: AVAudioNode, format: AVAudioFormat, into sink: JamCaptureSink) {
        node.installTap(onBus: 0, bufferSize: 1024, format: format) { buffer, when in
            sink.append(buffer, when: when)
        }
    }

    /// Called from the tap, on its own thread.
    func append(_ buffer: AVAudioPCMBuffer, when: AVAudioTime) {
        let frameLength = Int(buffer.frameLength)
        guard frameLength > 0, let data = buffer.floatChannelData else { return }
        let channels = min(Int(buffer.format.channelCount), 2)

        var peak: Float = 0
        for c in 0..<channels {
            var channelPeak: Float = 0
            vDSP_maxmgv(data[c], 1, &channelPeak, vDSP_Length(frameLength))
            peak = max(peak, channelPeak)
        }

        lock.lock()
        let first = !started
        var gap = 0
        if first {
            started = true
            sampleRate = buffer.format.sampleRate
            channelCount = channels
            if when.isHostTimeValid, when.hostTime != 0 {
                startHostSeconds = JamHostClock.seconds(fromTicks: when.hostTime)
            } else {
                // No stamp: the buffer was just captured, so its first sample is
                // one buffer ago. Good to a buffer's length, which is why it is
                // flagged.
                startHostSeconds = JamHostClock.nowSeconds - Double(frameLength) / sampleRate
                hostEstimated = true
            }
            if when.isSampleTimeValid { firstSampleTime = Double(when.sampleTime) }
        } else if when.isSampleTimeValid, let expected = nextSampleTime {
            let missing = Int((Double(when.sampleTime) - expected).rounded())
            if missing > 0 {
                gap = missing
                gapFrames += missing
            }
        }
        if when.isSampleTimeValid { nextSampleTime = Double(when.sampleTime) + Double(frameLength) }
        frames += gap + frameLength
        loudest = max(loudest, peak)
        meterPeak = max(meterPeak, peak)
        lock.unlock()

        // Copied here (the tap's buffer is reused) and written on the queue.
        var copy = [[Float]](repeating: [], count: channels)
        for c in 0..<channels {
            copy[c] = Array(UnsafeBufferPointer(start: data[c], count: frameLength))
        }
        let rate = buffer.format.sampleRate
        let chunk = copy, missing = gap
        queue.async { [self] in
            write(chunk, gap: missing, sampleRate: rate)
        }
    }

    private func write(_ channels: [[Float]], gap: Int, sampleRate: Double) {
        if keepInMemory {
            if memory.isEmpty { memory = Array(repeating: [], count: channels.count) }
            for c in 0..<channels.count {
                if gap > 0 { memory[c].append(contentsOf: repeatElement(0, count: gap)) }
                memory[c].append(contentsOf: channels[c])
            }
        }
        guard let fileURL else { return }
        do {
            if file == nil {
                guard let format = AVAudioFormat(
                    commonFormat: .pcmFormatFloat32, sampleRate: sampleRate,
                    channels: AVAudioChannelCount(channels.count), interleaved: false
                ) else { return }
                file = try AVAudioFile(forWriting: fileURL, settings: format.settings)
            }
            guard let file else { return }
            if gap > 0 { try writeSilence(frames: gap, to: file) }
            let frameCount = channels[0].count
            guard let buffer = AVAudioPCMBuffer(
                pcmFormat: file.processingFormat, frameCapacity: AVAudioFrameCount(frameCount)
            ), let out = buffer.floatChannelData else { return }
            buffer.frameLength = AVAudioFrameCount(frameCount)
            for c in 0..<channels.count {
                channels[c].withUnsafeBufferPointer { out[c].update(from: $0.baseAddress!, count: frameCount) }
            }
            try file.write(from: buffer)
        } catch {
            lock.lock()
            failed = true
            lock.unlock()
        }
    }

    private func writeSilence(frames: Int, to file: AVAudioFile) throws {
        var left = frames
        let chunk = 16_384
        while left > 0 {
            let n = min(chunk, left)
            guard let buffer = AVAudioPCMBuffer(pcmFormat: file.processingFormat, frameCapacity: AVAudioFrameCount(n)) else { return }
            buffer.frameLength = AVAudioFrameCount(n)
            for c in 0..<Int(file.processingFormat.channelCount) {
                buffer.floatChannelData![c].update(repeating: 0, count: n)
            }
            try file.write(from: buffer)
            left -= n
        }
    }

    /// The loudest sample since the last read, 0...1: the level meter. Reading
    /// it starts the next window.
    func takeMeterPeak() -> Float {
        lock.lock()
        defer { lock.unlock() }
        let peak = meterPeak
        meterPeak = 0
        return min(1, peak)
    }

    var capturedFrames: Int {
        lock.lock()
        defer { lock.unlock() }
        return frames
    }

    var didFail: Bool {
        lock.lock()
        defer { lock.unlock() }
        return failed
    }

    /// Close the file and hand over what was captured. Nil when nothing came.
    func finish() -> Capture? {
        // Everything queued is written, then the file is closed (released), so
        // it is a complete file when this returns.
        let kept: [[Float]] = queue.sync {
            file = nil
            return memory
        }
        lock.lock()
        defer { lock.unlock() }
        guard started, frames > 0 else { return nil }
        return Capture(
            url: fileURL, memory: kept, sampleRate: sampleRate, channels: channelCount,
            startHostSeconds: startHostSeconds, hostTimeEstimated: hostEstimated, frames: frames,
            gapFrames: gapFrames, loudest: loudest
        )
    }
}
