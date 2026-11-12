import Foundation

// RECORDING A PART, THE ARITHMETIC. Everything here is pure (numbers in,
// numbers out) so the one formula the feature exists for is tested alone, and
// the recorder, the review and the upload read the same definitions. It is a
// port of the web's `placement.ts`, `recorder.ts`, `tempo.ts`,
// `jam-take-edit.ts` and `peaks.ts`, and writes the same fields: a take made
// here and a take made there are the same shape, so each plays in time on the
// other (`JamRecordingTests` proves the phone's half, `JamWebTakeAlignmentTests`
// the web's).
//
// THE LATENCY MODEL. One engine plays the band and captures the microphone, and
// both are stamped on ONE clock, the host clock (`mach_absolute_time`):
//
//   - The band's song time S leaves the graph at host time H0 + (S - from).
//   - The player hears it L_out later (the OS mixer, the DAC, Bluetooth if any).
//   - They play along with what they hear. The note reaches the capture L_in
//     after it was played (the ADC, the OS).
//   - So the capture stamps the note for song time S at H0 + (S - from) + L,
//     with L = L_out + L_in, the ROUND TRIP.
//
// Only the sum matters, and it is exactly what a loopback measures: a click
// that left the graph at host time P comes back stamped P + L. The take's first
// captured sample, stamped Hc, therefore belongs at song time
//
//         from + (Hc - H0) - L.
//
// `offsetMs` is the song time of the stored file's FIRST sample, the count-in
// stays in the file, and `trimStartMs` hides everything before `from`.

/// The host clock, in seconds. `AVAudioTime` and `AVAudioPlayerNode` speak host
/// ticks; every sum in this file is seconds.
enum JamHostClock {
    private static let timebase: mach_timebase_info_data_t = {
        var info = mach_timebase_info_data_t()
        mach_timebase_info(&info)
        return info
    }()

    static func seconds(fromTicks ticks: UInt64) -> Double {
        Double(ticks) * Double(timebase.numer) / Double(timebase.denom) / 1_000_000_000
    }

    static func ticks(fromSeconds seconds: Double) -> UInt64 {
        UInt64(max(0, seconds) * 1_000_000_000 * Double(timebase.denom) / Double(timebase.numer))
    }

    static var nowSeconds: Double { seconds(fromTicks: mach_absolute_time()) }
}

// MARK: - Where a take lands

/// The clock facts of one take.
struct JamTakeClock: Equatable, Sendable {
    var sampleRate: Double
    /// Song time (ms) the band started from.
    var fromMs: Double
    /// Host time (s) at which `fromMs` left the graph.
    var backingStartSeconds: Double
    /// Host time (s) of the first captured sample.
    var captureStartSeconds: Double
    /// Output plus input latency to take off, ms.
    var roundTripMs: Double

    /// Song time (ms, unrounded) of the take's first captured sample.
    var rawOffsetMs: Double {
        fromMs + (captureStartSeconds - backingStartSeconds) * 1000 - roundTripMs
    }
}

enum JamTakePlacement {
    /// Make the offset a whole number of milliseconds by dropping a few leading
    /// samples (fewer than one millisecond's worth). The server stores
    /// `offsetMs` as an integer, so rounding it then moves nothing. At 48 kHz
    /// the result is exact; at 44.1 kHz the leftover is under one sample.
    static func wholeMillisecond(offsetMs: Double, sampleRate: Double) -> (offsetMs: Double, dropFrames: Int) {
        let target = (offsetMs - 1e-9).rounded(.up)
        let drop = Int(((target - offsetMs) / 1000 * sampleRate).rounded())
        return (target, max(0, drop))
    }

    /// The head of the file that is not heard: everything before the song time
    /// the band started from (the count-in and the round trip), never more than
    /// the file.
    static func trimStartMs(fromMs: Double, offsetMs: Double, durationMs: Double) -> Double {
        min(max(0, fromMs - offsetMs), durationMs)
    }

    /// Song time of buffer sample `i` for a stem placed at `offsetMs`.
    static func songMs(ofSample i: Int, offsetMs: Double, sampleRate: Double) -> Double {
        offsetMs + Double(i) / sampleRate * 1000
    }
}

/// A recorded take, in the contract's terms.
struct JamTakeTiming: Equatable, Sendable {
    var offsetMs: Double
    var trimStartMs: Double
    var trimEndMs: Double
    var durationMs: Double

    var playedMs: Double { max(0, durationMs - trimStartMs - trimEndMs) }
}

// MARK: - The count-in

struct JamCountIn: Equatable, Sendable {
    var bars: Int
    var beatsPerBar: Int
    var bpm: Double

    /// One bar of four at 100 BPM: what the web starts with.
    static let standard = JamCountIn(bars: 1, beatsPerBar: 4, bpm: 100)

    var totalBeats: Int { max(0, bars) * max(0, beatsPerBar) }
    var beatSeconds: Double { 60 / bpm }
    var durationSeconds: Double { Double(totalBeats) * beatSeconds }

    /// The tempo and the bars are validated before anything starts: a tempo
    /// of 0 would make a click scheduler loop forever.
    var isValid: Bool {
        bars >= 0 && bars <= 2 && beatsPerBar >= 1 && beatsPerBar <= 16 && bpm >= 20 && bpm <= 400
    }

    static func beatFrames(bpm: Double, sampleRate: Double) -> Int {
        Int(((60 / bpm) * sampleRate).rounded())
    }

    /// How long the count-in lasts, in whole frames.
    func frames(sampleRate: Double) -> Int {
        totalBeats * Self.beatFrames(bpm: bpm, sampleRate: sampleRate)
    }

    /// Frames (counted from the count-in's first beat) of every click, and
    /// which one is the accent.
    func clicks(sampleRate: Double) -> [(frame: Int, accent: Bool)] {
        let beat = Self.beatFrames(bpm: bpm, sampleRate: sampleRate)
        return (0..<totalBeats).map { (frame: $0 * beat, accent: $0 % max(1, beatsPerBar) == 0) }
    }

    /// The whole count-in as one mono buffer: silence with a click on every
    /// beat. One buffer, started at one host time, is sample-exact where a
    /// click per timer tick would not be.
    func samples(sampleRate: Double) -> [Float] {
        var out = [Float](repeating: 0, count: frames(sampleRate: sampleRate))
        for click in clicks(sampleRate: sampleRate) {
            let sound = JamSignals.metronomeClick(sampleRate: sampleRate, accent: click.accent)
            for (i, value) in sound.enumerated() where click.frame + i < out.count { out[click.frame + i] += value }
        }
        return out
    }
}

// MARK: - What a person may change before sending

/// The optional edits between stopping and sending: nudge the whole take
/// earlier or later. (The web also trims and changes the volume; a nudge is
/// what a part that sits a little off needs, and a trim hides nothing the
/// count-in has not already hidden.) A nudge MOVES the audio, which is the one
/// thing a trim never does.
struct JamTakeEdits: Equatable, Sendable {
    var nudgeMs: Double = 0

    /// How far a nudge may go either way.
    static let nudgeLimitMs = 500.0
    /// The smallest step the buttons take: fine enough to hear, coarse enough
    /// to be one press.
    static let nudgeStepMs = 5.0

    var isEdited: Bool { nudgeMs != 0 }

    func nudged(by deltaMs: Double) -> JamTakeEdits {
        JamTakeEdits(nudgeMs: Self.clamp(nudgeMs + deltaMs))
    }

    static func clamp(_ ms: Double) -> Double {
        min(max(ms.rounded(), -nudgeLimitMs), nudgeLimitMs)
    }

    /// What the engine and the server get: the take's own numbers with the
    /// edit laid on. Only the offset moves.
    func placed(_ take: JamTakeTiming) -> JamTakeTiming {
        JamTakeTiming(
            offsetMs: take.offsetMs + nudgeMs, trimStartMs: take.trimStartMs,
            trimEndMs: take.trimEndMs, durationMs: take.durationMs
        )
    }

    /// A held button steps faster the longer it is held.
    static func holdStep(afterRepeats repeats: Int) -> Double {
        switch repeats {
        case ..<6: nudgeStepMs
        case ..<16: nudgeStepMs * 2
        default: nudgeStepMs * 4
        }
    }
}

// MARK: - Peaks and silence

enum JamTakePeaks {
    static let maxPeaks = JamLimits.peaksMax

    /// A waveform you can draw without the audio: at most `count` numbers in
    /// 0...1, each the loudest absolute sample in its slice of the WHOLE take,
    /// trims included, so the lane draws the hidden head greyed out and a nudge
    /// needs no new peaks. Absolute, not normalised, so a quiet stem looks quiet
    /// beside a loud one. Rounded to three decimals.
    static func compute(_ samples: [Float], count: Int = maxPeaks) -> [Double] {
        let buckets = max(0, min(count, maxPeaks, samples.count))
        guard buckets > 0 else { return [] }
        var out = [Double](repeating: 0, count: buckets)
        for b in 0..<buckets {
            let start = b * samples.count / buckets
            let end = (b + 1) * samples.count / buckets
            var peak: Float = 0
            var i = start
            while i < end {
                let a = abs(samples[i])
                if a > peak { peak = a }
                i += 1
            }
            out[b] = (Double(min(1, peak)) * 1000).rounded() / 1000
        }
        return out
    }

    /// A peak under this (about -40 dBFS) over the whole part that would be
    /// heard is a flat line: a muted or unplugged input. Quiet playing is
    /// nowhere near it. The web's number (`SILENT_PEAK`).
    static let silentPeak: Float = 0.01

    static func isSilent(loudest: Float) -> Bool { loudest < silentPeak }
}

// MARK: - Mono

enum JamMono {
    enum Choice: String, Sendable { case mono, left, right, mix }

    /// A stem is mono. A two-input interface usually delivers the guitar on one
    /// side and nothing (or a faint bleed) on the other; averaging would cost
    /// 6 dB and add the other input's hiss. So: if one side is more than 24 dB
    /// quieter, keep the loud side alone; otherwise average the two.
    static func choose(_ channels: [[Float]]) -> (samples: [Float], choice: Choice) {
        guard let first = channels.first else { return ([], .mono) }
        guard channels.count > 1 else { return (first, .mono) }
        let l = first, r = channels[1]
        func rms(_ x: [Float]) -> Double {
            guard !x.isEmpty else { return 0 }
            var sum = 0.0
            for v in x { sum += Double(v) * Double(v) }
            return (sum / Double(x.count)).squareRoot()
        }
        let a = rms(l), b = rms(r)
        let ratio = pow(10, 24.0 / 20)
        if a > b * ratio || (b == 0 && a > 0) { return (l, .left) }
        if b > a * ratio || (a == 0 && b > 0) { return (r, .right) }
        var out = [Float](repeating: 0, count: min(l.count, r.count))
        for i in 0..<out.count { out[i] = 0.5 * (l[i] + r[i]) }
        return (out, .mix)
    }
}

// MARK: - What is sent

/// The take as the server wants it, from the take and the edit. The web's
/// `postTake` / `prepareStemUpload` numbers: a whole-millisecond duration and
/// trims, the offset as it is.
enum JamUploadPlan {
    /// A recording shorter than this is a tap on the button.
    static let minDurationMs = 300
    /// The longest a take may be, file head included.
    static let maxDurationMs = JamLimits.trackMaxDurationMs
    /// A take stops itself this long before the ceiling.
    static let autoStopMs = JamLimits.trackMaxDurationMs - 5000
    /// What the bucket accepts for one audio object (32 MiB).
    static let maxBytes = 32 * 1024 * 1024
    /// FLAC is what the web sends and the one type every client opens without
    /// moving a sample (`JAM_AUDIO_CONTENT_TYPES` in the contract).
    static let contentType = "audio/flac"

    enum Problem: Equatable, Sendable {
        case tooShort, tooLong, tooBig
    }

    static func problem(durationMs: Double, byteSize: Int) -> Problem? {
        let rounded = Int(durationMs.rounded())
        if rounded < minDurationMs { return .tooShort }
        if rounded > maxDurationMs { return .tooLong }
        if byteSize > maxBytes { return .tooBig }
        return nil
    }

    static func body(
        timing: JamTakeTiming, edits: JamTakeEdits, instrument: JamInstrument, label: String?,
        audioUploadId: String, peaks: [Double]
    ) -> JamAddTrackBody {
        let placed = edits.placed(timing)
        let duration = Int(timing.durationMs.rounded())
        // Whole milliseconds, and never trims that leave nothing to play (the
        // server answers 422 for that; the head trim is below the file by
        // construction).
        let start = min(Int(placed.trimStartMs.rounded()), max(0, duration - 1))
        let end = min(Int(placed.trimEndMs.rounded()), max(0, duration - start - 1))
        return JamAddTrackBody(
            instrument: instrument, label: label, audioUploadId: audioUploadId, durationMs: duration,
            offsetMs: placed.offsetMs, trimStartMs: start, trimEndMs: end, gain: 1, peaks: peaks
        )
    }
}

// MARK: - Test and calibration signals

enum JamSignals {
    /// A metronome click: a short decaying sine. `accent` is the first beat of
    /// a bar (higher and louder), the way every DAW's click sounds.
    static func metronomeClick(sampleRate: Double, accent: Bool) -> [Float] {
        let freq = accent ? 1760.0 : 1320.0
        let n = Int((0.03 * sampleRate).rounded())
        let amp = accent ? 0.6 : 0.4
        let attack = Int((0.001 * sampleRate).rounded())
        var out = [Float](repeating: 0, count: n)
        for i in 0..<n {
            let env = i < attack ? Double(i) / Double(max(1, attack)) : exp(-Double(i - attack) / (0.006 * sampleRate))
            out[i] = Float(amp * env * sin(2 * Double.pi * freq * Double(i) / sampleRate))
        }
        return out
    }

    /// A Hann-windowed exponential sweep, 8 kHz down to 1 kHz. Its
    /// autocorrelation is one sharp peak a sample wide, which is what makes it
    /// a good thing to find in a recording: a speaker and a microphone colour
    /// it, they do not move its peak.
    static func sweep(sampleRate: Double, durationMs: Double = 10, amplitude: Double = 0.5) -> [Float] {
        let n = max(16, Int((durationMs / 1000 * sampleRate).rounded()))
        // Stay clear of Nyquist on a 16 kHz Bluetooth headset microphone.
        let high = min(8000, sampleRate * 0.4)
        let low = min(1000, high / 4)
        let (f0, f1) = (high, low)
        let total = Double(n) / sampleRate
        let k = log(f1 / f0)
        var out = [Float](repeating: 0, count: n)
        for i in 0..<n {
            let t = Double(i) / sampleRate
            let phase = (2 * Double.pi * f0 * total / k) * (exp(t * k / total) - 1)
            let w = 0.5 - 0.5 * cos(2 * Double.pi * Double(i) / Double(n - 1))
            out[i] = Float(amplitude * w * sin(phase))
        }
        return out
    }

    /// Lay `pulse` into a silent buffer at each frame in `at`.
    static func pulseTrain(length: Int, pulse: [Float], at: [Int]) -> [Float] {
        var out = [Float](repeating: 0, count: length)
        for start in at {
            for i in 0..<pulse.count {
                let j = start + i
                if j >= 0 && j < length { out[j] += pulse[i] }
            }
        }
        return out
    }
}
