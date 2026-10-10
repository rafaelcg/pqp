import AVKit
import Combine
import SwiftUI

/**
 AN UPLOADED BAÚ VIDEO, PLAYED WHERE IT SITS.

 The card draws an `AVPlayerViewController`, so the scrubber, the full screen
 button, AirPlay and the Picture in Picture button are the system's own, and
 backgrounding the app while it plays goes to PiP by itself
 (`canStartPictureInPictureAutomaticallyFromInline`).

 SCROLLING AWAY IS THE CASE AVKit DOES NOT COVER. Its automatic PiP is tied to
 the app leaving the screen, not to a card leaving the viewport, and the
 controller has no public "start PiP now". So when a playing card scrolls out
 of view the session hands the player to a layer of its own and starts PiP
 from that one (`BauVideoSession.cardDidDisappear`). When the card comes
 back, or the person closes the window, the player goes home.

 THE ONE RULE THAT SHAPES ALL OF IT: an `AVPlayer` drives ONE layer at a time
 (see `WatchPicture` for the build where two layers on one player left a frozen
 frame and a player that still reported `.playing`). So the player is never
 on the controller and on the PiP layer at once: it is taken off the first
 before it is put on the second, and the other way round.

 The session outlives the card on purpose. A lazy stack throws off-screen
 rows away, and the PiP window must not die with the row that started it, so
 `BauPlayback` keeps the playing session alive until it stops.

 AUDIO. See `BauPlaybackPolicy.audioPlan`: outside a call a playing video takes
 `.playback`/`.moviePlayback` (it should be heard with the ringer switch off,
 and Picture in Picture requires it); inside a call the session is left exactly
 as it is, because `.playback` under a live call takes the microphone away from
 it. The video then plays through the call's own session, mixed with the call.
 */

// MARK: - Decisions (pure, so they can be tested without a device)

enum BauAudioPlan: Equatable {
    /// Nothing else owns the audio session: take `.playback`.
    case takePlayback
    /// A call (or anything holding a microphone) owns it: touch nothing.
    case leaveSessionAlone
}

enum BauScrollAwayPlan: Equatable {
    /// Hand the player to the PiP layer and start Picture in Picture.
    case pictureInPicture
    /// Not playing, or PiP cannot run: stop making noise nobody can see.
    case pause
    /// Not playing and nothing to do (or fullscreen is up and the card is not
    /// really gone).
    case leaveAlone
}

enum BauPlaybackPolicy {
    /// A live call wins, whichever way it is detected: the app's own model
    /// says so (`callActive`), or the session is already in a recording
    /// category, which is the same fact seen from the other side. Reuses the
    /// watch party's interlock so there is one definition of "would break a
    /// call".
    static func audioPlan(callActive: Bool, category: AVAudioSession.Category) -> BauAudioPlan {
        if callActive || WatchAudioSession.wouldInterruptACall(category) {
            return .leaveSessionAlone
        }
        return .takePlayback
    }

    static func scrollAwayPlan(
        isPlaying: Bool, pipSupported: Bool, isFullScreen: Bool, pipAlreadyRunning: Bool
    ) -> BauScrollAwayPlan {
        if isFullScreen || pipAlreadyRunning { return .leaveAlone }
        guard isPlaying else { return .leaveAlone }
        return pipSupported ? .pictureInPicture : .pause
    }
}

/// Which Baú video holds the floor. Only one plays at a time, and a second one
/// starting displaces the first whether it sits inline or in a PiP window.
struct BauActivePlayer: Equatable {
    private(set) var current: UUID?

    /// Make `id` the playing one. Returns whoever it displaced, if anyone.
    mutating func claim(_ id: UUID) -> UUID? {
        let displaced = current.flatMap { $0 == id ? nil : $0 }
        current = id
        return displaced
    }

    /// `id` stopped on its own. Only clears the floor if it still held it.
    mutating func release(_ id: UUID) {
        if current == id { current = nil }
    }
}

// MARK: - Coordinator

/// Owns whichever session is playing, so it survives its card, and the floor.
@MainActor
@Observable
final class BauPlayback {
    static let shared = BauPlayback()

    /// A PiP window's "restore" button was tapped: the feed scrolls to this
    /// post. Consumed (set back to nil) by `CommunityHomeView`.
    var restoreTargetPostID: String?

    @ObservationIgnored private var floor = BauActivePlayer()
    @ObservationIgnored private var retained: [UUID: BauVideoSession] = [:]
    @ObservationIgnored private var weChangedTheAudioSession = false

    /// The session already playing this URL (a card that was thrown away and
    /// rebuilt while its video kept going), or a fresh one.
    func session(for url: URL, postID: String?) -> BauVideoSession {
        if let live = retained.values.first(where: { $0.url == url }) {
            live.postID = postID
            return live
        }
        return BauVideoSession(url: url, postID: postID)
    }

    /// Called by a session the moment it starts playing.
    func claim(_ session: BauVideoSession, callActive: Bool) {
        retained[session.id] = session
        if let displaced = floor.claim(session.id) {
            retained[displaced]?.yieldTheFloor()
        }
        activateAudio(callActive: callActive)
    }

    /// Called when a session stops playing (pause, end, failure).
    func release(_ session: BauVideoSession) {
        floor.release(session.id)
        // Keep the session alive while its PiP window is still on screen.
        if !session.hasPictureInPicture { retained.removeValue(forKey: session.id) }
        if floor.current == nil { deactivateAudio() }
    }

    /// The Baú screen itself is going away.
    func stopAllUnlessFullScreen() {
        for session in retained.values where !session.isFullScreen {
            session.stopCompletely()
        }
    }

    private func activateAudio(callActive: Bool) {
        let audio = AVAudioSession.sharedInstance()
        guard BauPlaybackPolicy.audioPlan(callActive: callActive, category: audio.category)
            == .takePlayback
        else { return }
        guard audio.category != .playback else { return }
        do {
            try audio.setCategory(.playback, mode: .moviePlayback)
            try audio.setActive(true)
            weChangedTheAudioSession = true
        } catch {
            // A video with the wrong routing beats no video.
        }
    }

    private func deactivateAudio() {
        guard weChangedTheAudioSession else { return }
        weChangedTheAudioSession = false
        // Only if it is still ours: a call may have taken the session since.
        guard AVAudioSession.sharedInstance().category == .playback else { return }
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
    }
}

// MARK: - Session

@MainActor
@Observable
final class BauVideoSession: NSObject {
    enum Status: Equatable { case loading, ready, failed }

    let id = UUID()
    let url: URL
    var postID: String?
    private(set) var status: Status = .loading
    @ObservationIgnored private(set) var player: AVPlayer?

    /// Set by the card from the app's own call state.
    @ObservationIgnored var callActive = false
    @ObservationIgnored private(set) var isFullScreen = false
    @ObservationIgnored private(set) var isCardVisible = false
    @ObservationIgnored private(set) var isPictureInPictureActive = false
    /// The controller's own PiP (the button, backgrounding) is up. Separate
    /// from the session's PiP layer, but it holds the session alive the same
    /// way: a paused video in a window still on screen must not be released.
    @ObservationIgnored private(set) var isSystemPictureInPictureActive = false
    var hasPictureInPicture: Bool { isPictureInPictureActive || isSystemPictureInPictureActive }

    @ObservationIgnored private weak var controller: AVPlayerViewController?
    @ObservationIgnored private var pipCanvas: WatchPlayerCanvas?
    @ObservationIgnored private var pip: AVPictureInPictureController?
    @ObservationIgnored private var pipPossibleObservation: AnyCancellable?
    @ObservationIgnored private var pipTimeout: Task<Void, Never>?
    @ObservationIgnored private(set) var restoring = false
    @ObservationIgnored private var statusObservation: AnyCancellable?
    @ObservationIgnored private var prepareTask: Task<Void, Never>?
    @ObservationIgnored private var orientationOwner: UUID?

    init(url: URL, postID: String?) {
        self.url = url
        self.postID = postID
        super.init()
    }

    var isPlaying: Bool {
        guard let player else { return false }
        return player.timeControlStatus != .paused
    }

    // MARK: Loading

    /// Probe before handing the asset over, as `MediaPlayerView` does, so an
    /// unplayable URL lands in `.failed` rather than a player with a
    /// permanently black frame, then watch the item: a signed URL that dies
    /// before the first tap fails in the item, not in the probe.
    func prepareIfNeeded() async {
        guard player == nil, status != .failed else { return }
        // The probe is shared by every card that asks for this session, but a
        // card that scrolls away cancels ITS wait: when nobody is waiting any
        // more the work is dropped too. A card that arrives while a cancelled
        // probe is still winding down must not inherit its early return, so
        // it goes round again with a probe of its own.
        for _ in 0..<3 {
            let task: Task<Void, Never>
            if let prepareTask, !prepareTask.isCancelled {
                task = prepareTask
            } else {
                task = Task { await prepare() }
                prepareTask = task
            }
            await withTaskCancellationHandler {
                await task.value
            } onCancel: {
                task.cancel()
            }
            if prepareTask == task { prepareTask = nil }
            if player != nil || status == .failed || Task.isCancelled { return }
        }
    }

    private func prepare() async {
        let asset = AVURLAsset(url: url)
        let item = AVPlayerItem(asset: asset)
        let player: AVPlayer
        do {
            guard try await asset.load(.isPlayable) else { throw APIError.transport("Not playable") }
            if Task.isCancelled { return }
            player = AVPlayer(playerItem: item)
            // Paint the first frame as the poster, the web's `#t=0.001`.
            await player.seek(to: CMTime(seconds: 0.001, preferredTimescale: 600))
            if Task.isCancelled { return }
        } catch {
            if Task.isCancelled { return }
            status = .failed
            return
        }
        self.player = player
        status = .ready
        controller?.player = player
        watchPlayback(of: player)
        watchHealth(of: item)
    }

    /// The item failing outright, an error set on it (a range request that
    /// dies mid-clip while the status still reads readyToPlay), and the
    /// "could not reach the end" notification a dropped connection posts.
    private func watchHealth(of item: AVPlayerItem) {
        var cancellables = Set<AnyCancellable>()
        Publishers.CombineLatest(item.publisher(for: \.status), item.publisher(for: \.error))
            .filter { BauVideoHealth.isFailure(status: $0.0, error: $0.1) }
            .map { _ in () }
            .merge(with: NotificationCenter.default
                .publisher(for: AVPlayerItem.failedToPlayToEndTimeNotification, object: item)
                .map { _ in () })
            .receive(on: DispatchQueue.main)
            .sink { [weak self] in
                MainActor.assumeIsolated { self?.fail() }
            }
            .store(in: &cancellables)
        healthObservation = cancellables
    }

    @ObservationIgnored private var healthObservation = Set<AnyCancellable>()

    private func fail() {
        stopCompletely()
        player = nil
        controller?.player = nil
        status = .failed
    }

    /// Claim the floor when playback starts, give it up when it stops.
    private func watchPlayback(of player: AVPlayer) {
        statusObservation = player.publisher(for: \.timeControlStatus)
            .receive(on: DispatchQueue.main)
            .sink { [weak self] status in
                MainActor.assumeIsolated {
                    guard let self else { return }
                    if status == .paused {
                        BauPlayback.shared.release(self)
                    } else {
                        BauPlayback.shared.claim(self, callActive: self.callActive)
                    }
                }
            }
    }

    // MARK: The controller

    func attach(_ controller: AVPlayerViewController) {
        self.controller = controller
        // While the PiP layer holds the player the controller stays empty.
        controller.player = isPictureInPictureActive || pip != nil ? nil : player
    }

    func detach(_ controller: AVPlayerViewController) {
        guard self.controller === controller else { return }
        controller.player = nil
        self.controller = nil
    }

    func systemPictureInPictureDidStart() { isSystemPictureInPictureActive = true }

    /// The restore button of the controller's PiP window was tapped.
    func systemPictureInPictureWillRestore() { restoring = true }

    /// The controller's PiP window closed. Restore, or the card is on screen:
    /// keep playing. The X button with the card off screen: nobody is watching.
    func systemPictureInPictureDidStop() {
        isSystemPictureInPictureActive = false
        let keep = restoring || isCardVisible
        restoring = false
        if !keep { player?.pause() }
        if player?.timeControlStatus == .paused { BauPlayback.shared.release(self) }
    }

    func fullScreenWillBegin() {
        isFullScreen = true
        let owner = UUID()
        orientationOwner = owner
        WatchOrientation.enterBauVideo(owner)
    }

    func fullScreenDidEnd() {
        isFullScreen = false
        if let owner = orientationOwner {
            orientationOwner = nil
            WatchOrientation.leaveBauVideo(owner)
        }
    }

    // MARK: Scrolling away and back

    func cardDidAppear() {
        isCardVisible = true
        endPictureInPicture()
    }

    func cardDidDisappear() {
        isCardVisible = false
        let plan = BauPlaybackPolicy.scrollAwayPlan(
            isPlaying: isPlaying,
            pipSupported: AVPictureInPictureController.isPictureInPictureSupported(),
            isFullScreen: isFullScreen,
            pipAlreadyRunning: isPictureInPictureActive || pip != nil
        )
        switch plan {
        case .pictureInPicture: beginPictureInPicture()
        case .pause: player?.pause()
        case .leaveAlone: break
        }
    }

    /// Another video started.
    func yieldTheFloor() {
        player?.pause()
        endPictureInPicture()
    }

    /// Pause, close any PiP window, and put the player back on the card.
    func stopCompletely() {
        player?.pause()
        endPictureInPicture()
    }

    // MARK: Picture in Picture from the session's own layer

    private func beginPictureInPicture() {
        guard let player else { return }
        // Controller first, PiP layer second: never both at once.
        controller?.player = nil

        let canvas = WatchPlayerCanvas()
        canvas.playerLayer.videoGravity = .resizeAspect
        canvas.alpha = 0.01
        canvas.isUserInteractionEnabled = false
        canvas.frame = CGRect(x: 0, y: 0, width: 16, height: 9)
        keyWindow?.addSubview(canvas)
        canvas.player = player
        pipCanvas = canvas

        guard let pip = AVPictureInPictureController(playerLayer: canvas.playerLayer) else {
            tearDownPictureInPicture(keepPlaying: false)
            return
        }
        pip.canStartPictureInPictureAutomaticallyFromInline = false
        pip.delegate = self
        self.pip = pip

        pipPossibleObservation = pip.publisher(for: \.isPictureInPicturePossible)
            .receive(on: DispatchQueue.main)
            .sink { [weak self] possible in
                MainActor.assumeIsolated {
                    guard possible, let self, let pip = self.pip,
                          !pip.isPictureInPictureActive else { return }
                    pip.startPictureInPicture()
                }
            }
        // A system that will not give the window (a call holds the audio
        // session, PiP is switched off in Settings) must not leave a video
        // playing to nobody.
        pipTimeout?.cancel()
        pipTimeout = Task { [weak self] in
            try? await Task.sleep(for: .seconds(1.5))
            guard !Task.isCancelled, let self, !self.isPictureInPictureActive else { return }
            self.tearDownPictureInPicture(keepPlaying: false)
        }
    }

    private func endPictureInPicture() {
        guard pip != nil else { return }
        if let pip, pip.isPictureInPictureActive {
            // `didStop` finishes the job and puts the player back.
            pip.stopPictureInPicture()
        } else {
            tearDownPictureInPicture(keepPlaying: true)
        }
    }

    /// PiP layer off, player back on the card's controller (if there is one).
    private func tearDownPictureInPicture(keepPlaying: Bool) {
        pipTimeout?.cancel()
        pipTimeout = nil
        pipPossibleObservation = nil
        pip?.delegate = nil
        pip = nil
        pipCanvas?.player = nil
        pipCanvas?.removeFromSuperview()
        pipCanvas = nil
        isPictureInPictureActive = false
        controller?.player = player
        if !keepPlaying { player?.pause() }
        if player?.timeControlStatus == .paused {
            BauPlayback.shared.release(self)
        }
    }

    private var keyWindow: UIWindow? {
        UIApplication.shared.connectedScenes
            .compactMap { $0 as? UIWindowScene }
            .flatMap(\.windows)
            .first(where: \.isKeyWindow)
    }
}

extension BauVideoSession: @preconcurrency AVPictureInPictureControllerDelegate {
    func pictureInPictureControllerDidStartPictureInPicture(
        _ pictureInPictureController: AVPictureInPictureController
    ) {
        isPictureInPictureActive = true
        pipTimeout?.cancel()
    }

    func pictureInPictureController(
        _ pictureInPictureController: AVPictureInPictureController,
        restoreUserInterfaceForPictureInPictureStopWithCompletionHandler completionHandler:
            @escaping (Bool) -> Void
    ) {
        restoring = true
        BauPlayback.shared.restoreTargetPostID = postID
        completionHandler(true)
    }

    func pictureInPictureControllerDidStopPictureInPicture(
        _ pictureInPictureController: AVPictureInPictureController
    ) {
        // Restore, or the card came back: keep playing. The X button on the
        // window: stop, there is nobody watching.
        let keep = restoring || isCardVisible
        restoring = false
        tearDownPictureInPicture(keepPlaying: keep)
    }

    func pictureInPictureController(
        _ pictureInPictureController: AVPictureInPictureController,
        failedToStartPictureInPictureWithError error: Error
    ) {
        tearDownPictureInPicture(keepPlaying: false)
    }
}

// MARK: - The view

struct BauInlineVideo: View {
    @Environment(\.openURL) private var openURL
    @Environment(VoiceModel.self) private var voice
    @Environment(CallModel.self) private var call
    /// Whichever rendition the caller picked. The player only ever plays the
    /// URL it is given.
    let url: URL
    let name: String
    var postID: String?

    @State private var session: BauVideoSession?
    /// Tracked apart from the session: `onAppear` can fire before the task
    /// below has produced one.
    @State private var cardVisible = false

    private var callActive: Bool { voice.holdsSeat || call.phase.isInRoom }

    var body: some View {
        Group {
            if let session, session.status == .ready {
                BauPlayerSurface(session: session)
            } else if session?.status == .failed {
                Button { openURL(url) } label: {
                    ZStack {
                        Palette.surfaceRaised
                        VStack(spacing: 6) {
                            Image(systemName: "exclamationmark.triangle")
                                .foregroundStyle(Palette.warning)
                            Text("Could not play this file.")
                                .font(Typography.callout)
                                .foregroundStyle(Palette.paperMuted)
                        }
                    }
                }
                .buttonStyle(.plain)
            } else {
                Palette.surfaceRaised.overlay { ProgressView().tint(Palette.paperMuted) }
            }
        }
        .frame(maxWidth: .infinity)
        .aspectRatio(16 / 9, contentMode: .fit)
        .clipShape(RoundedRectangle(cornerRadius: Metrics.cornerRadiusSmall, style: .continuous))
        .accessibilityLabel(name.isEmpty ? Text("Play video") : Text(name))
        .accessibilityIdentifier("bau.media.video")
        .task(id: url) {
            let next = BauPlayback.shared.session(for: url, postID: postID)
            // A refresh re-signs the URL under a card that stays put. The old
            // session would play on, unseen and unreachable, so it stops,
            // unless a PiP window or the full screen is deliberately using it.
            if let old = session, old !== next, !old.hasPictureInPicture, !old.isFullScreen {
                old.stopCompletely()
            }
            session = next
            next.callActive = callActive
            if cardVisible { next.cardDidAppear() }
            await next.prepareIfNeeded()
        }
        .onChange(of: callActive, initial: true) { _, now in session?.callActive = now }
        .onAppear {
            cardVisible = true
            session?.cardDidAppear()
        }
        .onDisappear {
            cardVisible = false
            session?.cardDidDisappear()
        }
    }
}

/// `AVPlayerViewController` for the card. Full screen is the system's button;
/// the app is portrait-locked, so full screen asks for landscape through
/// `WatchOrientation` while it is up and gives it back when it ends.
private struct BauPlayerSurface: UIViewControllerRepresentable {
    let session: BauVideoSession

    func makeCoordinator() -> Coordinator { Coordinator(session: session) }

    func makeUIViewController(context: Context) -> AVPlayerViewController {
        let controller = AVPlayerViewController()
        controller.allowsPictureInPicturePlayback = true
        controller.canStartPictureInPictureAutomaticallyFromInline = true
        controller.entersFullScreenWhenPlaybackBegins = false
        controller.exitsFullScreenWhenPlaybackEnds = true
        controller.videoGravity = .resizeAspect
        controller.delegate = context.coordinator
        session.attach(controller)
        return controller
    }

    func updateUIViewController(_ controller: AVPlayerViewController, context: Context) {}

    static func dismantleUIViewController(_ controller: AVPlayerViewController, coordinator: Coordinator) {
        coordinator.session.detach(controller)
    }

    @MainActor
    final class Coordinator: NSObject, @preconcurrency AVPlayerViewControllerDelegate {
        let session: BauVideoSession

        init(session: BauVideoSession) { self.session = session }

        func playerViewController(
            _ playerViewController: AVPlayerViewController,
            willBeginFullScreenPresentationWithAnimationCoordinator
                coordinator: UIViewControllerTransitionCoordinator
        ) {
            session.fullScreenWillBegin()
        }

        func playerViewController(
            _ playerViewController: AVPlayerViewController,
            willEndFullScreenPresentationWithAnimationCoordinator
                coordinator: UIViewControllerTransitionCoordinator
        ) {
            // Give portrait back only after the transition, or the controller
            // rotates mid-animation.
            coordinator.animate(alongsideTransition: nil) { [session] _ in
                Task { @MainActor in session.fullScreenDidEnd() }
            }
        }

        func playerViewController(
            _ playerViewController: AVPlayerViewController,
            restoreUserInterfaceForPictureInPictureStopWithCompletionHandler
                completionHandler: @escaping (Bool) -> Void
        ) {
            session.systemPictureInPictureWillRestore()
            BauPlayback.shared.restoreTargetPostID = session.postID
            completionHandler(true)
        }

        func playerViewControllerDidStopPictureInPicture(
            _ playerViewController: AVPlayerViewController
        ) {
            session.systemPictureInPictureDidStop()
        }

        func playerViewControllerDidStartPictureInPicture(
            _ playerViewController: AVPlayerViewController
        ) {
            session.systemPictureInPictureDidStart()
        }
    }
}

/// When an inline Baú video counts as broken and the card should offer the
/// open-out fallback instead of a player that will never move.
enum BauVideoHealth {
    /// A failed item, or any error on the item whatever its status says:
    /// `readyToPlay` is a statement about the probe, not about the stream.
    static func isFailure(status: AVPlayerItem.Status, error: Error?) -> Bool {
        status == .failed || error != nil
    }
}
