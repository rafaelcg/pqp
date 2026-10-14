import AVFoundation
import Network
import os
import SwiftUI
import UIKit

// PRELOADING, SO THE NEXT STORY HAS ITS FIRST FRAME BEFORE IT IS ASKED FOR.
//
// With a story open, the next two of the queue (across authors) and the next
// author's first are fetched ahead: a picture is downloaded and decoded, a
// video gets a player that is already buffered and prerolled. With the tray on
// screen, the first unseen story of the first three rings is warmed the same
// way. At most two run at once, anything that leaves the window is cancelled,
// and on Low Data Mode no video is fetched ahead.

// MARK: - The plan (pure)

/// One thing worth having before it is needed.
enum StoryPreloadItem: Hashable, Sendable {
    /// Downloaded, decoded, kept in memory.
    case image(URL)
    /// A player that is buffered and prerolled, paused at the start.
    case video(URL)
    /// Fetched so the system's URL cache has it (an avatar the stock
    /// `AsyncImage` will ask for).
    case warm(URL)

    var isVideo: Bool {
        if case .video = self { return true }
        return false
    }

    var key: String {
        switch self {
        case .image(let url): "img:" + url.absoluteString
        case .video(let url): "vid:" + url.absoluteString
        case .warm(let url): "warm:" + url.absoluteString
        }
    }
}

@MainActor
enum StoryPreloadPlan {
    /// Videos buffered ahead at once: a decoder and a connection each.
    static let maxConcurrent = 2

    /// What to fetch for `stories`, in the order they will be needed: for each
    /// one its picture (a video's poster and the video itself), then the
    /// pictures its layers place, then its author's avatar. A story's first
    /// frame comes before the next story's anything.
    static func items(for stories: [Story], lowData: Bool, serverIcon: (String) -> String? = { _ in nil }) -> [StoryPreloadItem] {
        var items: [StoryPreloadItem] = []
        func add(_ item: StoryPreloadItem) {
            if !items.contains(item) { items.append(item) }
        }
        for story in stories {
            if let media = story.media {
                if media.isVideo {
                    if let poster = url(media.posterUrl) { add(.image(poster)) }
                    if !lowData, let video = url(media.url) { add(.video(video)) }
                } else if let picture = url(media.url) {
                    add(.image(picture))
                }
            }
            for layer in story.layers {
                switch layer.content {
                case .image(let picture), .drawing(let picture):
                    if let layerUrl = url(picture.url) { add(.image(layerUrl)) }
                case .call(let serverId, _):
                    for asset in callAssets(story: story, serverId: serverId, serverIcon: serverIcon) { add(.image(asset)) }
                default: break
                }
            }
            if let avatar = Avatar.resolve(story.author.avatarUrl) { add(.warm(avatar)) }
        }
        return items
    }

    /// The pictures a call card draws: the server's tile and the faces in the
    /// room. A card with them still to come is a story arriving in pieces.
    static func callAssets(story: Story, serverId: String, serverIcon: (String) -> String?) -> [URL] {
        var urls: [URL] = []
        if let icon = url(serverIcon(serverId)) { urls.append(icon) }
        for person in (story.call?.participants ?? []).prefix(3) {
            if let face = url(person.avatarUrl) { urls.append(face) }
        }
        return urls
    }

    /// EVERYTHING a story draws that has to be fetched: its base (a photo, or a
    /// video's poster), every placed photo and the drawing, and the call card's
    /// pictures. The story is shown when all of it is in memory, decoded: one
    /// finished picture, never the background and then the photo and then the
    /// rest. (Text, mentions and fonts are drawn from the system: nothing to
    /// wait for.)
    static func assets(of story: Story, serverIcon: (String) -> String? = { _ in nil }) -> [URL] {
        var urls: [URL] = []
        func add(_ url: URL?) {
            if let url, !urls.contains(url) { urls.append(url) }
        }
        if let media = story.media { add(url(media.isVideo ? media.posterUrl : media.url)) }
        for layer in story.layers {
            switch layer.content {
            case .image(let picture), .drawing(let picture): add(url(picture.url))
            case .call(let serverId, _):
                for asset in callAssets(story: story, serverId: serverId, serverIcon: serverIcon) { add(asset) }
            default: break
            }
        }
        return urls
    }

    static func hasCallLayer(_ story: Story) -> Bool {
        story.layers.contains { if case .call = $0.content { true } else { false } }
    }

    /// The viewer's window: the story on screen (its pictures only, its player
    /// is the viewer's own) and the stories ahead of it, in the order they will
    /// be needed.
    static func window(
        current: Story?, ahead: [Story], lowData: Bool, serverIcon: (String) -> String? = { _ in nil }
    ) -> [StoryPreloadItem] {
        var result = current.map { items(for: [$0], lowData: lowData, serverIcon: serverIcon).filter { !$0.isVideo } } ?? []
        for item in items(for: ahead, lowData: lowData, serverIcon: serverIcon) where !result.contains(item) { result.append(item) }
        return result
    }

    /// The tray's pick: the first unseen story of each of the first three
    /// rings (the first one, when every story in a ring is seen).
    static func trayStoryIds(_ strip: StoryStrip, rings: Int = 3) -> [String] {
        strip.items.prefix(rings).compactMap { item in
            item.unseen ? item.storyIds.first : nil
        }
    }

    private static func url(_ raw: String?) -> URL? {
        guard let raw, !raw.isEmpty else { return nil }
        return Avatar.resolve(raw) ?? URL(string: raw)
    }
}

extension StoryPlayback {
    /// What to have ready: the story on screen, the next two of the queue
    /// across authors, and the next author's first. The order is the order
    /// they will be needed in.
    var windowIds: [String] {
        // Walks forward from where the viewer is, three stories, without
        // building the whole queue.
        var ids: [String] = []
        var p = person
        var i = index
        while ids.count < 3, people.indices.contains(p) {
            if people[p].indices.contains(i) {
                ids.append(people[p][i])
                i += 1
            } else {
                p += 1
                i = 0
            }
        }
        if people.indices.contains(person + 1), let first = people[person + 1].first, !ids.contains(first) {
            ids.append(first)
        }
        return ids
    }
}

// MARK: - The preloader

@MainActor
final class StoryPreloader {
    static let shared = StoryPreloader()

    /// Decoded pictures, by URL. Bounded by bytes: a story picture decoded is
    /// a few megabytes.
    private let images: NSCache<NSURL, UIImage> = {
        let cache = NSCache<NSURL, UIImage>()
        cache.totalCostLimit = 96 * 1024 * 1024
        cache.countLimit = 40
        return cache
    }()

    /// Stories already read from the API, so opening one from the tray does
    /// not wait on a round trip first. Short-lived on purpose: a story's
    /// viewer state and call roster move.
    private var stories: [String: (story: Story, at: Date)] = [:]
    static let storyTTL: TimeInterval = 60
    static let storyCap = 60

    private var running: [String: Task<Void, Never>] = [:]
    private var inflight: [URL: Task<UIImage?, Never>] = [:]
    private var pending: [StoryPreloadItem] = []
    private var wanted: Set<String> = []
    private var warmed: Set<String> = []
    private var players: [URL: AVPlayer] = [:]

    private let constrained = OSAllocatedUnfairLock(initialState: false)
    private let monitor = NWPathMonitor()

    /// Counters a test or a measurement reads.
    private(set) var started: [String] = []
    private(set) var cancelled: [String] = []
    private(set) var peakConcurrent = 0
    /// Set by a test to stand in for the network.
    var imageFetcher: (@Sendable (URL) async -> UIImage?)?

    init() {
        monitor.pathUpdateHandler = { [constrained] path in
            let wasConstrained = constrained.withLock { value -> Bool in
                let before = value
                value = path.isConstrained
                return before
            }
            // Low Data Mode came on or went off: videos stop buffering, or the
            // ones the window still wants start.
            if path.isConstrained != wasConstrained {
                Task { @MainActor in StoryPreloader.shared.replan() }
            }
        }
        monitor.start(queue: DispatchQueue.global(qos: .utility))
    }

    /// Set by a test; nil follows the network path.
    var lowDataOverride: Bool?

    var lowDataMode: Bool { lowDataOverride ?? constrained.withLock { $0 } }

    // MARK: Stories

    func remember(_ fetched: [Story]) {
        let now = Date()
        for story in fetched { stories[story.id] = (story, now) }
        // Short-lived and bounded: what has aged out goes, and so does the
        // oldest past the cap.
        stories = stories.filter { now.timeIntervalSince($0.value.at) < Self.storyTTL }
        if stories.count > Self.storyCap {
            let keep = stories.sorted { $0.value.at > $1.value.at }.prefix(Self.storyCap)
            stories = Dictionary(uniqueKeysWithValues: keep.map { ($0.key, $0.value) })
        }
    }

    /// Another account, or none: nothing one person's viewer saw (a reaction,
    /// what is seen) may initialise the next one's.
    func reset() {
        stories.removeAll()
        warmed.removeAll()
        setWindow([])
        images.removeAllObjects()
    }

    func cachedStory(_ id: String, now: Date = Date()) -> Story? {
        guard let hit = stories[id] else { return nil }
        guard now.timeIntervalSince(hit.at) < Self.storyTTL else {
            stories[id] = nil
            return nil
        }
        return hit.story
    }

    // MARK: Pictures

    func image(for url: URL) -> UIImage? {
        images.object(forKey: url as NSURL)
    }

    /// The picture, for a view that needs it now: from memory, or from the
    /// preload already fetching it, or fetched here.
    func imageForDisplay(_ url: URL) async -> UIImage? {
        if let hit = image(for: url) { return hit }
        if let job = running[StoryPreloadItem.image(url).key] {
            await job.value
            if let hit = image(for: url) { return hit }
        }
        // Whoever else wants it at this moment (the story's own pictures all
        // ask at once) shares one fetch.
        if let shared = inflight[url] { return await shared.value }
        let fetching = Task { await fetch(url) }
        inflight[url] = fetching
        let fetched = await fetching.value
        inflight[url] = nil
        if let fetched { store(fetched, for: url) }
        return fetched
    }

    /// Returns when every one of `urls` is in memory, decoded (or has failed,
    /// which is not a reason to hold a story back for ever). A few at a time:
    /// a story has a handful of pictures, and they should not become a burst of
    /// requests and decodes beside everything else the app is doing.
    func ensure(_ urls: [URL], width: Int = 4) async {
        let missing = urls.filter { image(for: $0) == nil }
        guard !missing.isEmpty else { return }
        await withTaskGroup(of: Void.self) { group in
            var rest = missing.makeIterator()
            for _ in 0..<width {
                guard let url = rest.next() else { break }
                group.addTask { [self] in _ = await imageForDisplay(url) }
            }
            while await group.next() != nil {
                if let url = rest.next() {
                    group.addTask { [self] in _ = await imageForDisplay(url) }
                }
            }
        }
    }

    private func fetch(_ url: URL) async -> UIImage? {
        if let imageFetcher { return await imageFetcher(url) }
        return await Self.download(url)
    }

    private func store(_ image: UIImage, for url: URL) {
        let cost = Int(image.size.width * image.scale * image.size.height * image.scale * 4)
        images.setObject(image, forKey: url as NSURL, cost: cost)
    }

    nonisolated private static func download(_ url: URL) async -> UIImage? {
        guard let (data, response) = try? await URLSession.shared.data(from: url),
              (response as? HTTPURLResponse).map({ (200..<300).contains($0.statusCode) }) ?? true,
              let image = UIImage(data: data)
        else { return nil }
        // Decoded here, off the main thread, so the first frame is a blit.
        return await image.byPreparingForDisplay() ?? image
    }

    // MARK: Video

    /// A player that was buffering for `url`, if there is one. It is the
    /// caller's now: paused at the start, so it plays what it already has.
    func takePlayer(for url: URL) -> AVPlayer? {
        guard let player = players.removeValue(forKey: url) else { return nil }
        running[StoryPreloadItem.video(url).key]?.cancel()
        running[StoryPreloadItem.video(url).key] = nil
        return player
    }

    // MARK: The window

    /// The window as the caller set it, videos and all: Low Data Mode filters
    /// what is run, never what is wanted, so it can be undone.
    private var lastWindow: [StoryPreloadItem] = []

    /// The connection changed (Low Data Mode on or off): run the window again.
    func replan() {
        apply(lastWindow)
    }

    /// Sets what is worth having. Whatever was being fetched and is not in
    /// `items` any more is cancelled (a swipe past it, a closed viewer); the
    /// rest is started, two at a time, in order. No video runs on Low Data Mode.
    func setWindow(_ items: [StoryPreloadItem]) {
        lastWindow = items
        apply(items)
    }

    private func apply(_ wantedItems: [StoryPreloadItem]) {
        let items = lowDataMode ? wantedItems.filter { !$0.isVideo } : wantedItems
        wanted = Set(items.map(\.key))
        for (key, task) in running where !wanted.contains(key) {
            task.cancel()
            running[key] = nil
            cancelled.append(key)
        }
        for url in players.keys where !wanted.contains(StoryPreloadItem.video(url).key) {
            release(players.removeValue(forKey: url))
        }
        pending = items.filter { item in
            guard running[item.key] == nil else { return false }
            switch item {
            case .image(let url): return image(for: url) == nil
            case .video(let url): return players[url] == nil
            case .warm: return !warmed.contains(item.key)
            }
        }
        pump()
    }

    /// Nothing is wanted: the viewer closed.
    func clearWindow() {
        setWindow([])
    }

    private func pump() {
        while running.count < StoryPreloadPlan.maxConcurrent, !pending.isEmpty {
            let item = pending.removeFirst()
            guard wanted.contains(item.key) else { continue }
            started.append(item.key)
            let key = item.key
            running[key] = Task { [weak self] in
                await self?.run(item)
                guard !Task.isCancelled else { return }
                self?.finished(key)
            }
            peakConcurrent = max(peakConcurrent, running.count)
        }
    }

    private func finished(_ key: String) {
        running[key] = nil
        pump()
    }

    private func run(_ item: StoryPreloadItem) async {
        switch item {
        case .image(let url):
            if let image = await fetch(url), !Task.isCancelled { store(image, for: url) }
        case .warm(let url):
            _ = try? await URLSession.shared.data(from: url)
            if !Task.isCancelled { warmed.insert(item.key) }
        case .video(let url):
            await bufferVideo(url)
        }
    }

    /// Buffers a few seconds and prerolls, so the first frame is on screen as
    /// the player is. The player is kept (not just the bytes) because the
    /// buffered data lives in it.
    private func bufferVideo(_ url: URL) async {
        let item = AVPlayerItem(url: url)
        item.preferredForwardBufferDuration = 4
        let player = AVPlayer(playerItem: item)
        player.automaticallyWaitsToMinimizeStalling = false
        player.isMuted = true
        players[url] = player
        while !Task.isCancelled {
            switch item.status {
            case .readyToPlay:
                _ = await player.preroll(atRate: 1)
                return
            case .failed:
                if players[url] === player { players[url] = nil }
                release(player)
                return
            default:
                try? await Task.sleep(for: .milliseconds(50))
            }
        }
        // Cancelled while buffering: only its own player is let go (a taker
        // may already hold it).
        if players[url] === player {
            players[url] = nil
            release(player)
        }
    }

    private func release(_ player: AVPlayer?) {
        player?.pause()
        player?.replaceCurrentItem(with: nil)
    }
}

// MARK: - A picture that is there already

/// An image that draws from memory on its first frame when the preloader has
/// it (no placeholder, no spinner), and otherwise loads it. `placeholder`
/// is told whether the load failed.
struct StoryCachedImage<Placeholder: View>: View {
    let url: URL
    var contentMode: ContentMode = .fill
    /// Names the `StoryMetrics` mark made when this picture is on screen.
    var metric: String?
    /// Called once the picture is on screen, or has failed to be: the point a
    /// story's timer may start.
    var onSettled: (() -> Void)?
    @ViewBuilder var placeholder: (_ failed: Bool) -> Placeholder

    @State private var loaded: (url: URL, image: UIImage)?
    @State private var failedUrl: URL?

    var body: some View {
        // Read synchronously: the first render of a preloaded story is the
        // picture itself.
        let image = (loaded?.url == url ? loaded?.image : nil) ?? StoryPreloader.shared.image(for: url)
        Group {
            if let image {
                Image(uiImage: image).resizable().aspectRatio(contentMode: contentMode)
            } else {
                placeholder(failedUrl == url)
            }
        }
        .onAppear {
            if let metric, image != nil { StoryMetrics.mark("frame." + metric) }
            if image != nil { onSettled?() }
        }
        .task(id: url) {
            guard StoryPreloader.shared.image(for: url) == nil else { return }
            if let fetched = await StoryPreloader.shared.imageForDisplay(url) {
                loaded = (url, fetched)
                if let metric { StoryMetrics.mark("frame." + metric) }
                onSettled?()
            } else if !Task.isCancelled {
                failedUrl = url
                onSettled?()
            }
        }
    }
}

/// A face drawn from the preloader's memory: the monogram under it, the
/// picture over it the instant it is there. The call card uses this so its
/// faces are part of the story's one reveal, not pictures that pop in later.
struct StoryAvatar: View {
    let name: String
    let seed: String
    let size: CGFloat
    let url: String?

    var body: some View {
        ZStack {
            Avatar(name: name, seed: seed, size: size, url: nil)
            if let resolved = Avatar.resolve(url) {
                StoryCachedImage(url: resolved, contentMode: .fill) { _ in Color.clear }
                    .frame(width: size, height: size)
                    .clipShape(Circle())
            }
        }
        .frame(width: size, height: size)
    }
}
