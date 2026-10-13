import AVFoundation
import Foundation
import UIKit

// The decisions around the story camera that need no hardware: what a press on
// the shutter means, how far the zoom may go, what the flash button cycles
// through, which screen the camera shows for a given permission, and where a
// trimmed video starts. Pure, so every one of them is tested on a simulator,
// which has no capture device at all.

enum StoryCameraPosition: Equatable, Sendable {
    case back
    case front

    var flipped: StoryCameraPosition { self == .back ? .front : .back }
}

// MARK: - Shutter

/// "Tap for a photo, hold for a video": one press, resolved by how long it
/// lasted. The press asks `holdBegan` once the threshold passes while the
/// finger is still down, so a recording starts under the finger and not after
/// it lifts.
struct StoryShutterPress: Equatable {
    /// Below this a press is a tap. Long enough that a firm tap never starts a
    /// recording, short enough that a hold feels instant. The system camera
    /// uses about the same.
    static let holdThreshold: TimeInterval = 0.35

    enum Outcome: Equatable {
        case photo
        case recordingStopped
        /// A release after a very long press that never started recording
        /// (the camera was busy): nothing to do.
        case nothing
    }

    private(set) var startedAt: Date?
    private(set) var isRecording = false

    var isDown: Bool { startedAt != nil }

    mutating func down(at date: Date) {
        guard startedAt == nil else { return }
        startedAt = date
    }

    /// Called when the hold timer fires. True when recording should begin now.
    mutating func holdElapsed(at date: Date) -> Bool {
        guard let startedAt, !isRecording,
              date.timeIntervalSince(startedAt) >= Self.holdThreshold - 0.001
        else { return false }
        isRecording = true
        return true
    }

    mutating func up(at date: Date) -> Outcome {
        defer {
            startedAt = nil
            isRecording = false
        }
        guard let startedAt else { return .nothing }
        if isRecording { return .recordingStopped }
        return date.timeIntervalSince(startedAt) < Self.holdThreshold ? .photo : .nothing
    }

    /// The limit hit while the finger is still down. The recording is over;
    /// the release that follows must not take a photo.
    mutating func recordingEnded() {
        isRecording = false
        startedAt = nil
    }
}

// MARK: - Zoom

enum StoryZoom {
    /// What the pill says: "1x", "0.5x", "2.4x". One decimal, none when whole.
    static func label(_ display: Double) -> String {
        let rounded = (display * 10).rounded() / 10
        if rounded == rounded.rounded() { return "\(Int(rounded))x" }
        return String(format: "%.1fx", rounded)
    }

    /// A pinch: the factor the gesture started at times its scale, held inside
    /// what the device can do.
    static func pinched(from start: Double, scale: Double, range: ClosedRange<Double>) -> Double {
        min(max(start * scale, range.lowerBound), range.upperBound)
    }

    /// Hold-and-drag-up while recording: 0 pt is no change, `fullTravel` pt up
    /// is the whole range on a log scale (zoom feels linear on a log scale).
    static func dragged(from start: Double, translationY: CGFloat, fullTravel: CGFloat = 260, range: ClosedRange<Double>) -> Double {
        guard fullTravel > 0, range.lowerBound > 0 else { return start }
        let t = Double(max(-1, min(1, -translationY / fullTravel)))
        let span = log(range.upperBound / start)
        let down = log(start / range.lowerBound)
        let factor = t >= 0 ? exp(span * t) : exp(-down * -t)
        return min(max(start * factor, range.lowerBound), range.upperBound)
    }

    /// Whether to show the zoom pill at all: only when there is somewhere to go.
    static func isZoomable(_ range: ClosedRange<Double>) -> Bool {
        range.upperBound - range.lowerBound > 0.05
    }
}

// MARK: - Flash

/// Off, on, auto: the order Instagram and the system camera cycle through.
enum StoryFlash: String, CaseIterable, Equatable, Sendable {
    case off, on, auto

    var next: StoryFlash {
        switch self {
        case .off: .on
        case .on: .auto
        case .auto: .off
        }
    }

    var symbol: String {
        switch self {
        case .off: "bolt.slash.fill"
        case .on: "bolt.fill"
        case .auto: "bolt.badge.automatic.fill"
        }
    }

    var label: String {
        switch self {
        case .off: String(localized: "Flash off")
        case .on: String(localized: "Flash on")
        case .auto: String(localized: "Flash auto")
        }
    }

    var avMode: AVCaptureDevice.FlashMode {
        switch self {
        case .off: .off
        case .on: .on
        case .auto: .auto
        }
    }

    /// While a video records the flash is a torch: lit for "on" and "auto",
    /// because a recording cannot decide mid-way that the scene got dark.
    var torchesVideo: Bool { self != .off }
}

// MARK: - Recording clock

enum StoryRecordingClock {
    /// 0...1 around the ring.
    static func progress(elapsed: TimeInterval, limit: TimeInterval = TimeInterval(StoryLimits.maxVideoMs) / 1000) -> Double {
        guard limit > 0 else { return 0 }
        return min(1, max(0, elapsed / limit))
    }

    /// "0:07".
    static func label(_ elapsed: TimeInterval) -> String {
        let whole = max(0, Int(elapsed))
        return String(format: "%d:%02d", whole / 60, whole % 60)
    }

    static func isOverLimit(_ elapsed: TimeInterval, limit: TimeInterval = TimeInterval(StoryLimits.maxVideoMs) / 1000) -> Bool {
        elapsed >= limit
    }
}

// MARK: - Access

/// What the camera screen shows. Photos picked from the library need no
/// permission (the picker runs in another process), so every state except
/// `ready` still offers the gallery.
enum StoryCameraAccess: Equatable {
    /// Camera permission has not been asked: the system sheet is the next step.
    case needsPrompt
    case ready
    /// Refused, now or earlier: only Settings can change it.
    case denied
    /// Parental controls or a profile.
    case restricted
    /// A phone with no usable camera (a simulator, an iPad without one).
    case noDevice
    /// The camera is on in a call, and a device has one owner.
    case busyInCall

    static func resolve(status: AVAuthorizationStatus, hasDevice: Bool) -> StoryCameraAccess {
        switch status {
        case .denied: return .denied
        case .restricted: return .restricted
        case .notDetermined: return hasDevice ? .needsPrompt : .noDevice
        case .authorized: return hasDevice ? .ready : .noDevice
        @unknown default: return .denied
        }
    }

    /// Whether the screen can offer Settings (only a refusal the person can undo).
    var offersSettings: Bool { self == .denied }

    var title: String {
        switch self {
        case .needsPrompt, .ready: ""
        case .busyInCall: String(localized: "Your camera is on in the call")
        case .denied: String(localized: "Camera access is off")
        case .restricted: String(localized: "The camera is blocked on this phone")
        case .noDevice: String(localized: "No camera on this device")
        }
    }

    var detail: String {
        switch self {
        case .needsPrompt, .ready: ""
        case .busyInCall: String(localized: "Turn it off in the call to shoot here. You can still pick from your photos.")
        case .denied: String(localized: "Turn it on in Settings to shoot a story. You can still pick from your photos.")
        case .restricted: String(localized: "A setting on this phone doesn't let apps use the camera. You can still pick from your photos.")
        case .noDevice: String(localized: "Pick a photo or a video instead.")
        }
    }
}

// MARK: - Trim

/// A video longer than the limit is cut to a window of exactly the limit. The
/// window slides; the start is the only thing the person chooses.
enum StoryTrim {
    /// Slack past the limit that is cropped silently instead of asking:
    /// recordings stop a frame or two over, and a trimmer for 30.02 s is noise.
    static let slackMs = 1_000

    static func needsTrim(durationMs: Int, maxMs: Int = StoryLimits.maxVideoMs) -> Bool {
        durationMs > maxMs + slackMs
    }

    /// The latest the window may start.
    static func maxStartMs(durationMs: Int, maxMs: Int = StoryLimits.maxVideoMs) -> Int {
        max(0, durationMs - maxMs)
    }

    static func clampedStartMs(_ startMs: Int, durationMs: Int, maxMs: Int = StoryLimits.maxVideoMs) -> Int {
        min(max(0, startMs), maxStartMs(durationMs: durationMs, maxMs: maxMs))
    }

    /// What is kept: from `startMs`, at most `maxMs`, never past the end.
    static func keptRange(startMs: Int, durationMs: Int, maxMs: Int = StoryLimits.maxVideoMs) -> (startMs: Int, lengthMs: Int) {
        let start = clampedStartMs(startMs, durationMs: durationMs, maxMs: maxMs)
        return (start, min(maxMs, max(0, durationMs - start)))
    }

    /// "0:12 a 0:42".
    static func label(startMs: Int, lengthMs: Int) -> String {
        let from = StoryRecordingClock.label(Double(startMs) / 1000)
        let to = StoryRecordingClock.label(Double(startMs + lengthMs) / 1000)
        return String(localized: "\(from) to \(to)")
    }
}
