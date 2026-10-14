import Foundation
import Observation

// UPLOADING AHEAD OF POST.
//
// A story's bytes are final long before the author taps Post: a photo the
// moment it is taken, a clip once it is trimmed, a placed photo the moment it
// is added. So they go up then, in the background, to a URL the server gives
// for a file that has no story yet (`POST /api/stories/uploads`). Post then has
// nothing left to send but one small request that claims them by id, and the
// ring completes almost at once. Throwing a draft away (the X, removing a
// photo, re-trimming) aborts what is in flight and deletes what is up.
//
// Never blocks the editor, never shows an error: a file that fell over is just
// sent again when Post is tapped, the old way.

/// One file on its way up before its story exists.
final class StoryEagerFile: @unchecked Sendable {
    /// `base`, or `layer:<layer id>`.
    let key: String
    let kind: String
    let contentType: String
    let byteSize: Int
    /// What the file was when it started: a change means a new upload.
    let fingerprint: Int
    /// The copy this upload reads from, removed when it ends.
    let fileURL: URL

    private let lock = NSLock()
    private var sent: Int64 = 0
    private var minted: String?
    private var succeeded = false
    /// A DELETE was sent for it on purpose (the file was thrown away).
    private var deleteSent = false
    private var sink: (@Sendable (Int64) -> Void)?
    private(set) var task: Task<String, any Error>?

    init(key: String, kind: String, contentType: String, byteSize: Int, fingerprint: Int, fileURL: URL) {
        self.key = key
        self.kind = kind
        self.contentType = contentType
        self.byteSize = byteSize
        self.fingerprint = fingerprint
        self.fileURL = fileURL
    }

    /// The id the server gave, once it has: known before the bytes are up so
    /// that throwing the file away can delete it even mid-PUT.
    var uploadId: String? {
        lock.lock()
        defer { lock.unlock() }
        return minted
    }

    fileprivate func start(backend: any StoryPostBackend) {
        task = Task.detached { [self] in
            defer { try? FileManager.default.removeItem(at: fileURL) }
            let ticket = try await backend.mintUpload(kind: kind, contentType: contentType, byteLength: byteSize)
            setMinted(ticket.uploadId)
            // Thrown away while the server was answering: it is already
            // minted, so it goes straight back.
            if Task.isCancelled {
                sendDelete(backend: backend, unlessAlreadySent: true)
                throw CancellationError()
            }
            do {
                try await backend.put(file: fileURL, to: ticket.upload) { [self] bytes in
                    report(bytes)
                }
            } catch {
                // Never claimed: it would only sit in storage until the sweep.
                // (A file thrown away is deleted by `abandon`, which is what
                // cancelled this.)
                if !Task.isCancelled { sendDelete(backend: backend, unlessAlreadySent: false) }
                throw error
            }
            // Thrown away just as the last byte landed.
            if Task.isCancelled {
                sendDelete(backend: backend, unlessAlreadySent: true)
                throw CancellationError()
            }
            markSucceeded()
            return ticket.uploadId
        }
    }

    /// The DELETE goes out from its own task, never from inside the one that
    /// was cancelled: a request made by a cancelled task is cancelled with it
    /// and never leaves the phone.
    private func sendDelete(backend: any StoryPostBackend, unlessAlreadySent: Bool) {
        lock.lock()
        guard let id = minted, !(unlessAlreadySent && deleteSent) else {
            lock.unlock()
            return
        }
        deleteSent = true
        lock.unlock()
        Task.detached { await backend.deleteUpload(id: id) }
    }

    private func markSucceeded() {
        lock.lock()
        succeeded = true
        lock.unlock()
    }

    private func setMinted(_ id: String) {
        lock.lock()
        minted = id
        lock.unlock()
    }

    private func report(_ bytes: Int64) {
        lock.lock()
        sent = bytes
        let sink = sink
        lock.unlock()
        sink?(bytes)
    }

    /// A post takes over the progress of an upload that is already running.
    func attach(_ sink: @escaping @Sendable (Int64) -> Void) {
        lock.lock()
        self.sink = sink
        let current = sent
        lock.unlock()
        if current > 0 { sink(current) }
    }

    /// Stops it and deletes what the server holds for it: the PUT is aborted
    /// and the DELETE goes out beside it, from a task of its own. An upload
    /// that has no id yet (the server is still answering the mint) deletes
    /// itself the moment it has one.
    func abandon(backend: any StoryPostBackend) {
        task?.cancel()
        sendDelete(backend: backend, unlessAlreadySent: false)
    }
}

/// What the editor wants uploaded right now.
struct StoryEagerWant: Sendable {
    let key: String
    let kind: String
    let contentType: String
    let byteSize: Int
    let fingerprint: Int
    var data: Data? = nil
    var fileURL: URL? = nil

    static func baseKey() -> String { "base" }
    static func layerKey(_ layerId: String) -> String { "layer:" + layerId }

    /// Same bytes, same fingerprint, within one run: enough to tell an edited
    /// drawing from an untouched one.
    static func fingerprint(of data: Data) -> Int {
        var hasher = Hasher()
        hasher.combine(data)
        return hasher.finalize()
    }
}

/// The composer's uploads: reconciled against what the editor holds whenever
/// it changes.
@MainActor
final class StoryEagerUploads {
    private let backend: any StoryPostBackend
    /// Off when the server does not offer eager uploads: every call is then a
    /// no-op and posting is the old create, PUT, publish.
    let enabled: Bool
    private(set) var files: [String: StoryEagerFile] = [:]

    init(backend: any StoryPostBackend, enabled: Bool) {
        self.backend = backend
        self.enabled = enabled
    }

    /// Starts what is new, and abandons what is gone or changed.
    func sync(_ wants: [StoryEagerWant]) {
        guard enabled else { return }
        let wanted = Dictionary(wants.map { ($0.key, $0) }, uniquingKeysWith: { _, last in last })
        for (key, file) in files where wanted[key]?.fingerprint != file.fingerprint {
            file.abandon(backend: backend)
            files[key] = nil
        }
        for want in wants where files[want.key] == nil {
            guard let file = prepare(want) else { continue }
            files[want.key] = file
            file.start(backend: backend)
        }
    }

    /// The draft was thrown away: everything in flight stops, everything up goes.
    func discardAll() {
        for file in files.values { file.abandon(backend: backend) }
        files.removeAll()
    }

    /// Post: the files now belong to the post, which claims them by id.
    func release() -> [String: StoryEagerFile] {
        defer { files.removeAll() }
        return files
    }

    private func prepare(_ want: StoryEagerWant) -> StoryEagerFile? {
        let url = FileManager.default.temporaryDirectory.appendingPathComponent("story-eager-\(UUID().uuidString).bin")
        do {
            // Its own copy: the composer deletes what it was handed the moment
            // it closes, which can be while this is still going up.
            if let source = want.fileURL {
                try FileManager.default.copyItem(at: source, to: url)
            } else if let data = want.data {
                try data.write(to: url, options: .atomic)
            } else {
                return nil
            }
        } catch {
            return nil
        }
        return StoryEagerFile(
            key: want.key, kind: want.kind, contentType: want.contentType,
            byteSize: want.byteSize, fingerprint: want.fingerprint, fileURL: url
        )
    }
}

// MARK: - Claiming them

extension CreateStoryRequest {
    /// This request with its files named by upload id, to publish in the same
    /// call. A layer's id is in its JSON; the base has its own field.
    func claiming(_ ids: [String: String]) -> CreateStoryRequest {
        var request = self
        if let base = ids[StoryEagerWant.baseKey()], var media = request.media {
            media.uploadId = base
            request.media = media
        }
        if var layers = request.layers {
            for index in layers.indices {
                guard let layerId = layers[index]["id"]?.stringValue,
                      let uploadId = ids[StoryEagerWant.layerKey(layerId)],
                      var upload = layers[index]["upload"]
                else { continue }
                upload["uploadId"] = .string(uploadId)
                layers[index]["upload"] = upload
            }
            request.layers = layers
        }
        request.publish = true
        return request
    }
}
