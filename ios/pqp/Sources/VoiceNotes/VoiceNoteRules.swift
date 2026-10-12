import CoreGraphics
import Foundation

// The pure half of recording a voice note: the waveform the card will draw, the
// gesture that decides what a finger is doing, and the rule for when recording
// is refused. None of it touches AVFoundation or UIKit, so all of it runs in the
// unit-test target, which cannot open a microphone.

// MARK: - Limits

enum VoiceNoteLimits {
    /// The recorder's hard stop. Matches `VOICE_NOTE_MAX_DURATION_MS` in
    /// `@pqp/shared`, which the mint refuses past.
    static let maxDurationMs = 5 * 60 * 1000
    /// The server refuses under this (`VOICE_NOTE_MIN_DURATION_MS`).
    static let serverMinDurationMs = 300
    /// What the gesture treats as an accidental tap rather than a message. Above
    /// the server's floor on purpose: 0.3 s of room tone is a thumb, not a note.
    static let accidentalTapMs = 700
    /// Peaks in the waveform, one byte each (`VOICE_NOTE_WAVEFORM_PEAKS`).
    static let waveformPeaks = 64
    /// How long a cancelled recording can still be brought back.
    static let undoSeconds: Double = 5
}

// MARK: - Waveform

/// Turns the meter readings taken while recording into the 64 bytes the server
/// stores and every card draws.
///
/// `AVAudioRecorder.averagePower(forChannel:)` answers in decibels, -160 for
/// digital silence up to 0 for full scale, once per call. A recorder samples it
/// on a timer, so the input here is "however many readings the recording took",
/// from a handful for a one-second note to thousands for a five-minute one.
enum VoiceWaveform {
    /// Below this a reading is silence. Speech in a quiet room meters around
    /// -45 to -20 dB, and treating anything under -50 as zero keeps the hiss
    /// between words flat instead of drawing it as texture.
    static let floorDecibels: Float = -50

    /// A reading as 0...1, linear in decibels between the floor and full scale.
    /// Non-finite readings (a recorder that has not metered yet answers
    /// -infinity or NaN on some devices) count as silence.
    static func level(decibels: Float) -> Float {
        guard decibels.isFinite else { return 0 }
        let clamped = min(0, max(floorDecibels, decibels))
        return (clamped - floorDecibels) / -floorDecibels
    }

    /// Exactly `peakCount` bytes. Each is the LOUDEST reading in its slice of
    /// the recording (a peak, not an average, so one word stays visible), then
    /// the whole thing is scaled so the loudest slice is 255. That scaling is
    /// what makes a quiet talker's note look as lively as a loud one's; a note
    /// that is entirely silence stays all zeros rather than being amplified into
    /// noise.
    ///
    /// Fewer readings than peaks (a very short note) stretch: each reading
    /// covers several adjacent peaks.
    static func normalise(decibels: [Float], peakCount: Int = VoiceNoteLimits.waveformPeaks) -> [UInt8] {
        guard peakCount > 0 else { return [] }
        let levels = decibels.map(level(decibels:))
        guard !levels.isEmpty else { return [UInt8](repeating: 0, count: peakCount) }

        var peaks = [Float](repeating: 0, count: peakCount)
        for index in 0..<peakCount {
            // Slice [lo, hi) of the readings that this peak summarises, never
            // empty: when readings are scarcer than peaks, hi = lo + 1.
            let lo = index * levels.count / peakCount
            let hi = max(lo + 1, (index + 1) * levels.count / peakCount)
            peaks[index] = levels[lo..<min(hi, levels.count)].max() ?? 0
        }

        let loudest = peaks.max() ?? 0
        // Under this the whole recording is indistinguishable from silence.
        guard loudest > 0.02 else { return [UInt8](repeating: 0, count: peakCount) }
        return peaks.map { UInt8(min(255, max(0, ($0 / loudest * 255).rounded()))) }
    }

    /// The wire form: 64 bytes, base64 (88 characters ending `==`).
    static func encode(_ peaks: [UInt8]) -> String {
        Data(peaks).base64EncodedString()
    }

    /// The card's bars, 0...1. Empty for a missing or unreadable waveform, which
    /// the card draws as a flat line.
    static func decode(_ base64: String) -> [Float] {
        guard let data = Data(base64Encoded: base64) else { return [] }
        return data.map { Float($0) / 255 }
    }

    /// The same peaks resampled to `count` bars for a card of a given width:
    /// the loudest in each slice when shrinking, repeated when growing.
    static func bars(from peaks: [Float], count: Int) -> [Float] {
        guard count > 0 else { return [] }
        guard !peaks.isEmpty else { return [Float](repeating: 0, count: count) }
        return (0..<count).map { index in
            let lo = index * peaks.count / count
            let hi = max(lo + 1, (index + 1) * peaks.count / count)
            return peaks[lo..<min(hi, peaks.count)].max() ?? 0
        }
    }
}

// MARK: - The gesture

/// What a finger on the microphone button is doing, as a state machine.
///
/// WhatsApp's gesture, because the muscle memory is already in every user's
/// thumb: hold to record, slide left to cancel, slide up to lock. Locked, the
/// finger can lift; the recording gets Pause and Send.
///
/// It is a value type fed inputs and returning effects, with no timers and no
/// recorder inside, so every transition (including the awkward ones: lifting
/// after the cap, tapping Send on a note that is too short, a call arriving
/// mid-hold) is a unit test rather than a thing to try on a phone.
struct VoiceGesture: Equatable, Sendable {
    enum Phase: Equatable, Sendable {
        case idle
        /// Finger down, recording.
        case holding
        /// Hands free. `paused` is the recorder's state; `canResume` is false
        /// once the cap was reached or a cancelled note was brought back, when
        /// there is nothing left to append to.
        case locked(paused: Bool, canResume: Bool)
    }

    enum Input: Equatable, Sendable {
        case pressBegan
        /// The finger's offset from where it went down. Left is negative `dx`,
        /// up is negative `dy` (UIKit's axes).
        case moved(dx: CGFloat, dy: CGFloat)
        case released(elapsedMs: Int)
        case pause
        case resume
        case send(elapsedMs: Int)
        case discard
        /// Five minutes reached. The recorder has stopped itself.
        case capReached
        /// A call, Siri, the app going to the background, a media-services
        /// reset: whatever means the microphone is not ours any more.
        case interrupted
        /// "Desfazer" on the cancelled-note banner.
        case undoDiscard
    }

    enum Haptic: Equatable, Sendable { case start, lock, cancel }

    enum Effect: Equatable, Sendable {
        case startRecording
        case haptic(Haptic)
        case pauseRecording
        case resumeRecording
        /// Stop and hand the note on.
        case send
        /// Stop and drop it. `undoable` keeps the file for a few seconds.
        case discard(undoable: Bool)
        /// Shorter than `accidentalTapMs`: dropped without a banner, with a
        /// hint to hold the button.
        case discardTooShort
    }

    static let cancelDistance: CGFloat = 110
    static let lockDistance: CGFloat = 90
    /// How far the finger must travel before the direction is decided.
    static let axisSlop: CGFloat = 10

    private enum Axis { case horizontal, vertical }

    private(set) var phase: Phase = .idle
    private var axis: Axis?
    /// 0...1 progress toward each threshold, for the UI to lean on.
    private(set) var cancelProgress: CGFloat = 0
    private(set) var lockProgress: CGFloat = 0

    var isActive: Bool { phase != .idle }

    mutating func handle(_ input: Input) -> [Effect] {
        switch (phase, input) {
        case (.idle, .pressBegan):
            phase = .holding
            axis = nil
            cancelProgress = 0
            lockProgress = 0
            return [.haptic(.start), .startRecording]

        case (.holding, .moved(let dx, let dy)):
            if axis == nil, max(abs(dx), abs(dy)) >= Self.axisSlop {
                axis = abs(dx) >= abs(dy) ? .horizontal : .vertical
            }
            switch axis {
            case .horizontal:
                cancelProgress = min(1, max(0, -dx / Self.cancelDistance))
                lockProgress = 0
                if cancelProgress >= 1 {
                    reset()
                    return [.haptic(.cancel), .discard(undoable: true)]
                }
            case .vertical:
                lockProgress = min(1, max(0, -dy / Self.lockDistance))
                cancelProgress = 0
                if lockProgress >= 1 {
                    phase = .locked(paused: false, canResume: true)
                    cancelProgress = 0
                    lockProgress = 0
                    return [.haptic(.lock)]
                }
            case nil:
                break
            }
            return []

        case (.holding, .released(let elapsedMs)):
            reset()
            return elapsedMs < VoiceNoteLimits.accidentalTapMs ? [.discardTooShort] : [.send]

        case (.locked(false, let canResume), .pause) where canResume:
            phase = .locked(paused: true, canResume: true)
            return [.pauseRecording]

        case (.locked(true, true), .resume):
            phase = .locked(paused: false, canResume: true)
            return [.resumeRecording]

        case (.locked, .send(let elapsedMs)):
            reset()
            return elapsedMs < VoiceNoteLimits.accidentalTapMs ? [.discardTooShort] : [.send]

        case (.locked, .discard):
            reset()
            return [.haptic(.cancel), .discard(undoable: true)]

        case (.holding, .capReached), (.locked(false, _), .capReached):
            // The finger may still be down; the cap hands the note over for
            // review instead of sending it, so nothing is cut off silently.
            phase = .locked(paused: true, canResume: false)
            cancelProgress = 0
            lockProgress = 0
            return [.haptic(.lock), .pauseRecording]

        case (.holding, .interrupted):
            reset()
            return [.haptic(.cancel), .discard(undoable: true)]

        case (.locked(false, let canResume), .interrupted):
            // Keep what was said; the person comes back to Send or Discard.
            phase = .locked(paused: true, canResume: canResume)
            return [.pauseRecording]

        case (.idle, .undoDiscard):
            phase = .locked(paused: true, canResume: false)
            return []

        default:
            // Everything else is a stray event: a release after the lock, a
            // second press, Send with nothing recording. Ignored on purpose.
            return []
        }
    }

    private mutating func reset() {
        phase = .idle
        axis = nil
        cancelProgress = 0
        lockProgress = 0
    }
}

// MARK: - Refusing to record

/// Why the microphone button said no.
enum VoiceRecordRefusal: Equatable, Sendable {
    /// A pqp call (DM call, mesh or LiveKit voice room) holds the microphone.
    case inCall
    case permissionDenied
    case failedToStart
}

enum VoiceRecordGate {
    /// Recording needs `.playAndRecord`, and a live call already has the shared
    /// audio session in that category with its own mode and routing. Taking it
    /// would reconfigure the call underneath the people in it, so the answer
    /// while a call is live is no, with a message, and the call's session is
    /// never touched. Pure, so "a call blocks recording" is a test and not a
    /// promise.
    static func refusal(callIsLive: Bool, seatedInVoiceRoom: Bool) -> VoiceRecordRefusal? {
        (callIsLive || seatedInVoiceRoom) ? .inCall : nil
    }
}
