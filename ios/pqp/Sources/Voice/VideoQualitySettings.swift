import Foundation
import Observation

/// The chosen video quality, and who to tell when it moves.
///
/// DEVICE-LOCAL, like the web's `LocalSettings.videoQuality` and unlike almost
/// everything else in Settings. What your phone can encode and what your phone's
/// uplink can carry are facts about this device, so syncing the choice to the
/// account would push a phone's answer onto a desktop that has a different one.
///
/// A LISTENER REGISTRY as well as `@Observable`, because the two readers are
/// different kinds of thing. A settings screen wants to redraw, which is what
/// Observation is for; a live call wants to re-tune senders that are already on
/// the wire, and it has to do that whether or not any view of that call is
/// currently in the hierarchy. A collapsed DM call is exactly that case: no
/// stage on screen, cameras still publishing.
@MainActor
@Observable
final class VideoQualitySettings {
    static let shared = VideoQualitySettings()

    static let defaultsKey = "pqp.videoQuality"

    private let defaults: UserDefaults

    var quality: VideoQuality {
        didSet {
            guard quality != oldValue else { return }
            defaults.set(quality.rawValue, forKey: Self.defaultsKey)
            for listener in listeners.values { listener(quality) }
        }
    }

    /// Ignored by Observation on purpose: registering a listener is not a
    /// reason for anything to redraw.
    @ObservationIgnored private var listeners: [String: (VideoQuality) -> Void] = [:]

    init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
        quality = VideoQuality.parse(defaults.string(forKey: Self.defaultsKey))
    }

    /// Keyed like `SessionStore.eventHandlers`, so a model that is created twice
    /// replaces its own registration rather than accumulating them.
    func addListener(_ key: String, _ body: @escaping (VideoQuality) -> Void) {
        listeners[key] = body
    }

    func removeListener(_ key: String) {
        listeners.removeValue(forKey: key)
    }
}

/// What one video sender is really putting on the wire.
///
/// Straight from `outbound-rtp`, which reports the size the encoder actually
/// produced rather than the size anything asked for. That distinction is the
/// whole point of this type: the web ladder passed its tests and shipped broken
/// for weeks because every check compared a request against a request, and the
/// picture that arrived was only ever caught by a person looking at a screen.
struct VideoSendStats: Equatable, Sendable {
    var width: Int
    var height: Int
    var frameRate: Int
    var kbps: Int
    /// `qualityLimitationReason`: `none`, `bandwidth`, `cpu` or `other`. This is
    /// the field that says whether a small picture is the link's doing, this
    /// phone's, or our own settings.
    var limitation: String

    var size: String { "\(width)x\(height)" }
}

/// Both roles at once, because they are sampled in one pass over one stats
/// report and a caller that received them separately could show a camera and a
/// screen from different seconds.
struct VideoSendSnapshot: Equatable, Sendable {
    var camera: VideoSendStats?
    var screen: VideoSendStats?

    var isEmpty: Bool { camera == nil && screen == nil }
}

/// The live send report, app-wide.
///
/// App-wide rather than per model because the reader is Settings, and Settings
/// is presented from the home shell while the call it is describing is either a
/// collapsed DM call or a voice channel one screen back. A value keyed to the
/// screen that produced it would be unreadable exactly when it is wanted.
///
/// **This is the instrument, not a decoration.** iOS has never been able to say
/// what it transmits, which is why "the iOS screen share arrives at 360p" had to
/// be reported by eye from a phone and could not be checked afterwards by
/// anybody without one.
@MainActor
@Observable
final class VideoSendReport {
    static let shared = VideoSendReport()

    /// Nil means nothing is publishing that role right now.
    var camera: VideoSendStats?
    var screen: VideoSendStats?

    func apply(_ snapshot: VideoSendSnapshot) {
        camera = snapshot.camera
        screen = snapshot.screen
    }

    func clear() {
        camera = nil
        screen = nil
    }
}
