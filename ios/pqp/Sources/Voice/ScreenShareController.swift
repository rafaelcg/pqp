import CoreVideo
import Foundation
import Observation
import QuartzCore
import UIKit

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

    /// When the share control was last tapped, and the watcher armed by it.
    ///
    /// See `noteTapped` for why a tap is worth remembering at all.
    private var lastTapAt: TimeInterval?
    private var captureObserver: NSObjectProtocol?
    private var captureWatcher: Task<Void, Never>?

    /// How often the watchdog looks. Well under `staleTimeout`, so the stop it
    /// detects lands inside the two seconds that timeout promises.
    private static let watchdogInterval: Duration = .milliseconds(400)

    /// How recently the control must have been tapped for a capture starting to
    /// count as *ours*.
    ///
    /// `isCaptured` is true for AirPlay, mirroring and the built-in screen
    /// recorder as well as for a broadcast extension, so it cannot be read as
    /// "our share started" on its own. Pairing it with a tap on our own control
    /// in the last few seconds is what makes it specific: somebody who starts
    /// iOS's own recorder mid-call never touched our button, and gets no
    /// complaint from us.
    private static let tapAttributionWindow: TimeInterval = 15

    /// How long a live capture may produce no frames before the app says so.
    ///
    /// The extension retries the socket every 500ms and the app is already
    /// listening by the time the control is even visible, so the first frame
    /// should arrive almost immediately. Five seconds is far past "slow" and
    /// well inside the extension's own ten-second give-up, so the two messages
    /// cannot both fire for one failure.
    private static let firstFrameDeadline: Duration = .seconds(5)

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
        observeCapture()
    }

    /// Stops listening and unpublishes. Called when the room ends.
    func disarm() async {
        watchdog?.cancel()
        watchdog = nil
        captureWatcher?.cancel()
        captureWatcher = nil
        if let captureObserver {
            NotificationCenter.default.removeObserver(captureObserver)
        }
        captureObserver = nil
        lastTapAt = nil
        receiver?.stop()
        receiver = nil
        lastFrameAt = nil
        isRefused = false
        if isSharing {
            isSharing = false
            await onStop?()
        }
    }

    /// The share control was tapped.
    ///
    /// WHY THE APP NEEDS TO KNOW. Everything after this tap belongs to iOS: the
    /// sheet is Apple's, the decision is the user's, and the system reports
    /// neither back. Without this the app cannot tell a control that was never
    /// touched from one that was touched and did nothing, which is exactly the
    /// state a broken share leaves somebody in. It changes no state on its own
    /// and shows nothing: a picker opened and dismissed must still leave no
    /// trace. It only makes the *next* thing that happens attributable.
    func noteTapped() {
        lastTapAt = CACurrentMediaTime()
        errorMessage = nil
    }

    /// Watch for a system capture beginning, so a broadcast that starts and
    /// sends nothing can be reported instead of looking like a frozen call.
    private func observeCapture() {
        guard captureObserver == nil else { return }
        captureObserver = NotificationCenter.default.addObserver(
            forName: UIScreen.capturedDidChangeNotification,
            object: nil,
            queue: nil
        ) { [weak self] notification in
            // Read on the posting thread (always the main one for this
            // notification) and carry a plain Bool across, because
            // `Notification` is not `Sendable`.
            let isCaptured = (notification.object as? UIScreen)?.isCaptured ?? false
            Task { @MainActor [weak self] in
                self?.captureChanged(isCaptured: isCaptured)
            }
        }
    }

    private func captureChanged(isCaptured: Bool) {
        guard isCaptured else {
            captureWatcher?.cancel()
            captureWatcher = nil
            return
        }
        guard let lastTapAt,
              CACurrentMediaTime() - lastTapAt <= Self.tapAttributionWindow else {
            // Somebody else's capture. Not ours to explain.
            return
        }
        captureWatcher?.cancel()
        captureWatcher = Task { [weak self] in
            try? await Task.sleep(for: Self.firstFrameDeadline)
            guard !Task.isCancelled else { return }
            await self?.reportSilentBroadcast()
        }
    }

    private func reportSilentBroadcast() async {
        // A share that got through needs no explanation, and a refusal already
        // carries the room's own sentence.
        guard !isSharing, !isRefused, lastFrameAt == nil else { return }
        errorMessage = String(
            localized: "Screen sharing started but no picture is getting through. Stop the broadcast and start it again."
        )
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
