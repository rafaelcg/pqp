import AVFoundation
import Foundation

/// THE AUDIO SESSION WHILE RECORDING A PART, AND WHEN IT IS NOT OURS TO TAKE.
///
/// A call holds `.playAndRecord` with the voice-chat mode; taking the session
/// out from under it ends the call's microphone. Recording a part would do
/// exactly that, so the studio does not open at all while a call is up
/// (`JamRecordingGate`): the button says to leave the call first, which is the
/// simplest behaviour that is also correct. The same answer the voice notes
/// already give (`VoiceRecordGate`).
///
/// When nothing else owns the session the studio takes it with the settings a
/// MUSICIAN wants and a caller does not:
///
///  - `.playAndRecord`, because the band plays while the microphone listens;
///  - mode `.default`, NOT `.voiceChat` or `.videoChat`: those switch on voice
///    processing (echo cancellation, gain control, noise suppression), which
///    would thin out an instrument, duck the band under the player's own sound
///    and add a delay the round trip cannot hold;
///  - `.defaultToSpeaker`, so with no headphones the band comes out of the
///    loudspeaker and not the earpiece (it bleeds into the microphone; the
///    studio warns), and `.allowBluetoothA2DP`, so Bluetooth headphones still
///    play the band (the studio warns about those too). Not `.allowBluetooth`:
///    that is the hands-free profile, a telephone-quality microphone and a 16
///    kHz band.
///
/// and gives it back (the previous category) when the studio closes.
protocol JamRecordingSessionDriver: AnyObject {
    var category: AVAudioSession.Category { get }
    var mode: AVAudioSession.Mode { get }
    var categoryOptions: AVAudioSession.CategoryOptions { get }
    var sampleRate: Double { get }
    var inputLatency: TimeInterval { get }
    var outputLatency: TimeInterval { get }
    var ioBufferDuration: TimeInterval { get }
    func setCategory(_ category: AVAudioSession.Category, mode: AVAudioSession.Mode, options: AVAudioSession.CategoryOptions) throws
    func setPreferredSampleRate(_ rate: Double) throws
    func setPreferredIOBufferDuration(_ duration: TimeInterval) throws
    func setActive(_ active: Bool, options: AVAudioSession.SetActiveOptions) throws
}

extension AVAudioSession: JamRecordingSessionDriver {}

enum JamRecordingGate {
    enum Refusal: Equatable, Sendable {
        /// A call (or anything already recording) holds the audio session.
        case inCall
    }

    /// Whether a part may be recorded right now. `callActive` is the app's own
    /// "am I seated or ringing"; the category is the same fact seen from the
    /// session's side (and the one a call started elsewhere in the process
    /// shows).
    static func refusal(callActive: Bool, category: AVAudioSession.Category, studioOwnsSession: Bool) -> Refusal? {
        if callActive { return .inCall }
        if !studioOwnsSession, WatchAudioSession.wouldInterruptACall(category) { return .inCall }
        return nil
    }
}

@MainActor
final class JamRecordingSession {
    private let driver: any JamRecordingSessionDriver
    private var previous: (category: AVAudioSession.Category, mode: AVAudioSession.Mode, options: AVAudioSession.CategoryOptions)?
    private(set) var isHolding = false

    /// The rate and buffer asked for. 48 kHz is what every web take is, so no
    /// rate conversion happens on the way in or out; a small buffer keeps the
    /// round trip short (the route may give another one).
    static let preferredSampleRate = 48_000.0
    static let preferredBufferSeconds = 0.005

    init(driver: any JamRecordingSessionDriver = AVAudioSession.sharedInstance()) {
        self.driver = driver
    }

    var sampleRate: Double { driver.sampleRate }
    var inputLatencySeconds: Double { driver.inputLatency }
    var outputLatencySeconds: Double { driver.outputLatency }

    /// Take the session. Throws when the system refuses (a call took it between
    /// the gate and here); nothing is left changed then.
    func activate() throws {
        if !isHolding {
            previous = (driver.category, driver.mode, driver.categoryOptions)
        }
        do {
            try driver.setCategory(.playAndRecord, mode: .default, options: [.defaultToSpeaker, .allowBluetoothA2DP])
            // Preferences, not demands: the route may give something else, and
            // the take is stamped with what it really got.
            try? driver.setPreferredSampleRate(Self.preferredSampleRate)
            try? driver.setPreferredIOBufferDuration(Self.preferredBufferSeconds)
            try driver.setActive(true, options: [])
            isHolding = true
        } catch {
            restore()
            throw error
        }
    }

    /// Give the session back, unless a call has taken it since: a blind
    /// deactivate would end that call's audio.
    func deactivate() {
        guard isHolding else { return }
        isHolding = false
        if WatchAudioSession.wouldInterruptACall(driver.category), !(driver.category == .playAndRecord && driver.mode == .default) {
            // Not our configuration any more: a call (voice chat) owns it.
            previous = nil
            return
        }
        try? driver.setActive(false, options: .notifyOthersOnDeactivation)
        restore()
    }

    private func restore() {
        guard let previous else { return }
        self.previous = nil
        try? driver.setCategory(previous.category, mode: previous.mode, options: previous.options)
    }
}
