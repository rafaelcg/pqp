import AVFoundation
import Foundation
import Observation
import UIKit

/// A finished recording, ready to upload.
struct RecordedVoiceNote: Equatable, Sendable {
    let fileURL: URL
    let durationMs: Int
    /// 64 peaks, base64.
    let waveform: String
    let byteSize: Int
}

/// The microphone side of voice notes: `AVAudioRecorder` driven by
/// `VoiceGesture`.
///
/// WHAT IT RECORDS. AAC-LC, mono, 24 kHz, about 48 kbps, in an MP4 container
/// (`.m4a`), uploaded as the bare `audio/mp4`. That is inside the server's
/// contract (mono, at most 64 kbps), plays natively on every platform, and a
/// five-minute note is under two megabytes.
///
/// THE AUDIO SESSION. `.playAndRecord` is taken only for the length of a
/// recording and put back after (`VoiceNoteAudioSession`). And it is never
/// taken while a pqp call is live: the call's session belongs to WebRTC or
/// LiveKit, and reconfiguring it under the people in the call is how a voice
/// client breaks voice. The gate (`VoiceRecordGate`) says no instead, with a
/// message, so the call is never touched.
@MainActor
@Observable
final class VoiceRecorder {
    private(set) var gesture = VoiceGesture()
    private(set) var elapsedMs = 0
    /// The last few metering readings as 0...1, newest last, for the live bars.
    private(set) var levels: [Float] = []
    /// A cancelled note that can still be brought back, with its length.
    private(set) var undoable: UndoableNote?
    /// Said above the composer, once. The owner clears it when shown.
    var refusal: VoiceRecordRefusal?
    /// Set when a press was too short: the hint "hold to record".
    var tooShortHint = false

    struct UndoableNote: Equatable {
        let id = UUID()
        let durationMs: Int
        let fileURL: URL
        fileprivate let waveform: String
    }

    /// Handed a finished note. Set by whoever owns the conversation.
    @ObservationIgnored var onNote: ((RecordedVoiceNote) -> Void)?

    var phase: VoiceGesture.Phase { gesture.phase }
    var isActive: Bool { gesture.isActive }
    var cancelProgress: CGFloat { gesture.cancelProgress }
    var lockProgress: CGFloat { gesture.lockProgress }

    // MARK: - Private state

    @ObservationIgnored private var recorder: AVAudioRecorder?
    @ObservationIgnored private var fileURL: URL?
    @ObservationIgnored private var savedSession: VoiceNoteAudioSession.Saved?
    @ObservationIgnored private var samples: [Float] = []
    @ObservationIgnored private var meterTask: Task<Void, Never>?
    @ObservationIgnored private var undoTask: Task<Void, Never>?
    /// A press that arrived while the permission prompt was up (or was refused)
    /// must not start recording when the finger finally lifts.
    @ObservationIgnored private var swallowingTouch = false
    @ObservationIgnored nonisolated(unsafe) private var observers: [NSObjectProtocol] = []

    init() {
        let center = NotificationCenter.default
        observers.append(center.addObserver(
            forName: AVAudioSession.interruptionNotification, object: nil, queue: .main
        ) { [weak self] note in
            // Only the start of an interruption matters: we never resume on
            // our own, the person decides.
            let raw = note.userInfo?[AVAudioSessionInterruptionTypeKey] as? UInt
            guard raw == AVAudioSession.InterruptionType.began.rawValue else { return }
            Task { @MainActor in self?.interrupt() }
        })
        observers.append(center.addObserver(
            forName: AVAudioSession.mediaServicesWereResetNotification, object: nil, queue: .main
        ) { [weak self] _ in
            Task { @MainActor in self?.interrupt() }
        })
    }

    deinit {
        observers.forEach(NotificationCenter.default.removeObserver)
    }

    // MARK: - Touches (called by the microphone button)

    /// The finger went down on the microphone.
    func touchDown(callIsLive: Bool, seatedInVoiceRoom: Bool) {
        guard !gesture.isActive, !swallowingTouch else { return }
        clearUndo(deleteFile: true)
        tooShortHint = false

        if let refused = VoiceRecordGate.refusal(
            callIsLive: callIsLive, seatedInVoiceRoom: seatedInVoiceRoom
        ) {
            swallowingTouch = true
            refusal = refused
            return
        }

        switch AVAudioApplication.shared.recordPermission {
        case .granted:
            apply(gesture.handle(.pressBegan))
        case .undetermined:
            // The system prompt takes the touch away from us. Ask, and let the
            // person press again once they have answered.
            swallowingTouch = true
            Task { _ = await AVAudioApplication.requestRecordPermission() }
        default:
            swallowingTouch = true
            refusal = .permissionDenied
        }
    }

    func touchMoved(dx: CGFloat, dy: CGFloat) {
        apply(gesture.handle(.moved(dx: dx, dy: dy)))
    }

    func touchUp() {
        if swallowingTouch {
            swallowingTouch = false
            return
        }
        apply(gesture.handle(.released(elapsedMs: elapsedMs)))
    }

    // MARK: - Locked controls

    func pause() { apply(gesture.handle(.pause)) }
    func resume() { apply(gesture.handle(.resume)) }
    func sendTapped() { apply(gesture.handle(.send(elapsedMs: elapsedMs))) }
    func discardTapped() { apply(gesture.handle(.discard)) }

    /// The banner's "Desfazer": the note comes back into the locked state, ready
    /// to Send or Discard (the recorder has stopped, so it cannot be extended).
    func undoDiscard() {
        guard let note = undoable, !gesture.isActive else { return }
        undoTask?.cancel()
        undoable = nil
        fileURL = note.fileURL
        elapsedMs = note.durationMs
        samples = []
        restoredWaveform = note.waveform
        apply(gesture.handle(.undoDiscard))
    }

    /// The app left the foreground: a hold ends (undoably), a lock pauses.
    func appBecameInactive() { interrupt() }

    func interrupt() {
        apply(gesture.handle(.interrupted))
    }

    // MARK: - Effects

    @ObservationIgnored private var restoredWaveform: String?

    private func apply(_ effects: [VoiceGesture.Effect]) {
        for effect in effects {
            switch effect {
            case .haptic(let kind):
                haptic(kind)
            case .startRecording:
                startRecording()
            case .pauseRecording:
                recorder?.pause()
                pushLevels()
            case .resumeRecording:
                recorder?.record()
            case .send:
                finish(send: true, undoable: false)
            case .discard(let undoable):
                finish(send: false, undoable: undoable)
            case .discardTooShort:
                tooShortHint = true
                finish(send: false, undoable: false)
            }
        }
    }

    private func startRecording() {
        do {
            let saved = try VoiceNoteAudioSession.beginRecording()
            savedSession = saved

            let directory = FileManager.default.temporaryDirectory.appendingPathComponent("voice-notes", isDirectory: true)
            try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
            let url = directory.appendingPathComponent("\(UUID().uuidString).m4a")
            let recorder = try AVAudioRecorder(url: url, settings: Self.settings)
            recorder.isMeteringEnabled = true
            guard recorder.prepareToRecord(), recorder.record() else {
                throw VoiceNoteAudioSession.Failure.recorderRefused
            }
            self.recorder = recorder
            self.fileURL = url
            self.restoredWaveform = nil
            samples = []
            levels = []
            elapsedMs = 0
            startMetering()
        } catch {
            // The session is put back and the gesture reset, so a failure to
            // start leaves the composer exactly as it was.
            tearDownRecorder(deleteFile: true)
            gesture = VoiceGesture()
            refusal = .failedToStart
        }
    }

    /// AAC-LC, mono, 24 kHz, 48 kbps.
    nonisolated static var settings: [String: Any] { [
        AVFormatIDKey: kAudioFormatMPEG4AAC,
        AVSampleRateKey: 24_000,
        AVNumberOfChannelsKey: 1,
        AVEncoderBitRateKey: 48_000,
        AVEncoderAudioQualityKey: AVAudioQuality.medium.rawValue,
    ] }

    // MARK: - Metering

    private func startMetering() {
        meterTask?.cancel()
        meterTask = Task { [weak self] in
            var tick = 0
            while !Task.isCancelled {
                try? await Task.sleep(for: .milliseconds(50))
                guard let self, let recorder = self.recorder else { return }
                // Paused: the recorder neither advances nor meters, and
                // sampling it would pad the waveform with silence.
                if recorder.isRecording {
                    recorder.updateMeters()
                    self.samples.append(recorder.averagePower(forChannel: 0))
                    let elapsed = Int(recorder.currentTime * 1000)
                    tick += 1
                    // Published at 10 Hz: the clock shows whole seconds and the
                    // bars do not need to move any faster than that.
                    if tick % 2 == 0 {
                        self.elapsedMs = elapsed
                        self.pushLevels()
                    }
                    if elapsed >= VoiceNoteLimits.maxDurationMs {
                        self.elapsedMs = VoiceNoteLimits.maxDurationMs
                        self.apply(self.gesture.handle(.capReached))
                    }
                }
            }
        }
    }

    private func pushLevels() {
        let recent = samples.suffix(48).map(VoiceWaveform.level(decibels:))
        levels = Array(recent)
    }

    // MARK: - Finishing

    private func finish(send: Bool, undoable: Bool) {
        // Stopped NOW, synchronously, not on the next turn of a task: the
        // microphone indicator and the session must go away the moment the
        // finger lifts. Stopping also finalises the file (the MP4 `moov` atom
        // is written on stop; a file read before it is not a playable file).
        let url = fileURL
        let recordedSamples = samples
        let restored = restoredWaveform
        let fallbackMs = elapsedMs
        tearDownRecorder(deleteFile: false)
        fileURL = nil
        samples = []
        restoredWaveform = nil
        elapsedMs = 0
        guard let url else { return }

        Task { [weak self] in
            let measured = await Self.measureDurationMs(url) ?? fallbackMs
            // The container can run a frame or two past the cap; the
            // contract's ceiling is inclusive and a note is never declared
            // longer than it.
            let durationMs = min(measured, VoiceNoteLimits.maxDurationMs)
            let waveform = restored
                ?? VoiceWaveform.encode(VoiceWaveform.normalise(decibels: recordedSamples))
            self?.complete(url: url, durationMs: durationMs, waveform: waveform,
                           send: send, undoable: undoable)
        }
    }

    private func complete(url: URL, durationMs: Int, waveform: String, send: Bool, undoable: Bool) {
        guard send else {
            if undoable, durationMs >= VoiceNoteLimits.accidentalTapMs {
                holdForUndo(UndoableNote(durationMs: durationMs, fileURL: url, waveform: waveform))
            } else {
                try? FileManager.default.removeItem(at: url)
            }
            return
        }

        let size = (try? url.resourceValues(forKeys: [.fileSizeKey]).fileSize) ?? 0
        guard size > 0, durationMs >= VoiceNoteLimits.serverMinDurationMs else {
            try? FileManager.default.removeItem(at: url)
            tooShortHint = true
            return
        }
        onNote?(RecordedVoiceNote(fileURL: url, durationMs: durationMs, waveform: waveform, byteSize: size))
    }

    private func holdForUndo(_ note: UndoableNote) {
        clearUndo(deleteFile: true)
        undoable = note
        undoTask = Task { [weak self] in
            try? await Task.sleep(for: .seconds(VoiceNoteLimits.undoSeconds))
            guard !Task.isCancelled else { return }
            self?.clearUndo(deleteFile: true)
        }
    }

    private func clearUndo(deleteFile: Bool) {
        undoTask?.cancel()
        if deleteFile, let url = undoable?.fileURL { try? FileManager.default.removeItem(at: url) }
        undoable = nil
    }

    private func tearDownRecorder(deleteFile: Bool) {
        meterTask?.cancel()
        meterTask = nil
        recorder?.stop()
        recorder = nil
        if let saved = savedSession {
            VoiceNoteAudioSession.endRecording(restoring: saved)
            savedSession = nil
        }
        if deleteFile, let url = fileURL { try? FileManager.default.removeItem(at: url) }
        if deleteFile { fileURL = nil }
        levels = []
    }

    private static func measureDurationMs(_ url: URL) async -> Int? {
        let asset = AVURLAsset(url: url)
        guard let duration = try? await asset.load(.duration), duration.isNumeric else { return nil }
        let ms = Int((duration.seconds * 1000).rounded())
        return ms > 0 ? ms : nil
    }

    // MARK: - Haptics

    private func haptic(_ kind: VoiceGesture.Haptic) {
        switch kind {
        case .start:
            // Before the session is activated: iOS mutes haptics while the
            // microphone is live unless the session opts back in.
            UIImpactFeedbackGenerator(style: .medium).impactOccurred()
        case .lock:
            UIImpactFeedbackGenerator(style: .rigid).impactOccurred()
        case .cancel:
            UINotificationFeedbackGenerator().notificationOccurred(.warning)
        }
    }
}

// MARK: - Audio session

/// Takes `.playAndRecord` for the length of a recording and gives the session
/// back the way it was found.
@MainActor
enum VoiceNoteAudioSession {
    enum Failure: Error { case recorderRefused }

    struct Saved {
        let category: AVAudioSession.Category
        let mode: AVAudioSession.Mode
        let options: AVAudioSession.CategoryOptions
    }

    static func beginRecording() throws -> Saved {
        let session = AVAudioSession.sharedInstance()
        let saved = Saved(category: session.category, mode: session.mode, options: session.categoryOptions)
        try session.setCategory(.playAndRecord, mode: .default, options: [.defaultToSpeaker, .allowBluetoothHFP])
        // Haptics and the system's own sounds are muted while recording unless
        // asked for, which would silence the lock and cancel feedback.
        try? session.setAllowHapticsAndSystemSoundsDuringRecording(true)
        try session.setActive(true)
        return saved
    }

    static func endRecording(restoring saved: Saved) {
        let session = AVAudioSession.sharedInstance()
        try? session.setAllowHapticsAndSystemSoundsDuringRecording(false)
        // Back to whatever was there (the default `.soloAmbient` for an app
        // that is not playing anything), then released, so a song that was
        // ducked or interrupted comes back.
        try? session.setCategory(saved.category, mode: saved.mode, options: saved.options)
        try? session.setActive(false, options: .notifyOthersOnDeactivation)
    }
}
