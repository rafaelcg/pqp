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
            AsyncImage(url: url) { image in
                image.resizable().scaledToFill()
            } placeholder: {
                Color.white.opacity(0.12)
            }
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

    var body: some View {
        let width = context.canvas.width
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
                Color.clear.preference(key: StoryLayerSizesKey.self, value: [layer.id: proxy.size])
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
        .scaleEffect(layer.scale)
        .rotationEffect(.radians(layer.rotation))
        .position(x: CGFloat(layer.x) * context.canvas.width, y: CGFloat(layer.y) * context.canvas.height)
        .accessibilityElement(children: layer.isDrawing ? .ignore : .contain)
        .accessibilityLabel(layer.isDrawing ? "" : layer.spokenLabel)
        .accessibilityHidden(layer.isDrawing)
    }

    @ViewBuilder
    private func drawing(_ picture: StoryLayerPicture) -> some View {
        // Covers the canvas exactly, whatever the layer's own numbers say.
        Group {
            if let image = context.previews[layer.id] {
                Image(uiImage: image).resizable().scaledToFill()
            } else if let url = picture.url.flatMap(URL.init(string:)) {
                AsyncImage(url: url) { $0.resizable().scaledToFill() } placeholder: { Color.clear }
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

/// What the sticker shows. `preview` is the editor's, before anything is live.
struct StoryCallStickerData: Equatable, Sendable {
    enum State: Equatable, Sendable { case preview, live, ended, full }

    var roomName: String
    var serverName: String
    var serverId: String
    var serverIconUrl: String?
    var participants: [StoryAuthor]
    var count: Int
    var state: State
    var joinable: Bool
}

/// The "chama pra call" card: the room and the server it is in, who is there
/// right now (up to three faces and a "+n"), a live dot while there are
/// people, and the door. Empty, full and ended each say so in words.
struct StoryCallStickerCard: View {
    let data: StoryCallStickerData
    let canvasWidth: CGFloat
    var reduceMotion = false
    var onJoin: (() -> Void)?

    private var width: CGFloat { canvasWidth * StoryCanvas.stickerWidthFraction }
    private var unit: CGFloat { width / 300 }
    private var isLive: Bool { data.state == .live && data.count > 0 }
    private var isEnded: Bool { data.state == .ended }

    var body: some View {
        VStack(alignment: .leading, spacing: 12 * unit) {
            header
            people
            footer
        }
        .padding(16 * unit)
        .frame(width: width, alignment: .leading)
        .background(
            ZStack {
                RoundedRectangle(cornerRadius: 24 * unit, style: .continuous).fill(.ultraThinMaterial)
                RoundedRectangle(cornerRadius: 24 * unit, style: .continuous)
                    .fill(Palette.inkDeep.opacity(isEnded ? 0.82 : 0.6))
            }
        )
        .overlay(
            RoundedRectangle(cornerRadius: 24 * unit, style: .continuous)
                .strokeBorder(isLive ? Palette.signal.opacity(0.75) : Color.white.opacity(0.14), lineWidth: isLive ? 1.5 : 1)
        )
        .shadow(color: .black.opacity(0.35), radius: 14 * unit, y: 4)
        .saturation(isEnded ? 0.4 : 1)
        .accessibilityElement(children: .combine)
        .accessibilityLabel(Text(verbatim: spoken))
        .accessibilityAddTraits(onJoin != nil && data.joinable ? .isButton : [])
        .accessibilityIdentifier("story.call.sticker")
    }

    private var header: some View {
        HStack(spacing: 10 * unit) {
            Avatar(name: data.serverName, seed: data.serverId, size: 34 * unit, url: data.serverIconUrl)
            VStack(alignment: .leading, spacing: 1 * unit) {
                HStack(spacing: 5 * unit) {
                    Image(systemName: "speaker.wave.2.fill")
                        .font(.system(size: 12 * unit, weight: .bold))
                    Text(verbatim: data.roomName)
                        .font(.system(size: 17 * unit, weight: .heavy, design: .rounded))
                        .lineLimit(1)
                }
                .foregroundStyle(.white)
                Text(verbatim: data.serverName)
                    .font(.system(size: 12 * unit, weight: .medium))
                    .foregroundStyle(.white.opacity(0.7))
                    .lineLimit(1)
            }
            Spacer(minLength: 4 * unit)
            if isLive { liveBadge }
        }
    }

    private var liveBadge: some View {
        HStack(spacing: 5 * unit) {
            LiveDot(size: 8 * unit, reduceMotion: reduceMotion)
            Text("Live")
                .font(.system(size: 11 * unit, weight: .heavy))
                .textCase(.uppercase)
                .foregroundStyle(Palette.signal)
        }
        .padding(.horizontal, 8 * unit)
        .padding(.vertical, 4 * unit)
        .background(Capsule().fill(Palette.signal.opacity(0.16)))
    }

    @ViewBuilder
    private var people: some View {
        if data.state == .preview {
            Text("People who are in the room show up here live.")
                .font(.system(size: 13 * unit, weight: .medium))
                .foregroundStyle(.white.opacity(0.75))
                .fixedSize(horizontal: false, vertical: true)
        } else if isEnded {
            Text("The call ended")
                .font(.system(size: 14 * unit, weight: .semibold))
                .foregroundStyle(.white.opacity(0.7))
        } else if data.count == 0 {
            Text("Nobody in the call right now")
                .font(.system(size: 14 * unit, weight: .semibold))
                .foregroundStyle(.white.opacity(0.8))
        } else {
            HStack(spacing: 10 * unit) {
                HStack(spacing: -10 * unit) {
                    ForEach(Array(data.participants.prefix(3).enumerated()), id: \.element.id) { index, person in
                        Avatar(name: person.displayName, seed: person.id, size: 34 * unit, url: person.avatarUrl)
                            .overlay(Circle().strokeBorder(Palette.inkDeep, lineWidth: 2.5 * unit))
                            .zIndex(Double(3 - index))
                    }
                    let extra = data.count - min(3, data.participants.count)
                    if extra > 0 {
                        Text(verbatim: "+\(extra)")
                            .font(.system(size: 12 * unit, weight: .heavy))
                            .foregroundStyle(.white)
                            .frame(width: 34 * unit, height: 34 * unit)
                            .background(Circle().fill(Palette.surfaceRaised))
                            .overlay(Circle().strokeBorder(Palette.inkDeep, lineWidth: 2.5 * unit))
                    }
                }
                Text(verbatim: String(localized: "\(data.count) in the call"))
                    .font(.system(size: 14 * unit, weight: .semibold))
                    .foregroundStyle(.white)
                    .lineLimit(1)
            }
        }
    }

    @ViewBuilder
    private var footer: some View {
        if data.state == .full {
            Text("The room is full")
                .font(.system(size: 13 * unit, weight: .semibold))
                .foregroundStyle(Palette.warning)
        } else if let onJoin, data.joinable, !isEnded {
            Button(action: onJoin) {
                HStack(spacing: 6 * unit) {
                    Image(systemName: "headphones")
                    Text("Join")
                }
                .font(.system(size: 15 * unit, weight: .heavy))
                .foregroundStyle(Palette.inkDeep)
                .frame(maxWidth: .infinity)
                .padding(.vertical, 10 * unit)
                .background(Capsule().fill(Palette.signal))
            }
            .buttonStyle(.plain)
            .accessibilityIdentifier("story.call.join")
        } else if data.state == .preview {
            HStack(spacing: 6 * unit) {
                Image(systemName: "headphones")
                Text("Join")
            }
            .font(.system(size: 15 * unit, weight: .heavy))
            .foregroundStyle(Palette.inkDeep)
            .frame(maxWidth: .infinity)
            .padding(.vertical, 10 * unit)
            .background(Capsule().fill(Palette.signal))
        }
    }

    private var spoken: String {
        let room = String(localized: "Call in \(data.roomName), \(data.serverName)")
        switch data.state {
        case .preview: return room
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
