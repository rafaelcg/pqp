import Observation
import PencilKit
import SwiftUI
import UIKit

/// The bytes behind a picture layer that has not been posted yet.
struct StoryLayerFile: Sendable {
    let data: Data
    let contentType: String
    let width: Int
    let height: Int
}

/// The call a call layer points at, for drawing it before it is posted.
struct StoryCallLayerInfo: Hashable, Sendable {
    let roomName: String
    let serverName: String
    let serverIconUrl: String?
}

/// Everything the editor holds: the layers, which one is picked, the gesture
/// in flight, the guides it draws, and the last few actions to undo. Pure
/// state with no views, so a drag, a snap and an undo are tested without a
/// screen.
@MainActor
@Observable
final class StoryEditorModel {
    struct Guides: Equatable {
        var vertical = false
        var horizontal = false
        var rotation = false
    }

    private struct Snapshot {
        let layers: [StoryLayer]
        let drawing: PKDrawing?
    }

    // MARK: State

    private(set) var layers: [StoryLayer] = []
    var selectedId: String?
    /// Natural size of each layer in points at the current canvas, reported by
    /// the views, used to find the layer under a finger.
    var sizes: [String: CGSize] = [:]
    var canvas: CGSize = .zero

    /// Bytes and a preview for every picture layer that is still a draft.
    private(set) var files: [String: StoryLayerFile] = [:]
    private(set) var previews: [String: UIImage] = [:]
    /// What the call layer's card shows before it is posted.
    private(set) var callInfo: StoryCallLayerInfo?
    /// The strokes behind the drawing layer, so a second visit to the pen
    /// keeps drawing on top of the first.
    private(set) var drawing = PKDrawing()

    private(set) var guides = Guides()
    private(set) var isDragging = false
    private(set) var overTrash = false
    private(set) var activeId: String?
    private(set) var canUndo = false

    /// Fires a light haptic: a snap entered, a trash entered.
    var onSnap: (() -> Void)?
    var onTrashEnter: (() -> Void)?
    var onDelete: (() -> Void)?

    private var undoStack: [Snapshot] = []
    static let undoDepth = 20

    // Gesture baselines.
    private var gestureBefore: Snapshot?
    private var startCenter = CGPoint.zero
    private var rawX = 0.0
    private var rawY = 0.0
    private var scaleBase = 1.0
    private var rotationBase = 0.0
    private var rotationRaw = 0.0
    private var lastSnappedX = false
    private var lastSnappedY = false
    private var lastSnappedAngle = false
    private var moved = false
    private var trashed = false

    // MARK: Reading

    func layer(_ id: String) -> StoryLayer? { layers.first { $0.id == id } }

    var hasContent: Bool { !layers.isEmpty }

    func count(where predicate: (StoryLayer) -> Bool) -> Int { layers.filter(predicate).count }

    var imageCount: Int { count { if case .image = $0.content { true } else { false } } }
    var mentionCount: Int { count { if case .mention = $0.content { true } else { false } } }
    var hasCall: Bool { count { if case .call = $0.content { true } else { false } } > 0 }
    var drawingLayer: StoryLayer? { layers.first { $0.isDrawing } }

    var isFull: Bool { layers.count >= StoryLayerLimits.max }

    func canAddImage() -> Bool { !isFull && imageCount < StoryLayerLimits.images }
    func canAddMention() -> Bool { !isFull && mentionCount < StoryLayerLimits.mentions }
    func canAddCall() -> Bool { !isFull && !hasCall }

    // MARK: Undo

    private func snapshot() -> Snapshot { Snapshot(layers: layers, drawing: drawing) }

    private func record(_ before: Snapshot) {
        undoStack.append(before)
        if undoStack.count > Self.undoDepth { undoStack.removeFirst() }
        canUndo = true
    }

    func undo() {
        guard let last = undoStack.popLast() else { return }
        layers = last.layers
        drawing = last.drawing ?? PKDrawing()
        canUndo = !undoStack.isEmpty
        if let selectedId, layer(selectedId) == nil { self.selectedId = nil }
        pruneFiles()
    }

    // MARK: Edits

    @discardableResult
    func addText(_ data: StoryTextData) -> String? {
        guard !isFull else { return nil }
        let before = snapshot()
        // A new line of text lands a little below the last one, so two are
        // not stacked on the exact same spot.
        let textCount = count { $0.isText }
        let y = min(0.82, 0.5 + Double(textCount % 6) * 0.07)
        let layer = StoryLayer(x: 0.5, y: y, content: .text(data))
        layers.append(layer)
        selectedId = layer.id
        record(before)
        return layer.id
    }

    func updateText(id: String, _ data: StoryTextData) {
        guard let index = layers.firstIndex(where: { $0.id == id }) else { return }
        let before = snapshot()
        layers[index].content = .text(data)
        record(before)
    }

    @discardableResult
    func addImage(_ file: StoryLayerFile, preview: UIImage) -> String? {
        guard canAddImage() else { return nil }
        let before = snapshot()
        let picture = StoryLayerPicture(url: nil, width: file.width, height: file.height, shape: .rounded)
        let offset = Double(imageCount % 4) * 0.04
        let layer = StoryLayer(x: 0.5 + offset, y: 0.45 + offset, scale: 1, content: .image(picture))
        layers.append(layer)
        files[layer.id] = file
        previews[layer.id] = preview
        selectedId = layer.id
        record(before)
        return layer.id
    }

    func cycleShape(id: String) {
        guard let index = layers.firstIndex(where: { $0.id == id }),
              case .image(var picture) = layers[index].content else { return }
        let before = snapshot()
        picture.shape = picture.shape.next
        layers[index].content = .image(picture)
        record(before)
    }

    @discardableResult
    func addCall(serverId: String, channelId: String, info: StoryCallLayerInfo) -> String? {
        guard canAddCall() else { return nil }
        let before = snapshot()
        let layer = StoryLayer(x: 0.5, y: 0.72, content: .call(serverId: serverId, channelId: channelId))
        layers.append(layer)
        callInfo = info
        selectedId = layer.id
        record(before)
        return layer.id
    }

    @discardableResult
    func addMention(userId: String, user: StoryAuthor) -> String? {
        guard canAddMention() else { return nil }
        // Each person once.
        if layers.contains(where: { if case .mention(let id, _) = $0.content { id == userId } else { false } }) { return nil }
        let before = snapshot()
        let offset = Double(mentionCount) * 0.06
        let layer = StoryLayer(x: 0.5, y: 0.3 + offset, content: .mention(userId: userId, user: user))
        layers.append(layer)
        selectedId = layer.id
        record(before)
        return layer.id
    }

    /// The drawing is one layer covering the canvas, replaced as a whole each
    /// time the pen is put down. An empty drawing removes it.
    func setDrawing(_ strokes: PKDrawing, file: StoryLayerFile?, preview: UIImage?) {
        let before = snapshot()
        let existing = drawingLayer
        guard !strokes.strokes.isEmpty, let file, let preview else {
            if let existing { layers.removeAll { $0.id == existing.id }; files[existing.id] = nil; previews[existing.id] = nil }
            drawing = PKDrawing()
            if existing != nil { record(before) }
            return
        }
        let picture = StoryLayerPicture(url: nil, width: file.width, height: file.height)
        if let existing, let index = layers.firstIndex(where: { $0.id == existing.id }) {
            layers[index].content = .drawing(picture)
            files[existing.id] = file
            previews[existing.id] = preview
        } else if !isFull {
            let layer = StoryLayer(content: .drawing(picture))
            // The drawing is the lowest layer, just above the base, so a
            // doodle never covers a title, a photo or a sticker.
            layers.insert(layer, at: 0)
            files[layer.id] = file
            previews[layer.id] = preview
        } else {
            return
        }
        drawing = strokes
        record(before)
    }

    func delete(id: String) {
        guard layer(id) != nil else { return }
        let before = snapshot()
        let wasDrawing = layer(id)?.isDrawing == true
        layers.removeAll { $0.id == id }
        if wasDrawing { drawing = PKDrawing() }
        if selectedId == id { selectedId = nil }
        record(before)
        pruneFiles()
    }

    func bringToFront(id: String) {
        guard let index = layers.firstIndex(where: { $0.id == id }), index != layers.count - 1 else { return }
        let before = snapshot()
        let layer = layers.remove(at: index)
        layers.append(layer)
        record(before)
    }

    func sendToBack(id: String) {
        guard let index = layers.firstIndex(where: { $0.id == id }), index != 0 else { return }
        let before = snapshot()
        let layer = layers.remove(at: index)
        // Behind everything, but not behind the drawing.
        layers.insert(layer, at: 0)
        record(before)
    }

    /// A keyboard or VoiceOver nudge: move by a fraction of the canvas.
    func nudge(id: String, dx: Double, dy: Double) {
        guard let index = layers.firstIndex(where: { $0.id == id }) else { return }
        let before = snapshot()
        layers[index].x = StoryCanvas.clampUnit(layers[index].x + dx)
        layers[index].y = StoryCanvas.clampUnit(layers[index].y + dy)
        record(before)
    }

    func resize(id: String, by factor: Double) {
        guard let index = layers.firstIndex(where: { $0.id == id }) else { return }
        let before = snapshot()
        layers[index].scale = StoryCanvas.clampScale(layers[index].scale * factor)
        record(before)
    }

    func clear() {
        layers = []
        files = [:]
        previews = [:]
        drawing = PKDrawing()
        undoStack = []
        canUndo = false
        selectedId = nil
        callInfo = nil
    }

    private func pruneFiles() {
        let alive = Set(layers.map(\.id))
        files = files.filter { alive.contains($0.key) }
        previews = previews.filter { alive.contains($0.key) }
        if !hasCall { callInfo = nil }
    }

    // MARK: Gestures

    /// A finger went down. True when it landed on a layer (or one is already
    /// being worked on), which then follows the gesture.
    @discardableResult
    func beginGesture(at point: CGPoint) -> Bool {
        if activeId != nil { return true }
        guard let target = StoryCanvas.topmost(layers, sizes: sizes, at: point, canvas: canvas) else { return false }
        begin(target)
        return true
    }

    /// A pinch or a twist with no finger yet on a layer: it goes to the
    /// picked layer, or the one under the middle of the fingers.
    @discardableResult
    func beginGestureOnSelection(at point: CGPoint) -> Bool {
        if activeId != nil { return true }
        if beginGesture(at: point) { return true }
        if let selectedId, let layer = layer(selectedId), !layer.isDrawing {
            begin(layer)
            return true
        }
        return false
    }

    private func begin(_ target: StoryLayer) {
        activeId = target.id
        selectedId = target.id
        gestureBefore = snapshot()
        rawX = target.x
        rawY = target.y
        startCenter = CGPoint(x: target.x, y: target.y)
        scaleBase = target.scale
        rotationBase = target.rotation
        rotationRaw = target.rotation
        moved = false
        trashed = false
        lastSnappedX = false
        lastSnappedY = false
        lastSnappedAngle = false
        isDragging = false
        overTrash = false
    }

    func drag(translation: CGSize, touch: CGPoint) {
        guard let id = activeId, let index = layers.firstIndex(where: { $0.id == id }),
              canvas.width > 0, canvas.height > 0 else { return }
        isDragging = true
        moved = true
        rawX = StoryCanvas.clampUnit(startCenter.x + translation.width / canvas.width)
        rawY = StoryCanvas.clampUnit(startCenter.y + translation.height / canvas.height)
        let snapped = StorySnap.position(x: rawX, y: rawY, canvas: canvas)
        layers[index].x = snapped.x
        layers[index].y = snapped.y
        if (snapped.snappedX && !lastSnappedX) || (snapped.snappedY && !lastSnappedY) { onSnap?() }
        lastSnappedX = snapped.snappedX
        lastSnappedY = snapped.snappedY
        guides.vertical = snapped.snappedX
        guides.horizontal = snapped.snappedY
        let over = StorySnap.isOverTrash(touch, canvas: canvas)
        if over && !overTrash { onTrashEnter?() }
        overTrash = over
    }

    func beginPinch() {
        guard let id = activeId, let layer = layer(id) else { return }
        scaleBase = layer.scale
    }

    func pinch(scale: Double) {
        guard let id = activeId, let index = layers.firstIndex(where: { $0.id == id }) else { return }
        moved = true
        layers[index].scale = StoryCanvas.clampScale(scaleBase * scale)
    }

    func beginRotation() {
        guard let id = activeId, let layer = layer(id) else { return }
        rotationBase = layer.rotation
        rotationRaw = layer.rotation
    }

    func rotate(by radians: Double) {
        guard let id = activeId, let index = layers.firstIndex(where: { $0.id == id }) else { return }
        moved = true
        rotationRaw = rotationBase + radians
        let snapped = StorySnap.rotation(rotationRaw)
        layers[index].rotation = snapped.angle
        if snapped.snapped && !lastSnappedAngle { onSnap?() }
        lastSnappedAngle = snapped.snapped
        guides.rotation = snapped.snapped
    }

    /// All fingers are up. Over the trash it deletes; otherwise a move is one
    /// undoable action.
    func endGesture() {
        defer {
            activeId = nil
            gestureBefore = nil
            isDragging = false
            overTrash = false
            guides = Guides()
        }
        guard let id = activeId, let before = gestureBefore else { return }
        if overTrash {
            layers.removeAll { $0.id == id }
            if selectedId == id { selectedId = nil }
            record(before)
            pruneFiles()
            onDelete?()
            return
        }
        if moved, snapshot().layers != before.layers { record(before) }
    }
}
