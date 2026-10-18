import AVFoundation
import SwiftUI
import UIKit

/// The story viewer, full screen.
///
/// Tap right / left: next / previous story. Hold: pause (the chrome fades
/// after 250 ms). Swipe sideways: next / previous person, a deck rather than
/// a cube (the next card slides over, the current one recedes and dims).
/// Swipe down: close. Swipe up on your own story: who saw it.
///
/// Under Reduce Motion: no deck and no recede, a crossfade between people and
/// between stories; the progress bars still run, because a progress bar is
/// information, not decoration.
struct StoryViewer: View {
    @Environment(SessionStore.self) private var session
    @Environment(VoiceModel.self) private var voice
    @Environment(CallRatingModel.self) private var ratings
    @Environment(\.dismiss) private var dismiss
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.scenePhase) private var scenePhase

    let launch: StoryViewerLaunch
    /// The stories watched (ids), so the strip can turn rings seen on close.
    let onClose: (Set<String>) -> Void

    @State private var playback: StoryPlayback
    @State private var stories: [String: Story] = [:]
    /// Ids the server answered without (expired, removed, no longer visible).
    @State private var gone: Set<String> = []
    @State private var progress: Double = 0
    @State private var holding = false
    @State private var chromeHidden = false
    @State private var replyText = ""
    @FocusState private var replyFocused: Bool
    /// The footer's top edge in the card, for fitting a text story above it.
    @State private var footerTop: CGFloat = .infinity
    @State private var headerBottom: CGFloat = 0
    @State private var drag: CGSize = .zero
    @State private var showingViewers = false
    @State private var showingMenu = false
    @State private var reportTarget: ReportTarget?
    @State private var profileSubject: ProfileSubject?
    /// For the call sticker's server icon: fetched once, only when a story on
    /// screen has a call layer.
    @State private var serversById: [String: Server] = [:]
    @State private var confirming: PendingAction?
    @State private var flash: String?
    @State private var flyingReaction: String?
    @State private var watched: Set<String> = []
    @State private var pendingViews: Set<String> = []
    @State private var player: AVPlayer?
    /// The story `player` plays. A video's bar only follows a player that
    /// belongs to the story on screen.
    @State private var playerStoryId: String?
    /// A story's video has its first frame (a photo has none to wait for).
    @State private var frameIds: Set<String> = []
    /// Every picture a story draws is in memory, decoded.
    @State private var assetIds: Set<String> = []
    /// Stories shown, whole: all their assets (and a video's first frame) were
    /// ready, and they appeared in ONE frame. The timer runs from there.
    @State private var revealedIds: Set<String> = []
    /// The servers list is in (a call card needs the server's picture).
    @State private var serversLoaded = false
    /// The whole story's opacity: 0 for the instant it is revealed, then up in
    /// a short fade (the base, the layers and the card together, as one
    /// picture). 1 the rest of the time, so moving between stories that are
    /// ready is a cut in a single frame.
    @State private var revealOpacity = 1.0
    /// The story fading in: its placeholder stays under it until it is whole.
    @State private var fadingId: String?
    /// The story whose first frame is late (a blurred placeholder and a spinner).
    @State private var waitingId: String?
    /// Set once the viewer is going away: nothing advances any more.
    @State private var closing = false
    @State private var muted = true
    @State private var error: String?
    @State private var handlerKey = "story-viewer-" + UUID().uuidString
    /// The reply being sent and its nonce. Retrying the same words after a
    /// failure reuses the nonce, so a reply that did land is not sent twice.
    @State private var replyAttempt: (storyId: String, text: String, nonce: String)?

    enum PendingAction: Identifiable {
        case delete(Story)
        case remove(Story, serverId: String, serverName: String)
        var id: String {
            switch self {
            case .delete(let story): "delete-\(story.id)"
            case .remove(let story, let serverId, _): "remove-\(story.id)-\(serverId)"
            }
        }
    }

    init(launch: StoryViewerLaunch, onClose: @escaping (Set<String>) -> Void) {
        self.launch = launch
        self.onClose = onClose
        let playback = StoryPlayback(people: launch.people, startPerson: launch.startPerson)
        _playback = State(initialValue: playback)
        // Stories the tray already read: the first one opens with no round trip.
        var known: [String: Story] = [:]
        for id in playback.prefetchIds + playback.windowIds {
            if let story = StoryPreloader.shared.cachedStory(id) { known[id] = story }
        }
        _stories = State(initialValue: known)
    }

    private var current: Story? { playback.currentId.flatMap { stories[$0] } }
    private var paused: Bool { holding || replyFocused || showingViewers || showingMenu || reportTarget != nil || confirming != nil || profileSubject != nil }

    var body: some View {
        GeometryReader { geometry in
            ZStack {
                Color.black.ignoresSafeArea()
                card(size: geometry.size)
                    .offset(x: drag.width, y: max(0, drag.height))
                    .scaleEffect(reduceMotion ? 1 : dragScale(geometry.size))
                    .clipShape(RoundedRectangle(cornerRadius: drag == .zero ? 0 : 20, style: .continuous))
            }
            .contentShape(Rectangle())
            .gesture(dragGesture(size: geometry.size))
        }
        .statusBarHidden()
        .task(id: playback.currentId) { await storyChanged() }
        .task { await clock() }
        .task { await flushViewsLoop() }
        // A story staff removed (or its author deleted) leaves an open viewer
        // at once: `removedStoryIds` rides the `stories-update` frame.
        .onAppear {
            StoryMetrics.mark("viewer.open")
            session.eventHandlers[handlerKey] = { event in
                guard case .storiesUpdate(let update) = event, !update.removedStoryIds.isEmpty else { return }
                dropRemoved(Set(update.removedStoryIds))
            }
        }
        .onDisappear {
            session.eventHandlers.removeValue(forKey: handlerKey)
            Task { await flushViews() }
            player?.pause()
            StoryPreloader.shared.clearWindow()
            onClose(watched)
        }
        .sheet(isPresented: $showingViewers) {
            if let current {
                StoryViewersSheet(story: current) { action in
                    showingViewers = false
                    confirming = action
                }
                .presentationDetents([.medium, .large])
                .presentationBackground(Palette.ink)
            }
        }
        .sheet(item: $reportTarget) { target in
            ReportSheet(target: target)
        }
        .sheet(item: $profileSubject) { subject in
            UserProfileSheet(subject: subject, onOpenConversation: { _, _ in }, server: nil)
        }
        .task(id: current?.id) { await prepareReveal() }
        // The call card is a live roster: it follows the room while the story
        // is open, held or not.
        .task(id: callWatchId) { await watchCall() }
        .confirmationDialog(
            confirmTitle,
            isPresented: Binding(get: { confirming != nil }, set: { if !$0 { confirming = nil } }),
            titleVisibility: .visible
        ) {
            if let confirming {
                Button(confirmButton(confirming), role: .destructive) {
                    Task { await run(confirming) }
                }
            }
            Button("Cancel", role: .cancel) { confirming = nil }
        }
        .confirmationDialog("", isPresented: $showingMenu, titleVisibility: .hidden) {
            menuButtons
        }
    }

    // MARK: - The card

    @ViewBuilder
    private func card(size: CGSize) -> some View {
        ZStack {
            // The story stays where it is when the keyboard comes up for a
            // reply; only the footer rides the keyboard.
            // Until the story is whole, its place: the author's colour, never
            // a half-drawn picture.
            if let story = current, !isShown(story) || fadingId == story.id {
                placeholder(for: story)
                    .ignoresSafeArea()
                    .allowsHitTesting(false)
                    .transition(.identity)
            }

            content(size: size)
                .id(playback.currentId)
                .opacity(revealOpacity)
                .transition(.identity)
                .ignoresSafeArea(.keyboard)

            // Late (past 300 ms): a spinner on the placeholder.
            if let story = current, waitingId == story.id, !revealedIds.contains(story.id) {
                ProgressView().tint(.white)
                    .accessibilityIdentifier("story.loading")
            }

            // Tap zones and the hold, under the chrome so its buttons win.
            HStack(spacing: 0) {
                Color.clear.contentShape(Rectangle())
                    .frame(width: size.width * 0.3)
                    .onTapGesture { previous() }
                Color.clear.contentShape(Rectangle())
                    .onTapGesture { next() }
            }
            .onLongPressGesture(minimumDuration: 0.25, maximumDistance: 20) {
                // Ended: released after a hold.
            } onPressingChanged: { pressing in
                setHolding(pressing)
            }
            // The tap zones are invisible to VoiceOver, so the same moves are
            // offered as actions and as swipe up / down (adjustable).
            .accessibilityElement(children: .ignore)
            .accessibilityLabel(Text("Story"))
            .accessibilityAdjustableAction { direction in
                switch direction {
                case .increment: next()
                case .decrement: previous()
                @unknown default: break
                }
            }
            .accessibilityAction(named: Text("Next story")) { next() }
            .accessibilityAction(named: Text("Previous story")) { previous() }
            .accessibilityAction(named: Text(holding ? "Resume" : "Pause")) { setHolding(!holding) }

            // The author's layers, over the tap zones: only the call's door and
            // a mention take touches, everything else falls through to them.
            if let story = current, !story.layers.isEmpty, isShown(story) {
                StoryLayersOverlay(
                    story: story, size: size, callData: callSticker, reduceMotion: reduceMotion,
                    onJoin: { _ in
                        if let call = current?.call { Task { await join(call) } }
                    },
                    onMention: { userId in openProfile(userId) }
                )
                .id(story.id)
                .ignoresSafeArea(.keyboard)
                .opacity(replyFocused ? 0.35 : 1)
                .opacity(revealOpacity)
                .transition(.identity)
            }

            VStack(spacing: 0) {
                header
                    .opacity(chromeHidden ? 0 : 1)
                    .onGeometryChange(for: CGFloat.self) { $0.frame(in: .named("storyCard")).maxY } action: { headerBottom = $0 }
                Spacer(minLength: 0)
                // A server that predates layers has no call layer: the card
                // keeps its old place at the bottom.
                if let call = current?.call, current.map(isShown) == true,
                   !(current?.layers.contains { if case .call = $0.content { true } else { false } } ?? false) {
                    StoryCallCard(call: call) { Task { await join(call) } }
                        .padding(.horizontal, 24)
                        .padding(.bottom, 18)
                        .opacity(chromeHidden ? 0 : 1)
                }
                if let caption = current?.legacyCaption, current.map(isShown) == true {
                    Text(verbatim: caption)
                        .font(.system(size: 16, weight: .medium))
                        .foregroundStyle(.white)
                        .multilineTextAlignment(.center)
                        .padding(.horizontal, 14)
                        .padding(.vertical, 8)
                        .background(RoundedRectangle(cornerRadius: 10).fill(.black.opacity(0.45)))
                        .padding(.horizontal, 20)
                        .padding(.bottom, 14)
                        .opacity(chromeHidden ? 0 : 1)
                }
                footer
                    .opacity(chromeHidden ? 0 : 1)
                    // Measured in the card's coordinates: the words of a text
                    // story fit above it while the keyboard is up.
                    .onGeometryChange(for: CGFloat.self) { $0.frame(in: .named("storyCard")).minY } action: { footerTop = $0 }
            }

            if let flash {
                Text(verbatim: flash)
                    .font(Typography.bodyMedium)
                    .foregroundStyle(Palette.inkDeep)
                    .padding(.horizontal, 16)
                    .padding(.vertical, 8)
                    .background(Capsule().fill(Palette.signal))
                    .transition(.opacity)
                    .accessibilityIdentifier("story.flash")
            }
            if let flyingReaction {
                StoryReactionFlight(glyph: flyingReaction)
            }
        }
        .coordinateSpace(name: "storyCard")
        .animation(.easeOut(duration: 0.2), value: chromeHidden)
        .animation(.easeOut(duration: 0.2), value: flash)
    }

    @ViewBuilder
    private func content(size: CGSize) -> some View {
        if let story = current {
            StoryStageBase(
                story: story, player: player, size: size, revealed: isShown(story),
                onFirstFrame: {
                    frameIds.insert(story.id)
                    maybeReveal(story)
                },
                headerBottom: replyFocused ? headerBottom : nil,
                footerTop: replyFocused ? footerTop : nil
            )
                .accessibilityElement(children: story.isVideo ? .contain : .ignore)
                .accessibilityLabel(Text(verbatim: story.spokenDescription ?? (story.isText ? "" : String(localized: "Photo"))))
        } else if let id = playback.currentId, gone.contains(id) {
            Color.black.onAppear { next() }
        } else {
            ProgressView().tint(.white)
                .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
    }

    // MARK: - Layers

    /// The call layer's card: the live state the server answers for the
    /// story, with the server's name and icon.
    private func callSticker(_ layer: StoryLayer) -> StoryCallStickerData? {
        guard case .call(let serverId, let channelId) = layer.content,
              let story = current, let live = story.call, live.channelId == channelId
        else { return nil }
        let server = serversById[serverId]
        let named = story.audiences.compactMap { audience -> String? in
            if case .server(let id, let name) = audience, id == serverId { return name }
            return nil
        }.first
        return StoryCallStickerData(live: live, serverName: server?.name ?? named ?? "", serverIconUrl: server?.iconUrl)
    }

    private func openProfile(_ userId: String) {
        guard let story = current else { return }
        for layer in story.layers {
            if case .mention(let id, let user) = layer.content, id == userId, let user {
                profileSubject = ProfileSubject(id: user.id, displayName: user.displayName, tag: nil, avatarUrl: user.avatarUrl)
                return
            }
        }
    }

    /// The story whose card is being kept fresh: the one on screen, when it
    /// carries a call.
    private var callWatchId: String? {
        current.flatMap { StoryCallRefresh.watches($0) ? $0.id : nil }
    }

    /// Re-reads the open story on a slow beat and swaps in the roster when it
    /// changed. Nothing else about the story is touched, and a failed read
    /// just waits for the next beat.
    private func watchCall() async {
        guard let id = callWatchId else { return }
        var unchanged = 0
        while !Task.isCancelled {
            try? await Task.sleep(for: StoryCallRefresh.delay(unchanged: unchanged))
            guard !Task.isCancelled else { return }
            guard scenePhase == .active else { continue }
            guard let fresh = try? await session.api.stories(ids: [id]).first,
                  let old = stories[id], old.call != fresh.call else {
                unchanged += 1
                continue
            }
            stories[id]?.call = fresh.call
            unchanged = 0
        }
    }

    /// The server list, once: a call card draws the server's picture and name.
    private func loadServers() async {
        guard !serversLoaded else { return }
        if let list = try? await session.api.servers() {
            serversById = Dictionary(uniqueKeysWithValues: list.map { ($0.id, $0) })
        }
        serversLoaded = true
    }

    private func placeholder(for story: Story) -> some View {
        let hue = Avatar.hue(seed: story.author.id)
        return LinearGradient(
            colors: [Color(hue: hue, saturation: 0.45, brightness: 0.30), Color(hue: hue, saturation: 0.55, brightness: 0.12)],
            startPoint: .top, endPoint: .bottom
        )
        .accessibilityHidden(true)
    }

    private var header: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 3) {
                ForEach(0..<playback.countInPerson, id: \.self) { index in
                    StoryProgressBar(fill: fill(for: index))
                }
            }
            HStack(spacing: 10) {
                if let story = current {
                    Avatar(name: story.author.displayName, seed: story.author.id, size: 32, url: story.author.avatarUrl)
                    VStack(alignment: .leading, spacing: 1) {
                        HStack(spacing: 6) {
                            Text(verbatim: story.isMine ? String(localized: "Your story") : story.author.displayName)
                                .font(.system(size: 14, weight: .semibold))
                                .foregroundStyle(.white)
                            if let at = story.publishedAt {
                                Text(verbatim: StoryRules.age(since: at))
                                    .font(.system(size: 12))
                                    .foregroundStyle(.white.opacity(0.7))
                            }
                        }
                        Text(verbatim: audienceLine(story))
                            .font(.system(size: 11))
                            .foregroundStyle(.white.opacity(0.7))
                            .lineLimit(1)
                    }
                }
                Spacer()
                // The sound, with the other controls (and only for a video):
                // a 44 pt target in the bar, not a button floating over the
                // picture. Above the tap zones, so it never moves the story.
                if current?.isVideo == true, let player {
                    Button {
                        muted.toggle()
                        player.isMuted = muted
                    } label: {
                        Image(systemName: muted ? "speaker.slash.fill" : "speaker.wave.2.fill")
                            .font(.system(size: 16, weight: .bold))
                            .foregroundStyle(.white)
                            .frame(width: 44, height: 44)
                            .contentShape(Rectangle())
                            .decorative()
                    }
                    .accessibilityLabel(Text(muted ? "Turn the sound on" : "Turn the sound off"))
                    .accessibilityIdentifier("story.mute")
                }
                Button { showingMenu = true } label: {
                    Image(systemName: "ellipsis")
                        .font(.system(size: 16, weight: .bold))
                        .foregroundStyle(.white)
                        .frame(width: 44, height: 44)
                        .contentShape(Rectangle())
                        .decorative()
                }
                .accessibilityLabel("More")
                .accessibilityIdentifier("story.menu")
                Button { close() } label: {
                    Image(systemName: "xmark")
                        .font(.system(size: 16, weight: .bold))
                        .foregroundStyle(.white)
                        .frame(width: 44, height: 44)
                        .contentShape(Rectangle())
                        .decorative()
                }
                .accessibilityLabel("Close")
                .accessibilityIdentifier("story.close")
            }
        }
        .padding(.horizontal, 12)
        .padding(.top, 8)
        .background(
            LinearGradient(colors: [.black.opacity(0.55), .clear], startPoint: .top, endPoint: .bottom)
                .ignoresSafeArea()
                .allowsHitTesting(false)
        )
    }

    @ViewBuilder
    private var footer: some View {
        if let story = current {
            VStack(spacing: 10) {
                if let error {
                    Text(verbatim: error)
                        .font(Typography.caption)
                        .foregroundStyle(Palette.danger)
                }
                if story.isMine {
                    ownFooter(story)
                } else {
                    if replyFocused {
                        reactionRow(story)
                            .transition(reduceMotion ? .opacity : .move(edge: .bottom).combined(with: .opacity))
                    }
                    replyRow(story)
                }
            }
            .padding(.horizontal, 12)
            .padding(.bottom, 8)
            .animation(reduceMotion ? .easeOut(duration: 0.15) : .spring(response: 0.3, dampingFraction: 0.85), value: replyFocused)
        }
    }

    private func ownFooter(_ story: Story) -> some View {
        Button { showingViewers = true } label: {
            HStack(spacing: 8) {
                Image(systemName: "eye").decorative()
                if let own = story.own, own.status != "live" {
                    Text("Processing the video…")
                } else {
                    Text("Seen by \(story.own?.viewCount ?? 0)")
                }
                Image(systemName: "chevron.up").font(.system(size: 11, weight: .bold)).decorative()
            }
            .font(.system(size: 14, weight: .semibold))
            .foregroundStyle(.white)
            .padding(.horizontal, 16)
            .padding(.vertical, 10)
            .background(Capsule().fill(.black.opacity(0.45)))
        }
        .accessibilityIdentifier("story.viewers")
    }

    @ViewBuilder
    private func replyRow(_ story: Story) -> some View {
        HStack(spacing: 8) {
            if story.viewer.canReply {
                TextField(
                    "",
                    text: $replyText,
                    prompt: Text("Reply to \(story.author.firstName)…").foregroundStyle(.white.opacity(0.6)),
                    axis: .horizontal
                )
                .focused($replyFocused)
                .foregroundStyle(.white)
                .submitLabel(.send)
                .onSubmit { Task { await reply(story) } }
                .padding(.horizontal, 14)
                .padding(.vertical, 11)
                .background(Capsule().strokeBorder(.white.opacity(0.5), lineWidth: 1))
                .accessibilityLabel(Text("Reply to \(story.author.firstName)…"))
                .accessibilityIdentifier("story.reply")
            } else if let line = StoryRules.replyBlockedLine(story.viewer.replyBlockedReason, name: story.author.firstName) {
                Text(verbatim: line)
                    .font(Typography.caption)
                    .foregroundStyle(.white.opacity(0.75))
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .accessibilityIdentifier("story.replyBlocked")
            } else {
                Spacer()
            }
            if replyText.trimmingCharacters(in: .whitespaces).isEmpty {
                quickReaction(story, key: "gg")
            } else {
                Button { Task { await reply(story) } } label: {
                    Image(systemName: "arrow.up")
                        .font(.system(size: 16, weight: .bold))
                        .foregroundStyle(Palette.inkDeep)
                        .frame(width: 40, height: 40)
                        .background(Circle().fill(Palette.signal))
                        .decorative()
                }
                .accessibilityLabel("Send")
            }
        }
    }

    private func reactionRow(_ story: Story) -> some View {
        HStack(spacing: 10) {
            ForEach(Array(StoryRules.reactions.enumerated()), id: \.offset) { offset, reaction in
                quickReaction(story, key: reaction.key)
                    .transition(reduceMotion ? .opacity : .scale(scale: 0.6).combined(with: .opacity))
                    .animation(reduceMotion ? nil : .spring(response: 0.3).delay(Double(offset) * 0.03), value: replyFocused)
            }
        }
        .padding(8)
        .background(Capsule().fill(.black.opacity(0.5)))
    }

    private func quickReaction(_ story: Story, key: String) -> some View {
        let glyph = StoryRules.glyph(for: key)
        let chosen = story.viewer.reaction == key
        return Button { Task { await react(story, key: key) } } label: {
            Text(verbatim: glyph)
                .font(.system(size: key == "gg" ? 13 : 22, weight: .heavy))
                .foregroundStyle(key == "gg" ? Palette.inkDeep : .white)
                .frame(width: 40, height: 40)
                .background(Circle().fill(key == "gg" ? Palette.signal : Color.clear))
                .overlay(Circle().strokeBorder(chosen ? Palette.signal : .clear, lineWidth: 2))
        }
        .accessibilityLabel(Text("React \(glyph)"))
        .accessibilityIdentifier("story.react.\(key)")
    }

    @ViewBuilder
    private var menuButtons: some View {
        if let story = current {
            if story.isMine {
                ForEach(story.viewer.canSaveToBau, id: \.self) { serverId in
                    Button("Save to Baú (\(serverName(serverId, in: story)))") {
                        Task { await saveToBau(story, serverId: serverId) }
                    }
                }
                Button("Delete", role: .destructive) { confirming = .delete(story) }
            } else {
                Button("Mute \(story.author.firstName)'s stories") {
                    Task { await mute(story) }
                }
                Button("Report story", role: .destructive) {
                    reportTarget = .story(id: story.id, authorName: story.author.displayName, serverId: reportServerId(story))
                }
                ForEach(story.viewer.canModerate, id: \.self) { serverId in
                    Button("Remove from \(serverName(serverId, in: story))", role: .destructive) {
                        confirming = .remove(story, serverId: serverId, serverName: serverName(serverId, in: story))
                    }
                }
            }
        }
    }

    private var confirmTitle: String {
        switch confirming {
        case .delete: String(localized: "Delete this story? It disappears for everyone now.")
        case .remove(_, _, let name): String(localized: "Remove from \(name)? Gone from there right away, and logged for staff.")
        case nil: ""
        }
    }

    private func confirmButton(_ action: PendingAction) -> String {
        switch action {
        case .delete: String(localized: "Delete")
        case .remove(_, _, let name): String(localized: "Remove from \(name)")
        }
    }

    // MARK: - Helpers

    private func fill(for index: Int) -> Double {
        if index < playback.index { return 1 }
        if index > playback.index { return 0 }
        return progress
    }

    private func audienceLine(_ story: Story) -> String {
        if case .server(let id, let name) = launch.scope,
           story.audiences.contains(where: { $0.serverId == id }) {
            return name
        }
        let names = story.audiences.map { audience -> String in
            switch audience {
            case .server(_, let name): name
            case .friends: String(localized: "Friends")
            }
        }
        return names.joined(separator: " · ")
    }

    private func serverName(_ id: String, in story: Story) -> String {
        for audience in story.audiences {
            if case .server(let serverId, let name) = audience, serverId == id { return name }
        }
        return ""
    }

    /// The audience the reporter saw it through: this server, or friends.
    private func reportServerId(_ story: Story) -> String? {
        if let id = launch.scope.serverId, story.audiences.contains(where: { $0.serverId == id }) { return id }
        return nil
    }

    private func dragScale(_ size: CGSize) -> CGFloat {
        guard drag.height > 0 else { return 1 }
        return max(0.85, 1 - drag.height / max(1, size.height) * 0.6)
    }

    private func setHolding(_ pressing: Bool) {
        holding = pressing
        if pressing {
            player?.pause()
            // A tap presses too: only a press still held after 250 ms is a
            // hold, and only then the buzz and the chrome fade. Under Reduce
            // Motion the chrome stays; the story pauses either way.
            Task {
                try? await Task.sleep(for: .milliseconds(250))
                guard holding else { return }
                UIImpactFeedbackGenerator(style: .light).impactOccurred()
                if !reduceMotion { chromeHidden = true }
            }
        } else {
            chromeHidden = false
            if current?.isVideo == true { player?.play() }
        }
    }

    // MARK: - Gestures

    private func dragGesture(size: CGSize) -> some Gesture {
        DragGesture(minimumDistance: 18)
            .onChanged { value in
                guard !replyFocused else { return }
                let horizontal = abs(value.translation.width) > abs(value.translation.height)
                if horizontal {
                    drag = CGSize(width: reduceMotion ? 0 : value.translation.width, height: 0)
                } else if value.translation.height > 0 {
                    drag = CGSize(width: 0, height: reduceMotion ? 0 : value.translation.height)
                }
            }
            .onEnded { value in
                let dx = value.translation.width
                let dy = value.translation.height
                let vx = value.predictedEndTranslation.width - dx
                if abs(dx) > abs(dy) {
                    let passed = abs(dx) > size.width * 0.35 || abs(vx) > 600
                    if passed {
                        let forward = dx < 0
                        let spring = Animation.spring(response: 0.32, dampingFraction: 0.86)
                        if reduceMotion {
                            withAnimation(.easeInOut(duration: 0.2)) { changePerson(forward: forward) }
                            drag = .zero
                        } else {
                            withAnimation(spring) { drag = CGSize(width: forward ? -size.width : size.width, height: 0) }
                            Task {
                                try? await Task.sleep(for: .milliseconds(220))
                                changePerson(forward: forward)
                                drag = CGSize(width: forward ? size.width * 0.3 : -size.width * 0.3, height: 0)
                                withAnimation(spring) { drag = .zero }
                            }
                        }
                    } else {
                        withAnimation(.spring(response: 0.32, dampingFraction: 0.86)) { drag = .zero }
                    }
                } else if dy > 120 || value.predictedEndTranslation.height > 800 {
                    close()
                } else if dy < -80, current?.isMine == true {
                    drag = .zero
                    showingViewers = true
                } else {
                    withAnimation(.spring(response: 0.3, dampingFraction: 0.86)) { drag = .zero }
                }
            }
    }

    private func changePerson(forward: Bool) {
        let moved = forward ? playback.nextPerson() : playback.previousPerson()
        if !moved && forward { close() }
        progress = 0
    }

    private func next() {
        StoryMetrics.mark("next.tap")
        withAnimation(reduceMotion ? nil : .easeOut(duration: 0.1)) {
            if !playback.next() { close() }
            progress = 0
        }
    }

    private func previous() {
        withAnimation(reduceMotion ? nil : .easeOut(duration: 0.1)) {
            playback.previous()
            progress = 0
        }
    }

    private func dropRemoved(_ ids: Set<String>) {
        gone.formUnion(ids)
        for id in ids { stories[id] = nil }
        if playback.currentIsAmong(ids) { next() }
    }

    private func close() {
        guard !closing else { return }
        closing = true
        player?.pause()
        dismiss()
    }

    /// Whether the story can be drawn right now, whole: revealed already, or a
    /// photo story whose every picture is in memory (preloaded), so that its
    /// very first frame is the finished story and not a placeholder for one.
    private func isShown(_ story: Story) -> Bool {
        // A video is shown once revealed (its player is its own memory).
        if story.isVideo { return revealedIds.contains(story.id) }
        // A photo story is shown when everything it draws is in memory NOW: one
        // whose pictures were evicted since (memory pressure) is not, and goes
        // back through the placeholder instead of filling in piece by piece.
        guard !StoryPreloadPlan.hasCallLayer(story) || serversLoaded else { return false }
        return StoryPreloadPlan.assets(of: story, serverIcon: { serversById[$0]?.iconUrl })
            .allSatisfy { StoryPreloader.shared.image(for: $0) != nil }
    }

    /// A story is shown WHOLE: its base, every placed photo and the drawing,
    /// the call card's pictures, and a video's first frame are all in memory,
    /// decoded, and then everything appears in one frame (a short fade). Until
    /// then there is only the placeholder, and a spinner once it is late. The
    /// timer starts at the reveal. A story that cannot be made whole in twenty
    /// seconds is skipped rather than holding the queue.
    private static let revealGiveUpMs = 20_000

    private func prepareReveal() async {
        guard let story = current else { return }
        waitingId = nil
        // Seen before: straight back if it is all still in memory, otherwise it
        // is made whole again from the start.
        if revealedIds.contains(story.id), !story.isVideo {
            if isShown(story) {
                revealOpacity = 1
                return
            }
            revealedIds.remove(story.id)
            assetIds.remove(story.id)
        }
        let id = story.id
        let known = StoryPreloadPlan.assets(of: story, serverIcon: { serversById[$0]?.iconUrl })
        if !story.isVideo, known.allSatisfy({ StoryPreloader.shared.image(for: $0) != nil }),
           !StoryPreloadPlan.hasCallLayer(story) || serversLoaded {
            assetIds.insert(id)
            maybeReveal(story, fade: false)
            return
        }
        let spinner = Task {
            try? await Task.sleep(for: .milliseconds(300))
            if !Task.isCancelled, !revealedIds.contains(id) { waitingId = id }
        }
        let skipper = Task {
            try? await Task.sleep(for: .milliseconds(Self.revealGiveUpMs))
            if !Task.isCancelled, !revealedIds.contains(id), current?.id == id { next() }
        }
        defer {
            spinner.cancel()
            skipper.cancel()
        }
        if StoryPreloadPlan.hasCallLayer(story) { await ensureServers() }
        await StoryPreloader.shared.ensure(StoryPreloadPlan.assets(of: story, serverIcon: { serversById[$0]?.iconUrl }))
        guard !Task.isCancelled else { return }
        assetIds.insert(id)
        if story.isVideo, videoURL(story) == nil { frameIds.insert(id) }
        maybeReveal(story)
        // A clip that fails never gets a first frame: it does not hold the story.
        while !Task.isCancelled, !revealedIds.contains(id) {
            if story.isVideo, player?.currentItem?.status == .failed {
                frameIds.insert(id)
                maybeReveal(story)
            }
            try? await Task.sleep(for: .milliseconds(250))
        }
    }

    private func maybeReveal(_ story: Story, fade: Bool = true) {
        guard !revealedIds.contains(story.id), assetIds.contains(story.id),
              !story.isVideo || frameIds.contains(story.id) else { return }
        waitingId = nil
        // Already in memory when the story came up (preloaded): no placeholder
        // to fade from, the story is simply there.
        guard fade, !reduceMotion else {
            revealOpacity = 1
            revealedIds.insert(story.id)
            return
        }
        // Everything appears in the same frame, at 0, and rises together.
        var instant = Transaction()
        instant.disablesAnimations = true
        withTransaction(instant) {
            revealOpacity = 0
            fadingId = story.id
            revealedIds.insert(story.id)
        }
        Task { @MainActor in
            withAnimation(.easeOut(duration: 0.2)) { revealOpacity = 1 }
            try? await Task.sleep(for: .milliseconds(260))
            if fadingId == story.id { fadingId = nil }
        }
    }

    /// The server list, for at most three seconds: a call card without the
    /// server's picture is better than no story.
    private func ensureServers() async {
        guard !serversLoaded else { return }
        await withTaskGroup(of: Void.self) { group in
            group.addTask { await loadServers() }
            group.addTask { try? await Task.sleep(for: .seconds(3)) }
            await group.next()
            group.cancelAll()
        }
    }

    // MARK: - Loading and the clock

    /// Fetches what is about to play, in batches the server takes, and keeps
    /// the next few stories' pictures and videos ready.
    private func storyChanged() async {
        error = nil
        let preloader = StoryPreloader.shared
        // A player already buffering this clip is taken BEFORE the window is
        // set again: the window leaves the current video to the viewer, and
        // would release it as no longer wanted.
        var adopted = current.flatMap(videoURL).flatMap { preloader.takePlayer(for: $0) }
        // The story on screen and the stories after it, in the order they
        // are needed, then the rest of the person's.
        var ids = playback.windowIds
        for id in playback.prefetchIds where !ids.contains(id) { ids.append(id) }
        let wanted = ids.filter { stories[$0] == nil && !gone.contains($0) }
        for id in wanted {
            if let known = preloader.cachedStory(id) { stories[id] = known }
        }
        // What is already known starts loading its media before the answer
        // for the rest is back.
        updatePreloadWindow()
        let missing = wanted.filter { stories[$0] == nil }
        if !missing.isEmpty {
            do {
                let batch = Array(missing.prefix(StoryLimits.idsMax))
                let fetched = try await session.api.stories(ids: batch)
                preloader.remember(fetched)
                for story in fetched { stories[story.id] = story }
                for id in batch where !fetched.contains(where: { $0.id == id }) { gone.insert(id) }
            } catch {
                self.error = (error as? APIError)?.errorDescription ?? error.localizedDescription
            }
        }
        // Swiped on while the stories were being read: this task is over, and
        // the player it took belongs to a story that is no longer on screen.
        if Task.isCancelled {
            adopted?.pause()
            adopted?.replaceCurrentItem(with: nil)
            return
        }
        progress = 0
        player?.pause()
        player = nil
        playerStoryId = nil
        guard let story = current else { return }
        if story.isVideo, let url = videoURL(story) {
            // A player that was already buffering this clip, when the preload
            // got to it; else a fresh one. One taken for another clip is not
            // this one's.
            if let taken = adopted, (taken.currentItem?.asset as? AVURLAsset)?.url != url {
                taken.pause()
                taken.replaceCurrentItem(with: nil)
                adopted = nil
            }
            if adopted == nil { adopted = preloader.takePlayer(for: url) }
            let next = adopted ?? AVPlayer(url: url)
            next.isMuted = muted
            // A story seen before has a new player: its first frame is to come,
            // and it is shown whole again when it is here.
            frameIds.remove(story.id)
            revealedIds.remove(story.id)
            player = next
            playerStoryId = story.id
            next.play()
        }
        updatePreloadWindow()
    }

    private func videoURL(_ story: Story) -> URL? {
        guard story.isVideo, let raw = story.media?.url else { return nil }
        return Avatar.resolve(raw) ?? URL(string: raw)
    }

    /// What to have ready: the story on screen's pictures, and the next two
    /// of the queue (across authors) and the next author's first, pictures and
    /// buffered video. Skipped on Low Data Mode for video only.
    private func updatePreloadWindow() {
        let preloader = StoryPreloader.shared
        let ids = playback.windowIds
        let ahead = ids.dropFirst().compactMap { stories[$0] }
        // A call card's server picture needs the server list: asked for as soon
        // as a call is anywhere in the window, so it is in memory when it shows.
        if !serversLoaded, ([current].compactMap { $0 } + ahead).contains(where: StoryPreloadPlan.hasCallLayer) {
            Task { await loadServers() }
        }
        preloader.setWindow(StoryPreloadPlan.window(
            current: current, ahead: ahead, lowData: false, serverIcon: { serversById[$0]?.iconUrl }
        ))
    }

    /// Linear, because it is a clock. A video's bar follows the video. It runs
    /// from the story's first frame (`StoryClockRules`).
    private func clock() async {
        let tick: Double = 1.0 / 30
        while !Task.isCancelled {
            try? await Task.sleep(for: .milliseconds(Int(tick * 1000)))
            guard let story = current, !paused else { continue }
            let item = player?.currentItem
            guard let value = StoryClockRules.nextProgress(
                current: progress, isVideo: story.isVideo, ready: revealedIds.contains(story.id), closing: closing,
                playerIsForThisStory: playerStoryId == story.id && player != nil,
                videoSeconds: player?.currentTime().seconds, videoDuration: item?.duration.seconds,
                tick: tick, displayMs: story.displayMs
            ) else { continue }
            progress = value
            // A second on screen counts as seen.
            if progress * Double(story.displayMs) / 1000 >= 1, !story.isMine, !watched.contains(story.id) {
                watched.insert(story.id)
                if !story.viewer.seen { pendingViews.insert(story.id) }
            }
            if progress >= 1 { next() }
        }
    }

    private func flushViewsLoop() async {
        while !Task.isCancelled {
            try? await Task.sleep(for: .seconds(2))
            await flushViews()
        }
    }

    private func flushViews() async {
        guard !pendingViews.isEmpty else { return }
        let batch = Array(pendingViews)
        pendingViews.subtract(batch)
        try? await session.api.markStoriesViewed(batch)
    }

    // MARK: - Actions

    private func react(_ story: Story, key: String) async {
        let next = story.viewer.reaction == key ? nil : key
        stories[story.id]?.viewer.reaction = next
        watched.insert(story.id)
        if next != nil {
            UIImpactFeedbackGenerator(style: .light).impactOccurred()
            if reduceMotion {
                show(flash: String(localized: "Reacted \(StoryRules.glyph(for: key))"))
            } else {
                flyingReaction = StoryRules.glyph(for: key)
                Task {
                    try? await Task.sleep(for: .milliseconds(650))
                    flyingReaction = nil
                }
            }
        }
        do {
            try await session.api.reactToStory(id: story.id, reaction: next)
        } catch {
            stories[story.id]?.viewer.reaction = story.viewer.reaction
            self.error = (error as? APIError)?.errorDescription ?? error.localizedDescription
        }
    }

    private func reply(_ story: Story) async {
        let text = replyText.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return }
        replyText = ""
        replyFocused = false
        let nonce: String
        if let attempt = replyAttempt, attempt.storyId == story.id, attempt.text == text {
            nonce = attempt.nonce
        } else {
            nonce = UUID().uuidString
            replyAttempt = (story.id, text, nonce)
        }
        do {
            _ = try await session.api.replyToStory(id: story.id, text: text, nonce: nonce)
            replyAttempt = nil
            show(flash: String(localized: "Sent ✓"))
            // The reply may have opened a conversation the hub has never
            // listed, and the replier is the one socket that gets no frame.
            session.storyReplyRevision += 1
        } catch {
            replyText = text
            self.error = (error as? APIError)?.errorDescription ?? error.localizedDescription
        }
    }

    private func show(flash text: String) {
        flash = text
        Task {
            try? await Task.sleep(for: .milliseconds(1200))
            if flash == text { flash = nil }
        }
    }

    private func mute(_ story: Story) async {
        do {
            try await session.api.muteStories(of: story.author.id, muted: true)
            if !playback.nextPerson() { close() }
        } catch {
            self.error = (error as? APIError)?.errorDescription ?? error.localizedDescription
        }
    }

    private func saveToBau(_ story: Story, serverId: String) async {
        do {
            try await session.api.saveStoryToBau(storyId: story.id, serverId: serverId)
            show(flash: String(localized: "Saved as a Baú draft"))
        } catch {
            self.error = (error as? APIError)?.errorDescription ?? error.localizedDescription
        }
    }

    private func run(_ action: PendingAction) async {
        confirming = nil
        do {
            switch action {
            case .delete(let story):
                try await session.api.deleteStory(id: story.id)
                // Not next(): the stories-update frame the server sends our own
                // sockets for this delete lands here too, and two steps past a
                // story that was deleted once skip the one after it.
                dropRemoved([story.id])
            case .remove(let story, let serverId, _):
                try await session.api.removeStoryFromServer(storyId: story.id, serverId: serverId, reason: nil)
                dropRemoved([story.id])
            }
        } catch {
            self.error = (error as? APIError)?.errorDescription ?? error.localizedDescription
        }
    }

    /// "Entrar na call": the room, in one tap, the way the channel list joins.
    private func join(_ call: StoryCallLive) async {
        guard call.joinable,
              let channels = try? await session.api.channels(serverId: call.serverId),
              let channel = channels.first(where: { $0.id == call.channelId })
        else { return }
        close()
        voice.isCollapsed = false
        await voice.join(channel: channel, session: session, ratings: ratings, serverName: nil)
    }
}

/// One segment of the progress row. `scaleEffect`, never a width change.
struct StoryProgressBar: View {
    let fill: Double

    var body: some View {
        ZStack(alignment: .leading) {
            Capsule().fill(.white.opacity(0.3))
            Capsule().fill(.white)
                .scaleEffect(x: max(0, min(1, fill)), y: 1, anchor: .leading)
        }
        .frame(height: 2.5)
    }
}

/// When and how often an open story re-reads its call: on a backing-off
/// schedule, so a viewer who lingers costs a few requests a minute, not a steady drip.
enum StoryCallRefresh {
    /// The wait before the n-th read of a card that has not changed since the
    /// last one (0 is the first): 6, 10, 15, 25, then 40 s. Most stories are
    /// gone before the first read, a held one is read a few times a minute and
    /// then rarely, and any change starts the schedule over.
    static let schedule: [Int] = [6, 10, 15, 25, 40]
    static let jitter = 0.15

    static func delay(unchanged: Int, random: Double = .random(in: -1...1)) -> Duration {
        let base = Double(schedule[min(max(unchanged, 0), schedule.count - 1)])
        return .milliseconds(Int(base * (1 + jitter * random) * 1000))
    }

    /// Only a story with a room to follow: the live roster is on the story,
    /// and a story without a call has nothing to refresh.
    static func watches(_ story: Story) -> Bool {
        story.call != nil
    }
}

/// The call sticker, live: who is in, and the door, or "A call acabou".
struct StoryCallCard: View {
    let call: StoryCallLive
    let onJoin: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 6) {
                Image(systemName: "headphones").decorative()
                Text(call.state == "live" ? "In the call now" : (call.state == "full" ? "The room is full" : "The call ended"))
                    .textCase(.uppercase)
            }
            .font(.system(size: 11, weight: .bold))
            .foregroundStyle(call.state == "live" ? Palette.signal : Palette.paperMuted)
            Text(verbatim: call.channelName)
                .font(.system(size: 18, weight: .bold))
                .foregroundStyle(.white)
            if !call.participants.isEmpty {
                HStack(spacing: -8) {
                    ForEach(call.participants) { person in
                        Avatar(name: person.displayName, seed: person.id, size: 24, url: person.avatarUrl)
                            .overlay(Circle().strokeBorder(Color.black, lineWidth: 1.5))
                    }
                    Text(verbatim: call.participants.map(\.firstName).joined(separator: ", "))
                        .font(.system(size: 12))
                        .foregroundStyle(.white.opacity(0.8))
                        .padding(.leading, 14)
                        .lineLimit(1)
                }
            }
            if call.joinable {
                Button(action: onJoin) {
                    Label("Join the call", systemImage: "headphones")
                        .font(.system(size: 15, weight: .bold))
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 11)
                        .foregroundStyle(Palette.inkDeep)
                        .background(Capsule().fill(Palette.signal))
                }
                .accessibilityIdentifier("story.call.join")
            }
        }
        .padding(14)
        .background(RoundedRectangle(cornerRadius: 16).fill(.black.opacity(0.55)))
        .overlay(RoundedRectangle(cornerRadius: 16).strokeBorder(Palette.signal.opacity(call.state == "live" ? 0.6 : 0.2), lineWidth: 1))
    }
}

/// A sent reaction flies 150 pt up, grows and fades.
struct StoryReactionFlight: View {
    let glyph: String
    @State private var flown = false

    var body: some View {
        Text(verbatim: glyph)
            .font(.system(size: 44, weight: .heavy))
            .foregroundStyle(Palette.signal)
            .scaleEffect(flown ? 1.8 : 1)
            .offset(y: flown ? -150 : 60)
            .opacity(flown ? 0 : 1)
            .onAppear {
                withAnimation(.timingCurve(0.16, 1, 0.3, 1, duration: 0.6)) { flown = true }
            }
            .allowsHitTesting(false)
    }
}

/// An `AVPlayerLayer`, plain.
struct StoryVideoSurface: UIViewRepresentable {
    let player: AVPlayer
    /// A video shaped like the canvas fills it; any other is shown whole.
    var fills = false
    /// The layer has its first frame.
    var onReady: (() -> Void)?

    func makeUIView(context: Context) -> StoryPlayerView {
        let view = StoryPlayerView()
        view.onReady = onReady
        view.playerLayer.videoGravity = fills ? .resizeAspectFill : .resizeAspect
        view.playerLayer.player = player
        return view
    }

    func updateUIView(_ view: StoryPlayerView, context: Context) {
        view.onReady = onReady
        view.playerLayer.videoGravity = fills ? .resizeAspectFill : .resizeAspect
        if view.playerLayer.player !== player { view.playerLayer.player = player }
    }
}

final class StoryPlayerView: UIView {
    override class var layerClass: AnyClass { AVPlayerLayer.self }
    var playerLayer: AVPlayerLayer { layer as! AVPlayerLayer }
    private var readiness: NSKeyValueObservation?
    var onReady: (() -> Void)?

    override init(frame: CGRect) {
        super.init(frame: frame)
        // When the first video frame is on the layer: the story's timer starts.
        readiness = playerLayer.observe(\.isReadyForDisplay, options: [.initial, .new]) { [weak self] layer, _ in
            guard layer.isReadyForDisplay else { return }
            StoryMetrics.mark("frame.video")
            DispatchQueue.main.async { self?.onReady?() }
        }
    }

    @available(*, unavailable) required init?(coder: NSCoder) { fatalError() }
}
