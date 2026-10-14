import Foundation
import Observation
import UIKit

// POSTING A STORY IN THE BACKGROUND.
//
// Tapping "Postar story" used to hold the sheet open until the create, every
// PUT and the publish had come back: on a slow connection that is a spinner
// the size of the upload. Now the tap hands everything to this queue and the
// composer closes at once. The queue keeps the story on disk (so leaving the
// composer, a relaunch or a dead connection never loses it), runs create, the
// PUTs and publish on its own, reports a progress fraction the person's own
// ring draws, and on a failure keeps the draft until it is retried or
// discarded.

// MARK: - What is kept

/// A file a post still has to upload, inside the post's folder.
struct StoryPostFile: Codable, Hashable, Sendable {
    let name: String
    let contentType: String
    let byteSize: Int
}

/// A post, as it is kept on disk next to its files.
struct StoryPostRecord: Codable, Sendable {
    let id: String
    /// Whose it is: a signed-out account's draft is not the next one's.
    var userId: String?
    /// The create body, sent as it was built. Its `requestId` is made once, so
    /// a retry after a lost answer is the same story, not a second one.
    var request: CreateStoryRequest
    var base: StoryPostFile?
    /// By layer id.
    var layerFiles: [String: StoryPostFile]
    /// Set once the server minted it, so discarding the draft can delete it.
    var storyId: String?
    let createdAt: Date
    /// The files go up as eager uploads and the create claims them by id,
    /// publishing in the same call. Off with a server that has none.
    var eager: Bool?
    /// The upload ids already in storage, by file key (`base`, `layer:<id>`),
    /// kept so a retry sends only what is missing.
    var uploadIds: [String: String]?

    var serverIds: [String] { request.audiences.serverIds }
    var includesFriends: Bool { request.audiences.friends }

    /// The files this post sends, base first.
    var items: [StoryPostItem] {
        var result: [StoryPostItem] = []
        if let base { result.append(StoryPostItem(key: StoryEagerWant.baseKey(), kind: "base", file: base)) }
        for (layerId, file) in layerFiles.sorted(by: { $0.key < $1.key }) {
            result.append(StoryPostItem(key: StoryEagerWant.layerKey(layerId), kind: "layer", file: file))
        }
        return result
    }

    var usesEagerUploads: Bool { eager == true && !items.isEmpty }

    /// Every byte this post sends.
    var totalBytes: Int {
        (base?.byteSize ?? 0) + layerFiles.values.reduce(0) { $0 + $1.byteSize }
    }
}

/// One file of a post, with the key an eager upload is known by.
struct StoryPostItem: Sendable {
    let key: String
    /// `base` or `layer`, as the upload endpoint takes it.
    let kind: String
    let file: StoryPostFile
}

/// Bytes handed to the queue: in memory (a photo) or already a file (a video
/// export, which is copied, never read whole).
struct StoryPostBytes: Sendable {
    let contentType: String
    var data: Data? = nil
    var fileURL: URL? = nil
}

/// The post folders, one directory per post under Application Support.
struct StoryPostStore: Sendable {
    let root: URL

    static var standard: StoryPostStore {
        let base = (try? FileManager.default.url(
            for: .applicationSupportDirectory, in: .userDomainMask, appropriateFor: nil, create: true
        )) ?? FileManager.default.temporaryDirectory
        return StoryPostStore(root: base.appendingPathComponent("StoryPosts", isDirectory: true))
    }

    func folder(_ id: String) -> URL { root.appendingPathComponent(id, isDirectory: true) }
    func fileURL(_ record: StoryPostRecord, _ file: StoryPostFile) -> URL { folder(record.id).appendingPathComponent(file.name) }
    private func recordURL(_ id: String) -> URL { folder(id).appendingPathComponent("post.json") }

    /// Writes the record and its files. A file that is already on disk is
    /// copied (a clone on APFS, so a 20 MB video costs nothing), and the copy
    /// is what the post uploads from, whatever happens to the original.
    func create(
        id: String, userId: String?, request: CreateStoryRequest,
        base: StoryPostBytes?, layers: [String: StoryPostBytes], eager: Bool = false
    ) throws -> StoryPostRecord {
        let directory = folder(id)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        var baseFile: StoryPostFile?
        var layerFiles: [String: StoryPostFile] = [:]
        do {
            if let base { baseFile = try write(base, name: "base.bin", in: directory) }
            for (layerId, bytes) in layers {
                // A layer id is the editor's own uuid; keep only what is safe in a name.
                let safe = layerId.filter { $0.isLetter || $0.isNumber || $0 == "-" }
                layerFiles[layerId] = try write(bytes, name: "layer-\(safe).bin", in: directory)
            }
            let record = StoryPostRecord(
                id: id, userId: userId, request: request, base: baseFile,
                layerFiles: layerFiles, storyId: nil, createdAt: Date(), eager: eager ? true : nil, uploadIds: nil
            )
            try save(record)
            return record
        } catch {
            try? FileManager.default.removeItem(at: directory)
            throw error
        }
    }

    private func write(_ bytes: StoryPostBytes, name: String, in directory: URL) throws -> StoryPostFile {
        let target = directory.appendingPathComponent(name)
        let size: Int
        if let url = bytes.fileURL {
            try? FileManager.default.removeItem(at: target)
            try FileManager.default.copyItem(at: url, to: target)
            size = (try FileManager.default.attributesOfItem(atPath: target.path)[.size] as? Int) ?? 0
        } else if let data = bytes.data {
            try data.write(to: target, options: .atomic)
            size = data.count
        } else {
            throw APIError.transport("No bytes to keep")
        }
        return StoryPostFile(name: name, contentType: bytes.contentType, byteSize: size)
    }

    func save(_ record: StoryPostRecord) throws {
        let data = try Coding.encoder.encode(record)
        try data.write(to: recordURL(record.id), options: .atomic)
    }

    func loadAll() -> [StoryPostRecord] {
        let folders = (try? FileManager.default.contentsOfDirectory(at: root, includingPropertiesForKeys: nil)) ?? []
        return folders
            .compactMap { try? Data(contentsOf: $0.appendingPathComponent("post.json")) }
            .compactMap { try? Coding.decoder.decode(StoryPostRecord.self, from: $0) }
            .sorted { $0.createdAt < $1.createdAt }
    }

    func remove(_ id: String) {
        try? FileManager.default.removeItem(at: folder(id))
    }
}

// MARK: - The network, as a seam

/// What posting needs from the network, so the queue is tested without one.
protocol StoryPostBackend: Sendable {
    func create(_ request: CreateStoryRequest) async throws -> CreateStoryResponse
    /// Publishes; answers the story's status (`live`, or `processing` for a
    /// video whose frames are still being made).
    func publish(storyId: String) async throws -> String?
    /// Where a published story stands now; nil when it is gone or unknown.
    func storyStatus(id: String) async -> String?
    /// Best effort: the server's own sweep is the backstop.
    func delete(storyId: String) async
    /// PUT a file, reporting the bytes sent so far.
    func put(file: URL, to upload: StoryUpload, progress: @escaping @Sendable (Int64) -> Void) async throws
    /// A URL for a file whose story does not exist yet.
    func mintUpload(kind: String, contentType: String, byteLength: Int) async throws -> StoryUploadTicket
    /// Throws an upload away. Best effort: the server's sweep is the backstop.
    func deleteUpload(id: String) async
}

struct LiveStoryPostBackend: StoryPostBackend {
    let api: APIClient

    func create(_ request: CreateStoryRequest) async throws -> CreateStoryResponse {
        #if DEBUG
        // A UI test's way to make the first post fail once, as a dead
        // connection would, and prove the draft survives to be retried.
        if ProcessInfo.processInfo.environment["PQP_STORY_POST_FAIL"] == "once", Self.failures.take() {
            throw APIError.transport("simulated")
        }
        #endif
        return try await api.createStory(request)
    }

    #if DEBUG
    private static let failures = OneShot()
    private final class OneShot: @unchecked Sendable {
        private let lock = NSLock()
        private var spent = false
        func take() -> Bool {
            lock.lock()
            defer { lock.unlock() }
            defer { spent = true }
            return !spent
        }
    }
    #endif

    func publish(storyId: String) async throws -> String? {
        try await api.publishStory(id: storyId).own?.status
    }

    func storyStatus(id: String) async -> String? {
        try? await api.stories(ids: [id]).first?.own?.status
    }

    func delete(storyId: String) async {
        try? await api.deleteStory(id: storyId)
    }

    func put(file: URL, to upload: StoryUpload, progress: @escaping @Sendable (Int64) -> Void) async throws {
        try await StoryUploader.put(fileAt: file, to: upload, progress: progress)
    }

    func mintUpload(kind: String, contentType: String, byteLength: Int) async throws -> StoryUploadTicket {
        try await api.mintStoryUpload(kind: kind, contentType: contentType, byteLength: byteLength)
    }

    func deleteUpload(id: String) async {
        try? await api.deleteStoryUpload(id: id)
    }
}

// MARK: - Progress

/// Bytes sent across every file of one post, as the fraction the ring draws.
/// A class with a lock because upload callbacks arrive on URLSession's queue.
///
/// "Sent" is bytes handed to the socket, which on a fast uplink or a big send
/// buffer runs ahead of what the server has: a file counts for at most
/// `heldBack` of its size until the server has answered its PUT, so the ring
/// never reads full while the story is still on its way.
final class StoryPostProgress: @unchecked Sendable {
    static let heldBack = 0.9

    private let lock = NSLock()
    private let sizes: [Int64]
    private let total: Int64
    private var sent: [Int: Int64] = [:]
    private var finished: Set<Int> = []
    private var lastReported = -1.0

    init(fileSizes: [Int]) {
        sizes = fileSizes.map { Int64(max(0, $0)) }
        total = sizes.reduce(0, +)
    }

    /// The new fraction when it moved by a percent or more, else nil: a ring
    /// does not need thirty updates a second.
    func record(file index: Int, sent bytes: Int64) -> Double? {
        lock.lock()
        defer { lock.unlock() }
        sent[index] = bytes
        return fraction()
    }

    /// Where it stands, whether or not it moved.
    var current: Double {
        lock.lock()
        defer { lock.unlock() }
        return lastReported < 0 ? 0 : lastReported
    }

    /// The server answered this file's PUT: it counts in full.
    func complete(file index: Int) -> Double? {
        lock.lock()
        defer { lock.unlock() }
        finished.insert(index)
        return fraction()
    }

    private func fraction() -> Double? {
        guard total > 0 else { return nil }
        var counted = 0.0
        for (index, size) in sizes.enumerated() {
            if finished.contains(index) {
                counted += Double(size)
            } else {
                counted += min(Double(sent[index] ?? 0), Double(size) * Self.heldBack)
            }
        }
        let value = min(1, counted / Double(total))
        let moved = value - lastReported >= 0.01
        let done = value >= 1 && lastReported < 1
        guard moved || done else { return nil }
        lastReported = value
        return value
    }
}

// MARK: - The queue

@MainActor
@Observable
final class StoryPostQueue {
    enum Phase: Equatable, Sendable {
        case posting
        /// Published; a video's frames are still being made, and the story is
        /// not on the strip yet. The ring stays until it is.
        case processing
        case failed(String)
    }

    struct Job: Identifiable, Sendable {
        let id: String
        var record: StoryPostRecord
        var phase: Phase = .posting
        /// 0...1 of the bytes sent; 0 while the story is being created.
        var progress: Double = 0

        var failed: Bool {
            if case .failed = phase { return true }
            return false
        }

        var failureMessage: String? {
            if case .failed(let message) = phase { return message }
            return nil
        }

        /// Whether this post is going to the strip of `scope`.
        func targets(_ scope: StoryScope) -> Bool {
            switch scope {
            case .server(let id, _): record.serverIds.contains(id)
            case .friends: record.includesFriends
            }
        }
    }

    private(set) var jobs: [Job] = []
    /// Counts posts that went live, so a strip can read the server again.
    private(set) var publishedCount = 0

    @ObservationIgnored private let backend: any StoryPostBackend
    @ObservationIgnored private let store: StoryPostStore
    @ObservationIgnored private var tasks: [String: Task<Void, Never>] = [:]
    /// Posts waiting for one of the running slots, oldest first.
    @ObservationIgnored private var waiting: [String] = []
    /// A phone's uplink is shared: two stories at a time, the rest in line.
    static let maxRunning = 2
    @ObservationIgnored private var backgroundTasks: [String: UIBackgroundTaskIdentifier] = [:]
    /// Uploads that started in the composer, by post, until the post has
    /// claimed or dropped them.
    @ObservationIgnored private var early: [String: [String: StoryEagerFile]] = [:]
    @ObservationIgnored private var ownerId: String?
    @ObservationIgnored private let usesBackgroundTime: Bool
    /// Watchers of stories that are published but not yet live.
    @ObservationIgnored private var watchers: [String: Task<Void, Never>] = [:]
    @ObservationIgnored private let processingPoll: Duration

    init(
        backend: any StoryPostBackend, store: StoryPostStore = .standard, usesBackgroundTime: Bool = true,
        processingPoll: Duration = .seconds(2)
    ) {
        self.backend = backend
        self.store = store
        self.usesBackgroundTime = usesBackgroundTime
        self.processingPoll = processingPoll
    }

    /// What a strip draws on the person's own ring: a post in flight to that
    /// scope, or one that failed (a failure shows everywhere, so it is never
    /// silent behind a screen that is not the one it was aimed at).
    func job(for scope: StoryScope) -> Job? {
        jobs.first { $0.targets(scope) || $0.failed }
    }

    func job(id: String) -> Job? { jobs.first { $0.id == id } }

    /// The composer's uploads: ahead of Post when the server offers them.
    func makeEagerUploads(enabled: Bool) -> StoryEagerUploads {
        StoryEagerUploads(backend: backend, enabled: enabled)
    }

    var isPosting: Bool { jobs.contains { !$0.failed } }

    // MARK: Enqueue, retry, discard

    /// Keeps the post on disk and starts it. Throws, with nothing started,
    /// when the files cannot be kept (the disk is full): the composer then
    /// stays open and says so.
    ///
    /// `eager`: the files the composer already started uploading. They are the
    /// post's now; any it has none for are sent with it.
    @discardableResult
    func enqueue(
        request: CreateStoryRequest, base: StoryPostBytes?, layers: [String: StoryPostBytes], userId: String?,
        eager: StoryEagerUploads? = nil
    ) throws -> String {
        let id = UUID().uuidString.lowercased()
        let record = try store.create(
            id: id, userId: userId, request: request, base: base, layers: layers, eager: eager?.enabled == true
        )
        if let eager, eager.enabled { early[id] = eager.release() }
        ownerId = userId
        jobs.append(Job(id: id, record: record))
        start(id)
        return id
    }

    func retry(_ id: String) {
        guard let index = jobs.firstIndex(where: { $0.id == id }), jobs[index].failed else { return }
        jobs[index].phase = .posting
        jobs[index].progress = 0
        start(id)
    }

    func discard(_ id: String) {
        tasks[id]?.cancel()
        tasks[id] = nil
        watchers.removeValue(forKey: id)?.cancel()
        waiting.removeAll { $0 == id }
        endBackgroundTime(id)
        let record = job(id: id)?.record
        jobs.removeAll { $0.id == id }
        store.remove(id)
        let backend = backend
        // Uploads nobody will claim: stopped if still going, deleted if up.
        for file in early.removeValue(forKey: id).map({ Array($0.values) }) ?? [] { file.abandon(backend: backend) }
        for uploadId in (record?.uploadIds).map({ Array($0.values) }) ?? [] {
            Task.detached { await backend.deleteUpload(id: uploadId) }
        }
        if let storyId = record?.storyId {
            Task.detached { await backend.delete(storyId: storyId) }
        }
        pump()
    }

    /// Posts left on disk by an earlier run come back as failed ones, with the
    /// same two choices: nothing is re-sent behind the person's back.
    func restore(userId: String?) {
        ownerId = userId
        for record in store.loadAll() where record.userId == userId && !jobs.contains(where: { $0.id == record.id }) {
            var job = Job(id: record.id, record: record)
            job.phase = .failed(String(localized: "Didn't post. Try again"))
            jobs.append(job)
        }
    }

    /// Signing out: nothing of this account's stays on the phone.
    func clear() {
        for id in jobs.map(\.id) { tasks[id]?.cancel(); endBackgroundTime(id) }
        for watcher in watchers.values { watcher.cancel() }
        watchers.removeAll()
        for files in early.values { for file in files.values { file.abandon(backend: backend) } }
        early.removeAll()
        tasks.removeAll()
        waiting.removeAll()
        jobs.removeAll()
        try? FileManager.default.removeItem(at: store.root)
    }

    // MARK: Running

    private func start(_ id: String) {
        beginBackgroundTime(id)
        waiting.append(id)
        pump()
    }

    /// Starts waiting posts while there is a free slot.
    private func pump() {
        while tasks.count < Self.maxRunning, !waiting.isEmpty {
            let id = waiting.removeFirst()
            guard job(id: id) != nil else { continue }
            tasks[id] = Task { [weak self] in
                await self?.execute(id)
            }
        }
    }

    private func execute(_ id: String) async {
        guard var record = job(id: id)?.record else { return }
        do {
            if record.usesEagerUploads {
                do {
                    try await executeEager(id, &record)
                    return
                } catch APIError.server(let status, _) where (400..<500).contains(status) && status != 429 {
                    // The server would not take the uploads it was handed (gone,
                    // claimed, not what was declared): the old way, the files go
                    // up on the URLs the create hands back.
                    let backend = backend
                    for file in early.removeValue(forKey: id).map({ Array($0.values) }) ?? [] { file.abandon(backend: backend) }
                    for uploadId in (record.uploadIds ?? [:]).values {
                        Task.detached { await backend.deleteUpload(id: uploadId) }
                    }
                    record.uploadIds = nil
                    record.eager = nil
                    try? store.save(record)
                    update(id) { $0.record = record }
                }
            }
            try await executeClassic(id, &record)
        } catch {
            guard !Task.isCancelled, !error.isCancellation else { return }
            fail(id, error)
        }
    }

    /// A create that answered after the post was discarded: the story it made
    /// would sit pending with nobody holding its id, so it goes now.
    private func settleDiscard(_ created: CreateStoryResponse) async throws {
        if Task.isCancelled {
            // From a task of its own: a request made by this cancelled one
            // would be cancelled with it.
            let backend = backend
            let storyId = created.story.id
            Task.detached { await backend.delete(storyId: storyId) }
            throw CancellationError()
        }
    }

    /// Create, PUT every file on the URL the create returns, publish.
    private func executeClassic(_ id: String, _ record: inout StoryPostRecord) async throws {
        let created = try await backend.create(record.request)
        try await settleDiscard(created)
        record.storyId = created.story.id
        try? store.save(record)
        update(id) { $0.record.storyId = created.story.id }

        // Every file goes up before the story is published: the base photo
        // or video, and each placed photo and the drawing, all at once (they
        // are independent, and the post waits for the slowest, not the sum).
        var files: [(url: URL, size: Int, upload: StoryUpload)] = []
        if let upload = created.upload, let base = record.base {
            files.append((store.fileURL(record, base), base.byteSize, upload))
        }
        for target in created.layerUploads {
            guard let file = record.layerFiles[target.layerId] else { continue }
            files.append((
                store.fileURL(record, file), file.byteSize,
                StoryUpload(url: target.url, method: target.method, headers: target.headers)
            ))
        }
        let tracker = StoryPostProgress(fileSizes: files.map(\.size))
        let backend = backend
        try await withThrowingTaskGroup(of: Void.self) { group in
            for (index, file) in files.enumerated() {
                group.addTask { [weak self] in
                    try await backend.put(file: file.url, to: file.upload) { sent in
                        guard let fraction = tracker.record(file: index, sent: sent) else { return }
                        Task { @MainActor in self?.update(id) { $0.progress = fraction } }
                    }
                    if let fraction = tracker.complete(file: index) {
                        await self?.update(id) { $0.progress = fraction }
                    }
                }
            }
            try await group.waitForAll()
        }
        try Task.checkCancellation()
        // A story with nothing to upload (text, a call, a mention) is live
        // on the create answer and has nothing to publish.
        var status = created.story.own?.status
        if created.upload != nil || !created.layerUploads.isEmpty {
            status = try await backend.publish(storyId: created.story.id)
        }
        update(id) { $0.progress = 1 }
        StoryMetrics.mark("post.live")
        finish(id, storyStatus: status)
    }

    /// Every file is an upload by id (most already up, from the composer),
    /// then ONE request claims them and publishes: with the bytes already in
    /// storage, Post is a single small call.
    private func executeEager(_ id: String, _ record: inout StoryPostRecord) async throws {
        let items = record.items
        let tracker = StoryPostProgress(fileSizes: items.map(\.file.byteSize))
        var ids = record.uploadIds ?? [:]
        for (index, item) in items.enumerated() where ids[item.key] != nil { _ = tracker.complete(file: index) }
        update(id) { $0.progress = tracker.current }

        let snapshot = record
        try await withThrowingTaskGroup(of: (String, String).self) { group in
            for (index, item) in items.enumerated() where ids[item.key] == nil {
                group.addTask { [weak self] in
                    guard let self else { throw CancellationError() }
                    let uploadId = try await self.uploadId(for: item, in: snapshot, jobId: id, index: index, tracker: tracker)
                    return (item.key, uploadId)
                }
            }
            for try await (key, uploadId) in group {
                ids[key] = uploadId
                record.uploadIds = ids
                try? store.save(record)
                // The job holds them too: a retry reuses these uploads and a
                // discard deletes them.
                update(id) { $0.record.uploadIds = ids }
            }
        }
        try Task.checkCancellation()
        early[id] = nil

        let created = try await createClaiming(record.request.claiming(ids))
        try await settleDiscard(created)
        record.storyId = created.story.id
        try? store.save(record)
        update(id) { $0.record.storyId = created.story.id }
        // Answered published when it was one call; a replay can land a story
        // still pending.
        var status = created.story.own?.status
        if status == "pending" || created.upload != nil || !created.layerUploads.isEmpty {
            status = try await backend.publish(storyId: created.story.id)
        }
        update(id) { $0.progress = 1 }
        StoryMetrics.mark("post.live")
        finish(id, storyStatus: status)
    }

    /// The create that claims the uploads. A 409 says an object is not there
    /// yet (a PUT the server has not finished taking in): wait and send the
    /// very same create again, same `requestId`, a few times before giving up.
    private func createClaiming(_ request: CreateStoryRequest) async throws -> CreateStoryResponse {
        var attempt = 0
        while true {
            do {
                return try await backend.create(request)
            } catch APIError.server(let status, _) where status == 409 && attempt < 4 {
                attempt += 1
                try await Task.sleep(for: .milliseconds(1_500))
            }
        }
    }

    /// The upload id of one file: the composer's own upload if it has one that
    /// made it, else a fresh one from the copy kept on disk.
    private func uploadId(
        for item: StoryPostItem, in record: StoryPostRecord, jobId: String, index: Int, tracker: StoryPostProgress
    ) async throws -> String {
        let report: @Sendable (Int64) -> Void = { [weak self] sent in
            guard let fraction = tracker.record(file: index, sent: sent) else { return }
            Task { @MainActor in self?.update(jobId) { $0.progress = fraction } }
        }
        let finished: () -> Void = { [weak self] in
            guard let fraction = tracker.complete(file: index) else { return }
            Task { @MainActor in self?.update(jobId) { $0.progress = fraction } }
        }
        if let started = early[jobId]?[item.key], let task = started.task {
            started.attach(report)
            if let uploadId = try? await task.value {
                finished()
                return uploadId
            }
            try Task.checkCancellation()
        }
        let ticket = try await backend.mintUpload(kind: item.kind, contentType: item.file.contentType, byteLength: item.file.byteSize)
        do {
            try await backend.put(file: store.fileURL(record, item.file), to: ticket.upload, progress: report)
        } catch {
            let backend = backend
            let minted = ticket.uploadId
            Task.detached { await backend.deleteUpload(id: minted) }
            throw error
        }
        finished()
        return ticket.uploadId
    }

    private func finish(_ id: String, storyStatus: String? = nil) {
        tasks[id] = nil
        endBackgroundTime(id)
        // Discarded while the last request was in flight: nothing went live
        // that the person still means to be there.
        guard let record = job(id: id)?.record else { pump(); return }
        store.remove(id)
        early[id] = nil
        if storyStatus == "processing", let storyId = record.storyId {
            // Published, but a video's frames are still being made: the story
            // is not on the strip yet. The ring stays (it looks like the post
            // vanished otherwise) until the story is live.
            update(id) { $0.phase = .processing }
            watchers[id] = Task { [weak self] in await self?.waitUntilLive(id, storyId: storyId) }
        } else {
            jobs.removeAll { $0.id == id }
            publishedCount += 1
        }
        pump()
    }

    private func waitUntilLive(_ id: String, storyId: String) async {
        // Up to about three minutes; a story that will not go live is the
        // server's to say, not a ring that spins for ever.
        for _ in 0..<90 {
            try? await Task.sleep(for: processingPoll)
            guard !Task.isCancelled else { return }
            if await backend.storyStatus(id: storyId) != "processing" { break }
        }
        guard !Task.isCancelled, job(id: id) != nil else { return }
        watchers[id] = nil
        jobs.removeAll { $0.id == id }
        publishedCount += 1
    }

    private func fail(_ id: String, _ error: any Error) {
        tasks[id] = nil
        endBackgroundTime(id)
        update(id) { $0.phase = .failed(Self.message(for: error)) }
        pump()
    }

    private func update(_ id: String, _ change: (inout Job) -> Void) {
        guard let index = jobs.firstIndex(where: { $0.id == id }) else { return }
        change(&jobs[index])
    }

    /// What the person reads. Never a URLSession sentence on its own.
    static func message(for error: any Error) -> String {
        if let api = error as? APIError {
            switch api {
            case .transport: return String(localized: "Couldn't reach pqp. Check your connection.")
            default: return api.errorDescription ?? String(localized: "Didn't post. Try again")
            }
        }
        if error is URLError { return String(localized: "Couldn't reach pqp. Check your connection.") }
        return String(localized: "Didn't post. Try again")
    }

    // MARK: Background time

    /// A minute or so after the app is left, enough for a short interruption:
    /// a photo or a clip finishes uploading while the phone is in a pocket.
    private func beginBackgroundTime(_ id: String) {
        guard usesBackgroundTime, backgroundTasks[id] == nil else { return }
        let identifier = UIApplication.shared.beginBackgroundTask(withName: "story-post-\(id)") { [weak self] in
            // Out of time: give it back, and let the upload fail into the
            // retry state if the system stops it.
            Task { @MainActor in self?.endBackgroundTime(id) }
        }
        if identifier != .invalid { backgroundTasks[id] = identifier }
    }

    private func endBackgroundTime(_ id: String) {
        guard let identifier = backgroundTasks.removeValue(forKey: id) else { return }
        UIApplication.shared.endBackgroundTask(identifier)
    }
}

// MARK: - The PUT

/// The presigned PUT: exactly the headers the server signed, nothing else.
enum StoryUploader {
    /// From a file, with the bytes sent so far reported as they go. The file
    /// is streamed from disk: a clip is never held whole in memory.
    ///
    /// "Sent" is what URLSession has handed to the connection, which on a small
    /// file is all of it long before the network has taken it (the OS buffers
    /// hundreds of kilobytes). That is why `StoryPostProgress` holds a file
    /// back until the server has answered.
    static func put(fileAt file: URL, to upload: StoryUpload, progress: @escaping @Sendable (Int64) -> Void) async throws {
        let request = try makeRequest(upload)
        let delegate = ProgressDelegate(progress)
        let (_, response) = try await session.upload(for: request, fromFile: file, delegate: delegate)
        try check(response)
    }

    /// Its own session: a patient one. The API's session gives up on a request
    /// after 30 s, which is a whole video on a slow connection.
    private static let session: URLSession = {
        let config = URLSessionConfiguration.default
        config.waitsForConnectivity = false
        config.timeoutIntervalForRequest = 60
        config.timeoutIntervalForResource = 15 * 60
        config.urlCache = nil
        return URLSession(configuration: config)
    }()

    private static func makeRequest(_ upload: StoryUpload) throws -> URLRequest {
        guard let url = URL(string: upload.url) else { throw APIError.transport("Bad upload URL") }
        var request = URLRequest(url: url)
        request.httpMethod = upload.method
        for (name, value) in upload.headers {
            request.setValue(value, forHTTPHeaderField: name)
        }
        return request
    }

    private static func check(_ response: URLResponse) throws {
        guard let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode) else {
            throw APIError.transport(String(localized: "Didn't upload. Try again"))
        }
    }

    private final class ProgressDelegate: NSObject, URLSessionTaskDelegate, @unchecked Sendable {
        let report: @Sendable (Int64) -> Void
        init(_ report: @escaping @Sendable (Int64) -> Void) { self.report = report }

        func urlSession(
            _ session: URLSession, task: URLSessionTask,
            didSendBodyData bytesSent: Int64, totalBytesSent: Int64, totalBytesExpectedToSend: Int64
        ) {
            report(totalBytesSent)
        }
    }
}
