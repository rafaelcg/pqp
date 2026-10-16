import AVFoundation
import SwiftUI
import UIKit

/// The viewer's picture of a story: the base (a photo, a video, a card
/// background) and, over it, every layer the author placed, on the 9:16 canvas
/// the editor drew them on.
///
/// The author's canvas is NEVER cropped. It is the biggest 9:16 box that fits
/// the card (contain), centered, and whatever the card has left over (a tall
/// phone has a little above and below) is filled with the base itself, blurred
/// for a photo or a video and the background color for a card; the chrome sits
/// over the canvas as it always has. Everything an author placed is a fraction
/// of the canvas, so it is where they put it.
enum StoryStage {
    /// The biggest 9:16 box that fits `size`, centered.
    static func canvas(in size: CGSize) -> CGRect {
        let width = min(size.width, max(1, size.height) * StoryCanvas.aspect)
        let height = width / StoryCanvas.aspect
        return CGRect(x: (size.width - width) / 2, y: (size.height - height) / 2, width: width, height: height)
    }

    static func fillsCanvas(width: Int, height: Int) -> Bool {
        StoryCanvas.fillsCanvas(width: width, height: height)
    }

    /// A story drawn with layers versus one from before them, which keeps its
    /// old look (the line of text in the middle).
    static func usesLayers(_ story: Story) -> Bool { !story.layers.isEmpty }

    /// What the viewer's chrome can cover, as shares of the canvas: the twin
    /// of `STORY_SAFE_AREA` in `packages/shared/src/stories.ts`.
    static let safeAreaX: CGFloat = 0.05
    static let safeAreaTop: CGFloat = 0.10
    static let safeAreaBottom: CGFloat = 0.13

    /// The biggest size (34 pt, as it always was, down to 12) at which `text`,
    /// wrapped to `box`, still fits its height. Measured, not left to
    /// `minimumScaleFactor`: that one shrinks a long unbroken word to a speck
    /// because it first tries to keep the word on one line.
    static func legacyFontSize(text: String, in box: CGSize) -> CGFloat {
        guard !text.isEmpty, box.width > 0, box.height > 0 else { return 34 }
        var size: CGFloat = 34
        while size > 12 {
            let base = UIFont.systemFont(ofSize: size, weight: .heavy)
            let font = base.fontDescriptor.withDesign(.rounded).map { UIFont(descriptor: $0, size: size) } ?? base
            let rect = (text as NSString).boundingRect(
                with: CGSize(width: box.width - 4, height: .greatestFiniteMagnitude),
                options: [.usesLineFragmentOrigin, .usesFontLeading],
                attributes: [.font: font], context: nil
            )
            if ceil(rect.height) <= box.height { return size }
            size -= 1
        }
        return 12
    }

    /// Where a text story from before layers draws its words, in the card's
    /// own coordinates: the canvas less its safe area (the web's
    /// `usableBox`), and never under the footer. With the keyboard up the
    /// footer (reactions and the reply field) rides above it and is far
    /// taller than the 13% the safe area keeps, so `footerTop` (its measured
    /// top edge) pulls the bottom up and the words shrink into what is left
    /// instead of printing over the header, the pill and the field.
    static let minHeight: CGFloat = 24

    static func legacyTextBox(canvas: CGRect, headerBottom: CGFloat? = nil, footerTop: CGFloat?, gap: CGFloat = 12) -> CGRect {
        let left = canvas.minX + canvas.width * safeAreaX
        let right = canvas.maxX - canvas.width * safeAreaX
        var top = canvas.minY + canvas.height * safeAreaTop
        if let headerBottom, headerBottom + gap > top { top = headerBottom + gap }
        var bottom = canvas.maxY - canvas.height * safeAreaBottom
        if let footerTop, footerTop - gap < bottom { bottom = footerTop - gap }
        // Never collapse to nothing, and never reach past the footer: on a
        // short phone with the keyboard up the box keeps a line's height and
        // grows UP into the header's band rather than down over the field.
        if bottom - top < minHeight { top = bottom - minHeight }
        return CGRect(x: left, y: top, width: right - left, height: bottom - top)
    }
}

/// The base, under the layers.
struct StoryStageBase: View {
    let story: Story
    let player: AVPlayer?
    let size: CGSize
    /// Everything the story draws is in memory, decoded: now, and not before,
    /// the story is drawn, all of it in one frame. Until then nothing of it
    /// shows (a video's player is the one thing that exists, hidden, because
    /// its first frame is part of what is waited for).
    var revealed = true
    /// A video's first frame is on its layer.
    var onFirstFrame: (() -> Void)?
    /// The bottom of the header and the top of the footer in this view's
    /// coordinates, handed over while the keyboard is up (the canvas shrinks
    /// with it and the chrome no longer sits inside its margins).
    var headerBottom: CGFloat?
    var footerTop: CGFloat?

    var body: some View {
        let canvas = StoryStage.canvas(in: size)
        ZStack {
            if revealed { backdrop }
            if story.isText {
                if revealed, !StoryStage.usesLayers(story) {
                    // From before layers: the words, sized into the safe area
                    // (never under the header or the footer) and centered in it.
                    let box = StoryStage.legacyTextBox(canvas: canvas, headerBottom: headerBottom, footerTop: footerTop)
                    Text(verbatim: story.text ?? "")
                        .font(.system(size: StoryStage.legacyFontSize(text: story.text ?? "", in: box.size), weight: .heavy, design: .rounded))
                        .foregroundStyle(.white)
                        .multilineTextAlignment(.center)
                        .frame(width: box.width, height: box.height)
                        .position(x: box.midX, y: box.midY)
                        .animation(.easeOut(duration: 0.2), value: box.height)
                }
            } else if let media = story.media {
                mediaView(media)
                    .frame(width: canvas.width, height: canvas.height)
                    .clipped()
            }
        }
        .frame(width: size.width, height: size.height)
        .clipped()
    }

    /// Fills the whole card: the card's background color, or a blurred copy of
    /// the picture (the poster, for a video).
    @ViewBuilder
    private var backdrop: some View {
        if story.isText {
            StoryRules.backgroundGradient(story.background)
        } else if let media = story.media {
            let source = media.isVideo ? media.posterUrl : media.url
            ZStack {
                Color.black
                if let url = source.flatMap({ Avatar.resolve($0) ?? URL(string: $0) }) {
                    StoryCachedImage(url: url, contentMode: .fill) { _ in Color.clear }
                        .blur(radius: 32).scaleEffect(1.12).overlay(Color.black.opacity(0.28))
                }
            }
        } else {
            Color.black
        }
    }

    @ViewBuilder
    private func mediaView(_ media: StoryMedia) -> some View {
        let fills = StoryStage.fillsCanvas(width: media.width, height: media.height)
        ZStack {
            if media.isVideo {
                // A video that does not fill the canvas sits on black, as it did
                // in the editor.
                if revealed, !fills { Color.black }
                // The poster is under the player: there is a picture from the
                // first frame, and the video replaces it when it has its own.
                if revealed, let poster = Avatar.resolve(media.posterUrl) ?? media.posterUrl.flatMap(URL.init(string:)) {
                    StoryCachedImage(url: poster, contentMode: fills ? .fill : .fit, metric: "poster") { _ in Color.clear }
                }
                // Always there (its first frame is what the reveal waits for),
                // and seen only with the rest. The sound button lives in the
                // viewer's top bar, with the other controls.
                if let player {
                    StoryVideoSurface(player: player, fills: fills, onReady: onFirstFrame)
                        .opacity(revealed ? 1 : 0)
                }
            } else if revealed, let url = Avatar.resolve(media.url) ?? URL(string: media.url) {
                // Under the blurred backdrop while it loads; the viewer adds a
                // spinner if it is late.
                StoryCachedImage(url: url, contentMode: fills ? .fill : .fit, metric: "base") { failed in
                    if failed {
                        Image(systemName: "photo").foregroundStyle(Palette.paperMuted)
                    } else {
                        Color.clear
                    }
                }
            }
        }
        .clipped()
    }
}

/// The layers, over the base and over the tap zones. Only the call sticker's
/// door and a mention take touches; everything else lets them through to the
/// tap zones underneath, so a tap on a title still goes to the next story.
struct StoryLayersOverlay: View {
    let story: Story
    let size: CGSize
    let callData: (StoryLayer) -> StoryCallStickerData?
    let reduceMotion: Bool
    let onJoin: (StoryLayer) -> Void
    let onMention: (String) -> Void

    var body: some View {
        let canvas = StoryStage.canvas(in: size)
        let context = StoryLayerContext(
            canvas: canvas.size, previews: [:], call: callData,
            onJoin: onJoin, onMention: onMention, reduceMotion: reduceMotion
        )
        ZStack {
            ForEach(story.layers) { layer in
                StoryPlacedLayer(
                    layer: layer, context: context, interactive: true,
                    spoken: layer.isInteractiveInViewer || layer.hasUnspokenAlt(in: story)
                )
                    .allowsHitTesting(layer.isInteractiveInViewer)
            }
        }
        .frame(width: canvas.width, height: canvas.height)
        // A layer dragged half off the canvas is clipped at the canvas edge,
        // as it was in the editor.
        .clipped()
        .position(x: size.width / 2, y: size.height / 2)
        .frame(width: size.width, height: size.height)
    }
}

extension StoryLayer {
    /// A placed photo the author described, when the story's own `altText` does
    /// not already say it (a build that wrote the layer's `alt` and nothing in
    /// `altText`): the viewer names the photo then, and only then, so a screen
    /// reader never hears the same description twice.
    func hasUnspokenAlt(in story: Story) -> Bool {
        guard case .image(let picture) = content, let alt = StoryAltText.clean(picture.alt) else { return false }
        return !StoryAltText.says(alt, in: story.altText ?? "")
    }

    /// Calls and mentions are doors; text, photos and drawings are only seen.
    var isInteractiveInViewer: Bool {
        switch content {
        case .call, .mention: true
        case .text, .image, .drawing: false
        }
    }
}

extension StoryCallStickerData {
    /// From the live state the server answers for the call layer, plus what
    /// the viewer already knows about the server.
    init(live: StoryCallLive, serverName: String, serverIconUrl: String?) {
        let state: State
        switch live.state {
        case "live": state = .live
        case "full": state = .full
        default: state = .ended
        }
        self.init(
            roomName: live.channelName.isEmpty ? String(localized: "Call") : live.channelName,
            serverName: serverName, serverId: live.serverId,
            serverIconUrl: serverIconUrl, participants: live.participants, count: live.count,
            state: state, joinable: live.joinable
        )
    }
}

extension Story {
    /// The caption pill of a story from before layers. A story with text layers
    /// has those words twice (the author's build copies them into `caption` for
    /// older builds): the layers draw them where the author put them, so the
    /// pill is not drawn. Same rule as the web viewer (`showLegacyText`).
    var legacyCaption: String? {
        guard !isText, let caption, !caption.isEmpty else { return nil }
        if layers.contains(where: { $0.isText }) { return nil }
        return caption
    }

    /// What a screen reader says for the story: the alt text the author's app
    /// wrote, else the caption, else the text of a card.
    var spokenDescription: String? {
        for candidate in [altText, caption, text] {
            if let candidate, !candidate.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { return candidate }
        }
        return nil
    }
}
