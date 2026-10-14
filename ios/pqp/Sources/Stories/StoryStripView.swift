import SwiftUI

/// Which strip: a server's (members see it) or Amigos (friends see it).
enum StoryScope: Hashable, Sendable {
    case server(id: String, name: String)
    case friends

    var serverId: String? {
        if case .server(let id, _) = self { return id }
        return nil
    }
}

/// One strip's state: the rings, the author's notices, and what is open.
///
/// Owned by the screen that draws the strip (the channel list, the hub) so
/// that screen's own menu can open the composer too. Listens for
/// `stories-update` and refetches only the strip a frame names; drops rings
/// whose newest story expired, because expiry sends no frame.
@MainActor
@Observable
final class StoryStripModel {
    let scope: StoryScope
    private(set) var strip = StoryStrip.off
    /// "A staff tirou teu story do X", once, at the top of that server.
    private(set) var notices: [StoryNotice] = []
    var composing = false
    var viewing: StoryViewerLaunch?

    @ObservationIgnored private var session: SessionStore?
    @ObservationIgnored private let handlerKey = "stories-" + UUID().uuidString
    @ObservationIgnored private var expiryTask: Task<Void, Never>?

    init(scope: StoryScope) {
        self.scope = scope
    }

    func start(session: SessionStore) async {
        self.session = session
        session.eventHandlers[handlerKey] = { [weak self] event in
            guard let self, case .storiesUpdate(let update) = event else { return }
            switch update.scope {
            case "server" where update.serverId == self.scope.serverId:
                Task { await self.load() }
            case "friends" where self.scope == .friends:
                Task { await self.load() }
            case "own":
                Task { await self.load() }
            default:
                break
            }
        }
        await load()
    }

    func stop() {
        session?.eventHandlers.removeValue(forKey: handlerKey)
        expiryTask?.cancel()
    }

    func load() async {
        guard let session else { return }
        let answer: StoryStrip? = switch scope {
        case .server(let id, _): await session.api.serverStoryStrip(serverId: id)
        case .friends: await session.api.friendsStoryStrip()
        }
        // A failed read keeps what is on screen.
        guard let answer else { return }
        apply(answer)
        if let serverId = scope.serverId, answer.enabled {
            notices = await session.api.storyNotices().filter { $0.serverId == serverId }
        }
    }

    private func apply(_ next: StoryStrip) {
        strip = StoryRules.dropExpired(next)
        scheduleExpiry()
    }

    private func scheduleExpiry() {
        expiryTask?.cancel()
        guard let next = StoryRules.nextExpiry(strip) else { return }
        expiryTask = Task { [weak self] in
            let wait = max(1, next.timeIntervalSinceNow + 0.5)
            try? await Task.sleep(for: .seconds(wait))
            guard !Task.isCancelled, let self else { return }
            self.apply(self.strip)
        }
    }

    /// Rings watched to the end turn seen when the viewer closes, a beat
    /// after, so the change is seen (the design's 120 ms).
    func viewerClosed(seen: Set<String>, reduceMotion: Bool) {
        guard !seen.isEmpty else { return }
        Task {
            try? await Task.sleep(for: .milliseconds(120))
            withAnimation(reduceMotion ? .easeOut(duration: 0.15) : .easeInOut(duration: 0.3)) {
                strip = StoryRules.markingSeen(strip, seenIds: seen)
            }
        }
    }

    func acknowledge(_ notice: StoryNotice) async {
        notices.removeAll { $0.id == notice.id }
        await session?.api.acknowledgeStoryNotice(id: notice.id)
    }

    /// Warms what opening one of the first three unseen rings will show: the
    /// story is read (so the viewer needs no round trip) and its picture or the
    /// start of its video is fetched. Not while the viewer is open: it keeps
    /// its own window.
    func preloadTray() async {
        guard let session, viewing == nil else { return }
        let ids = StoryPreloadPlan.trayStoryIds(strip)
        guard !ids.isEmpty else { return }
        let preloader = StoryPreloader.shared
        var known = ids.compactMap { preloader.cachedStory($0) }
        let missing = ids.filter { id in !known.contains { $0.id == id } }
        if !missing.isEmpty, let fetched = try? await session.api.stories(ids: missing) {
            preloader.remember(fetched)
            known += fetched
        }
        guard !Task.isCancelled, viewing == nil else { return }
        let ordered = ids.compactMap { id in known.first { $0.id == id } }
        preloader.setWindow(StoryPreloadPlan.items(for: ordered, lowData: false))
    }

    /// What `preloadTray` depends on: the ring order and whether the viewer is up.
    var trayPreloadKey: [String] {
        StoryPreloadPlan.trayStoryIds(strip) + [viewing == nil ? "tray" : "viewer"]
    }

    /// Open the viewer on this ring, with every ring after it queued.
    func open(_ item: StoryStripItem) {
        StoryMetrics.mark("ring.tap")
        let people = strip.items.map(\.storyIds)
        let start = strip.items.firstIndex { $0.id == item.id } ?? 0
        viewing = StoryViewerLaunch(people: people, startPerson: start, scope: scope)
    }

    func openOwn() {
        guard let own = strip.own else { return }
        viewing = StoryViewerLaunch(people: [own.storyIds], startPerson: 0, scope: scope)
    }

    var showsStrip: Bool { StoryRules.showsStrip(strip) }
}

/// What the viewer is opened on.
struct StoryViewerLaunch: Identifiable, Hashable {
    let id = UUID()
    let people: [[String]]
    let startPerson: Int
    let scope: StoryScope
}

/// The strip: "Teu story" first, then the rings in the server's order. Drawn
/// only with a story on the air (or for the friends strip, the author's own
/// bubble when they have friends), so an empty strip costs no space.
struct StoryStripView: View {
    @Environment(SessionStore.self) private var session
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Bindable var model: StoryStripModel
    /// The friends strip shows the author's own bubble even with nothing live,
    /// when they have somebody to post to.
    var showsOwnBubbleAlone = false
    /// The server, for the composer's pre-ticked audience.
    var server: Server?
    var onPosted: () -> Void = {}

    @AppStorage private var hintDismissed: Bool
    /// The post whose options are open: retry or discard when it failed,
    /// discard or carry on while it is still going up.
    @State private var askingAboutPost: String?

    init(model: StoryStripModel, showsOwnBubbleAlone: Bool = false, server: Server? = nil, onPosted: @escaping () -> Void = {}) {
        self.model = model
        self.showsOwnBubbleAlone = showsOwnBubbleAlone
        self.server = server
        self.onPosted = onPosted
        let key = "pqp.stories.hintDismissed." + (model.scope.serverId ?? "friends")
        _hintDismissed = AppStorage(wrappedValue: false, key)
    }

    private var strip: StoryStrip { model.strip }

    /// The post this strip draws on the person's own ring, while it is on the
    /// way up or after it failed.
    private var posting: StoryPostQueue.Job? {
        session.storyPosts.job(for: model.scope)
    }

    private var askedJob: StoryPostQueue.Job? {
        askingAboutPost.flatMap { session.storyPosts.job(id: $0) }
    }

    private var showsRings: Bool {
        model.showsStrip || (strip.enabled && strip.canPost && showsOwnBubbleAlone) || (strip.enabled && posting != nil)
    }

    private var showsHint: Bool {
        strip.enabled && strip.firstRunHint && strip.canPost && !hintDismissed
            && strip.own == nil && strip.items.isEmpty
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            ForEach(model.notices) { notice in
                StoryNoticeCard(notice: notice) {
                    Task { await model.acknowledge(notice) }
                }
            }
            if showsRings {
                rings
            } else if showsHint {
                StoryFirstRunHint(
                    name: session.currentUser?.displayName ?? "?",
                    seed: session.currentUser?.id ?? "me",
                    avatarUrl: session.currentUser?.avatarUrl,
                    onPost: { model.composing = true },
                    onDismiss: { withAnimation(Motion.standard) { hintDismissed = true } }
                )
            }
        }
        .animation(reduceMotion ? .easeOut(duration: 0.15) : Motion.standard, value: strip.items.map(\.id))
        .task(id: model.trayPreloadKey) { await model.preloadTray() }
        .onChange(of: session.storyPosts.publishedCount) { _, _ in
            Task { await model.load() }
        }
        .confirmationDialog(
            askedJob?.failed == true ? "Couldn't post your story" : "Posting your story",
            isPresented: Binding(get: { askedJob != nil }, set: { if !$0 { askingAboutPost = nil } }),
            titleVisibility: .visible, presenting: askedJob
        ) { job in
            if job.failed {
                Button("Try again") { session.storyPosts.retry(job.id) }
            }
            Button("Discard", role: .destructive) { session.storyPosts.discard(job.id) }
            Button(job.failed ? "Cancel" : "Keep posting", role: .cancel) {}
        } message: { job in
            if let message = job.failureMessage { Text(verbatim: message) }
        }
        .fullScreenCover(item: $model.viewing) { launch in
            StoryViewer(launch: launch) { seen in
                model.viewerClosed(seen: seen, reduceMotion: reduceMotion)
                Task { await model.load() }
            }
        }
        .fullScreenCover(isPresented: $model.composing) {
            StoryComposer(preselectedServerId: model.scope.serverId, preselectsFriends: model.scope == .friends) {
                Task { await model.load() }
                onPosted()
            }
        }
    }

    private var rings: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(alignment: .top, spacing: 14) {
                if strip.canPost || strip.own != nil {
                    ownBubble
                }
                ForEach(strip.items) { item in
                    Button { model.open(item) } label: {
                        StoryRingCell(
                            author: item.author,
                            unseen: item.unseen,
                            hasCall: item.hasCall,
                            label: item.author.firstName
                        )
                    }
                    .buttonStyle(.plain)
                    .transition(reduceMotion ? .opacity : .scale(scale: 0.6).combined(with: .opacity))
                    .accessibilityLabel(item.unseen
                        ? Text("Story by \(item.author.displayName), new")
                        : Text("Story by \(item.author.displayName), seen"))
                    .accessibilityIdentifier("stories.ring.\(item.author.id)")
                }
            }
            .padding(.vertical, 2)
        }
        .accessibilityIdentifier("stories.strip")
    }

    private var ownBubble: some View {
        let me = session.currentUser
        let author = StoryAuthor(id: me?.id ?? "me", displayName: me?.displayName ?? "?", avatarUrl: me?.avatarUrl)
        let job = posting
        return Button {
            if let job {
                askingAboutPost = job.id
            } else if strip.own != nil {
                model.openOwn()
            } else {
                model.composing = true
            }
        } label: {
            StoryRingCell(
                author: author,
                unseen: strip.own != nil,
                hasCall: strip.own?.hasCall ?? false,
                label: label(for: job),
                showsPlus: strip.canPost && job == nil,
                posting: job.map { StoryRingPosting(progress: $0.progress, failed: $0.failed) }
            )
        }
        .buttonStyle(.plain)
        // With a story up, the tap plays it; a new one is a long press away
        // (and in the server's menu).
        .contextMenu {
            if strip.canPost {
                Button { model.composing = true } label: {
                    Label("New story", systemImage: "plus")
                }
            }
        }
        .accessibilityLabel(accessibilityLabel(for: job))
        .accessibilityValue(progressValue(for: job))
        .accessibilityIdentifier("stories.own")
    }

    private func label(for job: StoryPostQueue.Job?) -> String {
        guard let job else { return String(localized: "Your story") }
        return job.failed ? String(localized: "Didn't post") : String(localized: "Posting")
    }

    private func progressValue(for job: StoryPostQueue.Job?) -> Text {
        guard let job, !job.failed else { return Text(verbatim: "") }
        return Text("\(Int(job.progress * 100)) percent")
    }

    private func accessibilityLabel(for job: StoryPostQueue.Job?) -> Text {
        if let job {
            return job.failed ? Text("Your story didn't post. Double tap for options") : Text("Posting your story")
        }
        return strip.own != nil ? Text("Your story") : Text("Your story, post")
    }
}

/// What the own ring shows while a story is on its way up.
struct StoryRingPosting: Equatable {
    /// 0...1 of the bytes sent.
    let progress: Double
    let failed: Bool
}

/// A ring and the name under it.
struct StoryRingCell: View {
    let author: StoryAuthor
    let unseen: Bool
    let hasCall: Bool
    let label: String
    var showsPlus = false
    var posting: StoryRingPosting?

    var body: some View {
        VStack(spacing: 6) {
            StoryRing(unseen: unseen && posting == nil, posting: posting) {
                Avatar(name: author.displayName, seed: author.id, size: 56, url: author.avatarUrl)
            }
            .overlay(alignment: .bottomTrailing) {
                if posting?.failed == true {
                    Image(systemName: "exclamationmark")
                        .font(.system(size: 11, weight: .heavy))
                        .foregroundStyle(.white)
                        .frame(width: 20, height: 20)
                        .background(Circle().fill(Palette.danger))
                        .overlay(Circle().strokeBorder(Palette.ink, lineWidth: 2))
                        .offset(x: 2, y: 2)
                        .accessibilityHidden(true)
                } else if showsPlus {
                    Image(systemName: "plus")
                        .font(.system(size: 11, weight: .heavy))
                        .foregroundStyle(Palette.inkDeep)
                        .frame(width: 20, height: 20)
                        .background(Circle().fill(Palette.signal))
                        .overlay(Circle().strokeBorder(Palette.ink, lineWidth: 2))
                        .offset(x: 2, y: 2)
                } else if hasCall {
                    Image(systemName: "headphones")
                        .font(.system(size: 10, weight: .bold))
                        .foregroundStyle(Palette.signal)
                        .frame(width: 20, height: 20)
                        .background(Circle().fill(Palette.inkDeep))
                        .overlay(Circle().strokeBorder(Palette.ink, lineWidth: 2))
                        .offset(x: 2, y: 2)
                        .accessibilityLabel("In a call")
                }
            }
            Text(verbatim: label)
                .font(.system(size: 11, weight: unseen ? .semibold : .regular))
                .foregroundStyle(posting?.failed == true ? Palette.danger : (unseen ? Palette.paper : Palette.paperMuted))
                .lineLimit(1)
                .frame(width: 66)
        }
    }
}

/// Unseen: a lime to amber sweep. Seen: a thin grey line. Two stacked layers
/// that crossfade, never an animated gradient.
struct StoryRing<Content: View>: View {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    let unseen: Bool
    /// A post on its way up: the ring fills as the bytes go, or turns red when
    /// it did not make it.
    var posting: StoryRingPosting?
    @ViewBuilder var content: Content

    var body: some View {
        ZStack {
            Circle()
                .strokeBorder(posting?.failed == true ? Palette.danger : Palette.border, lineWidth: posting?.failed == true ? 2.5 : 1.5)
            Circle()
                .strokeBorder(
                    AngularGradient(
                        colors: [Palette.signal, Palette.warning, Palette.signal],
                        center: .center
                    ),
                    lineWidth: 2.5
                )
                .opacity(unseen ? 1 : 0)
            if let posting, !posting.failed {
                postingArc(posting)
            }
            content
        }
        .frame(width: 64, height: 64)
    }

    /// Starts at 12 o'clock and never shows less than a sliver, so the ring is
    /// on the moment the story is: the create has no bytes to count yet. Once
    /// every byte is handed over and the server has yet to answer, the arc
    /// turns, so a ring that cannot fill further still reads as working (held
    /// still under Reduce Motion).
    private func postingArc(_ posting: StoryRingPosting) -> some View {
        let waiting = posting.progress >= StoryPostProgress.heldBack
        return TimelineView(.animation(paused: !waiting || reduceMotion)) { context in
            let turn = waiting && !reduceMotion
                ? context.date.timeIntervalSinceReferenceDate.truncatingRemainder(dividingBy: 1.1) / 1.1 * 360
                : 0
            Circle()
                .trim(from: 0, to: max(0.04, min(1, posting.progress)))
                .stroke(Palette.signal, style: StrokeStyle(lineWidth: 3, lineCap: .round))
                .rotationEffect(.degrees(-90 + turn))
                .padding(1.5)
                .animation(reduceMotion ? nil : .linear(duration: 0.2), value: posting.progress)
        }
        .accessibilityIdentifier("stories.own.progress")
    }
}

/// The one-off dashed row while a server's stories are new and nobody posted.
struct StoryFirstRunHint: View {
    let name: String
    let seed: String
    let avatarUrl: String?
    let onPost: () -> Void
    let onDismiss: () -> Void

    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            Avatar(name: name, seed: seed, size: 44, url: avatarUrl)
                .overlay(alignment: .bottomTrailing) {
                    Image(systemName: "plus")
                        .font(.system(size: 9, weight: .heavy))
                        .foregroundStyle(Palette.inkDeep)
                        .frame(width: 16, height: 16)
                        .background(Circle().fill(Palette.signal))
                        .offset(x: 2, y: 2)
                }
            VStack(alignment: .leading, spacing: 3) {
                Text("Nobody has posted yet")
                    .font(Typography.bodyMedium)
                    .foregroundStyle(Palette.paper)
                Text("Show what's up: a clip, your setup, when you're getting on. Gone in 24 h.")
                    .font(Typography.caption)
                    .foregroundStyle(Palette.paperMuted)
                    .fixedSize(horizontal: false, vertical: true)
            }
            Spacer(minLength: 0)
            VStack(spacing: 8) {
                Button("Post", action: onPost)
                    .font(Typography.caption.weight(.bold))
                    .foregroundStyle(Palette.inkDeep)
                    .padding(.horizontal, 12)
                    .padding(.vertical, 6)
                    .background(Capsule().fill(Palette.signal))
                    .accessibilityIdentifier("stories.hint.post")
                Button(action: onDismiss) {
                    Image(systemName: "xmark").font(.system(size: 11, weight: .bold))
                }
                .tint(Palette.paperMuted)
                .accessibilityLabel("Dismiss")
            }
        }
        .padding(12)
        .background(
            RoundedRectangle(cornerRadius: Metrics.cornerRadius, style: .continuous)
                .strokeBorder(Palette.border, style: StrokeStyle(lineWidth: 1, dash: [4, 4]))
        )
    }
}

/// "A staff tirou teu story do X", once, with the reason.
struct StoryNoticeCard: View {
    let notice: StoryNotice
    let onOk: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("Staff removed your story from \(notice.serverName ?? "")")
                .font(Typography.bodyMedium)
                .foregroundStyle(Palette.paper)
            if let reason = notice.reason, !reason.isEmpty {
                Text("Reason: \(reason). If you posted it somewhere else too, it stays there until it expires.")
                    .font(Typography.caption)
                    .foregroundStyle(Palette.paperMuted)
            }
            Button("OK", action: onOk)
                .font(Typography.caption.weight(.semibold))
                .padding(.horizontal, 12)
                .padding(.vertical, 5)
                .background(Capsule().fill(Palette.surfaceRaised))
                .tint(Palette.paper)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(12)
        .pqpSurface()
        .accessibilityIdentifier("stories.notice")
    }
}
