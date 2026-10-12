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
    @State private var drag: CGSize = .zero
    @State private var showingViewers = false
    @State private var showingMenu = false
    @State private var reportTarget: ReportTarget?
    @State private var confirming: PendingAction?
    @State private var flash: String?
    @State private var flyingReaction: String?
    @State private var watched: Set<String> = []
    @State private var pendingViews: Set<String> = []
    @State private var player: AVPlayer?
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
        _playback = State(initialValue: StoryPlayback(people: launch.people, startPerson: launch.startPerson))
    }

    private var current: Story? { playback.currentId.flatMap { stories[$0] } }
    private var paused: Bool { holding || replyFocused || showingViewers || showingMenu || reportTarget != nil || confirming != nil }

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
        // Replying, a sheet or the menu pauses the story; the video pauses
        // with it so nothing plays past a frozen bar.
        .onChange(of: paused) { _, isPaused in
            guard current?.isVideo == true else { return }
            if isPaused { player?.pause() } else { player?.play() }
        }
        .task { await clock() }
        .task { await flushViewsLoop() }
        // A story staff removed (or its author deleted) leaves an open viewer
        // at once: `removedStoryIds` rides the `stories-update` frame.
        .onAppear {
            session.eventHandlers[handlerKey] = { event in
                guard case .storiesUpdate(let update) = event, !update.removedStoryIds.isEmpty else { return }
                dropRemoved(Set(update.removedStoryIds))
            }
        }
        .onDisappear {
            session.eventHandlers.removeValue(forKey: handlerKey)
            Task { await flushViews() }
            player?.pause()
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
            content
                .id(playback.currentId)
                .transition(.opacity)
                .ignoresSafeArea(.keyboard)

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

            VStack(spacing: 0) {
                header
                    .opacity(chromeHidden ? 0 : 1)
                Spacer(minLength: 0)
                if let call = current?.call {
                    StoryCallCard(call: call) { Task { await join(call) } }
                        .padding(.horizontal, 24)
                        .padding(.bottom, 18)
                        .opacity(chromeHidden ? 0 : 1)
                }
                if let caption = current?.caption, !caption.isEmpty, current?.isText == false {
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
        .animation(.easeOut(duration: 0.2), value: chromeHidden)
        .animation(.easeOut(duration: 0.2), value: flash)
    }

    @ViewBuilder
    private var content: some View {
        if let story = current {
            if story.isText {
                ZStack {
                    LinearGradient(colors: StoryRules.backgroundColors(story.background),
                                   startPoint: .top, endPoint: .bottom)
                    Text(verbatim: story.text ?? "")
                        .font(.system(size: 34, weight: .heavy, design: .rounded))
                        .foregroundStyle(.white)
                        .multilineTextAlignment(.center)
                        .minimumScaleFactor(0.5)
                        .padding(.horizontal, 28)
                }
                .ignoresSafeArea()
            } else if story.isVideo, let player {
                StoryVideoSurface(player: player)
                    .ignoresSafeArea()
                    .overlay(alignment: .topTrailing) {
                        Button {
                            muted.toggle()
                            player.isMuted = muted
                        } label: {
                            Image(systemName: muted ? "speaker.slash.fill" : "speaker.wave.2.fill")
                                .font(.system(size: 14, weight: .semibold))
                                .foregroundStyle(.white)
                                .padding(10)
                                .background(Circle().fill(.black.opacity(0.4)))
                        }
                        .padding(.top, 90)
                        .padding(.trailing, 14)
                        .accessibilityLabel(muted ? "Unmute" : "Mute")
                    }
            } else if let media = story.media, let url = Avatar.resolve(media.url) ?? URL(string: media.url) {
                AsyncImage(url: url) { phase in
                    switch phase {
                    case .success(let image):
                        image.resizable().scaledToFit()
                    case .failure:
                        Image(systemName: "photo").foregroundStyle(Palette.paperMuted)
                    default:
                        ProgressView().tint(.white)
                    }
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .background(Color.black)
            } else {
                Color.black
            }
        } else if let id = playback.currentId, gone.contains(id) {
            Color.black.onAppear { next() }
        } else if let error {
            // The story could not be fetched: say so, and offer to ask again,
            // instead of a spinner that never ends.
            VStack(spacing: 14) {
                Text(verbatim: error)
                    .font(Typography.callout)
                    .foregroundStyle(.white)
                    .multilineTextAlignment(.center)
                Button("Try again") { Task { await storyChanged() } }
                    .buttonStyle(.borderedProminent)
                    .tint(Palette.signal)
                    .foregroundStyle(Palette.inkDeep)
                    .accessibilityIdentifier("story.retry")
            }
            .padding(32)
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        } else {
            ProgressView().tint(.white)
                .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
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
                Button { showingMenu = true } label: {
                    Image(systemName: "ellipsis")
                        .font(.system(size: 16, weight: .bold))
                        .foregroundStyle(.white)
                        .frame(width: 36, height: 36)
                }
                .accessibilityLabel("More")
                .accessibilityIdentifier("story.menu")
                Button { close() } label: {
                    Image(systemName: "xmark")
                        .font(.system(size: 16, weight: .bold))
                        .foregroundStyle(.white)
                        .frame(width: 36, height: 36)
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
                Image(systemName: "eye")
                if let own = story.own, own.status != "live" {
                    Text("Processing the video…")
                } else {
                    Text("Seen by \(story.own?.viewCount ?? 0)")
                }
                Image(systemName: "chevron.up").font(.system(size: 11, weight: .bold))
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
        if let current = playback.currentId, ids.contains(current) { next() }
    }

    private func close() {
        player?.pause()
        dismiss()
    }

    // MARK: - Loading and the clock

    /// Fetches what is about to play, in batches the server takes.
    private func storyChanged() async {
        error = nil
        let wanted = playback.prefetchIds.filter { stories[$0] == nil && !gone.contains($0) }
        if !wanted.isEmpty {
            do {
                let fetched = try await session.api.stories(ids: wanted)
                for story in fetched { stories[story.id] = story }
                for id in wanted where !fetched.contains(where: { $0.id == id }) { gone.insert(id) }
            } catch {
                self.error = (error as? APIError)?.errorDescription ?? error.localizedDescription
            }
        }
        progress = 0
        player?.pause()
        player = nil
        guard let story = current else { return }
        if story.isVideo, let raw = story.media?.url, let url = Avatar.resolve(raw) ?? URL(string: raw) {
            let next = AVPlayer(url: url)
            next.isMuted = muted
            player = next
            next.play()
        }
    }

    /// Linear, because it is a clock. A video's bar follows the video.
    private func clock() async {
        let tick: Double = 1.0 / 30
        while !Task.isCancelled {
            try? await Task.sleep(for: .milliseconds(Int(tick * 1000)))
            guard let story = current, !paused else { continue }
            if story.isVideo, let player, let item = player.currentItem {
                let duration = item.duration.seconds
                if duration.isFinite, duration > 0 {
                    progress = min(1, player.currentTime().seconds / duration)
                }
            } else {
                progress += tick / (Double(story.displayMs) / 1000)
            }
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
        do {
            try await session.api.markStoriesViewed(batch)
        } catch {
            // Kept for the next flush (every 2 s, and on close): a view that
            // failed to record is retried, never dropped.
            pendingViews.formUnion(batch)
        }
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
                gone.insert(story.id)
                stories[story.id] = nil
                next()
            case .remove(let story, let serverId, _):
                try await session.api.removeStoryFromServer(storyId: story.id, serverId: serverId, reason: nil)
                gone.insert(story.id)
                stories[story.id] = nil
                next()
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

/// The call sticker, live: who is in, and the door, or "A call acabou".
struct StoryCallCard: View {
    let call: StoryCallLive
    let onJoin: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 6) {
                Image(systemName: "headphones")
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

/// An `AVPlayerLayer`, plain, aspect-fit.
struct StoryVideoSurface: UIViewRepresentable {
    let player: AVPlayer

    func makeUIView(context: Context) -> StoryPlayerView {
        let view = StoryPlayerView()
        view.playerLayer.videoGravity = .resizeAspect
        view.playerLayer.player = player
        return view
    }

    func updateUIView(_ view: StoryPlayerView, context: Context) {
        view.playerLayer.player = player
    }
}

final class StoryPlayerView: UIView {
    override class var layerClass: AnyClass { AVPlayerLayer.self }
    var playerLayer: AVPlayerLayer { layer as! AVPlayerLayer }
}
