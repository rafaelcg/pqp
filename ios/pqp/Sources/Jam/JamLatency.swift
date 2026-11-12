import Accelerate
import AVFoundation
import Foundation

// THE LATENCY MODEL'S PURE HALF: turning what the capture heard into a round
// trip, judging how far to trust it, and remembering it per audio route. A port
// of the web's `latency.ts` and `xcorr.ts`; the half that plays the sweeps and
// records them is `JamCalibrator`.
//
// Three ways to know the round trip, best first:
//
//  1. LOOPBACK. The microphone can hear the output (the speaker, or a headphone
//     cup held against the microphone). Sweeps are played and found in the
//     capture by cross-correlation. Measures the exact path a take travels, to a
//     fraction of a millisecond.
//  2. TAP-ALONG. The microphone cannot hear the output (wired headphones). The
//     player claps, taps the microphone or hits muted strings on every click;
//     the round trip is the median of (tap heard) minus (click played). A human:
//     a few milliseconds of spread at best.
//  3. ESTIMATE. What AVAudioSession reports: `outputLatency + inputLatency`.
//     Free and instant, and labelled "low": no OS promises those two numbers add
//     up to the real round trip, and the answer on a Bluetooth route changes
//     from one session to the next.
//
// A calibration is remembered per audio ROUTE (`JamAudioRoute.key`): the same
// headphones and the same microphone give the same latency, other ones do not.

enum JamLatencyMethod: String, Codable, Sendable {
    case loopback, tapAlong = "tap-along", estimate, manual
}

enum JamLatencyConfidence: String, Codable, Sendable {
    case high, medium, low, failed
}

struct JamLatencyResult: Codable, Equatable, Sendable {
    var method: JamLatencyMethod
    /// Output plus input, ms. Meaningless when `confidence` is `.failed`.
    var roundTripMs: Double
    var confidence: JamLatencyConfidence
    /// Largest deviation of an accepted measurement from the result, ms.
    var spreadMs: Double?
    /// How many pulses were usable, of how many were played.
    var accepted: Int
    var played: Int
    /// When it was measured.
    var at: Date
    /// `outputLatency` (ms) the session reported when this was measured. If the
    /// session later reports something clearly different, the output path
    /// changed under the same route (a Bluetooth codec renegotiated) and the
    /// stored value is stale.
    var reportedOutputMs: Double?

    var isUsable: Bool { confidence != .failed && roundTripMs.isFinite && roundTripMs >= 0 }
}

enum JamLatencyRules {
    /// How far the reported output latency may move before a stored
    /// measurement is stale, ms.
    static let staleOutputDriftMs = 8.0
    /// Input latency to assume when the session reports none (a typical capture
    /// buffer).
    static let assumedInputMs = 10.0

    /// What the session reports, as a free (low confidence) estimate.
    static func estimate(
        outputLatency: TimeInterval, inputLatency: TimeInterval, now: Date = Date()
    ) -> JamLatencyResult {
        let output = outputLatency.isFinite && outputLatency > 0 ? outputLatency * 1000 : 0
        // Under a millisecond is not a report (a simulator says 0.0000001).
        let input = inputLatency.isFinite && inputLatency >= 0.001 ? inputLatency * 1000 : assumedInputMs
        return JamLatencyResult(
            method: .estimate, roundTripMs: ((output + input) * 1000).rounded() / 1000, confidence: .low,
            spreadMs: nil, accepted: 0, played: 0, at: now, reportedOutputMs: output
        )
    }

    /// Which latency to compensate with: a stored measurement for this route
    /// when it is usable, otherwise the estimate. Loopback beats tap-along beats
    /// estimate; a manual value beats everything, because a person who typed a
    /// number meant it.
    static func choose(
        stored: [JamLatencyResult], estimate: JamLatencyResult, currentOutputMs: Double?
    ) -> JamLatencyResult {
        let rank: [JamLatencyMethod: Int] = [.manual: 0, .loopback: 1, .tapAlong: 2, .estimate: 3]
        let usable = stored
            .filter { $0.isUsable && !isStale($0, currentOutputMs: currentOutputMs) }
            .sorted { a, b in
                let ra = rank[a.method] ?? 9, rb = rank[b.method] ?? 9
                return ra != rb ? ra < rb : a.at > b.at
            }
        return usable.first ?? estimate
    }

    static func isStale(_ result: JamLatencyResult, currentOutputMs: Double?) -> Bool {
        if result.method == .manual { return false }
        guard let reported = result.reportedOutputMs, let current = currentOutputMs else { return false }
        return abs(reported - current) > staleOutputDriftMs
    }

    /// A person's own sentence for where the number came from, by method.
    static func isMeasured(_ result: JamLatencyResult) -> Bool {
        result.method != .estimate
    }
}

// MARK: - The route

/// Where the sound goes and where it comes from.
enum JamRouteKind: Equatable, Sendable {
    /// The phone's own speaker or earpiece: the band leaks into the microphone.
    case speaker
    /// Wired headphones, a headset, a USB interface, a line out.
    case wired
    /// Bluetooth, AirPlay, a car: 100 to 300 ms that change from session to
    /// session, which no calibration can hold.
    case wireless
    case other

    static func of(output port: AVAudioSession.Port) -> JamRouteKind {
        switch port {
        case .builtInSpeaker, .builtInReceiver: .speaker
        case .headphones, .usbAudio, .lineOut, .thunderbolt: .wired
        case .bluetoothA2DP, .bluetoothHFP, .bluetoothLE, .airPlay, .carAudio: .wireless
        default: .other
        }
    }
}

struct JamAudioRoute: Equatable, Sendable {
    var outputKind: JamRouteKind
    var outputName: String
    var outputUID: String
    var inputName: String
    var inputUID: String
    var sampleRate: Double
    /// `outputLatency` as the session reports it right now, ms.
    var reportedOutputMs: Double

    /// The key a calibration is stored under. The UIDs name the devices (they
    /// are stable across sessions); the names are in it for a human reading the
    /// store, and the sample rate is in it because a different rate is a
    /// different driver setup with a different buffer.
    var key: String {
        let norm = { (s: String) in s.trimmingCharacters(in: .whitespaces).lowercased() }
        return "in:\(inputUID)|\(norm(inputName)) out:\(outputUID)|\(norm(outputName)) sr:\(Int(sampleRate))"
    }

    /// Whether a take over this route can be trusted to line up, and what to
    /// say when it cannot. Playing back over anything is fine; recording over
    /// Bluetooth is not (the latency moves). The speaker records, with bleed.
    var assessment: JamRouteAssessment {
        if outputKind == .wireless || reportedOutputMs > 100 { return .wireless }
        if outputKind == .speaker { return .speaker }
        return .fine
    }

    static let unknown = JamAudioRoute(
        outputKind: .other, outputName: "", outputUID: "", inputName: "", inputUID: "", sampleRate: 48_000,
        reportedOutputMs: 0
    )
}

enum JamRouteAssessment: Equatable, Sendable {
    case fine, speaker, wireless
}

/// The route as the audio session sees it now.
@MainActor
enum JamRouteReader {
    static func current(session: AVAudioSession = .sharedInstance()) -> JamAudioRoute {
        let route = session.currentRoute
        let output = route.outputs.first
        let input = route.inputs.first
        return JamAudioRoute(
            outputKind: output.map { JamRouteKind.of(output: $0.portType) } ?? .other,
            outputName: output?.portName ?? "",
            outputUID: output?.uid ?? "",
            inputName: input?.portName ?? "",
            inputUID: input?.uid ?? "",
            sampleRate: session.sampleRate,
            reportedOutputMs: session.outputLatency * 1000
        )
    }
}

// MARK: - The store

/// Calibrations per route, in the preferences: a per-person convenience whose
/// loss costs a re-run, never an error.
struct JamLatencyStore {
    static let storeKey = "pqp.jam.latency.v1"
    private let defaults: UserDefaults

    init(defaults: UserDefaults = .standard) { self.defaults = defaults }

    private func readAll() -> [String: [JamLatencyResult]] {
        guard let data = defaults.data(forKey: Self.storeKey),
              let all = try? JSONDecoder().decode([String: [JamLatencyResult]].self, from: data)
        else { return [:] }
        return all
    }

    private func writeAll(_ all: [String: [JamLatencyResult]]) {
        if let data = try? JSONEncoder().encode(all) { defaults.set(data, forKey: Self.storeKey) }
    }

    func results(for key: String) -> [JamLatencyResult] { readAll()[key] ?? [] }

    /// Keep the newest result per method for this route. A failed measurement
    /// is not kept: it says nothing about the route.
    func save(_ result: JamLatencyResult, for key: String) {
        guard result.isUsable, result.method != .estimate else { return }
        var all = readAll()
        all[key] = (all[key] ?? []).filter { $0.method != result.method } + [result]
        writeAll(all)
    }

    func clear(method: JamLatencyMethod, for key: String) {
        var all = readAll()
        all[key] = (all[key] ?? []).filter { $0.method != method }
        writeAll(all)
    }

    func clearAll() { defaults.removeObject(forKey: Self.storeKey) }
}

// MARK: - Finding a known sound in a recording

enum JamPulse {
    struct Match: Equatable {
        /// Where `ref` starts in `signal`, in samples, with a sub-sample part
        /// from a parabola through the peak and its two neighbours.
        var position: Double
        /// Normalised correlation at the peak, 0...1 (absolute: polarity is
        /// ignored, because plenty of microphones invert).
        var quality: Double
    }

    /// Normalised cross-correlation of `ref` against `signal` for every start
    /// in `[from, to]`, and the position of the DIRECT sound. "Direct" matters
    /// in a room: a wall a metre away gives a second copy of the click about 6
    /// ms later, sometimes louder at the microphone, so the answer is the
    /// EARLIEST local peak that reaches `earliestRatio` of the strongest one.
    static func find(
        in signal: [Float], ref: [Float], from: Int, to: Int, sampleRate: Double, earliestRatio: Double = 0.6
    ) -> Match? {
        let n = ref.count
        let start = max(0, from)
        let end = min(signal.count - n, to)
        guard n > 0, end >= start else { return nil }
        var refEnergy: Float = 0
        vDSP_svesq(ref, 1, &refEnergy, vDSP_Length(n))
        guard refEnergy > 0 else { return nil }
        let refNorm = Double(refEnergy).squareRoot()

        let count = end - start + 1
        var ncc = [Double](repeating: 0, count: count)
        var best = 0.0
        signal.withUnsafeBufferPointer { sig in
            ref.withUnsafeBufferPointer { r in
                var window: Float = 0
                vDSP_svesq(sig.baseAddress! + start, 1, &window, vDSP_Length(n))
                var winEnergy = Double(window)
                for k in 0..<count {
                    let p = start + k
                    if k > 0 {
                        let out = Double(sig[p - 1]), inn = Double(sig[p + n - 1])
                        winEnergy += inn * inn - out * out
                        if winEnergy < 0 { winEnergy = 0 }
                    }
                    var dot: Float = 0
                    vDSP_dotpr(sig.baseAddress! + p, 1, r.baseAddress!, 1, &dot, vDSP_Length(n))
                    let denom = refNorm * winEnergy.squareRoot()
                    let v = denom > 1e-12 ? abs(Double(dot)) / denom : 0
                    ncc[k] = v
                    if v > best { best = v }
                }
            }
        }
        guard best > 0 else { return nil }
        // A correlation peak of a band-limited pulse rings: with polarity
        // ignored its first sidelobes are a fraction of a millisecond away and
        // can reach most of the main peak. So a candidate must be the largest
        // value within `guard` either side. A real reflection arrives later.
        let guardSpan = max(2, Int((sampleRate * 0.0005).rounded()))
        let threshold = best * earliestRatio
        var peak = -1
        for k in 0..<count where ncc[k] >= threshold {
            var isMax = true
            for j in max(0, k - guardSpan)...min(count - 1, k + guardSpan) where ncc[j] > ncc[k] {
                isMax = false
                break
            }
            if isMax { peak = k; break }
        }
        guard peak >= 0 else { return nil }
        let frac = peak > 0 && peak < count - 1 ? parabolicOffset(ncc[peak - 1], ncc[peak], ncc[peak + 1]) : 0
        return Match(position: Double(start + peak) + frac, quality: ncc[peak])
    }

    /// Vertex of the parabola through three equally spaced points, as an
    /// offset from the middle one, in -0.5...0.5.
    static func parabolicOffset(_ left: Double, _ mid: Double, _ right: Double) -> Double {
        let denom = left - 2 * mid + right
        if denom == 0 { return 0 }
        return max(-0.5, min(0.5, 0.5 * (left - right) / denom))
    }

    /// Onsets in a recording: claps, a tapped microphone, a muted string hit.
    /// A first difference (so rumble and DC do not count) is rectified and
    /// averaged over 1 ms; an onset is where that envelope crosses
    /// `thresholdRatio` of the loudest hit and has been quiet for
    /// `refractoryMs`. The position is the first SAMPLE in that millisecond that
    /// reaches a third of the local peak.
    static func onsets(
        in signal: [Float], sampleRate: Double, thresholdRatio: Double = 0.3, refractoryMs: Double = 120
    ) -> [Int] {
        let refractory = Int((refractoryMs / 1000 * sampleRate).rounded())
        let hop = max(1, Int((sampleRate / 1000).rounded()))
        let frames = (signal.count - 1) / hop
        guard frames > 0 else { return [] }
        var env = [Double](repeating: 0, count: frames)
        var maximum = 0.0
        for f in 0..<frames {
            var s = 0.0
            let base = f * hop + 1
            for i in 0..<hop { s += Double(abs(signal[base + i] - signal[base + i - 1])) }
            env[f] = s / Double(hop)
            if env[f] > maximum { maximum = env[f] }
        }
        guard maximum > 0 else { return [] }
        let threshold = maximum * thresholdRatio
        var out: [Int] = []
        var lastOnset = -Int.max / 2
        for f in 0..<frames where env[f] >= threshold {
            let at = f * hop
            if at - lastOnset < refractory { continue }
            var localPeak: Float = 0
            let peakEnd = min(signal.count, at + Int((0.005 * sampleRate).rounded()))
            let begin = max(0, at - hop)
            for i in begin..<peakEnd where abs(signal[i]) > localPeak { localPeak = abs(signal[i]) }
            var onset = at
            for i in begin..<peakEnd where abs(signal[i]) >= localPeak / 3 {
                onset = i
                break
            }
            out.append(onset)
            lastOnset = at
        }
        return out
    }

    static func median(_ values: [Double]) -> Double {
        guard !values.isEmpty else { return .nan }
        let s = values.sorted()
        let m = s.count / 2
        return s.count % 2 == 1 ? s[m] : (s[m - 1] + s[m]) / 2
    }
}

// MARK: - Judging a measurement

enum JamLatencyAnalysis {
    struct Thresholds {
        var highSpread: Double
        var mediumSpread: Double
        var outlierMs: Double
    }

    /// Loopback: sweeps went out, each is found in the capture, and the round
    /// trip is the median lag. `emittedFrames` are where each sweep LEFT the
    /// graph, in frames of the capture (frame 0 is the capture's first sample),
    /// so `lag = heard - emitted` is the round trip on the capture's own clock.
    static func loopback(
        captured: [Float], emittedFrames: [Int], reference: [Float], sampleRate: Double,
        maxLatencyMs: Double, reportedOutputMs: Double? = nil, minQuality: Double = 0.2, now: Date = Date()
    ) -> JamLatencyResult {
        let maxLag = Int((maxLatencyMs / 1000 * sampleRate).rounded())
        var lags: [Double] = []
        for emitted in emittedFrames {
            // A sweep that left before the capture began cannot have been heard.
            guard emitted >= 0 else { continue }
            guard let match = JamPulse.find(
                in: captured, ref: reference, from: emitted, to: emitted + maxLag, sampleRate: sampleRate
            ) else { continue }
            if match.quality >= minQuality { lags.append((match.position - Double(emitted)) / sampleRate * 1000) }
        }
        return judge(
            .loopback, lags: lags, played: emittedFrames.count, reportedOutputMs: reportedOutputMs, now: now,
            thresholds: Thresholds(highSpread: 0.25, mediumSpread: 1, outlierMs: 1)
        )
    }

    /// Tap-along: for wired headphones, where the microphone cannot hear the
    /// output. The first two taps are the player finding the beat and are
    /// ignored.
    static func tapAlong(
        captured: [Float], clickFrames: [Int], sampleRate: Double, maxLatencyMs: Double = 450,
        warmup: Int = 2, reportedOutputMs: Double? = nil, now: Date = Date()
    ) -> JamLatencyResult {
        let maxLag = maxLatencyMs / 1000 * sampleRate
        // A tap can be early: people anticipate a beat by tens of milliseconds.
        let early = 0.08 * sampleRate
        let onsets = JamPulse.onsets(in: captured, sampleRate: sampleRate)
        // Each onset belongs to at most one click, the nearest one whose window
        // it falls in: a missed tap must not let the next click's tap count twice.
        var owner: [Int: Int] = [:]
        for (oi, onset) in onsets.enumerated() {
            var best = -1
            var bestDist = Double.infinity
            for (ci, click) in clickFrames.enumerated() {
                let o = Double(onset), c = Double(click)
                if o < c - early || o > c + maxLag { continue }
                let dist = abs(o - c)
                if dist < bestDist { bestDist = dist; best = ci }
            }
            if best >= 0, owner[best] == nil { owner[best] = oi }
        }
        var lags: [Double] = []
        for (i, click) in clickFrames.enumerated() {
            guard let oi = owner[i], i >= warmup else { continue }
            lags.append(Double(onsets[oi] - click) / sampleRate * 1000)
        }
        return judge(
            .tapAlong, lags: lags, played: max(0, clickFrames.count - warmup), reportedOutputMs: reportedOutputMs,
            now: now, thresholds: Thresholds(highSpread: -1, mediumSpread: 6, outlierMs: 25)
        )
    }

    static func judge(
        _ method: JamLatencyMethod, lags: [Double], played: Int, reportedOutputMs: Double?, now: Date,
        thresholds t: Thresholds
    ) -> JamLatencyResult {
        let failed = JamLatencyResult(
            method: method, roundTripMs: .nan, confidence: .failed, spreadMs: nil, accepted: lags.count,
            played: played, at: now, reportedOutputMs: reportedOutputMs
        )
        guard lags.count >= 3 else { return failed }
        // A round trip is never negative. For a tap, a negative median means
        // the player anticipates the beat (people do, by tens of ms), and the
        // measurement says nothing about the route.
        guard JamPulse.median(lags) >= 0 else { return failed }
        let m = JamPulse.median(lags)
        let inliers = lags.filter { abs($0 - m) <= t.outlierMs }
        guard !inliers.isEmpty else { return failed }
        let result = JamPulse.median(inliers)
        let spread = inliers.reduce(0.0) { max($0, abs($1 - result)) }
        let minAccepted = max(3, Int((Double(played) * 0.5).rounded(.up)))
        var confidence: JamLatencyConfidence
        if inliers.count < minAccepted { confidence = .low }
        else if spread <= t.highSpread { confidence = .high }
        else if spread <= t.mediumSpread { confidence = .medium }
        else { confidence = .low }
        // A tap is a person: it carries their own reaction time (or their
        // anticipation) on top of the route's latency, so it is never better
        // than a rough adjustment, however steady the taps. The loopback is the
        // measurement; the nudge in review is where a human's feel goes.
        if method == .tapAlong, confidence == .high { confidence = .medium }
        return JamLatencyResult(
            method: method, roundTripMs: (result * 1000).rounded() / 1000, confidence: confidence,
            spreadMs: (spread * 1000).rounded() / 1000, accepted: inliers.count, played: played, at: now,
            reportedOutputMs: reportedOutputMs
        )
    }
}
