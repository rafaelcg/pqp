import SwiftUI
import UIKit

// How a layer is DRAWN, shared by the editor and the viewer: the same code on
// both sides is what makes what you placed be what they see.

// MARK: - Fonts

extension StoryFont {
    /// The same font for measuring and for drawing, so a text layer's box is
    /// exactly as wide as its text.
    func uiFont(size: CGFloat) -> UIFont {
        switch self {
        // The closest system faces to the web's: classic is a bold sans (700),
        // bold a heavy one (900), typewriter a monospace (600), serif an italic
        // serif (700), neon a heavy sans (800) with a glow.
        case .classic:
            return .systemFont(ofSize: size, weight: .bold)
        case .bold:
            return .systemFont(ofSize: size, weight: .black)
        case .typewriter:
            return .monospacedSystemFont(ofSize: size, weight: .semibold)
        case .serif:
            let base = UIFont.systemFont(ofSize: size, weight: .bold)
            let serif = base.fontDescriptor.withDesign(.serif) ?? base.fontDescriptor
            let italic = serif.withSymbolicTraits(.traitItalic) ?? serif
            return UIFont(descriptor: italic, size: size)
        case .neon:
            return .systemFont(ofSize: size, weight: .heavy)
        }
    }

    var label: String {
        switch self {
        case .classic: String(localized: "Classic")
        case .bold: String(localized: "Bold")
        case .typewriter: String(localized: "Typewriter")
        case .serif: String(localized: "Serif")
        case .neon: String(localized: "Neon")
        }
    }
}

// MARK: - Text

struct StoryTextLabel: View {
    let data: StoryTextData
    let canvasWidth: CGFloat

    private var fontSize: CGFloat { StoryCanvas.fontSize(for: data, canvasWidth: canvasWidth) }
    private var padding: CGSize {
        data.background == .none ? .zero : CGSize(width: fontSize * 0.55, height: fontSize * 0.28)
    }

    /// The width the text wants, capped at the wrap width.
    private var textWidth: CGFloat {
        let limit = max(40, canvasWidth * StoryCanvas.textMaxWidthFraction - padding.width * 2)
        let font = data.font.uiFont(size: fontSize)
        let rect = (data.text as NSString).boundingRect(
            with: CGSize(width: limit, height: .greatestFiniteMagnitude),
            options: [.usesLineFragmentOrigin, .usesFontLeading],
            attributes: [.font: font], context: nil
        )
        return min(limit, ceil(rect.width) + 3)
    }

    private var foreground: Color {
        data.background == .solid ? (data.color.isLight ? .black : .white) : data.color.color
    }

    var body: some View {
        let glow = data.font == .neon
        Text(verbatim: data.text)
            .font(Font(data.font.uiFont(size: fontSize)))
            .lineSpacing(StoryCanvas.textLineHeight * fontSize - data.font.uiFont(size: fontSize).lineHeight)
            // Neon is the text color glowing around a lighter core.
            .foregroundStyle(glow ? Color.white.opacity(0.92) : foreground)
            .multilineTextAlignment(data.align.textAlignment)
            .frame(width: textWidth, alignment: data.align.frameAlignment)
            .fixedSize(horizontal: false, vertical: true)
            .shadow(color: glow ? data.color.color : .clear, radius: glow ? fontSize * 0.28 : 0)
            .shadow(color: glow ? data.color.color.opacity(0.8) : .clear, radius: glow ? fontSize * 0.12 : 0)
            .padding(.horizontal, padding.width)
            .padding(.vertical, padding.height)
            .background(background)
            .shadow(color: .black.opacity(data.background == .none && !glow ? 0.35 : 0), radius: 3, y: 1)
    }

    @ViewBuilder
    private var background: some View {
        let radius = fontSize * 0.42
        switch data.background {
        case .none:
            Color.clear
        case .solid:
            RoundedRectangle(cornerRadius: radius, style: .continuous).fill(data.color.color)
        case .soft:
            RoundedRectangle(cornerRadius: radius, style: .continuous).fill(data.color.color.opacity(0.34))
        }
    }
}

// MARK: - A picture

struct StoryPictureLabel: View {
    let picture: StoryLayerPicture
    let local: UIImage?
    let canvasWidth: CGFloat

    var body: some View {
        let natural = StoryCanvas.pictureSize(picture, canvasWidth: canvasWidth)
        let side = min(natural.width, natural.height)
        let size = picture.shape == .circle ? CGSize(width: side, height: side) : natural
        content
            .frame(width: size.width, height: size.height)
            .clipShape(clip(size))
            .overlay(clip(size).strokeBorder(.white.opacity(0.9), lineWidth: max(2, canvasWidth * 0.008)))
            .shadow(color: .black.opacity(0.3), radius: 6, y: 2)
    }

    private func clip(_ size: CGSize) -> some InsettableShape {
        switch picture.shape {
        case .rect: AnyInsettableShape(Rectangle())
        case .rounded: AnyInsettableShape(RoundedRectangle(cornerRadius: canvasWidth * 0.035, style: .continuous))
        case .circle: AnyInsettableShape(Circle())
        }
    }

    @ViewBuilder
    private var content: some View {
        if let local {
            Image(uiImage: local).resizable().scaledToFill()
        } else if let url = picture.url.flatMap(URL.init(string:)) {
            StoryCachedImage(url: url, contentMode: .fill) { _ in Color.white.opacity(0.12) }
        } else {
            Color.white.opacity(0.12)
        }
    }
}

struct AnyInsettableShape: InsettableShape {
    private let build: @Sendable (CGRect) -> Path
    private let inset: @Sendable (CGFloat) -> AnyInsettableShape

    init<S: InsettableShape>(_ shape: S) {
        build = { shape.path(in: $0) }
        inset = { AnyInsettableShape(shape.inset(by: $0)) }
    }

    func path(in rect: CGRect) -> Path { build(rect) }
    func inset(by amount: CGFloat) -> AnyInsettableShape { inset(amount) }
}

// MARK: - A mention

struct StoryMentionPill: View {
    let name: String
    let canvasWidth: CGFloat

    var body: some View {
        let size = canvasWidth * StoryCanvas.mentionFontFraction
        HStack(spacing: size * 0.2) {
            Text(verbatim: "@")
                .foregroundStyle(Palette.signalDim)
            Text(verbatim: name)
                .foregroundStyle(.black)
        }
        .font(.system(size: size, weight: .heavy, design: .rounded))
        .lineLimit(1)
        .padding(.horizontal, size * 0.7)
        .padding(.vertical, size * 0.4)
        .background(Capsule().fill(.white.opacity(0.95)))
        .shadow(color: .black.opacity(0.25), radius: 5, y: 2)
    }
}

// MARK: - A layer, placed

struct StoryLayerSizesKey: PreferenceKey {
    static let defaultValue: [String: CGSize] = [:]
    static func reduce(value: inout [String: CGSize], nextValue: () -> [String: CGSize]) {
        value.merge(nextValue()) { _, new in new }
    }
}

/// The ingredients a layer may need that are not in the layer itself.
struct StoryLayerContext {
    var canvas: CGSize
    /// Draft bitmaps by layer id (the editor); empty in the viewer.
    var previews: [String: UIImage] = [:]
    /// The call card's data, by layer id.
    var call: (StoryLayer) -> StoryCallStickerData? = { _ in nil }
    var onJoin: ((StoryLayer) -> Void)?
    var onMention: ((String) -> Void)?
    var reduceMotion = false
}

/// One layer at its place: centered at (x, y) of the canvas, scaled and turned
/// about its own center. Reports its natural size (before scale and turn) so
/// the gesture surface can find it under a finger.
struct StoryPlacedLayer: View {
    let layer: StoryLayer
    let context: StoryLayerContext
    var selected = false
    /// The viewer lets calls and mentions take taps; the editor leaves every
    /// touch to the gesture surface.
    var interactive = false
    /// False in the viewer for what the story's alt text already says (text,
    /// photos): a screen reader hears the story once, not twice.
    var spoken = true

    /// Text, a mention and the call card are laid out at their final size (the
    /// canvas width times the layer's scale: every length in them is a share
    /// of it), not drawn small and scaled up, which is what made a pinched
    /// layer soft. Pictures are bitmaps either way and keep the transform.
    private var laysOutAtScale: Bool {
        switch layer.content {
        case .text, .mention, .call: true
        case .image, .drawing: false
        }
    }

    var body: some View {
        let scale = laysOutAtScale ? CGFloat(layer.scale) : 1
        let width = context.canvas.width * scale
        Group {
            switch layer.content {
            case .text(let data):
                StoryTextLabel(data: data, canvasWidth: width)
            case .image(let picture):
                StoryPictureLabel(picture: picture, local: context.previews[layer.id], canvasWidth: width)
            case .drawing(let picture):
                drawing(picture)
            case .call:
                if let data = context.call(layer) {
                    StoryCallStickerCard(
                        data: data, canvasWidth: width, reduceMotion: context.reduceMotion,
                        onJoin: interactive ? { context.onJoin?(layer) } : nil
                    )
                }
            case .mention(let userId, let user):
                mention(userId: userId, user: user, width: width)
            }
        }
        .background(
            GeometryReader { proxy in
                // Natural size: before the layer's scale, whichever way it is applied.
                Color.clear.preference(
                    key: StoryLayerSizesKey.self,
                    value: [layer.id: CGSize(width: proxy.size.width / scale, height: proxy.size.height / scale)]
                )
            }
        )
        .overlay {
            if selected && !layer.isDrawing {
                RoundedRectangle(cornerRadius: 8, style: .continuous)
                    .strokeBorder(.white.opacity(0.85), style: StrokeStyle(lineWidth: 1.5, dash: [5, 4]))
                    .padding(-6)
                    .allowsHitTesting(false)
            }
        }
        .scaleEffect(laysOutAtScale ? 1 : layer.scale)
        .rotationEffect(.radians(layer.rotation))
        .position(x: CGFloat(layer.x) * context.canvas.width, y: CGFloat(layer.y) * context.canvas.height)
        .accessibilityElement(children: layer.isDrawing ? .ignore : .contain)
        .accessibilityLabel(layer.isDrawing ? "" : layer.spokenLabel)
        .accessibilityHidden(layer.isDrawing || !spoken)
    }

    @ViewBuilder
    private func drawing(_ picture: StoryLayerPicture) -> some View {
        // Covers the canvas exactly, whatever the layer's own numbers say.
        Group {
            if let image = context.previews[layer.id] {
                Image(uiImage: image).resizable().scaledToFill()
            } else if let url = picture.url.flatMap(URL.init(string:)) {
                StoryCachedImage(url: url, contentMode: .fill) { _ in Color.clear }
            } else {
                Color.clear
            }
        }
        .frame(width: context.canvas.width, height: context.canvas.height)
        .clipped()
        .allowsHitTesting(false)
    }

    @ViewBuilder
    private func mention(userId: String, user: StoryAuthor?, width: CGFloat) -> some View {
        let name = user.map { $0.handle ?? $0.firstName } ?? String(localized: "someone")
        if interactive, let onMention = context.onMention {
            Button { onMention(userId) } label: { StoryMentionPill(name: name, canvasWidth: width) }
                .buttonStyle(.plain)
                .accessibilityLabel(Text("Open the profile of \(name)"))
        } else {
            StoryMentionPill(name: name, canvasWidth: width)
        }
    }
}

// MARK: - The call sticker

/// What the sticker shows. The editor's card is in the SAME states as the
/// viewer's, with the same words (`isPreview` only makes its door inert).
struct StoryCallStickerData: Equatable, Sendable {
    enum State: Equatable, Sendable { case live, ended, full }

    var roomName: String
    var serverName: String
    var serverId: String
    var serverIconUrl: String?
    var participants: [StoryAuthor]
    var count: Int
    var state: State
    var joinable: Bool
    /// The editor's card: the same picture and words, its Entrar drawn but not
    /// tappable.
    var isPreview = false
}

/// The "chama pra call" card: ONE compact row, the same card web and Android
/// draw. The server's tile, a kicker (the state, with a live dot and the count)
/// over the room and the server, up to three live faces, and the door. Empty,
/// full and ended each say so in words. Every length is a share of the canvas
/// width (`cq` is 1 cqw), so it is the same picture at any size and hides
/// about a tenth of the story.
struct StoryCallStickerCard: View {
    let data: StoryCallStickerData
    let canvasWidth: CGFloat
    var reduceMotion = false
    var onJoin: (() -> Void)?

    private var width: CGFloat { canvasWidth * StoryCanvas.stickerWidthFraction }
    /// One container-query-width unit: 1% of the canvas width.
    private var cq: CGFloat { canvasWidth / 100 }
    private var isLive: Bool { data.state == .live && data.count > 0 }
    private var isEnded: Bool { data.state == .ended }
    private var extra: Int { max(0, data.count - min(3, data.participants.count)) }

    var body: some View {
        HStack(spacing: 0) {
            serverTile
            VStack(alignment: .leading, spacing: 0) {
                kicker
                Text(verbatim: data.roomName)
                    .font(.system(size: 5 * cq, weight: .heavy, design: .rounded))
                    .foregroundStyle(.white)
                    .lineLimit(1)
                if !data.serverName.isEmpty {
                    Text(verbatim: data.serverName)
                        .font(.system(size: 2.9 * cq, weight: .medium))
                        .foregroundStyle(.white.opacity(0.7))
                        .lineLimit(1)
                }
            }
            .padding(.horizontal, 2.8 * cq)
            .frame(maxWidth: .infinity, alignment: .leading)
            faces
            door
        }
        .padding(3 * cq)
        .frame(width: width)
        .background(
            RoundedRectangle(cornerRadius: 5 * cq, style: .continuous)
                .fill(.ultraThinMaterial)
                .overlay(
                    RoundedRectangle(cornerRadius: 5 * cq, style: .continuous)
                        .fill(Palette.inkDeep.opacity(isEnded ? 0.5 : 0.66))
                )
        )
        .overlay(
            RoundedRectangle(cornerRadius: 5 * cq, style: .continuous)
                .strokeBorder(isEnded ? Color.white.opacity(0.25) : Palette.signal.opacity(0.75), lineWidth: max(1, 0.4 * cq))
        )
        .shadow(color: .black.opacity(0.35), radius: 3.5 * cq, y: 1 * cq)
        .opacity(isEnded ? 0.72 : 1)
        .accessibilityElement(children: .combine)
        .accessibilityLabel(Text(verbatim: spokenDescription))
        .accessibilityAddTraits(onJoin != nil && data.joinable ? .isButton : [])
        .accessibilityIdentifier("story.call.sticker")
    }

    /// The server's picture on a rounded square, its first letter without one.
    private var serverTile: some View {
        ZStack {
            RoundedRectangle(cornerRadius: 2.8 * cq, style: .continuous).fill(.white.opacity(0.14))
            Text(verbatim: String((data.serverName.isEmpty ? data.roomName : data.serverName).prefix(1)).uppercased())
                .font(.system(size: 5 * cq, weight: .heavy, design: .rounded))
                .foregroundStyle(.white)
            if let url = Avatar.resolve(data.serverIconUrl) {
                StoryCachedImage(url: url, contentMode: .fill) { _ in Color.clear }
            }
        }
        .frame(width: 11 * cq, height: 11 * cq)
        .clipShape(RoundedRectangle(cornerRadius: 2.8 * cq, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 2.8 * cq, style: .continuous).strokeBorder(.white.opacity(0.14), lineWidth: 1))
        .accessibilityHidden(true)
    }

    private var kickerText: String {
        switch data.state {
        case .ended: return String(localized: "The call ended")
        case .full: return String(localized: "The room is full")
        case .live:
            if data.count == 0 { return String(localized: "Nobody in the call right now") }
            return String(localized: "Live") + " · \(data.count)"
        }
    }

    private var kicker: some View {
        HStack(spacing: 1.2 * cq) {
            if isLive {
                LiveDot(size: 1.8 * cq, reduceMotion: reduceMotion)
            } else {
                Circle().fill(Color.white.opacity(0.6)).frame(width: 1.8 * cq, height: 1.8 * cq)
            }
            Text(verbatim: kickerText)
                .font(.system(size: 2.7 * cq, weight: .bold))
                .textCase(.uppercase)
                .tracking(0.04 * 2.7 * cq)
                .lineLimit(1)
                .minimumScaleFactor(0.75)
        }
        .foregroundStyle(isLive ? Palette.signal : Color.white.opacity(0.7))
    }

    /// Up to three live faces and a "+n", overlapping.
    @ViewBuilder
    private var faces: some View {
        if !isEnded, !data.participants.isEmpty {
            HStack(spacing: -1.4 * cq) {
                ForEach(Array(data.participants.prefix(3).enumerated()), id: \.element.id) { index, person in
                    StoryAvatar(name: person.displayName, seed: person.id, size: 7 * cq, url: person.avatarUrl)
                        .overlay(Circle().strokeBorder(Palette.inkDeep, lineWidth: max(1, 0.4 * cq)))
                        .zIndex(Double(3 - index))
                }
                if extra > 0 {
                    Text(verbatim: "+\(extra)")
                        .font(.system(size: 2.8 * cq, weight: .heavy, design: .rounded))
                        .foregroundStyle(.white)
                        .frame(width: 7 * cq, height: 7 * cq)
                        .background(Circle().fill(Color.white.opacity(0.22)))
                        .overlay(Circle().strokeBorder(Palette.inkDeep, lineWidth: max(1, 0.4 * cq)))
                }
            }
            .padding(.trailing, 2.8 * cq)
            .accessibilityHidden(true)
        }
    }

    /// The lime "Entrar": the real door in the viewer, the same look inert in
    /// the editor's preview, nothing when the room is full or over.
    @ViewBuilder
    private var door: some View {
        if let onJoin, data.joinable, !isEnded, data.state != .full {
            Button(action: onJoin) { joinLabel }
                .buttonStyle(.plain)
                .accessibilityIdentifier("story.call.join")
        } else if data.isPreview, data.joinable, !isEnded, data.state != .full {
            joinLabel
        }
    }

    private var joinLabel: some View {
        Text("Join")
            .font(.system(size: 3.6 * cq, weight: .heavy, design: .rounded))
            .foregroundStyle(Palette.inkDeep)
            .lineLimit(1)
            .fixedSize()
            .padding(.horizontal, 3 * cq)
            .padding(.vertical, 1.7 * cq)
            .background(Capsule().fill(Palette.signal))
    }

    var spokenDescription: String {
        let room = String(localized: "Call in \(data.roomName), \(data.serverName)")
        switch data.state {
        case .ended: return room + ". " + String(localized: "The call ended")
        case .full: return room + ". " + String(localized: "The room is full")
        case .live:
            if data.count == 0 { return room + ". " + String(localized: "Nobody in the call right now") }
            let names = data.participants.prefix(3).map(\.displayName).joined(separator: ", ")
            return room + ". " + String(localized: "\(data.count) in the call") + ". " + names
        }
    }
}

/// The live dot: a soft pulse while people are in, still under Reduce Motion.
struct LiveDot: View {
    let size: CGFloat
    var reduceMotion = false
    @State private var pulse = false

    var body: some View {
        ZStack {
            Circle().fill(Palette.signal.opacity(0.35))
                .frame(width: size * 2, height: size * 2)
                .scaleEffect(pulse ? 1 : 0.5)
                .opacity(pulse ? 0 : 0.8)
            Circle().fill(Palette.signal).frame(width: size, height: size)
        }
        .frame(width: size * 1.4, height: size * 1.4)
        .onAppear {
            guard !reduceMotion else { return }
            withAnimation(.easeOut(duration: 1.4).repeatForever(autoreverses: false)) { pulse = true }
        }
        .accessibilityHidden(true)
    }
}
