import AVFoundation
import PencilKit
import PhotosUI
import SwiftUI
import UIKit

/// What the canvas sits on: the shot or picked file, or a card background.
enum StoryEditorBase {
    case media(StoryDraftMedia)
    case card(background: String)
}

/// The edit step: a 9:16 canvas with layers on it, and the tools to add them.
/// Text, photos, a drawing, stickers; every layer drags, scales and turns
/// with the fingers, snaps to the middle with a tick, and goes in the bin when
/// it is dropped there. The composer owns the page around it (the close
/// button, "Next", the audience); this owns everything on the canvas.
struct StoryEditorView: View {
    @Environment(SessionStore.self) private var session
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    let model: StoryEditorModel
    let base: StoryEditorBase
    @Binding var muted: Bool
    @Binding var background: String
    let preselectedServerId: String?
    /// Opens the text tool as soon as the editor appears (a text card).
    var opensText = false
    /// Opens the call picker as soon as the editor appears (a call card).
    var opensCall = false
    let onClose: () -> Void
    let onNext: () -> Void
    let canAdvance: Bool

    /// The line the text tool is on: a new one (at the place it will start) or
    /// an existing layer, edited where it is.
    private enum TextTarget: Identifiable {
        case new(x: Double, y: Double)
        case edit(String)
        var id: String {
            switch self {
            case .new: "new"
            case .edit(let id): id
            }
        }
    }

    @State private var textTarget: TextTarget?
    @State private var showingTray = false
    @State private var showingCall = false
    @State private var showingMention = false
    @State private var showingPhotos = false
    @State private var photoItem: PhotosPickerItem?
    @State private var drawing = false
    @State private var menuFor: String?
    @State private var notice: String?
    @State private var confirmingDiscard = false
    @State private var snapTick = 0
    @State private var trashTick = 0
    @State private var deleteTick = 0
    @State private var callLive: [String: StoryCallLive] = [:]
    @State private var didAutoOpen = false

    private var stage: some View {
        GeometryReader { proxy in
            let canvas = canvasSize(in: proxy.size)
            ZStack {
                Color.black.ignoresSafeArea()
                canvasView(canvas)
                    .frame(width: canvas.width, height: canvas.height)
                    .position(x: proxy.size.width / 2, y: proxy.size.height / 2)
                    .onAppear { model.canvas = canvas }
                    .onChange(of: canvas) { _, value in model.canvas = value }

                // The buttons live INSIDE the picture, in its corners, never
                // across its edge: the chrome is laid out in the canvas' own box.
                chrome(canvas)
                    .frame(width: canvas.width, height: canvas.height)
                    .position(x: proxy.size.width / 2, y: proxy.size.height / 2)

                textOverlay(canvas, in: proxy.size)
                drawOverlay(canvas, in: proxy.size)
            }
        }
    }

    /// The text tool, on the line it is editing and nowhere else.
    @ViewBuilder
    private func textOverlay(_ canvas: CGSize, in size: CGSize) -> some View {
        if let target = textTarget {
            let place = textPlace(for: target)
            let originX: CGFloat = (size.width - canvas.width) / 2
            let originY: CGFloat = (size.height - canvas.height) / 2
            let center = CGPoint(
                x: originX + CGFloat(place.x) * canvas.width,
                y: originY + CGFloat(place.y) * canvas.height
            )
            StoryTextEditView(
                data: place.data, scale: place.scale, center: center,
                rotation: place.rotation, canvasWidth: canvas.width
            ) { result in
                finishText(target, result)
            }
            .id(target.id)
            .transition(.opacity)
            .zIndex(5)
        }
    }

    @ViewBuilder
    private func drawOverlay(_ canvas: CGSize, in size: CGSize) -> some View {
        if drawing {
            StoryDrawView(canvas: canvas, initial: model.drawing) { strokes in
                finishDrawing(strokes, canvas: canvas)
            }
            .position(x: size.width / 2, y: size.height / 2)
            .zIndex(5)
        }
    }

    // The modifiers are split over three small functions: one long chain
    // after a big `GeometryReader` is more than the compiler will type-check in
    // reasonable time on a slower machine.
    var body: some View {
        withLifecycle(withSheets(withFeedback(stage)))
    }

    private func withFeedback<V: View>(_ view: V) -> some View {
        view
        // The keyboard must not squeeze the canvas: the line being typed is
        // edited IN PLACE, so the canvas keeps its size and place under it.
        .ignoresSafeArea(.keyboard)
        .sensoryFeedback(.impact(flexibility: .rigid, intensity: 0.5), trigger: snapTick)
        .sensoryFeedback(.impact(weight: .medium), trigger: trashTick)
        .sensoryFeedback(.success, trigger: deleteTick)
        .photosPicker(isPresented: $showingPhotos, selection: $photoItem, matching: .images, preferredItemEncoding: .current)
        .onChange(of: photoItem) { _, item in
            guard let item else { return }
            Task { await addPhoto(item) }
        }
    }

    private func withSheets<V: View>(_ view: V) -> some View {
        view
        .sheet(isPresented: $showingTray) {
            StoryStickerTray(
                isFull: model.isFull,
                canAddCall: model.canAddCall(), canAddMention: model.canAddMention(),
                onCall: { showingTray = false; showingCall = true },
                onMention: { showingTray = false; showingMention = true }
            )
            .presentationDetents([.height(230)])
            .presentationBackground(Palette.ink)
        }
        .sheet(isPresented: $showingCall) {
            StoryCallSheet { choice in
                showingCall = false
                addCall(choice)
            }
            .presentationDetents([.fraction(0.62), .large])
            .presentationBackground(Palette.ink)
        }
        .sheet(isPresented: $showingMention) {
            StoryMentionSheet(
                serverId: preselectedServerId,
                taken: Set(model.layers.compactMap { if case .mention(let id, _) = $0.content { id } else { nil } })
            ) { person in
                showingMention = false
                if model.addMention(userId: person.id, user: person.author) == nil {
                    show(model.isFull ? Self.fullNotice : String(localized: "You can't add that mention."))
                }
            }
            .presentationDetents([.large])
            .presentationBackground(Palette.ink)
        }
    }

    private func withLifecycle<V: View>(_ view: V) -> some View {
        view
        .confirmationDialog(Text("Discard this story?"), isPresented: $confirmingDiscard, titleVisibility: .visible) {
            Button("Discard", role: .destructive) { onClose() }
            Button("Keep editing", role: .cancel) {}
        }
        .task {
            model.onSnap = { snapTick += 1 }
            model.onTrashEnter = { trashTick += 1 }
            model.onDelete = { deleteTick += 1 }
            guard !didAutoOpen else { return }
            didAutoOpen = true
            if opensText, !model.hasContent { textTarget = newText() }
            if opensCall, !model.hasCall { showingCall = true }
        }
        .task(id: model.layers.map(\.id)) { await refreshCallState() }
    }

    // MARK: Canvas

    /// The biggest 9:16 that fits the screen. The controls sit over it, in its
    /// corners, the way Instagram's do.
    private func canvasSize(in size: CGSize) -> CGSize {
        let width = min(size.width, max(120, size.height) * StoryCanvas.aspect)
        return CGSize(width: width, height: width / StoryCanvas.aspect)
    }

    private func canvasView(_ canvas: CGSize) -> some View {
        ZStack {
            baseView(canvas)
            ForEach(model.layers) { layer in
                editableLayer(layer, canvas: canvas)
            }
            guides(canvas)
            trash(canvas)
            StoryGestureSurface(
                model: model, isEnabled: textTarget == nil && !drawing,
                onTap: { id in handleTap(id) },
                onLongPress: { id in menuFor = id }
            )
            .frame(width: canvas.width, height: canvas.height)
            // Above the surface, so its buttons are tapped and not swallowed.
            menu(canvas)
        }
        .frame(width: canvas.width, height: canvas.height)
        .clipShape(RoundedRectangle(cornerRadius: 22, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 22, style: .continuous).strokeBorder(.white.opacity(0.08), lineWidth: 1))
        .onPreferenceChange(StoryLayerSizesKey.self) { sizes in
            if model.sizes != sizes { model.sizes = sizes }
        }
    }

    /// A layer on the canvas, with the things a screen reader can do to it.
    private func editableLayer(_ layer: StoryLayer, canvas: CGSize) -> some View {
        StoryPlacedLayer(layer: layer, context: layerContext(canvas), selected: model.selectedId == layer.id && !model.isDragging)
            // The line being typed is drawn by the text tool, in its place.
            .opacity(isEditing(layer.id) ? 0 : 1)
            .modifier(StoryLayerAccessibility(layer: layer, model: model) { textTarget = .edit(layer.id) })
    }

    @ViewBuilder
    private func baseView(_ canvas: CGSize) -> some View {
        switch base {
        case .card(let key):
            LinearGradient(colors: StoryRules.backgroundColors(key), startPoint: .top, endPoint: .bottom)
                .frame(width: canvas.width, height: canvas.height)
        case .media(let draft):
            StoryMediaBase(draft: draft, canvas: canvas, muted: muted)
        }
    }

    private func layerContext(_ canvas: CGSize) -> StoryLayerContext {
        StoryLayerContext(
            canvas: canvas, previews: model.previews,
            call: { layer in
                guard case .call(let serverId, let channelId) = layer.content, let info = model.callInfo else { return nil }
                let live = callLive[channelId]
                return StoryCallStickerData(
                    roomName: live?.channelName ?? info.roomName, serverName: info.serverName, serverId: serverId,
                    serverIconUrl: info.serverIconUrl, participants: live?.participants ?? [],
                    count: live?.count ?? 0, state: .preview, joinable: true
                )
            },
            reduceMotion: reduceMotion
        )
    }

    // MARK: Guides, trash, menu

    @ViewBuilder
    private func guides(_ canvas: CGSize) -> some View {
        ZStack {
            if model.guides.vertical {
                Rectangle().fill(Palette.signal.opacity(0.9)).frame(width: 1.5, height: canvas.height)
            }
            if model.guides.horizontal {
                Rectangle().fill(Palette.signal.opacity(0.9)).frame(width: canvas.width, height: 1.5)
            }
        }
        .allowsHitTesting(false)
        .animation(reduceMotion ? nil : .easeOut(duration: 0.12), value: model.guides)
    }

    @ViewBuilder
    private func trash(_ canvas: CGSize) -> some View {
        let frame = StorySnap.trashFrame(canvas: canvas)
        ZStack {
            Circle().fill(model.overTrash ? Palette.danger : Color.black.opacity(0.55))
            Image(systemName: model.overTrash ? "trash.fill" : "trash")
                .font(.system(size: 22, weight: .semibold))
                .foregroundStyle(.white)
        }
        .frame(width: frame.width, height: frame.height)
        .scaleEffect(model.overTrash && !reduceMotion ? 1.18 : 1)
        .position(x: frame.midX, y: frame.midY)
        .opacity(model.isDragging ? 1 : 0)
        .animation(reduceMotion ? .easeOut(duration: 0.1) : Motion.press, value: model.overTrash)
        .animation(.easeOut(duration: 0.15), value: model.isDragging)
        .allowsHitTesting(false)
        .accessibilityHidden(true)
    }

    @ViewBuilder
    private func menu(_ canvas: CGSize) -> some View {
        if let id = menuFor, let layer = model.layer(id) {
            let size = model.sizes[id] ?? .zero
            let top: CGFloat = CGFloat(layer.y) * canvas.height - size.height * CGFloat(layer.scale) / 2 - 34
            let y = min(max(top, 28), canvas.height - 40)
            HStack(spacing: 4) {
                menuButton("square.3.layers.3d.top.filled", String(localized: "Bring to front"), id: "menu.front") {
                    model.bringToFront(id: id)
                    menuFor = nil
                }
                if case .image = layer.content {
                    menuButton("circle.square", String(localized: "Change shape"), id: "menu.shape") {
                        model.cycleShape(id: id)
                    }
                }
                menuButton("trash", String(localized: "Delete"), id: "menu.delete") {
                    model.delete(id: id)
                    menuFor = nil
                    deleteTick += 1
                }
            }
            .padding(6)
            .background(Capsule().fill(.black.opacity(0.78)))
            .overlay(Capsule().strokeBorder(.white.opacity(0.14), lineWidth: 1))
            .position(x: min(max(CGFloat(layer.x) * canvas.width, 70), canvas.width - 70), y: y)
            .transition(.opacity)
        }
    }

    private func menuButton(_ symbol: String, _ label: String, id: String, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Image(systemName: symbol)
                .font(.system(size: 16, weight: .semibold))
                .foregroundStyle(.white)
                .frame(width: 40, height: 36)
        }
        .accessibilityLabel(Text(verbatim: label))
        .accessibilityIdentifier(id)
    }

    // MARK: Chrome

    private func chrome(_ canvas: CGSize) -> some View {
        VStack(spacing: 0) {
            HStack(spacing: 10) {
                roundButton("xmark", String(localized: "Close"), id: "editor.close") {
                    if model.hasContent { confirmingDiscard = true } else { onClose() }
                }
                if model.canUndo {
                    roundButton("arrow.uturn.backward", String(localized: "Undo"), id: "editor.undo") { model.undo() }
                        .transition(.opacity)
                }
                Spacer()
                tools
            }
            .padding(.horizontal, 14)
            .padding(.top, 6)
            .animation(.easeOut(duration: 0.15), value: model.canUndo)
            Spacer()
            if let notice {
                Text(verbatim: notice)
                    .font(Typography.callout)
                    .foregroundStyle(.white)
                    .padding(.horizontal, 14)
                    .padding(.vertical, 8)
                    .background(Capsule().fill(.black.opacity(0.7)))
                    .padding(.bottom, 8)
                    .accessibilityIdentifier("editor.notice")
            }
            HStack {
                Spacer()
                Button(action: onNext) {
                    HStack(spacing: 8) {
                        Text("Next")
                        Image(systemName: "arrow.right")
                    }
                    .font(.system(size: 16, weight: .bold))
                    .foregroundStyle(Palette.inkDeep)
                    .padding(.horizontal, 22)
                    .padding(.vertical, 13)
                    .background(Capsule().fill(canAdvance ? Palette.signal : Palette.signal.opacity(0.4)))
                }
                .disabled(!canAdvance)
                .accessibilityIdentifier("composer.next")
            }
            .padding(.horizontal, 20)
            .padding(.bottom, 16)
        }
        // Out of the way while a finger drags a layer, and while the text or
        // draw tool has the screen.
        .opacity(model.isDragging || textTarget != nil || drawing ? 0 : 1)
        .animation(.easeOut(duration: 0.12), value: model.isDragging)
        .allowsHitTesting(textTarget == nil && !drawing)
    }

    /// The tools: the column Instagram has on the right.
    private var tools: some View {
        HStack(spacing: 10) {
            if case .media(let draft) = base, draft.isVideo {
                roundButton(muted ? "speaker.slash.fill" : "speaker.wave.2.fill",
                            muted ? String(localized: "Turn the sound on") : String(localized: "Turn the sound off"),
                            id: "editor.mute") { muted.toggle() }
            }
            if case .card = base {
                backgroundMenu
            }
            roundButton("scribble.variable", String(localized: "Draw"), id: "editor.draw") {
                // A new drawing is a layer like the others and counts against
                // the ceiling; redrawing the one that exists does not.
                if model.isFull, model.drawingLayer == nil {
                    show(Self.fullNotice)
                } else {
                    model.beginDrawing()
                    drawing = true
                }
            }
            roundButton("photo.badge.plus", String(localized: "Add a photo"), id: "editor.photo") {
                if model.isFull {
                    show(Self.fullNotice)
                } else if model.canAddImage() {
                    showingPhotos = true
                } else {
                    show(String(localized: "That's the most photos a story can hold."))
                }
            }
            roundButton("face.smiling", String(localized: "Stickers"), id: "editor.stickers") { showingTray = true }
            Button {
                if model.isFull { show(Self.fullNotice) } else { textTarget = newText() }
            } label: {
                Text(verbatim: "Aa")
                    .font(.system(size: 17, weight: .bold))
                    .foregroundStyle(.white)
                    .frame(width: 40, height: 40)
                    .background(Circle().fill(.black.opacity(0.55)).overlay(Circle().strokeBorder(.white.opacity(0.12), lineWidth: 1)))
            }
            .accessibilityLabel(Text("Add text"))
            .accessibilityIdentifier("editor.text")
        }
    }

    private var backgroundMenu: some View {
        Menu {
            ForEach(StoryRules.backgrounds, id: \.self) { key in
                Button { background = key } label: {
                    Label(StoryEditorView.backgroundName(key), systemImage: background == key ? "checkmark.circle.fill" : "circle.fill")
                }
            }
        } label: {
            Circle()
                .fill(LinearGradient(colors: StoryRules.backgroundColors(background), startPoint: .top, endPoint: .bottom))
                .frame(width: 28, height: 28)
                .overlay(Circle().strokeBorder(.white, lineWidth: 2))
                .frame(width: 40, height: 40)
        }
        .accessibilityLabel(Text("Background"))
        .accessibilityIdentifier("composer.background")
    }

    static func backgroundName(_ key: String) -> String {
        switch key {
        case "lime": String(localized: "Lime")
        case "night": String(localized: "Night")
        case "ember": String(localized: "Ember")
        case "grape": String(localized: "Grape")
        case "sand": String(localized: "Sand")
        default: String(localized: "Ink")
        }
    }

    private func roundButton(_ symbol: String, _ label: String, id: String, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Image(systemName: symbol)
                .font(.system(size: 17, weight: .semibold))
                .foregroundStyle(.white)
                .frame(width: 40, height: 40)
                .background(Circle().fill(.black.opacity(0.55)).overlay(Circle().strokeBorder(.white.opacity(0.12), lineWidth: 1)))
        }
        .accessibilityLabel(Text(verbatim: label))
        .accessibilityIdentifier(id)
    }

    // MARK: Actions

    private func handleTap(_ id: String?) {
        menuFor = nil
        guard let id, let layer = model.layer(id) else { return }
        if layer.isText { textTarget = .edit(id) }
    }

    private func isEditing(_ id: String) -> Bool {
        if case .edit(let editing)? = textTarget { return editing == id }
        return false
    }

    /// What every "add" says when the story already holds the ceiling (20).
    static var fullNotice: String { String(localized: "That's the most things a story can hold.") }

    private func newText() -> TextTarget {
        let start = model.nextTextCenter()
        return .new(x: start.x, y: start.y)
    }

    /// Everything the text tool needs to put the line where it is.
    private func textPlace(for target: TextTarget) -> (data: StoryTextData, x: Double, y: Double, scale: Double, rotation: Double) {
        switch target {
        case .new(let x, let y):
            return (StoryTextData(text: ""), x, y, 1, 0)
        case .edit(let id):
            if let layer = model.layer(id), case .text(let data) = layer.content {
                return (data, layer.x, layer.y, layer.scale, layer.rotation)
            }
            return (StoryTextData(text: ""), 0.5, 0.5, 1, 0)
        }
    }

    private func finishText(_ target: TextTarget, _ result: (StoryTextData, Double)?) {
        textTarget = nil
        // Cancelled: nothing changes.
        guard let (data, scale) = result else { return }
        // Done on nothing: a new line is not made, and an existing one that was
        // emptied goes away.
        if data.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            if case .edit(let id) = target { model.delete(id: id) }
            return
        }
        switch target {
        case .new(let x, let y):
            if model.addText(data, x: x, y: y, scale: scale) == nil { show(Self.fullNotice) }
        case .edit(let id):
            model.commitText(id: id, data, scale: scale)
        }
    }

    private func finishDrawing(_ strokes: PKDrawing?, canvas: CGSize) {
        drawing = false
        guard let strokes else { return }
        if strokes.strokes.isEmpty {
            model.setDrawing(PKDrawing(), file: nil, preview: nil)
            return
        }
        guard let png = StoryDrawingExport.png(strokes, canvas: canvas) else {
            show(String(localized: "Couldn't save the drawing."))
            return
        }
        if model.isFull, model.drawingLayer == nil {
            show(Self.fullNotice)
            return
        }
        model.setDrawing(
            strokes,
            file: StoryLayerFile(data: png.data, contentType: "image/png", width: png.width, height: png.height),
            preview: png.preview
        )
    }

    private func addPhoto(_ item: PhotosPickerItem) async {
        defer { photoItem = nil }
        // Downsampled from the bytes, so a full-size bitmap is never made.
        guard let data = try? await item.loadTransferable(type: Data.self),
              let image = await StoryImport.downsampledImage(data: data, maxEdge: StoryLimits.imageMaxEdge),
              let draft = StoryMediaPrep.image(image), draft.data.count <= StoryLayerLimits.maxBytes
        else {
            show(String(localized: "That format won't work. Use JPG, PNG, WebP or MP4."))
            return
        }
        let file = StoryLayerFile(data: draft.data, contentType: draft.contentType, width: draft.width, height: draft.height)
        if model.addImage(file, preview: draft.preview) == nil {
            show(model.isFull ? Self.fullNotice : String(localized: "That's the most photos a story can hold."))
        }
    }

    private func addCall(_ choice: StoryCallChoice) {
        let info = StoryCallLayerInfo(roomName: choice.channelName, serverName: choice.serverName, serverIconUrl: choice.serverIconUrl)
        if model.addCall(serverId: choice.serverId, channelId: choice.channelId, info: info) == nil {
            show(model.isFull ? Self.fullNotice : String(localized: "A story can have one call."))
        }
    }

    /// The call sticker in the editor shows who is in the room right now.
    private func refreshCallState() async {
        for layer in model.layers {
            guard case .call(let serverId, let channelId) = layer.content else { continue }
            let people = session.voiceOccupancy.participants(in: channelId)
            callLive[channelId] = StoryCallLive(
                serverId: serverId, channelId: channelId, channelName: model.callInfo?.roomName ?? "",
                participants: people.prefix(5).map { StoryAuthor(id: $0.userId, displayName: $0.displayName, avatarUrl: $0.avatarUrl) },
                count: people.count, state: "live", joinable: true
            )
        }
    }

    private func show(_ text: String) {
        notice = text
        Task {
            try? await Task.sleep(for: .seconds(2.5))
            if notice == text { notice = nil }
        }
    }
}

// MARK: - The media under the layers

/// A photo or video as the canvas base: filling it when it is already tall,
/// shown whole over a blurred copy of itself when it is not, so a landscape
/// shot is never cropped and never sits on black bars.
struct StoryMediaBase: View {
    let draft: StoryDraftMedia
    let canvas: CGSize
    let muted: Bool

    private var fillsCanvas: Bool {
        StoryCanvas.fillsCanvas(width: Int(draft.preview.size.width), height: Int(draft.preview.size.height))
    }

    var body: some View {
        ZStack {
            // A photo that does not fill sits over a blurred copy of itself; a
            // video, over black.
            if !fillsCanvas && !draft.isVideo {
                Color.clear.overlay {
                    Image(uiImage: draft.preview).resizable().scaledToFill().blur(radius: 28).scaleEffect(1.15)
                }
                .clipped()
                .overlay(Color.black.opacity(0.25))
            }
            if draft.isVideo, let url = draft.fileURL {
                StoryLoopPlayerView(url: url, muted: muted, fill: fillsCanvas)
            } else {
                Color.clear.overlay {
                    Image(uiImage: draft.preview)
                        .resizable()
                        .aspectRatio(contentMode: fillsCanvas ? .fill : .fit)
                }
                .clipped()
            }
        }
        .frame(width: canvas.width, height: canvas.height)
        .clipped()
    }
}

/// A silent-by-choice looping video for the canvas.
struct StoryLoopPlayerView: UIViewRepresentable {
    let url: URL
    let muted: Bool
    let fill: Bool

    final class View: UIView {
        override class var layerClass: AnyClass { AVPlayerLayer.self }
        var playerLayer: AVPlayerLayer { layer as! AVPlayerLayer }
        var player = AVQueuePlayer()
        var looper: AVPlayerLooper?
        var loadedURL: URL?
    }

    func makeUIView(context: Context) -> View {
        let view = View()
        view.playerLayer.player = view.player
        view.backgroundColor = .clear
        return view
    }

    func updateUIView(_ view: View, context: Context) {
        view.playerLayer.videoGravity = fill ? .resizeAspectFill : .resizeAspect
        view.player.isMuted = muted
        if view.loadedURL != url {
            view.loadedURL = url
            view.looper = AVPlayerLooper(player: view.player, templateItem: AVPlayerItem(url: url))
            view.player.play()
        }
    }

    static func dismantleUIView(_ view: View, coordinator: ()) {
        view.player.pause()
        view.looper = nil
    }
}


/// What VoiceOver can do to a layer: edit a line of text, move it, size it,
/// bring it forward, delete it. (A modifier of its own, so the canvas body stays
/// small enough to type-check quickly.)
private struct StoryLayerAccessibility: ViewModifier {
    let layer: StoryLayer
    let model: StoryEditorModel
    let onEdit: () -> Void

    func body(content: Content) -> some View {
        content
            .accessibilityAddTraits(layer.isText ? .isButton : [])
            .accessibilityHint(layer.isText ? Text("Double tap to edit") : Text(""))
            .accessibilityAction(named: Text("Edit")) { if layer.isText { onEdit() } }
            .modifier(StoryLayerMoveActions(id: layer.id, model: model))
    }
}

private struct StoryLayerMoveActions: ViewModifier {
    let id: String
    let model: StoryEditorModel

    func body(content: Content) -> some View {
        content
            .accessibilityAction(named: Text("Move up")) { model.nudge(id: id, dx: 0, dy: -0.05) }
            .accessibilityAction(named: Text("Move down")) { model.nudge(id: id, dx: 0, dy: 0.05) }
            .accessibilityAction(named: Text("Move left")) { model.nudge(id: id, dx: -0.05, dy: 0) }
            .accessibilityAction(named: Text("Move right")) { model.nudge(id: id, dx: 0.05, dy: 0) }
            .accessibilityAction(named: Text("Bigger")) { model.resize(id: id, by: 1.15) }
            .accessibilityAction(named: Text("Smaller")) { model.resize(id: id, by: 1 / 1.15) }
            .accessibilityAction(named: Text("Bring to front")) { model.bringToFront(id: id) }
            .accessibilityAction(named: Text("Delete")) { model.delete(id: id) }
    }
}
