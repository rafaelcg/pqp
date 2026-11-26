import ImageIO
import Observation
import PhotosUI
import SwiftUI
import UIKit

// EDITING A SONG: the order of things behind the sheet (`jam-edit-sheet.tsx`).
//
// THE COVER IS SENT WHEN IT IS PICKED, CLAIMED WHEN THEY SAVE. Picking a photo
// checks it BEFORE anything is encoded (a picture this phone cannot open, one
// too small to be a cover), crops it to a square JPEG here (the API never
// decodes an image), asks for a ticket for exactly that many bytes and PUTs the
// bytes straight to storage while the person goes on typing. Nothing about the
// song changes until Save, which claims the upload, so closing the sheet leaves
// the old cover as it was; the server sweeps an unclaimed object an hour later.
// Save sends only what changed, in the order name, then picture, and each
// answer is applied to the song the way its `jam-song-updated` frame is.

/// A picked photo, ready to send: the square JPEG and the picture it shows.
struct JamPreparedCover: @unchecked Sendable {
    let jpeg: Data
    let preview: UIImage
}

enum JamCoverPrep {
    /// What is wrong with a picked file, or the cover to send. Runs off the
    /// main actor: a phone photo is tens of megapixels, so it is scaled while
    /// it is read (ImageIO's thumbnailer) and never held whole.
    static func prepare(data: Data) -> Result<JamPreparedCover, JamCoverRules.Problem> {
        prepare(source: CGImageSourceCreateWithData(data as CFData, nil))
    }

    /// The same, from a file the library handed over: the encoded original is
    /// read by ImageIO as it needs it and never held whole in memory.
    static func prepare(file: URL, cancelled: () -> Bool = { false }) -> Result<JamPreparedCover, JamCoverRules.Problem> {
        prepare(source: CGImageSourceCreateWithURL(file as CFURL, nil), cancelled: cancelled)
    }

    /// One decode at a time, whatever the number of sheets that were opened and
    /// closed: a synchronous ImageIO call cannot be interrupted, so a replacement
    /// waits its turn instead of piling a second decode buffer on the first.
    private static let queue = DispatchQueue(label: "gg.pqp.jam.cover-prep", qos: .userInitiated)

    private final class CancelFlag: @unchecked Sendable {
        private let lock = NSLock()
        private var set = false
        var isSet: Bool { lock.lock(); defer { lock.unlock() }; return set }
        func cancel() { lock.lock(); set = true; lock.unlock() }
    }

    /// `prepare(file:)` on the serial queue, cancelled with the caller: a pick that
    /// was replaced or closed while it waited its turn never starts its decode.
    static func prepareSerially(file: URL) async -> Result<JamPreparedCover, JamCoverRules.Problem> {
        let flag = CancelFlag()
        return await withTaskCancellationHandler {
            await withCheckedContinuation { continuation in
                queue.async {
                    continuation.resume(returning: flag.isSet ? .failure(.failed) : prepare(file: file, cancelled: { flag.isSet }))
                }
            }
        } onCancel: { flag.cancel() }
    }

    private static func prepare(source: CGImageSource?, cancelled: () -> Bool = { false }) -> Result<JamPreparedCover, JamCoverRules.Problem> {
        guard let source,
              let properties = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any],
              let width = properties[kCGImagePropertyPixelWidth] as? Int,
              let height = properties[kCGImagePropertyPixelHeight] as? Int
        else { return .failure(.unreadable) }
        // The rule looks at the pixels as stored: a quarter turn swaps the two
        // and the smaller side is the same either way.
        if let problem = JamCoverRules.check(width: width, height: height) { return .failure(problem) }
        let options: [CFString: Any] = [
            kCGImageSourceCreateThumbnailFromImageAlways: true,
            kCGImageSourceCreateThumbnailWithTransform: true,
            kCGImageSourceThumbnailMaxPixelSize: JamCoverRules.size * 2,
        ]
        // A pick that was replaced or closed has nobody waiting for the decode.
        if cancelled() { return .failure(.failed) }
        guard let cg = CGImageSourceCreateThumbnailAtIndex(source, 0, options as CFDictionary) else {
            return .failure(.unreadable)
        }
        if cancelled() { return .failure(.failed) }
        guard let jpeg = squareJpeg(UIImage(cgImage: cg)), let preview = UIImage(data: jpeg) else {
            return .failure(.unreadable)
        }
        guard JamCoverRules.fits(byteCount: jpeg.count) else { return .failure(.tooLarge) }
        return .success(JamPreparedCover(jpeg: jpeg, preview: preview))
    }

    /// Centre-crop to a square and scale to `JamCoverRules.size`, as an opaque
    /// JPEG. A transparent part becomes the near-white of text on a picture
    /// (the web's `coverFlatten`), not the black an opaque context starts with.
    static func squareJpeg(_ image: UIImage, quality: CGFloat = 0.85) -> Data? {
        let source = image.size
        guard source.width > 0, source.height > 0 else { return nil }
        let size = CGFloat(JamCoverRules.size)
        let side = min(source.width, source.height)
        let format = UIGraphicsImageRendererFormat.default()
        format.scale = 1
        format.opaque = true
        let renderer = UIGraphicsImageRenderer(size: CGSize(width: size, height: size), format: format)
        let square = renderer.image { context in
            UIColor(red: 0.96, green: 0.96, blue: 0.94, alpha: 1).setFill()
            context.fill(CGRect(x: 0, y: 0, width: size, height: size))
            let scale = size / side
            let drawn = CGSize(width: source.width * scale, height: source.height * scale)
            image.draw(in: CGRect(x: (size - drawn.width) / 2, y: (size - drawn.height) / 2, width: drawn.width, height: drawn.height))
        }
        return square.jpegData(compressionQuality: quality)
    }
}

/// A photo as the library hands it over: a file, not bytes in memory. A ProRAW
/// or a panorama can be hundreds of MiB, and ImageIO reads it from disk.
struct JamPickedPhoto: Transferable {
    let url: URL

    static var transferRepresentation: some TransferRepresentation {
        FileRepresentation(contentType: .image) { photo in
            SentTransferredFile(photo.url)
        } importing: { received in
            let ext = received.file.pathExtension.isEmpty ? "img" : received.file.pathExtension
            let copy = FileManager.default.temporaryDirectory.appendingPathComponent("jam-pick-\(UUID().uuidString).\(ext)")
            try FileManager.default.copyItem(at: received.file, to: copy)
            return JamPickedPhoto(url: copy)
        }
    }
}

@MainActor
@Observable
final class JamEditSongModel {
    enum Upload: Equatable {
        case idle
        /// A photo was picked and is being read and framed, before any byte is
        /// sent. It counts as work in progress everywhere `uploading` does: Save
        /// and a swipe-down wait for it, and Cancel asks first.
        case preparing
        case uploading(Double)
        case failed(JamCoverRules.Problem)
    }

    /// The one line under the picture.
    enum Note: Equatable {
        /// "It only counts once you save."
        case ready
        /// "It only goes away once you save."
        case removed
    }

    let song: JamSongModel

    /// What the person typed, or nil while a field is untouched: an untouched
    /// field follows the song as it is now, so a name changed in another window
    /// is never written back over.
    var titleEdit: String?
    var artistEdit: String?
    private(set) var cover: JamCoverChoice = .keep
    /// The framed picture while it goes up, and the picture that went up.
    private(set) var pending: UIImage?
    private(set) var preview: UIImage?
    private(set) var upload: Upload = .idle
    private(set) var note: Note?
    private(set) var saving = false
    private(set) var failure: JamEditFailure?
    var touched = false

    @ObservationIgnored private var pickToken = 0
    @ObservationIgnored private var uploadTask: Task<Void, Never>?
    @ObservationIgnored private var closed = false

    init(song: JamSongModel) {
        self.song = song
    }

    // MARK: What is shown

    var current: JamSongSummary { song.song }
    /// The song's own text is shown without bidi controls, the way the web
    /// compares it (an old row may still hold them).
    var title: String { titleEdit ?? JamBidi.clean(current.title) }
    var artist: String { artistEdit ?? JamBidi.clean(current.artist ?? "") }

    var draft: JamSongEditDraft { JamSongEditDraft(title: title, artist: artist, cover: cover) }
    var plan: JamSongEditPlan { JamSongEditPlan.make(song: current, draft: draft) }

    var titleProblem: JamText.Problem? {
        if case .failure(let problem) = JamText.title(title) { return problem }
        return nil
    }

    var artistProblem: JamText.Problem? {
        if case .failure(let problem) = JamText.artist(artist) { return problem }
        return nil
    }

    /// Empty is said as soon as it is empty (an empty title also disables
    /// Save, and a disabled button cannot be pressed to find out why).
    var showsTitleProblem: Bool {
        titleProblem != nil && (touched || title != JamBidi.clean(current.title))
    }

    var showsArtistProblem: Bool {
        artistProblem != nil && (touched || artist != JamBidi.clean(current.artist ?? ""))
    }

    /// A photo is being prepared or sent: the sheet is not done yet.
    var isUploading: Bool {
        switch upload {
        case .preparing, .uploading: true
        case .idle, .failed: false
        }
    }

    /// Something would be lost by closing: a change Save would send, or a photo going up.
    var isDirty: Bool { !plan.isEmpty || isUploading }

    var canSave: Bool {
        !plan.isEmpty && !isUploading && !saving && titleProblem == nil && artistProblem == nil
    }

    /// A photo is showing, or about to.
    var hasPhoto: Bool {
        switch cover {
        case .new: true
        case .remove: false
        case .keep: isUploading || current.cover != nil
        }
    }

    /// The picture to draw instead of the song's own: the one that was picked.
    var shownLocal: UIImage? {
        if isUploading { return pending }
        if case .new = cover { return preview }
        return nil
    }

    /// The song's own cover is the picture, as opposed to the art a song has without one.
    var showsCurrentCover: Bool { cover == .keep && current.cover != nil && shownLocal == nil }

    // MARK: Picking a photo

    /// Check, frame, send. Each step that fails says why in words.
    func pick(_ item: PhotosPickerItem, api: APIClient) {
        let mine = beginPick()
        uploadTask = Task { [weak self] in
            guard let self else { return }
            // The picker was asked for pictures; a type that is not one is the rare case.
            if !item.supportedContentTypes.isEmpty, !item.supportedContentTypes.contains(where: { $0.conforms(to: .image) }) {
                self.finishFailed(.type, token: mine)
                return
            }
            guard let picked = try? await item.loadTransferable(type: JamPickedPhoto.self) else {
                self.finishFailed(.unreadable, token: mine)
                return
            }
            let file = picked.url
            // Cancelled with the pick (a closed sheet) and one at a time.
            let prepared = await JamCoverPrep.prepareSerially(file: file)
            // The small JPEG is all that goes on from here: the original is let go now,
            // not after the ticket and the upload.
            try? FileManager.default.removeItem(at: file)
            guard self.stillCurrent(mine) else { return }
            switch prepared {
            case .failure(let problem):
                self.upload = .failed(problem)
            case .success(let cover):
                await self.send(cover, api: api, token: mine)
            }
        }
    }

    /// A photo was picked: busy from this moment, not from the first byte. A
    /// Save pressed while the photo is still being read would otherwise go
    /// through and close the sheet, which throws the pick away unsaid.
    func beginPick() -> Int {
        pickToken += 1
        uploadTask?.cancel()
        upload = .preparing
        note = nil
        return pickToken
    }

    private func stillCurrent(_ token: Int) -> Bool { token == pickToken && !closed && !Task.isCancelled }

    private func finishFailed(_ problem: JamCoverRules.Problem, token: Int) {
        guard stillCurrent(token) else { return }
        pending = nil
        upload = .failed(problem)
    }

    private func send(_ cover: JamPreparedCover, api: APIClient, token: Int) async {
        // The framed picture is on the tile before its first byte is sent.
        pending = cover.preview
        upload = .uploading(0)
        let file = FileManager.default.temporaryDirectory.appendingPathComponent("jam-cover-\(UUID().uuidString).jpg")
        defer { try? FileManager.default.removeItem(at: file) }
        do {
            try cover.jpeg.write(to: file)
            let ticket = try await api.createJamUpload(
                songId: current.id, body: .cover(contentType: "image/jpeg", byteSize: cover.jpeg.count)
            )
            guard stillCurrent(token) else { return }
            try await JamStorageUpload.put(file: file, to: ticket.uploadUrl, contentType: "image/jpeg") { [weak self] fraction in
                Task { @MainActor in
                    guard let self, self.stillCurrent(token) else { return }
                    // Progress is queued onto the main actor, so a callback can run after the
                    // PUT has finished and the state has moved on (idle with the cover ready,
                    // or failed): it only moves a bar that is still being drawn.
                    guard case .uploading = self.upload else { return }
                    self.upload = .uploading(fraction)
                }
            }
            guard stillCurrent(token) else { return }
            adopt(uploadId: ticket.uploadId, preview: cover.preview)
        } catch {
            guard stillCurrent(token) else { return }
            // A failed replacement leaves the photo that was already chosen where it was.
            pending = nil
            upload = .failed(Self.problem(for: error))
        }
    }

    /// The picture that went up is the preview now, and Save will claim it.
    func adopt(uploadId: String, preview: UIImage?) {
        self.preview = preview
        pending = nil
        cover = .new(uploadId: uploadId)
        upload = .idle
        note = .ready
    }

    /// What a failed ticket or upload says: too large is the server's 413,
    /// everything else is "the photo did not go up".
    nonisolated static func problem(for error: Error) -> JamCoverRules.Problem {
        if JamErrorKind.of(error) == .tooLarge { return .tooLarge }
        return .failed
    }

    func removePhoto() {
        pickToken += 1
        uploadTask?.cancel()
        pending = nil
        preview = nil
        upload = .idle
        cover = .remove
        note = current.cover != nil ? .removed : nil
    }

    // MARK: Closing and saving

    /// The sheet closed: nothing keeps a late answer alive.
    func close() {
        closed = true
        pickToken += 1
        uploadTask?.cancel()
        pending = nil
        preview = nil
    }

    /// True when it all landed (the sheet then closes). The text first, then
    /// the picture; each answer is the song as it now is.
    func save(api: APIClient) async -> Bool {
        touched = true
        guard canSave else { return false }
        saving = true
        failure = nil
        defer { saving = false }
        let plan = plan
        do {
            if let patch = plan.patch {
                let sent = song.songWriteRevision()
                song.applySongEdit(try await api.updateJamSong(id: current.id, patch: patch), sentAt: sent)
            }
            switch plan.cover {
            case .set(let uploadId):
                let sent = song.songWriteRevision()
                song.applySongEdit(try await api.setJamCover(songId: current.id, uploadId: uploadId), sentAt: sent)
            case .remove:
                let sent = song.songWriteRevision()
                song.applySongEdit(try await api.removeJamCover(songId: current.id), sentAt: sent)
            case nil:
                break
            }
            return true
        } catch {
            if error.isCancellation { return false }
            failure = JamEditFailure.of(error)
            // The server said this person may not edit: their permissions on
            // this song are read again, because they were wrong.
            if failure?.isDenied == true { await song.refreshPermissions() }
            // The flag went off under an open song: its affordances are read again.
            if failure == .kind(.off) { await song.refreshConfig() }
            return false
        }
    }
}
