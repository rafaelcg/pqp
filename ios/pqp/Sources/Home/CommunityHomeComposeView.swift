import AVFoundation
import ImageIO
import PhotosUI
import SwiftUI
import UniformTypeIdentifiers

// Publishing from the phone: a title, some words, one photo or video or one
// link. The staff-only half of the Baú; everybody else never sees the button.
// Drafts, the schedule and the VIP tier stay on the web.

// MARK: - Entry point

extension View {
    /// Adds the "new post" button to a Baú screen, for the people the server
    /// would let publish and nobody else. It asks the server which bits this
    /// account holds (`CommunityHomeComposeGate`), says no until it answers,
    /// and re-asks each time the screen opens, so a promotion or a demotion
    /// shows up without restarting the app.
    func communityHomeComposer(
        server: Server,
        config: CommunityHomeConfig,
        channels: [Channel] = [],
        onPosted: @escaping () -> Void
    ) -> some View {
        modifier(CommunityHomeComposerEntry(server: server, config: config, channels: channels, onPosted: onPosted))
    }
}

private struct CommunityHomeComposerEntry: ViewModifier {
    @Environment(SessionStore.self) private var session
    let server: Server
    let config: CommunityHomeConfig
    let channels: [Channel]
    let onPosted: () -> Void

    @State private var permissions: PermissionsSnapshot?
    @State private var composing = false

    private var canPost: Bool {
        CommunityHomeComposeGate.canPost(config: config, permissions: permissions)
    }

    func body(content: Content) -> some View {
        content
            .toolbar {
                if canPost {
                    ToolbarItem(placement: .topBarTrailing) {
                        Button {
                            composing = true
                        } label: {
                            Image(systemName: "square.and.pencil")
                        }
                        .tint(Palette.signal)
                        .accessibilityLabel(Text("Post to the Baú"))
                        .accessibilityIdentifier("bau.compose.open")
                    }
                }
            }
            .sheet(isPresented: $composing) {
                CommunityHomeComposeView(server: server, config: config, api: session.api, channels: channels) {
                    composing = false
                    onPosted()
                }
            }
            .task(id: server.id) {
                permissions = try? await session.api.fetchMemberPermissions(serverId: server.id)
            }
    }
}

// MARK: - Picking

enum PickFailure: Equatable, Sendable {
    case unreadable
    case unsupported
    case tooLarge

    var message: String {
        switch self {
        case .unreadable: String(localized: "Could not read that file.")
        case .unsupported: String(localized: "Use a PNG, JPEG, WebP, GIF, MP4 or WebM.")
        case .tooLarge: String(localized: "That file is over 100 MB.")
        }
    }
}

/// What the picker produced, as a file this process owns.
struct PreparedMedia: Sendable {
    let url: URL
    let contentType: String
    let filename: String
    let isVideo: Bool
}

/// A video as the library hands it over: a file, copied somewhere we own
/// before the picker deletes its own.
private struct PickedMovie: Transferable {
    let url: URL

    static var transferRepresentation: some TransferRepresentation {
        FileRepresentation(contentType: .movie) { movie in
            SentTransferredFile(movie.url)
        } importing: { received in
            let ext = received.file.pathExtension.isEmpty ? "mov" : received.file.pathExtension
            let copy = FileManager.default.temporaryDirectory
                .appendingPathComponent("bau-\(UUID().uuidString).\(ext)")
            try FileManager.default.copyItem(at: received.file, to: copy)
            return PickedMovie(url: copy)
        }
    }
}

/// A photo as the library hands it over: a file, not bytes in memory. A ProRAW
/// or a panorama can be hundreds of MiB decoded, and the size is checked on
/// disk before anything is read.
private struct PickedImage: Transferable {
    let url: URL

    static var transferRepresentation: some TransferRepresentation {
        FileRepresentation(contentType: .image) { image in
            SentTransferredFile(image.url)
        } importing: { received in
            let ext = received.file.pathExtension.isEmpty ? "img" : received.file.pathExtension
            let copy = FileManager.default.temporaryDirectory
                .appendingPathComponent("bau-\(UUID().uuidString).\(ext)")
            try FileManager.default.copyItem(at: received.file, to: copy)
            return PickedImage(url: copy)
        }
    }
}

enum ComposePicker {
    /// A library item, as something the Baú will sign an upload for.
    ///
    /// Images keep their format when the Baú takes it (PNG, JPEG, GIF, WebP)
    /// and become JPEG otherwise, which is what HEIC, the iPhone's own, is.
    /// Video is MP4 as-is, or re-encoded to H.264 MP4 when it is a QuickTime
    /// `.mov`: the allowlist has no `video/quicktime`, and a browser cannot play
    /// the HEVC an iPhone records by default.
    static func prepare(_ item: PhotosPickerItem) async throws -> PreparedMedia {
        let types = item.supportedContentTypes
        if types.contains(where: { $0.conforms(to: .movie) || $0.conforms(to: .video) }) {
            return try await prepareVideo(item)
        }
        return try await prepareImage(item, types: types)
    }

    private static func prepareImage(_ item: PhotosPickerItem, types: [UTType]) async throws -> PreparedMedia {
        guard let picked = try await item.loadTransferable(type: PickedImage.self) else {
            throw PickFailure.unreadable
        }
        let native: [(UTType, String, String)] = [
            (.png, "image/png", "png"),
            (.jpeg, "image/jpeg", "jpg"),
            (.gif, "image/gif", "gif"),
            (.webP, "image/webp", "webp"),
        ]
        let size = fileSize(picked.url)
        guard size > 0 else {
            try? FileManager.default.removeItem(at: picked.url)
            throw PickFailure.unreadable
        }
        if let match = native.first(where: { candidate in types.contains { $0.conforms(to: candidate.0) } }) {
            guard size <= CommunityHomeLimits.maxBytes else {
                try? FileManager.default.removeItem(at: picked.url)
                throw PickFailure.tooLarge
            }
            return PreparedMedia(url: picked.url, contentType: match.1, filename: "photo.\(match.2)", isVideo: false)
        }
        // HEIC and the rest become JPEG, decoded through ImageIO's thumbnailer
        // so a 48 MP original is scaled while it is read, never held whole.
        defer { try? FileManager.default.removeItem(at: picked.url) }
        guard let source = CGImageSourceCreateWithURL(picked.url as CFURL, nil) else { throw PickFailure.unreadable }
        let options: [CFString: Any] = [
            kCGImageSourceCreateThumbnailFromImageAlways: true,
            kCGImageSourceCreateThumbnailWithTransform: true,
            kCGImageSourceThumbnailMaxPixelSize: 4096,
        ]
        guard let cg = CGImageSourceCreateThumbnailAtIndex(source, 0, options as CFDictionary),
              let jpeg = UIImage(cgImage: cg).jpegData(compressionQuality: 0.85) else {
            throw PickFailure.unreadable
        }
        guard Int64(jpeg.count) <= CommunityHomeLimits.maxBytes else { throw PickFailure.tooLarge }
        let url = FileManager.default.temporaryDirectory.appendingPathComponent("bau-\(UUID().uuidString).jpg")
        try jpeg.write(to: url)
        return PreparedMedia(url: url, contentType: "image/jpeg", filename: "photo.jpg", isVideo: false)
    }

    private static func fileSize(_ url: URL) -> Int64 {
        (try? FileManager.default.attributesOfItem(atPath: url.path)[.size] as? NSNumber)?.int64Value ?? 0
    }

    private static func prepareVideo(_ item: PhotosPickerItem) async throws -> PreparedMedia {
        guard let movie = try await item.loadTransferable(type: PickedMovie.self) else {
            throw PickFailure.unreadable
        }
        let ext = movie.url.pathExtension.lowercased()
        var ready = movie.url
        if ext != "mp4" && ext != "m4v" {
            ready = try await exportMP4(movie.url)
            try? FileManager.default.removeItem(at: movie.url)
        }
        let size = (try? FileManager.default.attributesOfItem(atPath: ready.path)[.size] as? NSNumber)?.int64Value ?? 0
        guard size > 0 else { throw PickFailure.unreadable }
        // At the limit means the export was cut off by `fileLengthLimit`.
        guard size < CommunityHomeLimits.maxBytes else {
            try? FileManager.default.removeItem(at: ready)
            throw PickFailure.tooLarge
        }
        return PreparedMedia(url: ready, contentType: "video/mp4", filename: "video.mp4", isVideo: true)
    }

    private static func exportMP4(_ source: URL) async throws -> URL {
        let asset = AVURLAsset(url: source)
        let preset = AVAssetExportSession.allExportPresets().contains(AVAssetExportPreset1920x1080)
            ? AVAssetExportPreset1920x1080 : AVAssetExportPresetHighestQuality
        guard let exporter = AVAssetExportSession(asset: asset, presetName: preset) else {
            throw PickFailure.unreadable
        }
        let output = FileManager.default.temporaryDirectory.appendingPathComponent("bau-\(UUID().uuidString).mp4")
        // The export stops writing at the limit instead of running to the end
        // of a long clip; the caller treats an output at the limit as too large.
        exporter.fileLengthLimit = CommunityHomeLimits.maxBytes
        if #available(iOS 18.0, *) {
            try await exporter.export(to: output, as: .mp4)
        } else {
            exporter.outputURL = output
            exporter.outputFileType = .mp4
            exporter.shouldOptimizeForNetworkUse = true
            await exporter.export()
            guard exporter.status == .completed else { throw PickFailure.unreadable }
        }
        return output
    }
}

extension PickFailure: Error {}

// MARK: - Model

@MainActor
@Observable
final class CommunityHomeComposeModel {
    var draft = ComposeDraft()
    var posting = false
    /// Set when Post was tapped on a draft that is not ready; cleared by the next edit.
    var problem: ComposeProblem?
    var pickFailure: PickFailure?
    /// The server (or the network) said no to the last write.
    var refusal: CommunityHomeRefusal?
    var posted = false
    /// A video being re-encoded before it can go up.
    var preparing = false

    private let api: APIClient
    private let serverId: String
    private var pickTask: Task<Void, Never>?
    private var pickToken = UUID()
    private var localURL: URL?

    init(api: APIClient, serverId: String) {
        self.api = api
        self.serverId = serverId
    }

    var isDirty: Bool {
        !draft.trimmedTitle.isEmpty || !draft.trimmedBody.isEmpty || !draft.trimmedLink.isEmpty || draft.media != nil
    }

    /// Any edit clears what the last attempt complained about.
    func edited() {
        problem = nil
        refusal = nil
    }

    func setLink(_ value: String) {
        if !value.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { dropMedia() }
        draft.link = value
        edited()
    }

    func pick(_ item: PhotosPickerItem) {
        dropMedia()
        pickFailure = nil
        edited()
        // Set before the task starts, so Post cannot slip in between the tap
        // and the first await and publish without the file.
        preparing = true
        // A cancelled pick finishes after its replacement has started; only
        // the pick that is still current may clear the flag.
        let token = UUID()
        pickToken = token
        pickTask = Task { [api, serverId] in
            defer { if pickToken == token { preparing = false } }
            let prepared: PreparedMedia
            do {
                prepared = try await ComposePicker.prepare(item)
            } catch {
                if !Task.isCancelled { pickFailure = (error as? PickFailure) ?? .unreadable }
                return
            }
            guard !Task.isCancelled else {
                try? FileManager.default.removeItem(at: prepared.url)
                return
            }
            localURL = prepared.url
            let size = (try? FileManager.default.attributesOfItem(atPath: prepared.url.path)[.size] as? NSNumber)?.int64Value ?? 0
            draft.link = ""
            draft.media = ComposeMedia(
                filename: prepared.filename,
                contentType: prepared.contentType,
                byteSize: size,
                isVideo: prepared.isVideo,
                uploading: true
            )
            do {
                let id = try await CommunityHomeMediaUploader(api: api).upload(
                    serverId: serverId,
                    fileURL: prepared.url,
                    contentType: prepared.contentType,
                    filename: prepared.filename
                )
                guard !Task.isCancelled else { return }
                draft.media?.uploadId = id
                draft.media?.uploading = false
            } catch {
                guard !Task.isCancelled else { return }
                draft.media?.uploading = false
                draft.media?.failed = true
                refusal = CommunityHomeRefusal.from(error)
            }
        }
    }

    func removeMedia() {
        dropMedia()
        pickFailure = nil
        edited()
    }

    private func dropMedia() {
        pickTask?.cancel()
        pickTask = nil
        pickToken = UUID()
        if let localURL { try? FileManager.default.removeItem(at: localURL) }
        localURL = nil
        draft.media = nil
        preparing = false
    }

    func discard() {
        guard !posting else { return }
        dropMedia()
    }

    func post() async {
        guard !posting else { return }
        if preparing {
            problem = .fileStillUploading
            return
        }
        guard let request = draft.request else {
            problem = draft.problem
            return
        }
        posting = true
        problem = nil
        refusal = nil
        defer { posting = false }
        do {
            _ = try await api.createCommunityHomePost(serverId: serverId, request: request)
            if let localURL { try? FileManager.default.removeItem(at: localURL) }
            localURL = nil
            posted = true
        } catch {
            let refusal = CommunityHomeRefusal.from(error)
            self.refusal = refusal == .network ? .unconfirmed : refusal
        }
    }
}

// MARK: - View

struct CommunityHomeComposeView: View {
    @Environment(\.dismiss) private var dismiss
    let server: Server
    let config: CommunityHomeConfig
    let channels: [Channel]
    let onPosted: () -> Void

    @State private var model: CommunityHomeComposeModel
    @State private var pickerItem: PhotosPickerItem?
    @State private var confirmDiscard = false
    @FocusState private var focus: Field?

    private enum Field { case title, body, link }

    init(
        server: Server,
        config: CommunityHomeConfig,
        api: APIClient,
        channels: [Channel] = [],
        onPosted: @escaping () -> Void
    ) {
        self.server = server
        self.config = config
        self.channels = channels
        self.onPosted = onPosted
        let model = CommunityHomeComposeModel(api: api, serverId: server.id)
        model.draft.channels = channels
        _model = State(initialValue: model)
    }

    var body: some View {
        NavigationStack {
            ZStack {
                Palette.ink.ignoresSafeArea()
                ScrollView {
                    VStack(alignment: .leading, spacing: 14) {
                        TextField("Title", text: $model.draft.title)
                            .focused($focus, equals: .title)
                            .font(Typography.bodyMedium)
                            .foregroundStyle(Palette.paper)
                            .padding(12)
                            .pqpSurface(cornerRadius: Metrics.cornerRadiusSmall)
                            .submitLabel(.next)
                            .onSubmit { focus = .body }
                            .onChange(of: model.draft.title) { _, _ in model.edited() }
                            .accessibilityIdentifier("bau.compose.title")

                        TextField("Write something", text: $model.draft.body, axis: .vertical)
                            .focused($focus, equals: .body)
                            .lineLimit(6...16)
                            .font(Typography.body)
                            .foregroundStyle(Palette.paper)
                            .padding(12)
                            .pqpSurface(cornerRadius: Metrics.cornerRadiusSmall)
                            .onChange(of: model.draft.body) { _, _ in model.edited() }
                            // The list can arrive after the sheet opened.
                            .onChange(of: channels) { _, fresh in model.draft.channels = fresh }
                            .accessibilityIdentifier("bau.compose.body")

                        channelSuggestions

                        mediaSection

                        if model.draft.media == nil {
                            TextField("Or paste a YouTube, Twitch, TikTok or Instagram link", text: Binding(
                                get: { model.draft.link },
                                set: { model.setLink($0) }
                            ))
                            .focused($focus, equals: .link)
                            .keyboardType(.URL)
                            .textContentType(.URL)
                            .textInputAutocapitalization(.never)
                            .autocorrectionDisabled()
                            .font(Typography.body)
                            .foregroundStyle(Palette.paper)
                            .padding(12)
                            .pqpSurface(cornerRadius: Metrics.cornerRadiusSmall)
                            .accessibilityIdentifier("bau.compose.link")

                            if let provider = CommunityHomeLinks.provider(model.draft.link) {
                                LinkPreview(provider: provider, link: model.draft.link)
                            }
                        }

                        if let text = errorText {
                            Text(text)
                                .font(Typography.callout)
                                .foregroundStyle(Palette.danger)
                                .accessibilityIdentifier("bau.compose.error")
                        }
                    }
                    .padding(.horizontal, Metrics.hPadding)
                    .padding(.vertical, 12)
                }
                .scrollDismissesKeyboard(.interactively)
                // What is on screen is what is in the request: edits made while a
                // post is in flight would be lost on success.
                .disabled(model.posting)
            }
            .navigationTitle("New post")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Button("Cancel") {
                        if model.isDirty { confirmDiscard = true } else { dismiss() }
                    }
                    .disabled(model.posting)
                    .tint(Palette.paperMuted)
                    .accessibilityIdentifier("bau.compose.cancel")
                }
                ToolbarItem(placement: .topBarTrailing) {
                    if model.posting {
                        ProgressView().tint(Palette.signal)
                    } else {
                        Button("Post") { Task { await model.post() } }
                            .fontWeight(.semibold)
                            .tint(Palette.signal)
                            .accessibilityIdentifier("bau.compose.post")
                    }
                }
            }
            .confirmationDialog("Discard this post?", isPresented: $confirmDiscard, titleVisibility: .visible) {
                Button("Discard", role: .destructive) {
                    model.discard()
                    dismiss()
                }
                Button("Keep writing", role: .cancel) {}
            }
        }
        .interactiveDismissDisabled(model.isDirty || model.posting)
        .onChange(of: pickerItem) { _, item in
            guard let item else { return }
            model.pick(item)
            // Cleared so choosing the same item again after removing it still fires.
            pickerItem = nil
        }
        .onChange(of: model.posted) { _, posted in
            if posted { onPosted() }
        }
        .onDisappear { if !model.posted { model.discard() } }
    }

    private var errorText: String? {
        if let problem = model.problem { return problem.message }
        if let failure = model.pickFailure { return failure.message }
        if let refusal = model.refusal { return refusal.message }
        return nil
    }

    /// The `#` picker. A `TextField` does not expose its caret, so this follows
    /// the end of the text: while the draft ends in `#ge`, the matching channels
    /// are offered and a tap swaps the token for `#name`.
    @ViewBuilder
    private var channelSuggestions: some View {
        if !model.posting,
           let query = BauChannelRefs.findQuery(model.draft.body) {
            let matches = BauChannelRefs.filter(model.draft.channels, query: query.query)
            if !matches.isEmpty {
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 8) {
                        ForEach(matches) { channel in
                            Button {
                                model.draft.body = BauChannelRefs.apply(
                                    to: model.draft.body,
                                    query: query,
                                    channel: channel,
                                    channels: model.draft.channels
                                )
                            } label: {
                                Text(verbatim: "#\(channel.name)")
                                    .font(Typography.callout)
                                    .foregroundStyle(Palette.signal)
                                    .padding(.horizontal, 12)
                                    .padding(.vertical, 7)
                                    .background(Capsule().fill(Palette.signal.opacity(0.14)))
                            }
                            .buttonStyle(.plain)
                            .accessibilityIdentifier("bau.compose.channel.\(channel.name)")
                        }
                    }
                }
                .accessibilityIdentifier("bau.compose.channels")
            }
        }
    }

    @ViewBuilder
    private var mediaSection: some View {
        if let media = model.draft.media {
            HStack(spacing: 12) {
                Image(systemName: media.isVideo ? "video" : "photo")
                    .foregroundStyle(Palette.paperMuted)
                VStack(alignment: .leading, spacing: 2) {
                    Text(media.filename)
                        .font(Typography.body)
                        .foregroundStyle(Palette.paper)
                        .lineLimit(1)
                    if media.uploading {
                        Text("Uploading…")
                            .font(Typography.caption)
                            .foregroundStyle(Palette.paperMuted)
                    } else if media.failed {
                        Text("The upload failed. Remove it and try again.")
                            .font(Typography.caption)
                            .foregroundStyle(Palette.danger)
                    } else {
                        Text(ByteCountFormatter.string(fromByteCount: media.byteSize, countStyle: .file))
                            .font(Typography.caption)
                            .foregroundStyle(Palette.paperMuted)
                    }
                }
                Spacer()
                if media.uploading { ProgressView().tint(Palette.signal) }
                Button("Remove") { model.removeMedia() }
                    .font(Typography.callout)
                    .tint(Palette.signal)
                    .accessibilityIdentifier("bau.compose.media.remove")
            }
            .padding(12)
            .pqpSurface(cornerRadius: Metrics.cornerRadiusSmall)
            .accessibilityIdentifier("bau.compose.media")
        } else if model.preparing {
            HStack(spacing: 12) {
                ProgressView().tint(Palette.signal)
                Text("Preparing…")
                    .font(Typography.body)
                    .foregroundStyle(Palette.paperMuted)
                Spacer()
            }
            .padding(12)
            .pqpSurface(cornerRadius: Metrics.cornerRadiusSmall)
        } else if CommunityHomeComposeGate.canAttachFiles(config: config) {
            PhotosPicker(selection: $pickerItem, matching: .any(of: [.images, .videos]), photoLibrary: .shared()) {
                AttachLabel()
            }
            .accessibilityIdentifier("bau.compose.attach")
        }
    }
}

/// What the link will be. A YouTube link shows its public thumbnail, the same
/// one the feed shows; the other three name their provider, because the
/// server decides what it will accept.
private struct LinkPreview: View {
    let provider: CommunityHomeLinks.Provider
    let link: String

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            if let thumbnail = CommunityHomeLinks.youtubeThumbnail(link) {
                AsyncImage(url: thumbnail) { image in
                    image.resizable().scaledToFill()
                } placeholder: {
                    Palette.surfaceRaised
                }
                .frame(maxWidth: .infinity)
                .frame(height: 180)
                .clipped()
            }
            Text("\(provider.rawValue) link. It shows up in the post.")
                .font(Typography.callout)
                .foregroundStyle(Palette.paper)
                .padding(12)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .pqpSurface(cornerRadius: Metrics.cornerRadiusSmall)
        .clipShape(RoundedRectangle(cornerRadius: Metrics.cornerRadiusSmall, style: .continuous))
        .accessibilityIdentifier("bau.compose.link.preview")
    }
}

/// Its own view because a `PhotosPicker` label closure is not main-actor
/// isolated, and the surface modifier is.
private struct AttachLabel: View {
    var body: some View {
        HStack(spacing: 8) {
            Image(systemName: "photo.on.rectangle")
            Text("Add a photo or video")
        }
        .font(Typography.bodyMedium)
        .foregroundStyle(Palette.signal)
        .frame(maxWidth: .infinity)
        .padding(12)
        .pqpSurface(cornerRadius: Metrics.cornerRadiusSmall)
    }
}
