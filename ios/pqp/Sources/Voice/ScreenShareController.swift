import CoreVideo
import Foundation
import Observation
import QuartzCore

/// Owns "am I sharing my screen", for a voice channel or a DM call alike.
///
/// The awkward shape of iOS screen sharing is what this class exists to absorb:
///
///  - Sharing is **started by the system**, not by us. `RPSystemBroadcastPickerView`
///    hands the decision to a sheet we do not control, and a user who opens it and
///    changes their mind must leave no trace — so nothing here changes state until
///    a frame actually arrives.
///  - Sharing is **stopped by the system too**, from the status-bar indicator or
///    Control Centre, and iOS tells the app *nothing*. Frames simply stop. Going
///    quiet is therefore the only stop signal that exists, which is why there is a
///    watchdog rather than a callback.
///  - A broadcast can outlive the call it was started for, and start before one
///    exists. The bridge is armed and disarmed with the room; the broadcast is
///    the operating system's business.
@MainActor
@Observable
final class ScreenShareController {
    /// True from the first bridged frame to `staleTimeout` after the last.
    private(set) var isSharing = false
    /// Why sharing is unavailable or was refused. Shown, then cleared by the next
    /// successful start.
    private(set) var errorMessage: String?
    /// False when this build cannot host a broadcast at all — no App Group
    /// container, or the simulator, whose group path is too long for a Unix
    /// socket. The share affordance is hidden rather than left to fail.
    private(set) var isAvailable = false

    private var receiver: ScreenShareReceiver?
    private var lastFrameAt: TimeInterval?
    private var watchdog: Task<Void, Never>?
    /// Set when the room refused the share (somebody else is presenting). Frames
    /// keep arriving until the user stops the broadcast, and none of them may
    /// re-announce; cleared when the bridge goes quiet.
    private var isRefused = false

    private var onFrame: (@MainActor (UncheckedBox<CVPixelBuffer>, Int) -> Void)?
    private var onStart: (@MainActor () async -> Void)?
    private var onStop: (@MainActor () async -> Void)?

    /// How often the watchdog looks. Well under `staleTimeout`, so the stop it
    /// detects lands inside the two seconds that timeout promises.
    private static let watchdogInterval: Duration = .milliseconds(400)

    func configure(
        onFrame: @escaping @MainActor (UncheckedBox<CVPixelBuffer>, Int) -> Void,
        onStart: @escaping @MainActor () async -> Void,
        onStop: @escaping @MainActor () async -> Void
    ) {
        self.onFrame = onFrame
        self.onStart = onStart
        self.onStop = onStop
    }

    /// Starts listening for a broadcast. Called when the room becomes live.
    func arm() {
        guard receiver == nil else { return }
        let receiver = ScreenShareReceiver { [weak self] buffer, rotation in
            Task { @MainActor [weak self] in
                self?.accept(buffer, rotation: rotation)
            }
        }
        #if DEBUG
        // Stands in for the extension, which cannot run in the simulator. See
        // `ScreenShareReceiver.startSynthetic`.
        if ProcessInfo.processInfo.arguments.contains("-pqp.fakeScreenShare") {
            self.receiver = receiver
            isAvailable = true
            receiver.startSynthetic()
            return
        }
        #endif
        guard receiver.start() else {
            isAvailable = false
            return
        }
        self.receiver = receiver
        isAvailable = true
    }

    /// Stops listening and unpublishes. Called when the room ends.
    func disarm() async {
        watchdog?.cancel()
        watchdog = nil
        receiver?.stop()
        receiver = nil
        lastFrameAt = nil
        isRefused = false
        if isSharing {
            isSharing = false
            await onStop?()
        }
    }

    /// The room refused it — the call is already at the screen-share cap.
    func refuse(message: String) async {
        isRefused = true
        errorMessage = message
        if isSharing {
            isSharing = false
            await onStop?()
        }
    }

    private func accept(_ buffer: UncheckedBox<CVPixelBuffer>, rotation: Int) {
        let now = CACurrentMediaTime()
        lastFrameAt = now
        guard !isRefused else { return }
        if !isSharing {
            isSharing = true
            errorMessage = nil
            startWatchdog()
            // Published before the first frame is forwarded, so the track exists
            // by the time WebRTC is handed something to send on it.
            Task { @MainActor [weak self] in
                guard let self else { return }
                await self.onStart?()
                self.onFrame?(buffer, rotation)
            }
            return
        }
        onFrame?(buffer, rotation)
    }

    private func startWatchdog() {
        watchdog?.cancel()
        watchdog = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(for: Self.watchdogInterval)
                guard !Task.isCancelled, let self else { return }
                await self.checkLiveness()
            }
        }
    }

    private func checkLiveness() async {
        guard screenShareIsStale(lastFrameAt: lastFrameAt, now: CACurrentMediaTime()) else {
            return
        }
        lastFrameAt = nil
        // A refusal that outlived its broadcast is over: the next broadcast is a
        // fresh attempt, and the room may be free by then.
        isRefused = false
        watchdog?.cancel()
        watchdog = nil
        guard isSharing else { return }
        isSharing = false
        await onStop?()
    }
}
