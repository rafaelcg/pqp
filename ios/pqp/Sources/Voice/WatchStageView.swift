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

 WHAT THE SYSTEM OWNS AND WHAT THIS DOES. Inside the video rectangle is
 `AVPlayerViewController` (see `WatchVideoSurface`): the transport bar that
 fades while you watch, the expand button that takes a film fullscreen in
 landscape, AirPlay, Picture in Picture. Under it is a strip this file draws,
 carrying the three things the system has no opinion about and a watch party
 needs: that this is live and how far behind, how many people are here, and
 which rung is being decoded.
 */
struct WatchStageView: View {
    @Environment(SessionStore.self) private var session
    @Environment(VoiceModel.self) private var voice

    let channel: Channel
    @State private var model = WatchModel()
    @State private var player: AVPlayer?
    /// The URL currently handed to the player, and when. `WatchStreamSwap`
    /// reads it to decide whether the freshest frame is worth a re-attach.
    @State private var attached: AttachedStream?
    @State private var stall = WatchStallWatch()
    @State private var edge = WatchLiveEdge()
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

    /// The pinned rung, in lines. Zero is Auto.
    ///
    /// DEVICE-LOCAL and remembered, for the same reason `VideoQualitySettings`
    /// is: what this phone's link can carry is a fact about this phone. It is
    /// not that class, though, because that one is what this phone SENDS.
    @AppStorage("pqp.watchQuality") private var pinnedLines = 0

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
        .task(id: channel.id) { await model.open(channelId: channel.id, session: session) }
        .task { await watchdog() }
        .onDisappear {
            tearDown()
            model.close()
        }
        .onChange(of: isSeated, initial: true) { _, seated in
            model.isSeated = seated
            if seated { tearDown() }
        }
        // Runs on every `channel-live`, which is twice a minute for the whole
        // party, because the stamped URL is different every time. The swap
        // rule is what stops that being a re-buffer every thirty seconds, and
        // it is also what performs the hourly token renewal: at fifty minutes
        // the very next frame is the one that gets attached.
        .onChange(of: model.stream, initial: true) { _, _ in reconcile() }
        .onChange(of: model.phase) { _, phase in
            if phase != .live { tearDown() }
        }
        .onChange(of: pinnedLines) { _, _ in applyQuality() }
        .onChange(of: surfacePixels) { _, _ in applyQuality() }
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
            guard let player, attached != nil else { continue }
            guard let item = player.currentItem else { continue }
            if item.status == .failed {
                model.playbackFailed(
                    String(localized: "The connection to the stream dropped.")
                )
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

            let remedy = edge.tick(
                position: position,
                window: window,
                // `rate` is the INTENT. It stays at 1 while the player waits
                // for media and drops to 0 only when something paused it, so
                // this is what stops a rejoin fighting a viewer who tapped
                // pause on the system transport bar.
                wantsPlayback: player.rate > 0,
                isWaiting: player.timeControlStatus == .waitingToPlayAtSpecifiedRate,
                now: now
            )
            if case .rejoin(let target) = remedy { seek(to: target) }

            let stalled = stall.tick(
                position: position,
                isPlaying: player.timeControlStatus == .playing,
                now: now
            )
            if stalled { reconcile(force: true) }
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
            if channel.isWatchParty {
                notice(
                    icon: "movieclapper.fill",
                    title: "Watch party",
                    message: "Nobody is streaming yet. When it starts, it shows up here."
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
    private var picture: some View {
        VStack(spacing: 0) {
            if !isMinimised {
                ZStack {
                    Color.black
                    if let player {
                        WatchVideoSurface(player: player) { pixels in
                            surfacePixels = pixels
                        }
                    } else {
                        // Between the frame arriving and the first segment
                        // decoding. Seconds, and honest about which of the two
                        // waits this is.
                        VStack(spacing: 8) {
                            ProgressView().tint(Palette.signal)
                            Text("Connecting to the stream")
                                .font(Typography.callout)
                                .foregroundStyle(Palette.paperMuted)
                        }
                    }
                }
                .aspectRatio(16 / 9, contentMode: .fit)
            }
            liveBar
        }
        .background(Palette.inkDeep)
    }

    // MARK: - The strip

    private var liveBar: some View {
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
            if ladder.isWorthOffering { qualityMenu }
            collapseButton
        }
        .padding(.horizontal, Metrics.hPadding)
        .padding(.vertical, 9)
        .background(Palette.surface)
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
            HStack(spacing: 4) {
                Image(systemName: "slider.horizontal.3")
                    .font(.system(size: 11, weight: .semibold))
                Text(WatchQualityLabel.text(choice: choice, effectiveLines: effectiveLines))
                    .font(Typography.caption)
            }
            .foregroundStyle(Palette.paperSubtle)
            .padding(.horizontal, 8)
            .padding(.vertical, 4)
            .background(
                Capsule().fill(Palette.surfaceRaised)
            )
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
                Button("Try again") { model.retry(); reconcile(force: true) }
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
        let next = AVPlayer(playerItem: item)
        // Without this the picture is suspended the moment the app leaves the
        // screen, which is most of a watch party: a phone in a pocket, a phone
        // face down on the table. `audio` is already in `UIBackgroundModes`,
        // so the sound keeps coming and the video resumes on return.
        next.audiovisualBackgroundPlaybackPolicy = .continuesIfPossible
        // Left alone deliberately. Turning this off makes `play()` start on
        // whatever is buffered, which is tempting on a ten second window and
        // is also a change nothing available here can measure: it trades
        // stalls for a faster start and only a real phone on a real link can
        // say which way that lands. `WatchLiveEdge` handles the state it would
        // have been aimed at.
        next.automaticallyWaitsToMinimizeStalling = true
        player = next
        attached = AttachedStream(startedAt: stream.startedAt, attachedAt: Date())
        stall = WatchStallWatch()
        edge = WatchLiveEdge()
        behindLive = false
        delaySeconds = nil
        effectiveLines = nil
        ladder = .empty
        next.play()
        WatchNowPlaying.begin(
            title: channel.name,
            subtitle: nil,
            onPlay: { next.play() },
            onPause: { next.pause() }
        )
        Task {
            let published = await WatchVariants.load(from: asset)
            // A frame that arrived while the master was being parsed may have
            // replaced the player already. Applying this ladder to a different
            // broadcast would offer rungs it does not serve.
            guard player === next else { return }
            ladder = published
            applyQuality()
        }
    }

    /// Re-tune the item that is already playing.
    ///
    /// Both of these are live properties, so a viewer changing rung mid film
    /// costs a rendition switch and not a re-buffer. Nothing here goes near
    /// `attach`, which is the difference between a quality picker and a
    /// restart.
    private func applyQuality() {
        guard let item = player?.currentItem else { return }
        // A remembered pin from a broadcast with a different ladder falls back
        // to Auto rather than to the nearest rung. See `WatchLadder.limits`.
        let effective = ladder.contains(choice) ? choice : .auto
        item.preferredMaximumResolution = ladder.resolutionCap(
            surfacePixels: surfacePixels, choice: effective
        )
        item.preferredPeakBitRate = ladder.limits(for: effective).peakBitRate
    }

    private func jumpToLive() {
        guard let item = player?.currentItem,
              let window = Self.liveWindow(of: item)
        else { return }
        seek(to: WatchLiveEdge.target(in: window))
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
        player.seek(
            to: CMTime(seconds: target, preferredTimescale: 600),
            toleranceBefore: .zero,
            toleranceAfter: CMTime(seconds: 2, preferredTimescale: 600)
        )
        player.play()
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
            wasPlayingBeforeInterruption = (player?.rate ?? 0) > 0
        case .ended:
            guard wasPlayingBeforeInterruption, player != nil else { return }
            wasPlayingBeforeInterruption = false
            let options = (note.userInfo?[AVAudioSessionInterruptionOptionKey] as? UInt)
                .map(AVAudioSession.InterruptionOptions.init(rawValue:))
            // No options key at all is the case where the system has no
            // opinion; a key that says do not resume is one that does, and it
            // outranks ours.
            guard options?.contains(.shouldResume) ?? true else { return }
            WatchAudioSession.activate()
            player?.play()
        @unknown default:
            break
        }
    }

    private func tearDown() {
        player?.pause()
        player = nil
        attached = nil
        stall = WatchStallWatch()
        edge = WatchLiveEdge()
        ladder = .empty
        behindLive = false
        delaySeconds = nil
        effectiveLines = nil
        surfacePixels = .zero
        wasPlayingBeforeInterruption = false
        WatchNowPlaying.end()
        WatchAudioSession.deactivate()
    }
}
