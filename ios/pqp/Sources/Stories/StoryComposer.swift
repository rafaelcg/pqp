import AVFoundation
import PhotosUI
import SwiftUI
import UIKit
import UniformTypeIdentifiers

/// Novo story: a photo or a video up to 30 s, a text card, or a call.
///
/// The bytes never pass the API: the composer asks `POST /api/stories` for a
/// presigned PUT, sends the file straight to storage, then publishes. A photo
/// is re-encoded on the phone (at most 1440 px on the long side, no EXIF, so
/// no location ever leaves it); a video is exported to 720p MP4 with its
/// metadata dropped, and one over 30 s is refused before anything uploads.
struct StoryComposer: View {
    @Environment(SessionStore.self) private var session
    @Environment(\.dismiss) private var dismiss
    @Environment(VoiceModel.self) private var voice
    @Environment(CallModel.self) private var callModel

    /// Pre-ticked in "Quem vê": where the composer was opened from.
    let preselectedServerId: String?
    let preselectsFriends: Bool
    let onPosted: () -> Void

    /// The tab the camera screen shows at the bottom. "Text" and "Call" skip
    /// straight to the editor on a card background; "Camera" is the source
    /// step, and a shot or a picked file moves it on to the editor.
    enum Mode: String, CaseIterable { case text, media, call }

    /// Opens on the camera, like the phone's own: the common story is a photo
    /// taken right now. Falls back to text when media is off for this server.
    @State private var mode: Mode = .media
    @State private var config = StoriesConfig.off
    @State private var configLoaded = false
    @State private var background = "night"
    @State private var draft: StoryDraftMedia?
    @State private var muted = false
    @State private var editor = StoryEditorModel()
    @State private var pickerItem: PhotosPickerItem?
    @State private var showingPicker = false
    @State private var showingFiles = false
    @State private var trimRequest: StoryTrimRequest?
    @State private var preparing = false
    @State private var showingAudience = false
    @State private var finalMedia: StoryDraftMedia?
    @State private var builtRequest = StoryDraftRequest(kind: "text", text: nil, background: nil, caption: nil, sticker: nil)
    @State private var error: String?

    var body: some View {
        ZStack {
            Color.black.ignoresSafeArea()
            if isEditing {
                StoryEditorView(
                    model: editor, base: editorBase, muted: $muted, background: $background,
                    preselectedServerId: preselectedServerId,
                    opensText: mode == .text, opensCall: mode == .call,
                    onClose: leaveEditor,
                    onNext: { Task { await advance() } },
                    canAdvance: canAdvance && !preparing
                )
                .id(editorIdentity)
                if let error {
                    VStack {
                        Spacer()
                        errorPill(error).padding(.bottom, 80)
                    }
                }
                if preparing {
                    Color.black.opacity(0.4).ignoresSafeArea()
                    ProgressView().tint(.white)
                }
            } else {
                cameraStep
            }
        }
        .task {
            config = await session.api.storiesConfig(serverId: preselectedServerId)
            configLoaded = true
            if !config.mediaEnabled, mode == .media { mode = .text }
            #if DEBUG
            // A picked video, for a simulator whose photo library has none and
            // whose picker a UI test cannot drive: a synthetic clip of this
            // many seconds goes down the same path a picked one does.
            if let seconds = ProcessInfo.processInfo.environment["PQP_STORY_FIXTURE_VIDEO"].flatMap(Double.init),
               let url = try? await StoryTestVideo.write(duration: seconds, size: CGSize(width: 180, height: 320), fps: 5) {
                await accept(videoAt: url)
            }
            #endif
        }
        .photosPicker(isPresented: $showingPicker, selection: $pickerItem,
                      matching: config.videoEnabled ? .any(of: [.images, .videos]) : .images,
                      preferredItemEncoding: .current)
        .onChange(of: pickerItem) { _, item in
            guard let item else { return }
            Task { await load(item) }
        }
        .fileImporter(isPresented: $showingFiles, allowedContentTypes: config.videoEnabled ? [.image, .movie] : [.image]) { result in
            guard case .success(let url) = result else { return }
            Task { await load(fileAt: url) }
        }
        .fullScreenCover(item: $trimRequest) { request in
            StoryTrimView(request: request) { startMs in
                trimRequest = nil
                Task { await accept(videoAt: request.url, trimStartMs: startMs) }
            } onCancel: {
                trimRequest = nil
            }
        }
        .sheet(isPresented: $showingAudience) {
            StoryAudienceSheet(
                preselectedServerId: preselectedServerId,
                preselectsFriends: preselectsFriends,
                callServerId: builtRequest.callServerId,
                request: builtRequest,
                media: finalMedia
            ) {
                showingAudience = false
                onPosted()
                dismiss()
            }
            .presentationDetents([.medium, .large])
            .presentationBackground(Palette.ink)
        }
    }

    // MARK: - Steps

    /// The edit step: a shot or picked file, or a card (text and call).
    private var isEditing: Bool {
        (mode == .media && draft != nil) || mode == .text || mode == .call
    }

    private var editorBase: StoryEditorBase {
        if mode == .media, let draft { return .media(draft) }
        return .card(background: background)
    }

    /// A new editor each time a different base is opened, so a draft discarded
    /// and a new one shot never inherit each other's layers.
    @State private var editorSerial = 0
    private var editorIdentity: String { "\(mode.rawValue)-\(editorSerial)" }

    /// The source step.
    private var cameraStep: some View {
        ZStack {
            Color.black.ignoresSafeArea()
            StoryCameraView(
                isActive: cameraActive,
                recordsAudio: !callActive,
                blockedByCall: callCameraOn,
                onCapture: { result in Task { await accept(cameraResult: result) } },
                onGallery: { showingPicker = true },
                onFiles: { showingFiles = true }
            )
            if preparing {
                Color.black.opacity(0.5).ignoresSafeArea()
                ProgressView().tint(.white)
            }
            VStack(spacing: 0) {
                HStack {
                    Button { dismiss() } label: {
                        Image(systemName: "xmark")
                            .font(.system(size: 16, weight: .bold))
                            .foregroundStyle(.white)
                            .frame(width: 40, height: 40)
                            .background(Circle().fill(.black.opacity(0.35)))
                    }
                    .accessibilityLabel(Text("Close"))
                    .accessibilityIdentifier("composer.close")
                    Spacer()
                }
                .padding(.horizontal, 14)
                .padding(.top, 6)
                Spacer(minLength: 0)
                if let error { errorPill(error).padding(.bottom, 10) }
                modeBar
            }
        }
    }

    private func errorPill(_ text: String) -> some View {
        Text(verbatim: text)
            .font(Typography.callout)
            .foregroundStyle(.white)
            .padding(.horizontal, 14)
            .padding(.vertical, 8)
            .background(Capsule().fill(Palette.danger.opacity(0.85)))
            .accessibilityIdentifier("composer.error")
    }

    /// The camera runs only while it is what is on screen: a draft, a sheet,
    /// the picker or the trimmer all release it.
    private var cameraActive: Bool {
        mode == .media && draft == nil && !preparing && !showingPicker && !showingFiles
            && !showingAudience && trimRequest == nil
    }

    private var callActive: Bool { voice.holdsSeat || callModel.phase.isInRoom }
    private var callCameraOn: Bool { voice.isCameraOn || callModel.isCameraOn }

    private var modeBar: some View {
        HStack(spacing: 22) {
            modeButton(.text, title: "Text")
            if !configLoaded || config.mediaEnabled {
                modeButton(.media, title: "Camera")
            }
            modeButton(.call, title: "Call")
        }
        .padding(.bottom, 12)
        .frame(maxWidth: .infinity)
        .background(LinearGradient(colors: [.clear, .black.opacity(0.55)], startPoint: .top, endPoint: .bottom).ignoresSafeArea())
    }

    private func modeButton(_ value: Mode, title: LocalizedStringKey) -> some View {
        Button {
            error = nil
            guard value != mode else { return }
            if value != .media { editor.clear(); editorSerial += 1 }
            withAnimation(Motion.standard) { mode = value }
        } label: {
            VStack(spacing: 4) {
                Text(title)
                    .textCase(.uppercase)
                    .font(.system(size: 13, weight: .bold))
                    .foregroundStyle(mode == value ? .white : .white.opacity(0.55))
                Circle().fill(mode == value ? Palette.signal : .clear).frame(width: 5, height: 5)
            }
        }
        .accessibilityIdentifier("composer.mode.\(value.rawValue)")
    }

    /// The X in the editor: a draft goes back to the camera, a card goes back
    /// to the camera tab.
    private func leaveEditor() {
        error = nil
        editor.clear()
        editorSerial += 1
        withAnimation(Motion.standard) {
            draft = nil
            muted = false
            mode = config.mediaEnabled || !configLoaded ? .media : mode
        }
        if !config.mediaEnabled, configLoaded { dismiss() }
    }

    // MARK: - Rules

    private var canAdvance: Bool {
        switch mode {
        case .media:
            guard let draft else { return false }
            if draft.isVideo,
               StoryRules.videoProblem(durationMs: draft.durationMs ?? 0, byteSize: draft.data.count, maxVideoMs: config.maxVideoMs) != nil {
                return false
            }
            return true
        case .text, .call:
            return editor.hasContent
        }
    }

    /// Everything the create request needs, from what is on the canvas.
    private func buildRequest(media: StoryDraftMedia?) -> StoryDraftRequest {
        let layers = editor.layers.map { layer -> StoryLayerInput in
            guard let file = editor.files[layer.id] else { return StoryLayerInput(layer: layer, upload: nil) }
            return StoryLayerInput(layer: layer, upload: StoryLayerUploadDeclaration(
                contentType: file.contentType, byteSize: file.data.count, width: file.width, height: file.height
            ))
        }
        let altText = StoryAltText.make(layers: editor.layers, callRoomName: editor.callInfo?.roomName, caption: nil)
        // Old builds show the caption and nothing else: the text the author
        // typed travels there too.
        let spoken = editor.layers.sorted { $0.y < $1.y }.compactMap { layer -> String? in
            if case .text(let data) = layer.content { return data.text.trimmingCharacters(in: .whitespacesAndNewlines) }
            return nil
        }.filter { !$0.isEmpty }.joined(separator: " ")
        var callServer: String?
        for layer in editor.layers {
            if case .call(let serverId, _) = layer.content { callServer = serverId }
        }
        switch mode {
        case .media:
            return StoryDraftRequest(
                kind: media?.isVideo == true ? "video" : "image", text: nil, background: nil,
                caption: spoken.isEmpty ? nil : String(spoken.prefix(StoryLimits.captionMax)),
                sticker: nil, layers: layers, altText: altText,
                layerFiles: editor.files, callServerId: callServer
            )
        case .text, .call:
            return StoryDraftRequest(
                kind: "text", text: nil, background: background, caption: nil, sticker: nil,
                layers: layers, altText: altText, layerFiles: editor.files, callServerId: callServer
            )
        }
    }

    /// Next: a video muted in the editor is re-exported without its sound
    /// first, then the audience sheet opens.
    private func advance() async {
        error = nil
        guard canAdvance else { return }
        var media = draft
        if mode == .media, muted, let current = draft, current.isVideo {
            preparing = true
            defer { preparing = false }
            do {
                media = try await StoryMediaPrep.silenced(current, maxVideoMs: config.maxVideoMs)
            } catch {
                self.error = String(localized: "That format won't work. Use JPG, PNG, WebP or MP4.")
                return
            }
        }
        finalMedia = mode == .media ? media : nil
        builtRequest = buildRequest(media: finalMedia)
        showingAudience = true
    }

    // MARK: - Media

    private func load(_ item: PhotosPickerItem) async {
        preparing = true
        error = nil
        defer {
            preparing = false
            pickerItem = nil
        }
        if item.supportedContentTypes.contains(where: { $0.conforms(to: .movie) }) {
            guard let movie = try? await item.loadTransferable(type: StoryMovieFile.self) else {
                error = String(localized: "That format won't work. Use JPG, PNG, WebP or MP4.")
                return
            }
            await accept(videoAt: movie.url)
        } else if let data = try? await item.loadTransferable(type: Data.self), let image = UIImage(data: data) {
            accept(image: image)
        } else {
            error = String(localized: "That format won't work. Use JPG, PNG, WebP or MP4.")
        }
    }

    private func accept(cameraResult: StoryCameraResult?) async {
        switch cameraResult {
        case .image(let image): accept(image: image)
        case .video(let url): await accept(videoAt: url)
        case nil: break
        }
    }

    private func accept(image: UIImage) {
        guard let draft = StoryMediaPrep.image(image) else {
            error = String(localized: "That format won't work. Use JPG, PNG, WebP or MP4.")
            return
        }
        open(draft)
    }

    private func open(_ draft: StoryDraftMedia) {
        editor.clear()
        editorSerial += 1
        muted = false
        withAnimation(Motion.standard) {
            mode = .media
            self.draft = draft
        }
    }

    /// A file from the Files app: copied somewhere this app owns first, because
    /// the picked URL is security scoped and only valid while it is open.
    private func load(fileAt url: URL) async {
        preparing = true
        error = nil
        defer { preparing = false }
        let scoped = url.startAccessingSecurityScopedResource()
        defer { if scoped { url.stopAccessingSecurityScopedResource() } }
        let type = UTType(filenameExtension: url.pathExtension)
        if type?.conforms(to: .movie) == true {
            let copy = FileManager.default.temporaryDirectory
                .appendingPathComponent("story-\(UUID().uuidString).\(url.pathExtension)")
            do {
                try FileManager.default.copyItem(at: url, to: copy)
            } catch {
                self.error = String(localized: "That format won't work. Use JPG, PNG, WebP or MP4.")
                return
            }
            await accept(videoAt: copy)
        } else if let data = try? Data(contentsOf: url), let image = UIImage(data: data) {
            accept(image: image)
        } else {
            error = String(localized: "That format won't work. Use JPG, PNG, WebP or MP4.")
        }
    }

    private func accept(videoAt url: URL, trimStartMs: Int? = nil) async {
        preparing = true
        defer { preparing = false }
        do {
            if trimStartMs == nil {
                let duration = try await AVURLAsset(url: url).load(.duration)
                let ms = Int((duration.seconds * 1000).rounded())
                // Past the limit the person chooses which 30 s; they are not
                // sent away with a refusal.
                if StoryTrim.needsTrim(durationMs: ms, maxMs: config.maxVideoMs) {
                    trimRequest = StoryTrimRequest(url: url, durationMs: ms)
                    return
                }
            }
            let draft = try await StoryMediaPrep.video(at: url, trimStartMs: trimStartMs, maxVideoMs: config.maxVideoMs)
            open(draft)
        } catch let failure as StoryMediaPrep.Failure {
            error = failure.message
        } catch {
            self.error = String(localized: "That format won't work. Use JPG, PNG, WebP or MP4.")
        }
    }
}

/// The parts of a create request the canvas decides.
struct StoryDraftRequest: Sendable {
    let kind: String
    let text: String?
    let background: String?
    let caption: String?
    let sticker: StoryCallSticker?
    var layers: [StoryLayerInput] = []
    var altText: String? = nil
    /// The bytes behind each picture layer, by layer id.
    var layerFiles: [String: StoryLayerFile] = [:]
    /// The server a call layer belongs to: it has to be one of the audiences.
    var callServerId: String? = nil
}

/// A picked or shot file, already prepared for upload.
struct StoryDraftMedia: Sendable {
    let data: Data
    let contentType: String
    let width: Int
    let height: Int
    let durationMs: Int?
    let preview: UIImage
    /// Where a video lives on disk, for playing it back in the editor.
    var fileURL: URL? = nil

    var isVideo: Bool { contentType.hasPrefix("video/") }
}

/// The call the sticker points at.
struct StoryCallChoice: Identifiable, Hashable, Sendable {
    let serverId: String
    let serverName: String
    let channelId: String
    let channelName: String
    var serverIconUrl: String? = nil
    var id: String { channelId }
}

/// Which room "Chama pra call" starts on, and whether the sticker will be open
/// once posted. The server keeps a call sticker live only while its AUTHOR is
/// in the room, so a sticker for a room the author is not in is posted already
/// closed ("A call acabou") for everyone. Pure so it is tested, not eyeballed.
enum StoryCallRoom {
    static func authorIn(_ channelId: String, userId: String?, occupants: (String) -> [VoiceParticipant]) -> Bool {
        guard let userId else { return false }
        return occupants(channelId).contains { $0.userId == userId }
    }

    /// The room the author is in, if any; otherwise nothing is picked for them.
    static func defaultChoice(
        _ rooms: [StoryCallChoice], userId: String?, occupants: (String) -> [VoiceParticipant]
    ) -> StoryCallChoice? {
        rooms.first { authorIn($0.channelId, userId: userId, occupants: occupants) }
    }
}

/// A movie handed over by the photo picker, copied somewhere this app owns.
struct StoryMovieFile: Transferable {
    let url: URL

    static var transferRepresentation: some TransferRepresentation {
        FileRepresentation(contentType: .movie) { movie in
            SentTransferredFile(movie.url)
        } importing: { received in
            let copy = FileManager.default.temporaryDirectory
                .appendingPathComponent("story-\(UUID().uuidString).\(received.file.pathExtension)")
            try FileManager.default.copyItem(at: received.file, to: copy)
            return StoryMovieFile(url: copy)
        }
    }
}

/// Re-encoding on the phone, the only place location data can be stripped.
enum StoryMediaPrep {
    struct Failure: Error {
        let message: String
    }

    /// At most `StoryLimits.imageMaxEdge` on the long side, re-drawn (which
    /// drops every EXIF field, GPS included) and saved as JPEG.
    static func image(_ source: UIImage) -> StoryDraftMedia? {
        let size = fittedSize(source.size, maxEdge: StoryLimits.imageMaxEdge)
        guard size.width >= 1, size.height >= 1 else { return nil }
        let format = UIGraphicsImageRendererFormat()
        format.scale = 1
        format.opaque = true
        let rendered = UIGraphicsImageRenderer(size: size, format: format).image { _ in
            source.draw(in: CGRect(origin: .zero, size: size))
        }
        guard let data = rendered.jpegData(compressionQuality: 0.85), data.count <= StoryLimits.maxBytes else { return nil }
        return StoryDraftMedia(
            data: data, contentType: "image/jpeg",
            width: Int(size.width), height: Int(size.height),
            durationMs: nil, preview: rendered
        )
    }

    static func fittedSize(_ size: CGSize, maxEdge: CGFloat) -> CGSize {
        let longest = max(size.width, size.height)
        guard longest > maxEdge, longest > 0 else {
            return CGSize(width: size.width.rounded(), height: size.height.rounded())
        }
        let scale = maxEdge / longest
        return CGSize(width: (size.width * scale).rounded(), height: (size.height * scale).rounded())
    }

    /// A video as it is now, without its sound: the editor's mute toggle.
    static func silenced(_ draft: StoryDraftMedia, maxVideoMs: Int) async throws -> StoryDraftMedia {
        guard let url = draft.fileURL else { return draft }
        return try await video(at: url, trimStartMs: 0, stripAudio: true, maxVideoMs: maxVideoMs)
    }

    /// 720p H.264 MP4, metadata dropped, refused past the limit before any
    /// byte is uploaded.
    ///
    /// `trimStartMs` is where the kept window starts when the clip is longer
    /// than the limit (the trimmer chooses it). Without one, a clip past the
    /// limit plus a second of slack is refused, and up to a second over is
    /// cut to the limit: a recording stops a frame or two late.
    static func video(at url: URL, trimStartMs: Int? = nil, stripAudio: Bool = false, maxVideoMs: Int) async throws -> StoryDraftMedia {
        let source = AVURLAsset(url: url)
        let duration = try await source.load(.duration)
        var asset: AVAsset = source
        if stripAudio {
            // Only the picture track goes into the composition, so what is
            // exported has no sound at all.
            let composition = AVMutableComposition()
            if let video = try await source.loadTracks(withMediaType: .video).first,
               let track = composition.addMutableTrack(withMediaType: .video, preferredTrackID: kCMPersistentTrackID_Invalid) {
                try track.insertTimeRange(CMTimeRange(start: .zero, duration: duration), of: video, at: .zero)
                track.preferredTransform = try await video.load(.preferredTransform)
            }
            asset = composition
        }
        let totalMs = Int((duration.seconds * 1000).rounded())
        if trimStartMs == nil, StoryTrim.needsTrim(durationMs: totalMs, maxMs: maxVideoMs) {
            throw Failure(message: StoryRules.videoProblem(durationMs: totalMs, byteSize: 0, maxVideoMs: maxVideoMs) ?? "")
        }
        let range = StoryTrim.keptRange(startMs: trimStartMs ?? 0, durationMs: totalMs, maxMs: maxVideoMs)
        let durationMs = range.lengthMs
        guard let export = AVAssetExportSession(asset: asset, presetName: AVAssetExportPreset1280x720) else {
            throw Failure(message: String(localized: "That format won't work. Use JPG, PNG, WebP or MP4."))
        }
        let out = FileManager.default.temporaryDirectory.appendingPathComponent("story-\(UUID().uuidString).mp4")
        export.outputURL = out
        export.outputFileType = .mp4
        export.shouldOptimizeForNetworkUse = true
        export.timeRange = CMTimeRange(
            start: CMTime(value: CMTimeValue(range.startMs), timescale: 1000),
            duration: CMTime(value: CMTimeValue(range.lengthMs), timescale: 1000)
        )
        // No location, no device, no creation date: nothing but the picture.
        export.metadata = []
        export.metadataItemFilter = .forSharing()
        await export.export()
        guard export.status == .completed else {
            throw Failure(message: String(localized: "That format won't work. Use JPG, PNG, WebP or MP4."))
        }
        let data = try Data(contentsOf: out)
        if let problem = StoryRules.videoProblem(durationMs: durationMs, byteSize: data.count, maxVideoMs: maxVideoMs) {
            throw Failure(message: problem)
        }
        let exported = AVURLAsset(url: out)
        var width = 720
        var height = 1280
        if let track = try await exported.loadTracks(withMediaType: .video).first {
            let (natural, transform) = try await track.load(.naturalSize, .preferredTransform)
            let applied = natural.applying(transform)
            width = max(1, Int(abs(applied.width)))
            height = max(1, Int(abs(applied.height)))
        }
        let generator = AVAssetImageGenerator(asset: exported)
        generator.appliesPreferredTrackTransform = true
        let poster = (try? await generator.image(at: CMTime(seconds: 0.5, preferredTimescale: 600)).image)
            .map { UIImage(cgImage: $0) } ?? UIImage()
        return StoryDraftMedia(
            data: data, contentType: "video/mp4", width: width, height: height,
            durationMs: max(1, durationMs), preview: poster, fileURL: out
        )
    }
}

/// What the story camera hands back: a photo, or a video file it just wrote.
enum StoryCameraResult {
    case image(UIImage)
    case video(URL)
}

/// "Chama pra call": the voice rooms of the servers this account can post
/// stories to, each with who is in it right now.
struct StoryCallPicker: View {
    @Environment(SessionStore.self) private var session
    @Binding var selection: StoryCallChoice?
    @State private var rooms: [StoryCallChoice] = []
    @State private var loaded = false

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("Call people in")
                .font(Typography.bodyMedium)
                .foregroundStyle(.white)
            Text("Whoever taps joins right away. The card shows who's in there live.")
                .font(Typography.caption)
                .foregroundStyle(.white.opacity(0.75))
            if loaded && rooms.isEmpty {
                Text("No voice room you can post to.")
                    .font(Typography.caption)
                    .foregroundStyle(.white.opacity(0.75))
            }
            if let selection, !StoryCallRoom.authorIn(
                selection.channelId, userId: session.currentUser?.id,
                occupants: { session.voiceOccupancy.participants(in: $0) }
            ) {
                Text(verbatim: String(localized: "You're not in \(selection.channelName). The card only lets people in while you're in the call."))
                    .font(Typography.caption)
                    .foregroundStyle(Palette.warning)
                    .fixedSize(horizontal: false, vertical: true)
                    .accessibilityIdentifier("composer.call.notInRoom")
            }
            ScrollView {
                VStack(spacing: 6) {
                    ForEach(rooms) { room in
                        let inside = session.voiceOccupancy.participants(in: room.channelId)
                        Button { selection = room } label: {
                            HStack(spacing: 12) {
                                Avatar(name: room.serverName, seed: room.serverId, size: 38, url: room.serverIconUrl)
                                VStack(alignment: .leading, spacing: 2) {
                                    HStack(spacing: 5) {
                                        Image(systemName: "speaker.wave.2.fill")
                                            .font(.system(size: 11, weight: .bold))
                                        Text(verbatim: room.channelName)
                                            .font(Typography.bodyMedium)
                                            .lineLimit(1)
                                    }
                                    .foregroundStyle(.white)
                                    Text(verbatim: room.serverName)
                                        .font(Typography.caption)
                                        .foregroundStyle(.white.opacity(0.7))
                                        .lineLimit(1)
                                    if inside.isEmpty {
                                        Text("Nobody in the call right now")
                                            .font(Typography.caption)
                                            .foregroundStyle(.white.opacity(0.55))
                                    }
                                }
                                Spacer()
                                if !inside.isEmpty {
                                    HStack(spacing: -8) {
                                        ForEach(inside.prefix(3), id: \.userId) { person in
                                            Avatar(name: person.displayName, seed: person.userId, size: 24)
                                                .overlay(Circle().strokeBorder(Palette.ink, lineWidth: 2))
                                        }
                                    }
                                    Text(verbatim: "\(inside.count)")
                                        .font(Typography.caption)
                                        .monospacedDigit()
                                        .foregroundStyle(Palette.signal)
                                }
                                Image(systemName: selection == room ? "largecircle.fill.circle" : "circle")
                                    .foregroundStyle(selection == room ? Palette.signal : .white.opacity(0.6))
                            }
                            .padding(10)
                            .background(RoundedRectangle(cornerRadius: 12).fill(.black.opacity(selection == room ? 0.55 : 0.35)))
                            .overlay(RoundedRectangle(cornerRadius: 12).strokeBorder(selection == room ? Palette.signal : .clear, lineWidth: 1.5))
                        }
                        .buttonStyle(.plain)
                        .accessibilityIdentifier("composer.call.\(room.channelId)")
                    }
                }
            }
        }
        .task { await load() }
    }

    private func load() async {
        defer { loaded = true }
        guard let options = try? await session.api.storyAudiences() else { return }
        var found: [StoryCallChoice] = []
        for server in options.servers where server.canPost {
            guard let channels = try? await session.api.channels(serverId: server.serverId) else { continue }
            for channel in channels where channel.isVoice {
                found.append(StoryCallChoice(
                    serverId: server.serverId, serverName: server.serverName,
                    channelId: channel.id, channelName: channel.name,
                    serverIconUrl: server.iconUrl
                ))
            }
        }
        // Rooms with people in them first: that is the call worth sharing.
        rooms = found.sorted {
            session.voiceOccupancy.participants(in: $0.channelId).count
                > session.voiceOccupancy.participants(in: $1.channelId).count
        }
        // Start on the room this account is in: that is the only sticker that
        // is open once posted.
        if selection == nil {
            selection = StoryCallRoom.defaultChoice(
                rooms, userId: session.currentUser?.id,
                occupants: { session.voiceOccupancy.participants(in: $0) }
            )
        }
    }
}

/// "Quem vê": every server with stories on where this account may post,
/// plus Amigos, pre-ticked where the composer opened; replies on or off;
/// and the post itself, with real upload progress.
struct StoryAudienceSheet: View {
    @Environment(SessionStore.self) private var session
    let preselectedServerId: String?
    let preselectsFriends: Bool
    /// A call sticker's server has to be one of the audiences.
    let callServerId: String?
    let request: StoryDraftRequest
    let media: StoryDraftMedia?
    let onPosted: () -> Void

    @State private var options: StoryAudienceOptions?
    @State private var servers: Set<String> = []
    @State private var friends = false
    @State private var repliesEnabled = true
    @State private var posting = false
    @State private var failed = false
    @State private var error: String?
    /// One per story this sheet posts, reused by "Tentar de novo", so a retry
    /// after a lost answer is the same story and not a second one.
    @State private var requestId = UUID().uuidString

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Who sees it")
                .font(Typography.title(19))
                .foregroundStyle(Palette.paper)
            Text("You can pick more than one. It starts with where you were.")
                .font(Typography.caption)
                .foregroundStyle(Palette.paperMuted)

            ScrollView {
                VStack(alignment: .leading, spacing: 4) {
                    if let options {
                        ForEach(options.servers) { server in
                            row(
                                title: server.serverName,
                                subtitle: server.canPost
                                    ? String(localized: "\(server.memberCount) members")
                                    : (StoryRules.blockedLine(server.blockedReason) ?? ""),
                                checked: servers.contains(server.serverId),
                                enabled: server.canPost
                            ) {
                                if servers.contains(server.serverId) {
                                    servers.remove(server.serverId)
                                } else if servers.count < StoryLimits.maxServerAudiences {
                                    servers.insert(server.serverId)
                                }
                            }
                            .accessibilityIdentifier("audience.server.\(server.serverId)")
                        }
                        if options.friends.enabled {
                            row(title: String(localized: "Friends"), subtitle: nil, checked: friends, enabled: options.friends.canPost) {
                                friends.toggle()
                            }
                            .accessibilityIdentifier("audience.friends")
                        }
                    } else {
                        ProgressView().tint(Palette.signal).frame(maxWidth: .infinity)
                    }
                }
            }

            Divider().overlay(Palette.border)
            Toggle(isOn: $repliesEnabled) {
                VStack(alignment: .leading, spacing: 1) {
                    Text("Allow replies")
                        .font(Typography.bodyMedium)
                        .foregroundStyle(Palette.paper)
                    Text("Replies land in your Conversations")
                        .font(Typography.caption)
                        .foregroundStyle(Palette.paperMuted)
                }
            }
            .tint(Palette.signal)

            if let error {
                Text(verbatim: error)
                    .font(Typography.callout)
                    .foregroundStyle(Palette.danger)
                    .accessibilityIdentifier("audience.error")
            }

            Button {
                Task { await post() }
            } label: {
                Text(posting ? String(localized: "Posting…") : (failed ? String(localized: "Didn't upload. Try again") : String(localized: "Post story")))
                    .frame(maxWidth: .infinity)
            }
            .buttonStyle(PrimaryButtonStyle(isEnabled: canPost && !posting))
            .disabled(!canPost || posting)
            .accessibilityIdentifier("audience.post")

            Text("Gone in 24 h. Each server's staff can remove it.")
                .font(Typography.caption)
                .foregroundStyle(Palette.paperMuted)
                .frame(maxWidth: .infinity)
        }
        .padding(Metrics.hPadding)
        .padding(.top, 8)
        .task { await load() }
    }

    private var canPost: Bool {
        guard !servers.isEmpty || friends else { return false }
        if let callServerId { return servers.contains(callServerId) }
        return true
    }

    private func row(title: String, subtitle: String?, checked: Bool, enabled: Bool, toggle: @escaping () -> Void) -> some View {
        Button(action: toggle) {
            HStack(spacing: 12) {
                Image(systemName: checked ? "checkmark.square.fill" : "square")
                    .font(.system(size: 20))
                    .foregroundStyle(checked ? Palette.signal : Palette.border)
                VStack(alignment: .leading, spacing: 1) {
                    Text(verbatim: title)
                        .font(Typography.bodyMedium)
                        .foregroundStyle(enabled ? Palette.paper : Palette.paperMuted)
                    if let subtitle, !subtitle.isEmpty {
                        Text(verbatim: subtitle)
                            .font(Typography.caption)
                            .foregroundStyle(Palette.paperMuted)
                    }
                }
                Spacer()
            }
            .padding(.vertical, 6)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .disabled(!enabled)
    }

    private func load() async {
        guard let loaded = try? await session.api.storyAudiences() else {
            error = String(localized: "Couldn't load where you can post.")
            return
        }
        options = loaded
        let postable = Set(loaded.servers.filter(\.canPost).map(\.serverId))
        if let preselectedServerId, postable.contains(preselectedServerId) {
            servers.insert(preselectedServerId)
        }
        if let callServerId, postable.contains(callServerId) {
            servers.insert(callServerId)
        }
        if preselectsFriends, loaded.friends.enabled, loaded.friends.canPost {
            friends = true
        }
    }

    /// Create, PUT the bytes with exactly the signed headers, publish.
    private func post() async {
        posting = true
        failed = false
        error = nil
        defer { posting = false }
        let body = CreateStoryRequest(
            requestId: requestId,
            kind: request.kind,
            caption: request.caption,
            text: request.text,
            background: request.background,
            sticker: request.sticker,
            repliesEnabled: repliesEnabled,
            audiences: StoryAudienceTargets(serverIds: Array(servers), friends: friends),
            media: media.map {
                StoryMediaInput(contentType: $0.contentType, byteSize: $0.data.count,
                                width: $0.width, height: $0.height, durationMs: $0.durationMs)
            },
            layers: request.layers.isEmpty ? nil : request.layers,
            altText: request.altText
        )
        do {
            let created = try await session.api.createStory(body)
            // Every file goes up before the story is published: the base
            // photo or video, then each placed photo and the drawing.
            if let upload = created.upload, let media {
                try await StoryUploader.put(media.data, to: upload)
            }
            for target in created.layerUploads {
                guard let file = request.layerFiles[target.layerId] else { continue }
                try await StoryUploader.put(file.data, to: StoryUpload(url: target.url, method: target.method, headers: target.headers))
            }
            if created.upload != nil || !created.layerUploads.isEmpty {
                _ = try await session.api.publishStory(id: created.story.id)
            }
            onPosted()
        } catch {
            failed = true
            self.error = (error as? APIError)?.errorDescription ?? error.localizedDescription
        }
    }
}

/// The presigned PUT: exactly the headers the server signed, nothing else.
enum StoryUploader {
    static func put(_ data: Data, to upload: StoryUpload) async throws {
        guard let url = URL(string: upload.url) else { throw APIError.transport("Bad upload URL") }
        var request = URLRequest(url: url)
        request.httpMethod = upload.method
        for (name, value) in upload.headers {
            request.setValue(value, forHTTPHeaderField: name)
        }
        let (_, response) = try await URLSession.shared.upload(for: request, from: data)
        guard let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode) else {
            throw APIError.transport(String(localized: "Didn't upload. Try again"))
        }
    }
}
