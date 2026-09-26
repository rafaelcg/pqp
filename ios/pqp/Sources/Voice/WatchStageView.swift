import AVKit
import SwiftUI

/**
 The picture, above the channel's transcript, for somebody who has not taken a
 seat.

 It sits in `ChatView`'s top safe area rather than in a screen of its own,
 which is the same place the collapsed call banner lives, and for the same
 reason: opening a channel is how you look at it, and a watch party you have to
 navigate into twice is a watch party people miss. Chat keeps scrolling
 underneath, which is what the audience is there for as much as the film.

 Every state here is a sentence. A dead black rectangle is the one outcome
 worth engineering against, because it is indistinguishable from the app being
 broken and it is what a viewer sees at the exact moment the host is asking
 whether it works.

 THE PICTURE IS OURS. `WatchVideoSurface` draws an `AVPlayerLayer`;
 `WatchOverlay` is the cinema chrome on top of it. There is no system
 transport bar and no scrubber, because a live window that offers to seek
 is a control that lies. Tap the film to see the bars, tap again to put
 them away.

 FULLSCREEN IS THE PHONE. Turn it on its side and this stage fills the screen;
 turn it back and the transcript returns. There is no button and no second
 screen, because three TestFlight builds of a presented theater (28, 30, 31)
 each failed differently and the last one failed for a reason no amount of
 chrome could fix: UIKit takes the presenter out of the window, SwiftUI calls
 that a disappearance, and the stage tore down the player underneath its own
 fullscreen. Nothing is presented now. The same view, the same `WatchPicture`
 layer and the same overlay simply get the whole screen.
 */
struct WatchStageView: View {
    @Environment(SessionStore.self) private var session
    @Environment(VoiceModel.self) private var voice

    let channel: Channel
    /// The coarse "this account can probably host here" reading `ChatView`
    /// computes -- see its own `canHostWatchParty` doc. Read only by the
    /// idle/`.unknown` notice below, to swap a discouraging "Nobody is
    /// streaming yet" for a nudge toward the toolbar's own Join button. It
    /// gates no action here; false is also the safe default for every
    /// caller but `ChatView` (previews, and any future call site that has
    /// not resolved it yet).
    var canHost: Bool = false
    /// Only used in the theater, where the system nav bar's own back
    /// chevron is hidden so it does not sit over the film immune to the
    /// autohide the rest of the chrome follows. `ChatView` hands in its own
    /// dismiss action; nil elsewhere leaves the system bar's button alone.
    var onBack: (() -> Void)?
    @State private var model = WatchModel()
    @State private var player: AVPlayer?
    /// The URL currently handed to the player, and when. `WatchStreamSwap`
    /// reads it to decide whether the freshest frame is worth a re-attach.
    @State private var attached: AttachedStream?
    @State private var stall = WatchStallWatch()
    @State private var edge = WatchLiveEdge()
    /// Bounded automatic recovery from a hard `AVPlayerItem` failure. See
    /// `WatchFailureRecovery`.
    @State private var recovery = WatchFailureRecovery()
    /// The `attachedAt` of the last attach for which `recovery` was cleared.
    /// A fresh `attach()` does NOT reset the budget by itself anymore: a
    /// replacement item that fails again immediately must still count
    /// against `WatchFailureRecovery.maxAttempts`, or a failure loop never
    /// reaches `giveUp`. The watchdog clears it only once THIS attach has
    /// held `.readyToPlay` and an advancing playhead for
    /// `recoveryConfirmTicks` straight seconds, which is the only signal
    /// that the replacement is not about to fail again in the next breath.
    @State private var recoveryClearedAttachedAt: Date?
    /// Consecutive watchdog ticks (one per second) this attach has spent
    /// confirmed healthy. Reset to zero the moment a tick is not, so a
    /// flicker (ready for one second, failed the next) never accumulates
    /// toward the threshold across two different unhealthy stretches.
    @State private var healthyPlaybackTicks = 0
    /// The playhead position read on the previous watchdog tick, so this
    /// tick can tell "reported playing" from "actually advancing". A stuck
    /// item can sit at `.readyToPlay` with `rate > 0` and a `timeControlStatus`
    /// of `.playing` while the decoder itself has wedged; none of those
    /// three are proof by themselves. `nil` right after an attach, so the
    /// very first tick of a new item never counts as advancing — there is
    /// nothing yet to compare it against.
    @State private var lastHealthCheckPosition: Double?
    /// Straight seconds of confirmed, ADVANCING playback before the recovery
    /// budget is considered proven, not merely started. Three ticks: long
    /// enough that a replacement item still holding together after a couple
    /// of seconds is actually different from the one that just failed, short
    /// enough that a real recovery is not made to look slower than it is.
    private static let recoveryConfirmTicks = 3
    @State private var isMinimised = false

    /// What the master playlist advertised for THIS broadcast, and how far
    /// behind the live edge the picture currently is.
    @State private var ladder = WatchLadder.empty
    @State private var behindLive = false
    /// The pipeline delay plus this viewer's own drift, measured every tick.
    /// Never the server's constant on its own: see `WatchDelay`.
    @State private var delaySeconds: Int?
    /// Lines actually being decoded, from `presentationSize`. What makes the
    /// Auto label worth reading.
    @State private var effectiveLines: Int?
    /// The video rectangle in device pixels, reported by the surface itself.
    @State private var surfacePixels: CGSize = .zero
    @State private var wasPlayingBeforeInterruption = false
    /// The phone is on its side and the film has the screen. Driven by the
    /// device, never by a control.
    @State private var isLandscape = false
    @State private var isPlaying = false
    /// What the viewer asked for. Distinct from `player.rate`, which drops
    /// to 0 on a pause nobody tapped (a rung switch, an interruption the
    /// notification missed). `WatchLiveEdge` and the unexpected-pause
    /// resume both read this, so a tap on pause is the only thing that
    /// stops the film on purpose.
    @State private var userWantsPlayback = true
    /// A seek reports a stale position and a brief `.paused` for a moment
    /// afterwards. Recovery must not fire inside this window or one starve
    /// becomes a burst of seeks that fight `play()`.
    @State private var seekingUntil = Date.distantPast
    @State private var chrome = WatchChromeClock()
    @State private var pip = WatchPictureInPicture()
    /// THE ONE LAYER. Not owned by either rectangle that draws it, because
    /// fullscreen MOVES it from the strip into the theater rather than
    /// building a second one. See `WatchPicture`.
    @State private var picturePlane = WatchPicture()
    @State private var chromeInsets = EdgeInsets()

    /// The pinned rung, in lines. Zero is Auto.
    ///
    /// DEVICE-LOCAL and remembered, for the same reason `VideoQualitySettings`
    /// is: what this phone's link can carry is a fact about this phone. It is
    /// not that class, though, because that one is what this phone SENDS.
    @AppStorage("pqp.watchQuality") private var pinnedLines = 0

    // MARK: - The presenter's camera

    /// The camera's own `AVPlayer`, independent of the film's: two decoders,
    /// never one asked to serve two pictures. `nil` whenever nothing is
    /// worth drawing (`cameraLayoutOffered`), including the whole time no
    /// camera egress is announced.
    @State private var cameraPlayer: AVPlayer?
    @State private var cameraAttached: CameraAttachedStream?
    /// How many camera failures in a row `checkCameraHealth()` has acted on
    /// without a confirmed healthy stretch in between. Drives
    /// `WatchCameraFailureBackoff.delay`; survives attach on purpose (see
    /// that function's comment) and resets only once `cameraHealthyTicks`
    /// proves the latest attach is actually holding.
    @State private var cameraFailureAttempt = 0
    /// The earliest moment `checkCameraHealth()` may act on another failed
    /// item. `nil` means no failure has been acted on yet -- the first one
    /// is handled immediately, same as before this backoff existed.
    @State private var cameraFailureNextRetryAt: Date?
    /// Consecutive watchdog ticks (~1/s) the camera has spent confirmed
    /// advancing since the last failure. Only counted once a failure has
    /// actually happened (`cameraFailureAttempt > 0`); a camera that has
    /// never failed has nothing to earn back.
    @State private var cameraHealthyTicks = 0
    /// The camera's playhead on the previous tick, so this tick can tell
    /// "reported playing" from "actually advancing" -- the same distinction
    /// `lastHealthCheckPosition` makes for the film.
    @State private var cameraLastPosition: Double?
    /// Corner, and which of the four layouts. Remembered per phone
    /// (`CameraPipPref`), same storage shape as `pinnedLines` above.
    @AppStorage("pqp.watchCameraPip") private var cameraPref: CameraPipPref = .default
    /// The corner box's live drag, reset to zero the moment a drag ends and
    /// the preference's corner has already snapped to wherever it landed.
    @GestureState private var cameraDragTranslation: CGSize = .zero

    /// AUTOMATIC RECOVERY FROM "THE PICTURE STOPPED" (`WatchDeadRetry`,
    /// mirroring the web's PR #824). How many automatic retries this failure
    /// episode has made; reset once the watchdog confirms a healthy,
    /// advancing attach (same place `recoveryClearedAttachedAt` is set)
    /// rather than on the optimistic flip back to `.live`, so the backoff
    /// keeps growing across a run of failures instead of restarting on every
    /// attempt.
    @State private var deadRetryAttempt = 0

    private var isSeated: Bool { voice.isLive && voice.channelId == channel.id }

    private var choice: WatchQualityChoice {
        WatchQualityChoice(lines: pinnedLines > 0 ? pinnedLines : nil)
    }

    var body: some View {
        VStack(spacing: 0) {
            if !isSeated {
                stage
            }
        }
        .preference(
            key: WatchHeroPreference.self,
            value: model.phase == .live && !isMinimised && !isSeated
        )
        // Landscape, live, not minimised, not seated: exactly `isLandscape`
        // below, which is already precisely that condition.
        .preference(key: WatchTheaterPreference.self, value: isLandscape)
        .task(id: channel.id) { await model.open(channelId: channel.id, session: session) }
        .task { await watchdog() }
        .task { await deadRetryLoop() }
        .onDisappear {
            // NOT WHILE THE FILM IS ON. A view that is off screen because the
            // stage is filling the screen is not a view somebody navigated
            // away from. Nothing is presented any more so this should not fire
            // at all, and the guard stays because tearing the player down
            // underneath its own fullscreen is exactly what builds 28, 30 and
            // 31 did.
            guard !isLandscape else { return }
            tearDown()
            deadRetryAttempt = 0
            model.close()
            WatchOrientation.leaveTheater()
        }
        .onChange(of: isSeated, initial: true) { _, seated in
            model.isSeated = seated
            if seated {
                tearDown()
                WatchOrientation.leaveTheater()
            }
        }
        // Runs on every `channel-live`, which is twice a minute for the whole
        // party, because the stamped URL is different every time. The swap
        // rule is what stops that being a re-buffer every thirty seconds, and
        // it is also what performs the hourly token renewal: at fifty minutes
        // the very next frame is the one that gets attached.
        .onChange(of: model.stream, initial: true) { _, _ in
            reconcile()
            reconcileCamera()
        }
        // The presenter can flip "junto"/"separada" mid-party without the
        // camera's path ever changing, so the mute state is applied in
        // place, same as `WatchCameraPip`'s sibling effect on the web:
        // never a reason to rebuild the player.
        .onChange(of: model.stream?.resolvedCameraHasVoiceAudio) { _, hasVoice in
            cameraPlayer?.isMuted = !(hasVoice ?? false)
        }
        // Picking "hide camera" with nothing to hear either should stop the
        // stream right away, not wait for the next `channel-live` (up to 30s
        // away) to notice (Farol review, PR 833).
        .onChange(of: cameraPref.layout) { _, _ in reconcileCamera() }
        .onChange(of: model.phase) { _, phase in
            if phase != .live {
                tearDown()
                WatchOrientation.leaveTheater()
            } else {
                // Landscape is unlocked only while there is a film to turn the
                // phone for. The app is portrait everywhere else and stays so.
                WatchOrientation.enterTheater()
                applyOrientation()
            }
        }
        .onChange(of: pinnedLines) { _, _ in applyQuality(trigger: .pin) }
        .onChange(of: surfacePixels) { _, _ in applyQuality(trigger: .surface) }
        .onChange(of: isLandscape) { _, _ in applyQuality(trigger: .fullscreen) }
        // THE ONE PAUSE NOBODY ASKED FOR. A call, Siri, an alarm or another
        // app taking the session stops `AVPlayer` dead and leaves it stopped;
        // there is no automatic resume and nothing in the app was listening,
        // so the film simply never came back and the only clue was a viewer
        // pressing play.
        .onReceive(
            NotificationCenter.default.publisher(
                for: AVAudioSession.interruptionNotification
            )
        ) { note in handleInterruption(note) }
        // THE PLAYS-THEN-STOPS SIGNAL. `AVPlayer` posts this when the
        // playhead has media behind it and none in front, which is the
        // live-edge stall: a few 2 s segments play, then silence. The
        // web recovers with `jumpToLiveTime` (one segment behind the
        // edge). Waiting for the 12 s starve clock is how the film
        // stays frozen in front of somebody.
        .onReceive(
            NotificationCenter.default.publisher(
                for: .AVPlayerItemPlaybackStalled
            )
        ) { note in handlePlaybackStalled(note) }
        .onReceive(
            NotificationCenter.default.publisher(
                for: UIDevice.orientationDidChangeNotification
            )
        ) { _ in
            chromeInsets = WatchOrientation.safeInsets
            applyOrientation()
        }
    }

    /**
     The three failures `AVPlayer` will not interrupt anybody about.

     `AVPlayerItem.status == .failed` is a real error the player already knows,
     sitting in a property nothing polls. A frozen picture is not an error at
     all (see `WatchStallWatch`) and only a clock finds it. And a playhead that
     has fallen out of a ten second live window is not an error either (see
     `WatchLiveEdge`): the player is simply waiting for media at a position the
     playlist no longer contains, which is the state `play()` cannot fix and a
     seek can. One second is the tick because the segments are two, so nothing
     here reacts faster than the stream can legitimately move.

     A stall reattaches rather than giving up, and it reattaches to the
     FRESHEST url, which is at most thirty seconds old. That covers the
     ordinary evening cases in one move: the tunnel, the lift, the handover
     from wifi to mobile. An overrun does not reattach at all, because
     rebuilding the player would throw away a perfectly good connection to fix
     a position; it seeks instead, which costs nothing. `failed` is where a
     viewer is told, and only after the player itself has declared it.
     */
    private func watchdog() async {
        while !Task.isCancelled {
            try? await Task.sleep(for: .seconds(1))
            checkCameraHealth()
            guard let player, attached != nil else { continue }
            guard let item = player.currentItem else { continue }
            if item.status == .failed {
                await recoverFromFailure()
                continue
            }
            let now = Date()
            let position = player.currentTime().seconds
            let window = Self.liveWindow(of: item)
            let lines = Int(item.presentationSize.height.rounded())
            if lines > 0, lines != effectiveLines { effectiveLines = lines }
            behindLive = WatchLiveEdge.isBehindLive(position: position, window: window)
            delaySeconds = WatchDelay.seconds(
                pipeline: model.stream?.delaySeconds, position: position, window: window
            )
            let status = player.timeControlStatus
            isPlaying = status == .playing || player.rate > 0
            chrome.tick(playing: isPlaying, at: now)
            // The budget clears only once THIS attach has held
            // `.readyToPlay`, `.playing` AND an advancing playhead for
            // `recoveryConfirmTicks` straight seconds, not on attach itself
            // and not on the first healthy-looking tick: a replacement item
            // that fails again a second later must still spend from the
            // same budget as the failure that produced it, or the
            // three-attempt cap is never reached. `.readyToPlay` plus
            // `rate > 0` is not proof on its own — a decoder can wedge while
            // still reporting both — so a tick only counts when the
            // position this tick is strictly ahead of the position last
            // tick. Any tick that is not confirmed advancing resets the
            // streak, so two short healthy stretches never add up.
            let advanced = lastHealthCheckPosition.map { position > $0 } ?? false
            let confirmedHealthyTick =
                item.status == .readyToPlay && isPlaying && player.rate > 0 && advanced
            lastHealthCheckPosition = position
            healthyPlaybackTicks = confirmedHealthyTick ? healthyPlaybackTicks + 1 : 0
            if let attached,
               healthyPlaybackTicks >= Self.recoveryConfirmTicks,
               recoveryClearedAttachedAt != attached.attachedAt {
                recovery.reset()
                recoveryClearedAttachedAt = attached.attachedAt
                // A confirmed, advancing attach is the only signal that a
                // failure episode is actually over -- the optimistic
                // `phase = .live` flip inside `WatchModel.retry()` is not,
                // so `deadRetryLoop()` does not reset here on every attempt.
                deadRetryAttempt = 0
            }

            edge.learnSegmentSeconds(recommendedOffset: item.recommendedTimeOffsetFromLive.seconds)
            // Once the real segment length is known, narrow the forward
            // buffer to what production serves and never past the window —
            // `apply()` ran before the manifest loaded and used the fallback.
            WatchPlayerItemTuning.retune(
                item, segmentSeconds: edge.segmentSeconds, windowSpan: window?.span
            )
            let seeking = now < seekingUntil
            if !seeking {
                let remedy = edge.tick(
                    position: position,
                    window: window,
                    // The VIEWER's intent. Rate is the outcome and it drops
                    // to 0 on a pause nobody asked for, which is exactly
                    // the state that has to recover. A tap on pause is the
                    // only thing that sets this false.
                    wantsPlayback: userWantsPlayback,
                    isWaiting: status == .waitingToPlayAtSpecifiedRate,
                    now: now
                )
                if case .rejoin(let target) = remedy {
                    seek(to: target)
                } else if userWantsPlayback, status == .paused, player.rate == 0 {
                    // A pause the viewer did not ask for. `play()` first;
                    // if the playhead has already slid out of the ten
                    // second window, only a seek puts it back.
                    resumeWantedPlayback()
                }
            }

            let stalled = stall.tick(
                position: position,
                isPlaying: status == .playing,
                wantsPlayback: userWantsPlayback,
                isWaiting: status == .waitingToPlayAtSpecifiedRate,
                now: now
            )
            if stalled { reconcile(force: true) }
        }
    }

    /**
     A hard `AVPlayerItem` failure, with one bounded attempt to fix it before
     the viewer sees a card.

     The dead end this replaces was calling `model.playbackFailed` on the
     spot, which never once asked the server for anything: if the failure was
     an expired token — the common case, since the token this player is
     holding can be up to `WatchStreamSwap.renewAfter` stale, or far staler
     than that if the socket has been quiet — the freshest thing available
     locally is the same dead URL. `refreshLive` asks the server what is
     actually true right now; `WatchFailureRecovery` is what stops that
     becoming an unbounded refetch loop against a stream that is genuinely
     gone.
     */
    private func recoverFromFailure() async {
        switch recovery.onFailure(now: Date()) {
        case .giveUp:
            model.playbackFailed(
                String(localized: "The connection to the stream dropped.")
            )
        case .refetch:
            do {
                switch try await model.refreshLive() {
                case .applied(let stream):
                    if stream != nil {
                        // A fresh stream came back: reattach to it
                        // regardless of how old `attached` is, the same way
                        // a stall or a manual retry does.
                        reconcile(force: true)
                    }
                    // `stream == nil` means the broadcast genuinely ended
                    // or never started, and `applyStream` already moved
                    // `phase` to `.ended` / `.idle` inside `refreshLive` —
                    // that sentence is truer than "the connection dropped",
                    // and `.onChange(of: model.phase)` tears the player
                    // down on its own.
                case .failed:
                    if model.phase == .live {
                        // The refetch itself failed (network), so `phase`
                        // was never touched by it and is still `.live` from
                        // before this failure. Nothing better is available:
                        // show the card.
                        model.playbackFailed(
                            String(localized: "The connection to the stream dropped.")
                        )
                    }
                case .superseded:
                    // Something more recent than this call already spoke
                    // for the stream — a socket frame, or a newer
                    // overlapping `refreshLive()` — and applied its own
                    // answer correctly. This call has nothing to add, and
                    // MUST NOT fall through to `playbackFailed`: `phase` can
                    // already be `.live` again with a perfectly good,
                    // freshly attached stream, and painting that as dead is
                    // exactly the false failure this case exists to avoid.
                    break
                }
            } catch is CancellationError {
                // The watchdog task itself was cancelled while this was in
                // flight (the view went away). Nothing to reconcile and
                // nothing to mark failed: there is no picture left to be
                // wrong about.
            } catch {
                // `refreshLive` never throws anything but cancellation.
            }
        }
    }

    /**
     "THE PICTURE STOPPED" TRIES AGAIN BY ITSELF.

     `WatchFailureRecovery` already refetches and reattaches on the first
     three failures inside a five minute window; this is what happens once
     that budget is spent and `model.phase` has become `.failed`. Sitting on
     that card until somebody notices and taps "Try again" is thirty seconds
     of a broadcast that may well still be running -- the same reasoning as
     the film's own live-edge recovery, just aimed at the card instead of the
     playhead. See `WatchDeadRetry` for the schedule.

     Cheap to poll every second while nothing has failed: no timer setup, no
     teardown to coordinate with `watchdog()`, and cancelled the same way
     everything else in this view is, by `onDisappear`'s `Task` cancellation.
     */
    private func deadRetryLoop() async {
        while !Task.isCancelled {
            guard case .failed = model.phase else {
                try? await Task.sleep(for: .seconds(1))
                continue
            }
            let wait = WatchDeadRetry.delay(
                attempt: deadRetryAttempt, jitter: { Double.random(in: 0...1) }
            )
            try? await Task.sleep(for: .seconds(wait))
            guard !Task.isCancelled, case .failed = model.phase else { continue }
            deadRetryAttempt += 1
            recovery.reset()
            model.retry()
            reconcile(force: true)
            // NOT forced (Farol review, PR 833): `force` on the camera's own
            // swap bypasses its same-session keep rule unconditionally, so a
            // healthy camera would restart -- a fresh rebuffer -- every time
            // the FILM alone needed a kick. The plain reconcile still picks
            // up a genuinely fresh URL or session; only the camera's own
            // failure (`cameraWatchdogTick`) has a reason to force it.
            reconcileCamera()
        }
    }

    /// The playlist's sliding window, as the item sees it.
    ///
    /// `seekableTimeRanges` is one range for a healthy live playlist and can be
    /// several across a discontinuity, so the window is the first range's start
    /// to the last range's end rather than any single range.
    static func liveWindow(of item: AVPlayerItem) -> WatchLiveWindow? {
        let ranges = item.seekableTimeRanges.map(\.timeRangeValue)
        guard let first = ranges.first, let last = ranges.last else { return nil }
        let start = first.start.seconds
        let end = (last.start + last.duration).seconds
        guard start.isFinite, end.isFinite, end > start else { return nil }
        return WatchLiveWindow(start: start, end: end)
    }

    // The session's real segment length is learned and retained on `edge`
    // (`WatchLiveEdge.segmentSeconds`), which, unlike reading the item afresh,
    // does NOT fall back to the 2 s constant on a momentarily-unavailable
    // reading during a reload. Every seek below reads that retained value, so
    // a 4 s session never lands 2 s behind live — near the tip — on a blip.

    /**
     AN EMPTY WATCH PARTY STILL HAS TO LOOK LIKE ONE.

     Build 21 drew `EmptyView()` here, and nothing is running most of the
     week, so a `watch_party` channel opened outside show time was byte for
     byte an ordinary voice channel: a transcript, and a phone button. That is
     what "watch party shows as a regular voice channel" was. The player was
     right; there was simply nothing on screen until a stream existed, and
     "nothing" is the one state a person cannot tell from a broken app.

     An ordinary voice channel keeps the old behaviour exactly. This view is
     mounted for EVERY voice room's transcript, so a card that drew itself on
     all of them would put a film poster over every call in the server.

     `unknown` and `idle` deliberately draw the same card. They are a round
     trip apart, and two different sentences half a second apart is a flicker,
     not information. `ended` keeps its own notice: "acabou" and "ainda não
     começou" are opposite facts and that distinction is worth the state.
     */
    @ViewBuilder
    private var stage: some View {
        switch model.phase {
        case .unknown, .idle:
            // A DEEP LINK OR A LIST TAP CAN LAND A HOST HERE BEFORE THEY HAVE
            // JOINED ANYTHING, and "Nobody is streaming yet" reads as a dead
            // end to exactly the person who is about to fix that -- the
            // toolbar's own Join button is one tap above this card the
            // whole time (`ChatView`'s toolbar, gated by
            // `watchPartyMayJoinRoom`), and `canHost` only changes which
            // sentence points at it.
            if channel.isWatchParty {
                notice(
                    icon: "movieclapper.fill",
                    title: "Watch party",
                    message: canHost
                        ? "Nobody is streaming yet. Tap Join above to set one up."
                        : "Nobody is streaming yet. When it starts, it shows up here."
                )
            }
        case .live:
            picture
        case .ended:
            notice(
                icon: "checkmark.circle",
                title: "The watch party ended",
                message: "The stream is over."
            )
        case .failed(let reason):
            notice(
                icon: "exclamationmark.triangle",
                title: "The picture stopped",
                message: LocalizedStringKey(reason),
                retry: true
            )
        }
    }

    /// COLLAPSED MEANS REMOVED, NOT SQUASHED. The old version kept the video
    /// view in the hierarchy at zero height, which leaves a decoder running
    /// full tilt to fill a rectangle nobody can see. Taking the surface out
    /// keeps the `AVPlayer` and therefore the sound, which is the whole point
    /// of collapsing it: listen to the film and read the chat.
    ///
    /// ONE VIEW, TWO SIZES. Portrait is a 16:9 strip above the transcript.
    /// Landscape is the same view given the whole screen: this lives in
    /// `ChatView`'s top safe-area inset, so an inset as tall as the screen IS
    /// the screen, and the transcript is simply below it. No presentation, no
    /// second controller, and the same `WatchPicture` layer throughout, which
    /// is why the film does not blink on the way in or out.
    private var picture: some View {
        VStack(spacing: 0) {
            if !isMinimised {
                if isLandscape {
                    pane(isTheater: true)
                        .frame(
                            maxWidth: .infinity,
                            minHeight: WatchOrientation.screenPoints.height,
                            maxHeight: .infinity
                        )
                } else {
                    pane(isTheater: false)
                        .frame(maxWidth: .infinity)
                        .aspectRatio(16 / 9, contentMode: .fit)
                }
            }
            if isMinimised {
                collapsedBar
            }
        }
        .background(Palette.inkDeep)
        .ignoresSafeArea(edges: isLandscape ? .all : [])
        .statusBarHidden(isLandscape)
    }

    @ViewBuilder
    private func pane(isTheater: Bool) -> some View {
        ZStack {
            Color.black
            if player != nil {
                GeometryReader { proxy in
                    stageLayers(size: proxy.size)
                }
                .onTapGesture { chrome.tap(at: Date()) }
                overlay(isTheater: isTheater)
            } else {
                connecting
            }
        }
    }

    private func overlay(isTheater: Bool) -> some View {
        WatchOverlay(
            chromeVisible: chrome.visible,
            isPlaying: isPlaying,
            isTheater: isTheater,
            behindLive: behindLive,
            audienceCount: model.audienceCount,
            audienceLabel: viewerLabel,
                    pipAvailable: isTheater ? false : pip.canStart,
            chromeInsets: isTheater ? chromeInsets : .init(),
            onBack: isTheater ? onBack : nil,
            onTogglePlay: togglePlay,
            onJumpToLive: jumpToLive,
            onStartPip: { pip.start() },
            onCollapse: isTheater ? nil : { isMinimised = true },
            qualityMenu: {
                if ladder.isWorthOffering { qualityMenu }
            },
            cameraMenu: {
                if cameraLayoutIsOffered { cameraLayoutMenu }
            }
        )
    }

    // MARK: - The stage's two pictures

    /// Whether the current broadcast has a camera worth a layout choice at
    /// all. Mirrors `cameraLayoutOffered`.
    private var cameraLayoutIsOffered: Bool {
        cameraLayoutOffered(
            cameraSrc: model.stream?.cameraHlsUrl,
            cameraHasVideo: model.stream?.resolvedCameraHasVideo ?? true
        )
    }

    /// The film, and the camera on top of it in whichever of the four
    /// arrangements the viewer picked (`CameraPipPref`). `size` is the
    /// stage's own box, read by `GeometryReader` so the corner and the
    /// drag's end point can be worked out in the same coordinates.
    @ViewBuilder
    private func stageLayers(size: CGSize) -> some View {
        let hasVoice = model.stream?.resolvedCameraHasVoiceAudio ?? false
        let cameraAnnounced = model.stream?.cameraHlsUrl != nil
        let layout: CameraLayout = cameraLayoutIsOffered
            ? effectiveCameraLayout(pref: cameraPref, cameraHasVideo: true)
            : .pip

        switch layout {
        case .side where cameraLayoutIsOffered:
            sideBySide(size: size)
        case .camera where cameraLayoutIsOffered:
            ZStack {
                // COVERED, NOT TORN DOWN: the film keeps decoding underneath
                // so switching back to it is instant, and it is still the
                // only place the party's sound plays from.
                WatchVideoSurface(picture: picturePlane)
                    .opacity(0)
                    .allowsHitTesting(false)
                WatchCameraSurface(player: cameraPlayer, fit: .resizeAspect)
            }
        default:
            // `pip` (the default) and `stream` ("hide camera") both draw the
            // film full bleed; the only difference is whether a picture goes
            // in the corner. A camera that carries no picture but does carry
            // the presenter's voice still gets the corner, drawn as the
            // voice-only indicator, in every layout except `camera`.
            ZStack {
                WatchVideoSurface(picture: picturePlane)
                if cameraLayoutIsOffered, cameraPref.layout != .stream {
                    cameraCornerBox(size: size)
                } else if hasVoice, cameraAnnounced {
                    voiceOnlyCornerBox(size: size)
                }
            }
        }
    }

    /// Side by side when the stage is wider than it is tall, stacked (film
    /// on top) otherwise. Reads the stage's own aspect rather than
    /// `isTheater`, so a squarish window (an iPad split view, say) still
    /// gets a sensible arrangement.
    private func sideBySide(size: CGSize) -> some View {
        Group {
            if size.width >= size.height {
                HStack(spacing: 2) {
                    WatchVideoSurface(picture: picturePlane)
                    WatchCameraSurface(player: cameraPlayer, fit: .resizeAspect)
                }
            } else {
                VStack(spacing: 2) {
                    WatchVideoSurface(picture: picturePlane)
                    WatchCameraSurface(player: cameraPlayer, fit: .resizeAspect)
                }
            }
        }
    }

    /// The corner box's size: a portrait rectangle, never wider than about a
    /// third of the stage, so it never competes with the film for attention.
    static func cameraCornerSize(in stage: CGSize) -> CGSize {
        let width = min(110, max(60, stage.width * 0.32))
        return CGSize(width: width, height: width * 4 / 3)
    }

    /// The box's centre for a given corner, inset by `margin` on both axes.
    static func cameraCornerOrigin(
        corner: CameraPipCorner, boxSize: CGSize, stageSize: CGSize, margin: CGFloat
    ) -> CGPoint {
        let x = (corner == .topLeading || corner == .bottomLeading)
            ? margin + boxSize.width / 2
            : stageSize.width - margin - boxSize.width / 2
        let y = (corner == .topLeading || corner == .topTrailing)
            ? margin + boxSize.height / 2
            : stageSize.height - margin - boxSize.height / 2
        return CGPoint(x: x, y: y)
    }

    private static let cameraCornerMargin: CGFloat = 10

    /// The draggable webcam. A tap or a short press passes straight through
    /// (the drag gesture never fires under `minimumDistance`), so it does
    /// not steal the "tap the film to see the chrome" gesture underneath it.
    private func cameraCornerBox(size: CGSize) -> some View {
        let boxSize = Self.cameraCornerSize(in: size)
        let anchor = Self.cameraCornerOrigin(
            corner: cameraPref.corner, boxSize: boxSize, stageSize: size,
            margin: Self.cameraCornerMargin
        )
        return WatchCameraSurface(player: cameraPlayer, fit: .resizeAspectFill)
            .frame(width: boxSize.width, height: boxSize.height)
            .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
            .overlay(
                RoundedRectangle(cornerRadius: 10, style: .continuous)
                    .strokeBorder(Color.white.opacity(0.18), lineWidth: 1)
            )
            .shadow(color: .black.opacity(0.4), radius: 8, y: 3)
            .position(
                x: anchor.x + cameraDragTranslation.width,
                y: anchor.y + cameraDragTranslation.height
            )
            .animation(Motion.standard, value: cameraPref.corner)
            .gesture(
                DragGesture(minimumDistance: 8)
                    .updating($cameraDragTranslation) { value, state, _ in
                        state = value.translation
                    }
                    .onEnded { value in
                        let landed = CGPoint(
                            x: anchor.x + value.translation.width,
                            y: anchor.y + value.translation.height
                        )
                        cameraPref.corner = CameraPipCorner.nearest(to: landed, in: size)
                    }
            )
            .accessibilityLabel("Your camera")
            .accessibilityAction(named: Text("Move the camera to another corner")) {
                cameraPref.corner = cameraPref.corner.clockwise()
            }
    }

    /// The audio-only shape of "separada": no picture, just the fact that a
    /// voice is here to hear, in the same corner a webcam would use.
    private func voiceOnlyCornerBox(size: CGSize) -> some View {
        let boxSize = Self.cameraCornerSize(in: size)
        let anchor = Self.cameraCornerOrigin(
            corner: cameraPref.corner, boxSize: boxSize, stageSize: size,
            margin: Self.cameraCornerMargin
        )
        return ZStack {
            RoundedRectangle(cornerRadius: 10, style: .continuous)
                .fill(Color.black.opacity(0.72))
            Image(systemName: "mic.fill")
                .font(.system(size: 18, weight: .medium))
                .foregroundStyle(Palette.paper.opacity(0.85))
        }
        .frame(width: boxSize.width, height: boxSize.height)
        .position(x: anchor.x, y: anchor.y)
        .accessibilityLabel("Presenter's voice")
    }

    /// `Camera layout` (`voice.hls.cameraLayout` on the web): offered only
    /// while a camera with a picture is actually running.
    private var cameraLayoutMenu: some View {
        Menu {
            Picker("Camera layout", selection: $cameraPref.layout) {
                Text("Default").tag(CameraLayout.pip)
                Text("Side by side").tag(CameraLayout.side)
                Text("Hide camera").tag(CameraLayout.stream)
                Text("Hide stream").tag(CameraLayout.camera)
            }
            .pickerStyle(.inline)
        } label: {
            WatchGlyphWell {
                Image(systemName: "rectangle.inset.bottomright.filled")
                    .font(.system(size: 13, weight: .semibold))
                    .foregroundStyle(Palette.paper)
            }
        }
        .accessibilityLabel("Camera layout")
    }

    private var connecting: some View {
        VStack(spacing: 10) {
            Image(systemName: "movieclapper.fill")
                .font(.system(size: 22, weight: .light))
                .foregroundStyle(Palette.paperMuted)
            ProgressView().tint(Palette.signal)
            Text("Connecting to the stream")
                .font(Typography.callout)
                .foregroundStyle(Palette.paperMuted)
        }
    }

    // MARK: - Collapsed strip, and the overlay's quality menu

    /// Sound without picture. The overlay is gone with the layer, so this
    /// stub is what still says the party is live and how to bring the film
    /// back.
    private var collapsedBar: some View {
        HStack(spacing: 8) {
            livePill
            // Shown while behind as well as while live, because that is
            // exactly when the number stops being decoration: it is the
            // sentence "the chat is a minute ahead of you", in one figure.
            if let delay = delaySeconds ?? model.stream?.delaySeconds, delay > 0 {
                Text("~\(delay)s delay")
                    .font(Typography.caption)
                    .foregroundStyle(behindLive ? Palette.warning : Palette.paperMuted)
                    .monospacedDigit()
            }
            // A glyph and a number rather than the sentence. Five controls on
            // a strip a phone wide is already tight, and "12 assistindo" is
            // the widest of them for the least information; the sentence
            // survives as the accessibility label, which is where somebody
            // who cannot see the glyph reads it anyway.
            HStack(spacing: 3) {
                Image(systemName: "eye")
                    .font(.system(size: 10, weight: .semibold))
                // `verbatim` because a bare count is a value, not words. A
                // plain literal here would become a catalogue key of "%lld".
                Text(verbatim: "\(model.audienceCount)")
                    .font(Typography.caption)
                    .monospacedDigit()
            }
            .foregroundStyle(Palette.paperMuted)
            .accessibilityElement(children: .ignore)
            .accessibilityLabel(viewerLabel)
            Spacer(minLength: 4)
            collapseButton
        }
        .padding(.horizontal, Metrics.hPadding)
        .padding(.vertical, 9)
        .background(Palette.inkDeep)
    }

    /// AO VIVO, or an offer to go back to it.
    ///
    /// The badge is not decoration on this stream. A recovery lands three
    /// segments back from the edge and a stall leaves drift behind it, so
    /// "behind" is the normal condition rather than the exceptional one.
    /// Claiming AO VIVO while a minute down is the kind of small lie that
    /// makes somebody distrust the whole player, and they find it out from the
    /// chat spoiling the film.
    @ViewBuilder
    private var livePill: some View {
        if behindLive {
            Button {
                jumpToLive()
            } label: {
                HStack(spacing: 5) {
                    Image(systemName: "forward.end.alt.fill")
                        .font(.system(size: 9, weight: .bold))
                    Text("Jump to live")
                        .font(Typography.label)
                }
                .foregroundStyle(Palette.ink)
                .padding(.horizontal, 8)
                .padding(.vertical, 4)
                .background(
                    Capsule().fill(Palette.signal)
                )
            }
            .buttonStyle(.plain)
        } else {
            HStack(spacing: 5) {
                Circle()
                    .fill(Palette.danger)
                    .frame(width: 6, height: 6)
                Text("LIVE")
                    .font(Typography.label)
                    .tracking(0.8)
                    .foregroundStyle(Palette.paper)
            }
            .padding(.horizontal, 8)
            .padding(.vertical, 4)
            .background(
                Capsule().fill(Palette.surfaceRaised)
            )
        }
    }

    /// Auto plus whatever the master playlist actually published, and nothing
    /// else. A menu offering 480p on a ladder that publishes 720p and 1080p
    /// would be a control that lies about what it can do.
    private var qualityMenu: some View {
        Menu {
            Picker("Broadcast quality", selection: $pinnedLines) {
                Text(WatchQualityLabel.text(choice: .auto, effectiveLines: effectiveLines))
                    .tag(0)
                ForEach(ladder.rungs) { rung in
                    Text(rung.label).tag(rung.lines)
                }
            }
            .pickerStyle(.inline)
        } label: {
            HStack(spacing: 5) {
                Image(systemName: "slider.horizontal.3")
                    .font(.system(size: 11, weight: .semibold))
                Text(WatchQualityLabel.text(choice: choice, effectiveLines: effectiveLines))
                    .font(Typography.caption)
                    .monospacedDigit()
            }
            .foregroundStyle(Palette.paper)
            .padding(.horizontal, 10)
            .padding(.vertical, 8)
            .background(Capsule().fill(Color.black.opacity(0.55)))
            .overlay(Capsule().strokeBorder(Color.white.opacity(0.10), lineWidth: 1))
        }
        .accessibilityLabel("Broadcast quality")
    }

    private var collapseButton: some View {
        Button {
            isMinimised.toggle()
        } label: {
            Image(systemName: isMinimised ? "chevron.down" : "chevron.up")
                .font(.system(size: 13, weight: .semibold))
                .foregroundStyle(Palette.paperMuted)
                .frame(width: 28, height: 24)
        }
        .accessibilityLabel(isMinimised ? "Show the stream" : "Hide the stream")
    }

    private var viewerLabel: String {
        let count = model.audienceCount
        return count == 1
            ? String(localized: "1 watching")
            : String(localized: "\(count) watching")
    }

    private func notice(
        icon: String, title: LocalizedStringKey, message: LocalizedStringKey,
        retry: Bool = false
    ) -> some View {
        HStack(spacing: 12) {
            Image(systemName: icon)
                .font(.system(size: 18, weight: .light))
                .foregroundStyle(Palette.paperMuted)
            VStack(alignment: .leading, spacing: 2) {
                Text(title)
                    .font(Typography.bodyMedium)
                    .foregroundStyle(Palette.paper)
                Text(message)
                    .font(Typography.callout)
                    .foregroundStyle(Palette.paperMuted)
            }
            Spacer()
            if retry {
                Button("Try again") {
                    recovery.reset()
                    model.retry()
                    reconcile(force: true)
                }
                    .font(Typography.callout)
                    .foregroundStyle(Palette.signal)
            }
        }
        .padding(.horizontal, Metrics.hPadding)
        .padding(.vertical, 12)
        .background(Palette.surface)
    }

    // MARK: - The player

    /**
     Hand the player a URL, or leave it alone.

     `WatchStreamSwap` owns the decision and the reasoning; the thing to know
     at this call site is that "the URL changed" is NOT a reason, and this runs
     on every frame, which is twice a minute for the length of a film.
     */
    private func reconcile(force: Bool = false) {
        guard !isSeated else { return }
        let move = WatchStreamSwap.next(
            attached: attached, latest: model.stream, failed: force, now: Date()
        )
        switch move {
        case .keep:
            return
        case .detach:
            tearDown()
        case .attach(let stream):
            attach(stream)
        }
    }

    private func attach(_ stream: LiveHlsStream) {
        guard let url = liveStreamURL(
            hlsUrl: stream.hlsUrl, apiBaseURL: Backend.current.apiBaseURL
        ) else {
            model.playbackFailed(String(localized: "The stream address was not readable."))
            return
        }
        player?.pause()
        WatchAudioSession.activate()
        // The asset is built here rather than by `AVPlayer(url:)` so the same
        // object can be asked for the master playlist's variants below. One
        // asset, one parse: asking a second `AVURLAsset` would fetch the
        // master again for nothing.
        let asset = AVURLAsset(url: url)
        let item = AVPlayerItem(asset: asset)
        WatchPlayerItemTuning.apply(item)
        let next = AVPlayer(playerItem: item)
        // Without this the picture is suspended the moment the app leaves the
        // screen, which is most of a watch party: a phone in a pocket, a phone
        // face down on the table. `audio` is already in `UIBackgroundModes`,
        // so the sound keeps coming and the video resumes on return.
        next.audiovisualBackgroundPlaybackPolicy = .continuesIfPossible
        // ON on purpose. Build 25 turned this off so the player would
        // decode the first segment instead of waiting for a buffer a ten
        // second playlist cannot grow. Combined with an immediate settle
        // seek it decoded one frame and sat. Waiting is what a live
        // playlist is for; `WatchLiveEdge` only seeks if the playhead
        // falls out of the window. The forward buffer on the item is what
        // stops that wait from being "a 30 s buffer this playlist cannot
        // grow".
        next.automaticallyWaitsToMinimizeStalling = true
        picturePlane.onSurfacePixels = { pixels in surfacePixels = pixels }
        attached = AttachedStream(startedAt: stream.startedAt, attachedAt: Date())
        stall = WatchStallWatch()
        edge = WatchLiveEdge()
        // NOT `recovery.reset()` here: this attach is unproven until the
        // watchdog confirms it. See `recoveryClearedAttachedAt`.
        healthyPlaybackTicks = 0
        lastHealthCheckPosition = nil
        behindLive = false
        delaySeconds = nil
        effectiveLines = nil
        ladder = .empty
        userWantsPlayback = true
        chrome.reveal(at: Date())
        WatchNowPlaying.begin(
            title: channel.name,
            subtitle: nil,
            onPlay: { playFromUser() },
            onPause: { pauseFromUser() }
        )
        // Parse the master, write the Auto ceiling, THEN play. Playing
        // first and applying the cap when `status == .readyToPlay` is the
        // stall: ABR climbs, the rendition switch freezes a 10 s window.
        Task { @MainActor in
            let published = await WatchVariants.load(from: asset)
            guard attached?.startedAt == stream.startedAt else { return }
            ladder = published
            player = next
            // The layer takes the player here and keeps it for the whole
            // broadcast. Never in `makeUIView`: that is once per rectangle,
            // and fullscreen is a second rectangle.
            picturePlane.show(next, pip: pip)
            applyQuality(trigger: .variants)
            next.play()
            isPlaying = true
        }
    }

    // MARK: - The camera

    /// Same reasoning as `reconcile()`, aimed at the camera's own player.
    /// `force` is true from a manual retry, the film's auto-retry loop
    /// picking up a fresh URL, and this view's own camera watchdog tick
    /// recovering a failed camera item.
    private func reconcileCamera(force: Bool = false) {
        guard !isSeated else { return }
        let hasVoice = model.stream?.resolvedCameraHasVoiceAudio ?? false
        let move = WatchCameraStreamSwap.next(
            attached: cameraAttached,
            latestUrl: cameraUrlWorthStreaming(
                cameraHlsUrl: model.stream?.cameraHlsUrl,
                hasVoiceAudio: hasVoice,
                layoutOffered: cameraLayoutIsOffered,
                layout: cameraPref.layout
            ),
            hasVideo: model.stream?.resolvedCameraHasVideo ?? true,
            hasVoiceAudio: hasVoice,
            failed: force,
            now: Date()
        )
        switch move {
        case .keep:
            return
        case .detach:
            tearDownCamera()
        case .attach(let url):
            attachCamera(url: url)
        }
    }

    private func attachCamera(url: String) {
        guard let resolved = liveStreamURL(
            hlsUrl: url, apiBaseURL: Backend.current.apiBaseURL
        ) else { return }
        cameraPlayer?.pause()
        let item = AVPlayerItem(url: resolved)
        let player = AVPlayer(playerItem: item)
        // Silent, unless this is the one shape where the camera carries the
        // presenter's own voice ("separada") -- see `LiveHlsStream`'s doc.
        // The audience's sound otherwise comes off the FILM's player, which
        // is the only place it is mixed; a second audible source a couple of
        // seconds out of step with the first is worse than silence.
        player.isMuted = !(model.stream?.resolvedCameraHasVoiceAudio ?? false)
        player.automaticallyWaitsToMinimizeStalling = true
        cameraAttached = CameraAttachedStream(
            sessionKey: cameraSessionKey(url), attachedAt: Date()
        )
        cameraPlayer = player
        // NOT `cameraFailureAttempt = 0` HERE (Farol review, PR 833, second
        // pass). A rebuild triggered BY a failure is itself an attach, and
        // resetting the backoff on every attach is exactly what made a
        // replacement that fails again land back at attempt zero -- a tight
        // loop bounded only by the 1s watchdog tick, hammering the same HLS
        // endpoint every second instead of backing off. The attempt counter
        // only resets once `checkCameraHealth` has seen this attach actually
        // hold for a while; `cameraHealthyTicks` below is what proves that.
        player.play()
    }

    private func tearDownCamera() {
        cameraPlayer?.pause()
        cameraPlayer = nil
        cameraAttached = nil
        // A deliberate teardown (hidden by the viewer, the stage leaving the
        // screen) is a clean slate, unlike an attach: there is no camera
        // running for a backoff to apply to, and if one starts again later
        // it deserves a fresh attempt at the fast end of the schedule.
        cameraFailureAttempt = 0
        cameraFailureNextRetryAt = nil
        cameraHealthyTicks = 0
        cameraLastPosition = nil
    }

    /**
     THE CAMERA GETS RECOVERY TOO (Farol review, PR 833), ON A REAL BACKOFF
     (Farol review, PR 833, second pass).

     Silent, like every other camera failure on this stage: no card, no
     retry button, the corner just comes back on its own once a reattach
     lands. Unlike the film, a hard `AVPlayerItem` failure here has no
     server to ask -- the camera never mints its own session, so there is no
     fresher URL to fetch, only the one `reconcileCamera` already knows.
     `force: true` on an unchanged session still reattaches (see
     `WatchCameraStreamSwap`), which is exactly what a stuck item needs: a
     brand new `AVPlayerItem` on the same playlist, past whatever segment
     killed the last one.

     THE BUG THE FIRST VERSION OF THIS HAD. It debounced on a timestamp that
     `attachCamera` cleared on every attach -- including the very reattach
     this function had just triggered. A replacement that failed again
     immediately (a genuinely broken camera egress, not a one-off blip) was
     therefore rebuilt again on the very next 1s watchdog tick, and the tick
     after that, for as long as it kept failing: a tight loop hammering the
     same HLS endpoint roughly once a second instead of backing off from it.

     THE FIX. `cameraFailureAttempt` and `cameraFailureNextRetryAt` survive
     attach on purpose (see the comment in `attachCamera`) and only grow
     while failures keep happening: `WatchCameraFailureBackoff.delay` is
     2s, 4s, 8s... doubling up to a minute, jittered so a run of viewers
     whose cameras failed together do not all retry in the same instant.
     They reset to zero only once THIS attach has proven itself --
     `cameraHealthyTicks` counting `WatchCameraFailureBackoff.healthyTicksToReset`
     straight seconds of a genuinely advancing playhead, the same "confirmed,
     not merely reported" standard the film's own `recoveryConfirmTicks`
     uses and for the same reason: a decoder can sit at a non-failed status
     while wedged.
     */
    private func checkCameraHealth() {
        guard let item = cameraPlayer?.currentItem else {
            cameraHealthyTicks = 0
            cameraLastPosition = nil
            return
        }
        let now = Date()
        if item.status == .failed {
            cameraHealthyTicks = 0
            cameraLastPosition = nil
            guard WatchCameraFailureBackoff.isDue(
                nextRetryAt: cameraFailureNextRetryAt, now: now
            ) else { return }
            let wait = WatchCameraFailureBackoff.delay(
                attempt: cameraFailureAttempt, jitter: { Double.random(in: 0...1) }
            )
            cameraFailureNextRetryAt = now.addingTimeInterval(wait)
            cameraFailureAttempt += 1
            reconcileCamera(force: true)
            return
        }
        guard cameraFailureAttempt > 0 || cameraFailureNextRetryAt != nil else {
            // Nothing has failed this camera yet; no backoff to earn back.
            return
        }
        let position = cameraPlayer?.currentTime().seconds ?? 0
        let advanced = cameraLastPosition.map { position > $0 } ?? false
        cameraLastPosition = position
        guard advanced else {
            cameraHealthyTicks = 0
            return
        }
        cameraHealthyTicks += 1
        if cameraHealthyTicks >= WatchCameraFailureBackoff.healthyTicksToReset {
            cameraFailureAttempt = 0
            cameraFailureNextRetryAt = nil
        }
    }

    /// Re-tune the item that is already playing.
    ///
    /// Both of these are live properties, so a viewer changing rung mid film
    /// costs a rendition switch and not a re-buffer. Nothing here goes near
    /// `attach`, which is the difference between a quality picker and a
    /// restart. A no-op (same ceiling the item already has) must not touch
    /// the properties at all: writing `preferredMaximumResolution` is what
    /// pauses the picture for about a second, even when the number did not
    /// change.
    private func applyQuality(trigger: WatchQualityRetune.Trigger) {
        guard let player, let item = player.currentItem else { return }
        let alreadyPlaying = WatchQualityRetune.hasStartedPlayback(
            rate: player.rate, timeControlStatus: player.timeControlStatus
        )
        guard WatchQualityRetune.shouldWrite(
            alreadyPlaying: alreadyPlaying, trigger: trigger
        ) else { return }
        // A remembered pin from a broadcast with a different ladder falls back
        // to Auto rather than to the nearest rung. See `WatchLadder.limits`.
        let effective = ladder.contains(choice) ? choice : .auto
        let resolution = ladder.resolutionCap(
            surfacePixels: surfacePixels, choice: effective
        )
        let peak = ladder.limits(for: effective).peakBitRate
        guard item.preferredMaximumResolution != resolution
            || item.preferredPeakBitRate != peak
        else { return }
        item.preferredMaximumResolution = resolution
        item.preferredPeakBitRate = peak
        // The switch itself can drop the player into `.paused` for a second.
        // `play()` on the same item keeps that from looking like a pause.
        // Never `attach` from this path. A person who asked (pin / theater)
        // also gets a seek back into the live window, because the write is
        // the same rendition switch that froze Auto a few seconds in.
        if userWantsPlayback {
            if trigger == .pin || trigger == .fullscreen,
               let window = Self.liveWindow(of: item) {
                seek(to: WatchLiveEdge.target(in: window, segmentSeconds: edge.segmentSeconds))
                return
            }
            seekingUntil = Date().addingTimeInterval(2)
            player.play()
        }
    }

    private func togglePlay() {
        if userWantsPlayback {
            pauseFromUser()
        } else {
            playFromUser()
        }
        chrome.reveal(at: Date())
    }

    /// The chrome, the lock screen and Now Playing all come through here,
    /// so a tap on pause is one bit of state, not three.
    private func pauseFromUser() {
        userWantsPlayback = false
        player?.pause()
        isPlaying = false
    }

    private func playFromUser() {
        userWantsPlayback = true
        isPlaying = true
        resumeWantedPlayback()
    }

    /// Start the picture again because the viewer still wants it.
    ///
    /// `play()` cannot help a playhead the ten second window has already
    /// slid past, so a position behind the oldest segment (or far enough
    /// behind live that the badge would offer) seeks first. A tap on pause
    /// never reaches here: `userWantsPlayback` is false then.
    private func resumeWantedPlayback() {
        guard let player, userWantsPlayback else { return }
        if let item = player.currentItem, let window = Self.liveWindow(of: item) {
            let position = player.currentTime().seconds
            if position.isFinite,
               position < window.start
                || WatchLiveEdge.isBehindLive(position: position, window: window) {
                seek(to: WatchLiveEdge.jumpTarget(in: window, segmentSeconds: edge.segmentSeconds))
                return
            }
        }
        player.play()
    }


    private func jumpToLive() {
        guard let item = player?.currentItem,
              let window = Self.liveWindow(of: item)
        else { return }
        userWantsPlayback = true
        isPlaying = true
        seek(to: WatchLiveEdge.jumpTarget(in: window, segmentSeconds: edge.segmentSeconds))
        chrome.reveal(at: Date())
    }

    /// Land inside the window and start again.
    ///
    /// `toleranceBefore: .zero` because everything before the target is closer
    /// to the sliding back edge, which is the direction that made this
    /// necessary. Forward tolerance is a segment: landing on the next segment
    /// boundary is free, and asking for frame accuracy on a live stream buys
    /// nothing and costs a decode from the previous keyframe.
    private func seek(to target: Double) {
        guard let player else { return }
        let now = Date()
        guard now >= seekingUntil else { return }
        seekingUntil = now.addingTimeInterval(2)
        player.seek(
            to: CMTime(seconds: target, preferredTimescale: 600),
            toleranceBefore: .zero,
            toleranceAfter: CMTime(seconds: 2, preferredTimescale: 600)
        )
        if userWantsPlayback { player.play() }
    }

    /// `AVPlayerItemPlaybackStalled`: media behind, nothing in front.
    /// Same recover as the web: jump one segment behind live, then play.
    private func handlePlaybackStalled(_ note: Notification) {
        guard userWantsPlayback else { return }
        guard let stalled = note.object as? AVPlayerItem,
              stalled === player?.currentItem
        else { return }
        guard let window = Self.liveWindow(of: stalled) else {
            player?.play()
            return
        }
        seek(to: WatchLiveEdge.jumpTarget(in: window, segmentSeconds: edge.segmentSeconds))
    }

    /// Resume after the session came back, and only if we were playing when it
    /// went. A viewer who had paused the film before the call came in should
    /// still have it paused afterwards.
    private func handleInterruption(_ note: Notification) {
        guard let raw = note.userInfo?[AVAudioSessionInterruptionTypeKey] as? UInt,
              let type = AVAudioSession.InterruptionType(rawValue: raw)
        else { return }
        switch type {
        case .began:
            wasPlayingBeforeInterruption = userWantsPlayback
        case .ended:
            guard wasPlayingBeforeInterruption, userWantsPlayback, player != nil else { return }
            wasPlayingBeforeInterruption = false
            let options = (note.userInfo?[AVAudioSessionInterruptionOptionKey] as? UInt)
                .map(AVAudioSession.InterruptionOptions.init(rawValue:))
            // No options key at all is the case where the system has no
            // opinion; a key that says do not resume is one that does, and it
            // outranks ours.
            guard options?.contains(.shouldResume) ?? true else {
                // The system said stay paused. Do not let the unexpected
                // pause path unpause it on the next tick.
                userWantsPlayback = false
                isPlaying = false
                return
            }
            WatchAudioSession.activate()
            resumeWantedPlayback()
        @unknown default:
            break
        }
    }

    /// The phone decided. A film worth turning the phone for is not worth a
    /// control, and a collapsed strip is not worth filling the screen with.
    private func applyOrientation() {
        let landscape = WatchOrientation.isLandscape && model.phase == .live
            && !isSeated && !isMinimised
        guard landscape != isLandscape else { return }
        if landscape {
            // The screen's own pixels, before the surface has been laid out at
            // its new size. `applyQuality(trigger: .fullscreen)` is one of only
            // two writes allowed onto a PLAYING item, and it reads
            // `surfacePixels`: without this it would write the STRIP's ceiling
            // onto a full screen, which is a rendition switch on a live window,
            // which is the freeze this file keeps warning about.
            let full = WatchOrientation.screenPixels
            if full.width > 0, full.height > 0 { surfacePixels = full }
        }
        isLandscape = landscape
        chrome.reveal(at: Date())
    }

    private func tearDown() {
        isLandscape = false
        player?.pause()
        player = nil
        attached = nil
        stall = WatchStallWatch()
        edge = WatchLiveEdge()
        recovery.reset()
        recoveryClearedAttachedAt = nil
        healthyPlaybackTicks = 0
        lastHealthCheckPosition = nil
        ladder = .empty
        behindLive = false
        delaySeconds = nil
        effectiveLines = nil
        surfacePixels = .zero
        wasPlayingBeforeInterruption = false
        isPlaying = false
        userWantsPlayback = true
        seekingUntil = .distantPast
        chrome = WatchChromeClock()
        chromeInsets = .init()
        picturePlane.show(nil, pip: pip)
        pip.attach(nil)
        WatchNowPlaying.end()
        WatchAudioSession.deactivate()
        tearDownCamera()
        // NOT `deadRetryAttempt = 0` HERE (Farol review, PR 833). This runs
        // on every `.failed` entry too (`.onChange(of: model.phase)` calls
        // `tearDown()` for any non-`.live` phase), so resetting it here
        // rewound the backoff to its first step on every single automatic
        // retry -- the counter never grew past 8-15s no matter how many
        // times the stream kept failing. The only two places that may
        // legitimately call this a fresh episode are a confirmed healthy
        // attach (`watchdog()`, once `healthyPlaybackTicks` proves it) and
        // actually leaving the screen (`onDisappear`, below).
    }
}
