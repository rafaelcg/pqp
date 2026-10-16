import Foundation
import SwiftUI
import UIKit

// LAYERS: what an author places on the 9:16 canvas (text, photos, a drawing, a
// call, mentions), as data and not as pixels burned into the picture. Wire
// shapes from `packages/shared/src/stories.ts`. The same value is what the
// editor mutates and what the viewer draws, so there is one geometry rule for
// both: `StoryCanvas`.

enum StoryLayerLimits {
    static let max = 20
    static let images = 6
    static let drawings = 1
    static let calls = 1
    static let mentions = 5
    static let scaleMin = 0.2
    static let scaleMax = 5.0
    static let textSizeMin = 0.5
    static let textSizeMax = 3.0
    static let maxBytes = 8 * 1024 * 1024
    static let altTextMax = 500
    /// What the author wrote to describe one photo (`STORY_LAYER_ALT_MAX`).
    static let altMax = 200
    /// A hair above pi, as the contract has it, so a 32-bit float pi passes.
    static let rotationMax = 3.1416
}

extension Color {
    init(hex: UInt32) {
        self.init(red: Double((hex >> 16) & 0xFF) / 255, green: Double((hex >> 8) & 0xFF) / 255, blue: Double(hex & 0xFF) / 255)
    }
}

enum StoryFont: String, CaseIterable, Codable, Sendable {
    case classic, bold, typewriter, serif, neon
}

enum StoryTextColor: String, CaseIterable, Codable, Sendable {
    case white, black, lime, yellow, orange, red, pink, purple, blue, cyan, green, gray

    var color: Color { Color(hex: hex) }

    /// The one palette every platform draws, as `STORY_TEXT_COLOR_HEX` in
    /// `packages/shared/src/stories.ts`.
    var hex: UInt32 {
        switch self {
        case .white: 0xFFFFFF
        case .black: 0x000000
        case .lime: 0xBBEC4C
        case .yellow: 0xFFD60A
        case .orange: 0xFF9500
        case .red: 0xFF3B30
        case .pink: 0xFF5FA2
        case .purple: 0xAF52DE
        case .blue: 0x0A84FF
        case .cyan: 0x64D2FF
        case .green: 0x30D158
        case .gray: 0x8E8E93
        }
    }

    /// Whether the color is bright enough that text on top of it must be dark:
    /// a solid background in a light color takes black text, a dark one white.
    var isLight: Bool {
        switch self {
        case .white, .lime, .yellow, .orange, .pink, .cyan, .green: true
        case .black, .red, .purple, .blue, .gray: false
        }
    }

    var label: String {
        switch self {
        case .white: String(localized: "White")
        case .black: String(localized: "Black")
        case .lime: String(localized: "Lime")
        case .yellow: String(localized: "Yellow")
        case .orange: String(localized: "Orange")
        case .red: String(localized: "Red")
        case .pink: String(localized: "Pink")
        case .purple: String(localized: "Purple")
        case .blue: String(localized: "Blue")
        case .cyan: String(localized: "Cyan")
        case .green: String(localized: "Green")
        case .gray: String(localized: "Gray")
        }
    }
}

enum StoryTextBackground: String, CaseIterable, Codable, Sendable {
    case none, solid, soft

    var next: StoryTextBackground {
        switch self {
        case .none: .solid
        case .solid: .soft
        case .soft: .none
        }
    }
}

enum StoryTextAlign: String, CaseIterable, Codable, Sendable {
    case left, center, right

    var next: StoryTextAlign {
        switch self {
        case .left: .center
        case .center: .right
        case .right: .left
        }
    }

    var symbol: String {
        switch self {
        case .left: "text.alignleft"
        case .center: "text.aligncenter"
        case .right: "text.alignright"
        }
    }

    var textAlignment: TextAlignment {
        switch self {
        case .left: .leading
        case .center: .center
        case .right: .trailing
        }
    }

    var frameAlignment: Alignment {
        switch self {
        case .left: .leading
        case .center: .center
        case .right: .trailing
        }
    }
}

enum StoryImageShape: String, CaseIterable, Codable, Sendable {
    case rect, rounded, circle

    var next: StoryImageShape {
        switch self {
        case .rect: .rounded
        case .rounded: .circle
        case .circle: .rect
        }
    }
}

struct StoryTextData: Hashable, Sendable {
    var text: String
    var font: StoryFont = .classic
    var color: StoryTextColor = .white
    var background: StoryTextBackground = .none
    var align: StoryTextAlign = .center
    var size: Double = 1
}

/// A picture on the canvas: a placed photo or the drawing. `url` is set on a
/// story that was read; a draft keeps its bytes in the editor's file table.
struct StoryLayerPicture: Hashable, Sendable {
    var url: String?
    var width: Int
    var height: Int
    var shape: StoryImageShape = .rect
    /// What the author wrote to describe a placed photo, for screen readers
    /// (`alt` on an image layer). Nil: none was written.
    var alt: String? = nil

    var aspect: Double { height > 0 ? Double(width) / Double(height) : 1 }
}

struct StoryLayer: Identifiable, Hashable, Sendable {
    enum Content: Hashable, Sendable {
        case text(StoryTextData)
        case image(StoryLayerPicture)
        case drawing(StoryLayerPicture)
        case call(serverId: String, channelId: String)
        case mention(userId: String, user: StoryAuthor?)
    }

    var id: String
    /// Center, 0..1 of the canvas.
    var x: Double
    var y: Double
    var scale: Double
    /// Radians, clockwise.
    var rotation: Double
    var content: Content

    init(id: String = UUID().uuidString.lowercased(), x: Double = 0.5, y: Double = 0.5,
         scale: Double = 1, rotation: Double = 0, content: Content) {
        self.id = id
        self.x = x
        self.y = y
        self.scale = scale
        self.rotation = rotation
        self.content = content
    }

    var isDrawing: Bool {
        if case .drawing = content { return true }
        return false
    }

    var isText: Bool {
        if case .text = content { return true }
        return false
    }

    var typeName: String {
        switch content {
        case .text: "text"
        case .image: "image"
        case .drawing: "drawing"
        case .call: "call"
        case .mention: "mention"
        }
    }

    /// What a screen reader says for this layer.
    var spokenLabel: String {
        switch content {
        case .text(let data): data.text
        case .image(let picture):
            if let alt = StoryAltText.clean(picture.alt) { String(localized: "Photo: \(alt)") } else { String(localized: "Photo") }
        case .drawing: String(localized: "Drawing")
        case .call: String(localized: "Call sticker")
        case .mention(_, let user):
            user.map { "@" + ($0.handle ?? $0.displayName) } ?? String(localized: "Mention")
        }
    }
}

// MARK: - Decoding (a story that was read)

extension StoryLayer: Decodable {
    private enum CodingKeys: String, CodingKey {
        case id, type, x, y, scale, rotation
        case text, font, color, background, align, size
        case shape, url, width, height, alt
        case serverId, channelId, userId, user
    }

    /// Lenient per field and strict per type: a layer whose `type` this build
    /// does not know, or whose geometry does not decode, throws, and
    /// `StoryLayerList` skips it. An unknown enum VALUE on a known type
    /// (a later font) falls back to the default instead, so the layer
    /// survives.
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        let id = try c.decode(String.self, forKey: .id)
        let x = try c.decode(Double.self, forKey: .x)
        let y = try c.decode(Double.self, forKey: .y)
        let scale = try c.decode(Double.self, forKey: .scale)
        let rotation = try c.decode(Double.self, forKey: .rotation)
        let content: Content
        switch try c.decode(String.self, forKey: .type) {
        case "text":
            content = .text(StoryTextData(
                text: try c.decode(String.self, forKey: .text),
                font: (try? c.decode(StoryFont.self, forKey: .font)) ?? .classic,
                color: (try? c.decode(StoryTextColor.self, forKey: .color)) ?? .white,
                background: (try? c.decode(StoryTextBackground.self, forKey: .background)) ?? .none,
                align: (try? c.decode(StoryTextAlign.self, forKey: .align)) ?? .center,
                size: (try? c.decode(Double.self, forKey: .size)) ?? 1
            ))
        case "image":
            content = .image(StoryLayerPicture(
                url: try c.decode(String.self, forKey: .url),
                width: try c.decode(Int.self, forKey: .width),
                height: try c.decode(Int.self, forKey: .height),
                shape: (try? c.decode(StoryImageShape.self, forKey: .shape)) ?? .rect,
                // `null` when none was written, and absent for a story from before.
                alt: StoryAltText.clean((try? c.decodeIfPresent(String.self, forKey: .alt)) ?? nil)
            ))
        case "drawing":
            content = .drawing(StoryLayerPicture(
                url: try c.decode(String.self, forKey: .url),
                width: try c.decode(Int.self, forKey: .width),
                height: try c.decode(Int.self, forKey: .height)
            ))
        case "call":
            content = .call(serverId: try c.decode(String.self, forKey: .serverId),
                            channelId: try c.decode(String.self, forKey: .channelId))
        case "mention":
            content = .mention(userId: try c.decode(String.self, forKey: .userId),
                               user: try? c.decode(StoryAuthor.self, forKey: .user))
        default:
            throw DecodingError.dataCorruptedError(forKey: .type, in: c, debugDescription: "Unknown layer type")
        }
        self.init(id: id, x: x, y: y, scale: scale, rotation: rotation, content: content)
    }
}

/// `layers` as a client reads it: one element at a time, keeping every layer
/// that decodes and silently dropping the rest, order kept. A story is never
/// refused because one layer was not understood, and a viewer never crashes
/// on one. Missing is `[]`.
struct StoryLayerList: Decodable, Sendable {
    let layers: [StoryLayer]

    private struct Skip: Decodable {}

    init(from decoder: Decoder) throws {
        var container = try decoder.unkeyedContainer()
        var found: [StoryLayer] = []
        while !container.isAtEnd {
            // A `null` is consumed on its own: neither a layer nor a `Skip` can
            // be decoded from it, and a cursor that never moves would loop here
            // for ever.
            if (try? container.decodeNil()) == true { continue }
            if let layer = try? container.decode(StoryLayer.self) {
                found.append(layer)
            } else {
                // A failed decode does not advance the cursor: step over
                // exactly that element.
                _ = try? container.decode(Skip.self)
            }
        }
        layers = found
    }
}

// MARK: - Encoding (a story being created)

/// What goes up for a picture layer: the declaration the server mints a key
/// against. The file itself is PUT to the URL the answer carries.
struct StoryLayerUploadDeclaration: Encodable, Hashable, Sendable {
    let contentType: String
    let byteSize: Int
    let width: Int
    let height: Int
}

/// A layer as `POST /api/stories` takes it. Strict on the server: a bad value
/// fails the whole request, so what is built here is clamped first.
struct StoryLayerInput: Encodable, Sendable {
    let layer: StoryLayer
    let upload: StoryLayerUploadDeclaration?

    private enum CodingKeys: String, CodingKey {
        case id, type, x, y, scale, rotation
        case text, font, color, background, align, size
        case shape, upload, serverId, channelId, userId, alt
    }

    func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(layer.id, forKey: .id)
        try c.encode(layer.typeName, forKey: .type)
        try c.encode(StoryCanvas.clampUnit(layer.x), forKey: .x)
        try c.encode(StoryCanvas.clampUnit(layer.y), forKey: .y)
        try c.encode(StoryCanvas.clampScale(layer.scale), forKey: .scale)
        try c.encode(StoryCanvas.normalizedRotation(layer.rotation), forKey: .rotation)
        switch layer.content {
        case .text(let data):
            try c.encode(data.text.trimmingCharacters(in: .whitespacesAndNewlines), forKey: .text)
            try c.encode(data.font, forKey: .font)
            try c.encode(data.color, forKey: .color)
            try c.encode(data.background, forKey: .background)
            try c.encode(data.align, forKey: .align)
            try c.encode(min(max(data.size, StoryLayerLimits.textSizeMin), StoryLayerLimits.textSizeMax), forKey: .size)
        case .image(let picture):
            try c.encode(picture.shape, forKey: .shape)
            // Optional on write: absent when none was written (the schema takes
            // a non-empty string or nothing).
            try c.encodeIfPresent(StoryAltText.clean(picture.alt), forKey: .alt)
            try c.encode(upload, forKey: .upload)
        case .drawing:
            try c.encode(upload, forKey: .upload)
        case .call(let serverId, let channelId):
            try c.encode(serverId, forKey: .serverId)
            try c.encode(channelId, forKey: .channelId)
        case .mention(let userId, _):
            try c.encode(userId, forKey: .userId)
        }
    }
}

/// A layer in the READ shape, so `Story` stays `Codable` and what the cache
/// writes is what `init(from:)` reads back (`url`, `width`, `height`, the
/// mention's person). Creating a story uses `StoryLayerInput` instead.
extension StoryLayer: Encodable {
    private enum ReadKeys: String, CodingKey {
        case id, type, x, y, scale, rotation
        case text, font, color, background, align, size
        case shape, url, width, height, alt, serverId, channelId, userId, user
    }

    func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: ReadKeys.self)
        try c.encode(id, forKey: .id)
        try c.encode(typeName, forKey: .type)
        try c.encode(x, forKey: .x)
        try c.encode(y, forKey: .y)
        try c.encode(scale, forKey: .scale)
        try c.encode(rotation, forKey: .rotation)
        switch content {
        case .text(let data):
            try c.encode(data.text, forKey: .text)
            try c.encode(data.font, forKey: .font)
            try c.encode(data.color, forKey: .color)
            try c.encode(data.background, forKey: .background)
            try c.encode(data.align, forKey: .align)
            try c.encode(data.size, forKey: .size)
        case .image(let picture):
            try c.encode(picture.shape, forKey: .shape)
            try c.encodeIfPresent(picture.alt, forKey: .alt)
            try c.encode(picture.url ?? "", forKey: .url)
            try c.encode(picture.width, forKey: .width)
            try c.encode(picture.height, forKey: .height)
        case .drawing(let picture):
            try c.encode(picture.url ?? "", forKey: .url)
            try c.encode(picture.width, forKey: .width)
            try c.encode(picture.height, forKey: .height)
        case .call(let serverId, let channelId):
            try c.encode(serverId, forKey: .serverId)
            try c.encode(channelId, forKey: .channelId)
        case .mention(let userId, let user):
            try c.encode(userId, forKey: .userId)
            try c.encodeIfPresent(user, forKey: .user)
        }
    }
}

/// One answer entry of `layerUploads`.
struct StoryLayerUploadTarget: Codable, Hashable, Sendable {
    let layerId: String
    let url: String
    let method: String
    let headers: [String: String]
    let expiresAt: String?
}

// MARK: - Geometry

/// The one rule for where a layer is and how big it is, shared by the editor
/// and the viewer so what was placed is what is seen.
///
/// Every size is a fraction of the canvas WIDTH, so a layer is the same
/// proportion of the story on a phone, on an iPad and on the web:
/// - a text layer's font is `textFontFraction` of the width at `size` 1;
/// - a text block wraps at `textMaxWidthFraction` of the width;
/// - an image layer is `imageWidthFraction` of the width at scale 1 (the
///   contract's rule), its height from its own aspect;
/// - a call or mention sticker is `stickerWidthFraction` of the width.
enum StoryCanvas {
    static let aspect: CGFloat = 9.0 / 16.0
    static let textFontFraction: CGFloat = 0.08
    static let textMaxWidthFraction: CGFloat = 0.84
    /// Line height as a multiple of the font size.
    static let textLineHeight: CGFloat = 1.14
    static let imageWidthFraction: CGFloat = 0.4
    static let stickerWidthFraction: CGFloat = 0.82
    static let mentionFontFraction: CGFloat = 0.05
    /// A picture within this fraction of 9:16 fills the canvas; anything else
    /// is shown whole over a blurred copy of itself.
    static let fillTolerance: Double = 0.12

    static func fillsCanvas(width: Int, height: Int) -> Bool {
        guard width > 0, height > 0 else { return false }
        let target = Double(aspect)
        return abs(Double(width) / Double(height) - target) / target <= fillTolerance
    }

    static func clampUnit(_ value: Double) -> Double { min(max(value, 0), 1) }

    static func clampScale(_ value: Double) -> Double {
        min(max(value, StoryLayerLimits.scaleMin), StoryLayerLimits.scaleMax)
    }

    /// Radians into (-pi, pi].
    static func normalizedRotation(_ value: Double) -> Double {
        var angle = value.truncatingRemainder(dividingBy: 2 * .pi)
        if angle > .pi { angle -= 2 * .pi }
        if angle < -.pi { angle += 2 * .pi }
        return min(max(angle, -.pi), .pi)
    }

    static func fontSize(for text: StoryTextData, canvasWidth: CGFloat) -> CGFloat {
        canvasWidth * textFontFraction * CGFloat(min(max(text.size, StoryLayerLimits.textSizeMin), StoryLayerLimits.textSizeMax))
    }

    /// The point size of a picture layer at scale 1.
    static func pictureSize(_ picture: StoryLayerPicture, canvasWidth: CGFloat) -> CGSize {
        let width = canvasWidth * imageWidthFraction
        return CGSize(width: width, height: width / CGFloat(max(0.05, picture.aspect)))
    }

    /// Whether `point` (canvas points) is on a layer of natural `size`:
    /// the point is taken back through the layer's own rotation and scale, so
    /// a turned, enlarged layer is hit where it is drawn, not where its
    /// bounding box is. `slop` widens it for a thumb.
    static func hit(_ layer: StoryLayer, size: CGSize, at point: CGPoint, canvas: CGSize, slop: CGFloat = 12) -> Bool {
        guard !layer.isDrawing, size.width > 0, size.height > 0 else { return false }
        let center = CGPoint(x: CGFloat(layer.x) * canvas.width, y: CGFloat(layer.y) * canvas.height)
        let dx = point.x - center.x
        let dy = point.y - center.y
        let cosine = cos(-layer.rotation)
        let sine = sin(-layer.rotation)
        let localX = (dx * cosine - dy * sine) / CGFloat(layer.scale)
        let localY = (dx * sine + dy * cosine) / CGFloat(layer.scale)
        return abs(localX) <= size.width / 2 + slop / CGFloat(layer.scale)
            && abs(localY) <= size.height / 2 + slop / CGFloat(layer.scale)
    }

    /// The topmost layer under the point, or nil. Layers are back to front.
    static func topmost(_ layers: [StoryLayer], sizes: [String: CGSize], at point: CGPoint, canvas: CGSize) -> StoryLayer? {
        layers.last { layer in
            sizes[layer.id].map { hit(layer, size: $0, at: point, canvas: canvas) } ?? false
        }
    }
}

// MARK: - Snapping and the trash

/// While a layer is dragged its center sticks to the canvas center lines, and
/// its rotation to the right angles, so a centered title is easy to make and a
/// straight one is easy to keep. Both are pure so they are tested.
enum StorySnap {
    /// How near, in points, the center must come before it sticks.
    static let distance: CGFloat = 7
    /// Radians: about 4 degrees.
    static let angle = 0.07

    struct Result: Equatable {
        var x: Double
        var y: Double
        var snappedX: Bool
        var snappedY: Bool
    }

    static func position(x: Double, y: Double, canvas: CGSize) -> Result {
        var result = Result(x: x, y: y, snappedX: false, snappedY: false)
        if canvas.width > 0, abs(CGFloat(x) - 0.5) * canvas.width <= distance {
            result.x = 0.5
            result.snappedX = true
        }
        if canvas.height > 0, abs(CGFloat(y) - 0.5) * canvas.height <= distance {
            result.y = 0.5
            result.snappedY = true
        }
        return result
    }

    /// Radians, snapped to 0, +-90 and 180 degrees when within `angle`.
    static func rotation(_ value: Double) -> (angle: Double, snapped: Bool) {
        let normalized = StoryCanvas.normalizedRotation(value)
        for stop in [0.0, .pi / 2, -.pi / 2, .pi, -.pi] where abs(normalized - stop) <= angle {
            return (stop == -.pi ? .pi : stop, true)
        }
        return (normalized, false)
    }

    /// The bottom-center target a layer is dragged onto to delete it.
    static func trashFrame(canvas: CGSize) -> CGRect {
        let diameter: CGFloat = 64
        return CGRect(x: (canvas.width - diameter) / 2, y: canvas.height - diameter - 28, width: diameter, height: diameter)
    }

    /// Whether a touch is on the trash, with generous room around it.
    static func isOverTrash(_ point: CGPoint, canvas: CGSize) -> Bool {
        trashFrame(canvas: canvas).insetBy(dx: -22, dy: -22).contains(point)
    }
}

// MARK: - Alt text

enum StoryAltText {
    /// A description as it travels: whitespace collapsed, trimmed, at most
    /// `StoryLayerLimits.altMax` characters, nil when nothing is left (the
    /// schema refuses an empty string).
    static func clean(_ raw: String?) -> String? {
        guard let raw else { return nil }
        let collapsed = raw.split(whereSeparator: \.isWhitespace).joined(separator: " ")
        guard !collapsed.isEmpty else { return nil }
        return String(collapsed.prefix(StoryLayerLimits.altMax))
    }

    /// A screen reader's version of the story, in the order the web composer
    /// writes it (`altTextFor`): what the author wrote to describe the base
    /// picture FIRST (it has no field of its own, so a build that only reads
    /// `altText` speaks it), then each placed photo's description in reading
    /// order (top to bottom, then left to right), the text layers, the mentions
    /// and a call, then the caption. Capped at the limit.
    static func make(layers: [StoryLayer], callRoomName: String?, caption: String?, baseAlt: String? = nil) -> String? {
        var parts: [String] = []
        if let base = clean(baseAlt) { parts.append(base) }
        let reading: (StoryLayer, StoryLayer) -> Bool = { $0.y != $1.y ? $0.y < $1.y : $0.x < $1.x }
        for layer in layers.filter({ if case .image = $0.content { true } else { false } }).sorted(by: reading) {
            if case .image(let picture) = layer.content, let alt = clean(picture.alt) { parts.append(alt) }
        }
        let ordered = layers.sorted { $0.y < $1.y }
        for layer in ordered {
            switch layer.content {
            case .text(let data): parts.append(data.text.trimmingCharacters(in: .whitespacesAndNewlines))
            case .mention(_, let user):
                if let user { parts.append("@" + (user.handle ?? user.displayName)) }
            case .call:
                if let callRoomName { parts.append(String(localized: "Call: \(callRoomName)")) }
            case .image, .drawing: break
            }
        }
        if let caption, !caption.isEmpty { parts.append(caption) }
        let joined = parts.filter { !$0.isEmpty }.joined(separator: ". ")
        guard !joined.isEmpty else { return nil }
        return String(joined.prefix(StoryLayerLimits.altTextMax))
    }
}
