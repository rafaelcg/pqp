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
    @State private var isMinimised = false

    private var isSeated: Bool { voice.isLive && voice.channelId == channel.id }

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
    }

    /**
     The two failures `AVPlayer` will not interrupt anybody about.

     `AVPlayerItem.status == .failed` is a real error the player already knows,
     sitting in a property nothing polls. A frozen picture is not an error at
     all (see `WatchStallWatch`) and only a clock finds it. One second is the
     tick because the segments are two, so nothing here reacts faster than the
     stream can legitimately move.

     A stall reattaches rather than giving up, and it reattaches to the FRESHEST
     url, which is at most thirty seconds old. That covers the ordinary evening
     cases in one move: the tunnel, the lift, the handover from wifi to mobile.
     `failed` is where a viewer is told, and only after the player itself has
     declared it.
     */
    private func watchdog() async {
        while !Task.isCancelled {
            try? await Task.sleep(for: .seconds(1))
            guard let player, attached != nil else { continue }
            if player.currentItem?.status == .failed {
                model.playbackFailed(
                    String(localized: "The connection to the stream dropped.")
                )
                continue
            }
            let stalled = stall.tick(
                position: player.currentTime().seconds,
                isPlaying: player.timeControlStatus == .playing,
                now: Date()
            )
            if stalled { reconcile(force: true) }
        }
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

    private var picture: some View {
        VStack(spacing: 0) {
            ZStack {
                Color.black
                if let player {
                    VideoPlayer(player: player)
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
            .frame(maxHeight: isMinimised ? 0 : .infinity)
            .clipped()

            liveBar
        }
        .background(Palette.inkDeep)
    }

    private var liveBar: some View {
        HStack(spacing: 8) {
            Circle()
                .fill(Palette.danger)
                .frame(width: 7, height: 7)
            Text("LIVE")
                .font(Typography.label)
                .tracking(0.8)
                .foregroundStyle(Palette.paper)
            Text(viewerLabel)
                .font(Typography.caption)
                .foregroundStyle(Palette.paperMuted)
            Spacer()
            Button {
                isMinimised.toggle()
            } label: {
                Image(systemName: isMinimised ? "chevron.down" : "chevron.up")
                    .font(.system(size: 13, weight: .semibold))
                    .foregroundStyle(Palette.paperMuted)
            }
            .accessibilityLabel(isMinimised ? "Show the stream" : "Hide the stream")
        }
        .padding(.horizontal, Metrics.hPadding)
        .padding(.vertical, 8)
        .background(Palette.surface)
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
        let next = AVPlayer(url: url)
        // Without this the picture is suspended the moment the app leaves the
        // screen, which is most of a watch party: a phone in a pocket, a phone
        // face down on the table. `audio` is already in `UIBackgroundModes`,
        // so the sound keeps coming and the video resumes on return.
        next.audiovisualBackgroundPlaybackPolicy = .continuesIfPossible
        // A live playlist has a live edge; the player should sit on it rather
        // than start wherever the buffer happens to begin.
        next.automaticallyWaitsToMinimizeStalling = true
        player = next
        attached = AttachedStream(startedAt: stream.startedAt, attachedAt: Date())
        stall = WatchStallWatch()
        next.play()
        WatchNowPlaying.begin(
            title: channel.name,
            subtitle: nil,
            onPlay: { next.play() },
            onPause: { next.pause() }
        )
    }

    private func tearDown() {
        player?.pause()
        player = nil
        attached = nil
        stall = WatchStallWatch()
        WatchNowPlaying.end()
        WatchAudioSession.deactivate()
    }
}
