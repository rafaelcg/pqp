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
}

/// The base, under the layers.
struct StoryStageBase: View {
    let story: Story
    let player: AVPlayer?
    @Binding var muted: Bool
    let size: CGSize

    var body: some View {
        let canvas = StoryStage.canvas(in: size)
        ZStack {
            backdrop
            if story.isText {
                if !StoryStage.usesLayers(story) {
                    // From before layers: the line in the middle, as it was.
                    Text(verbatim: story.text ?? "")
                        .font(.system(size: 34, weight: .heavy, design: .rounded))
                        .foregroundStyle(.white)
                        .multilineTextAlignment(.center)
                        .minimumScaleFactor(0.5)
                        .padding(.horizontal, 28)
                        .frame(width: canvas.width, height: canvas.height)
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
            LinearGradient(colors: StoryRules.backgroundColors(story.background), startPoint: .top, endPoint: .bottom)
        } else if let media = story.media {
            let source = media.isVideo ? media.posterUrl : media.url
            ZStack {
                Color.black
                if let url = source.flatMap({ Avatar.resolve($0) ?? URL(string: $0) }) {
                    AsyncImage(url: url) { phase in
                        if case .success(let image) = phase {
                            image.resizable().scaledToFill().blur(radius: 32).scaleEffect(1.12).overlay(Color.black.opacity(0.28))
                        }
                    }
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
            // A video that does not fill the canvas sits on black, as it did
            // in the editor.
            if media.isVideo, !fills { Color.black }
            if media.isVideo, let player {
                StoryVideoSurface(player: player, fills: fills)
                    .overlay(alignment: .topTrailing) {
                        Button {
                            muted.toggle()
                            player.isMuted = muted
                        } label: {
                            Image(systemName: muted ? "speaker.slash.fill" : "speaker.wave.2.fill")
                                .font(.system(size: 14, weight: .semibold))
                                .foregroundStyle(.white)
                                .padding(10)
                                .background(Circle().fill(.black.opacity(0.4)))
                        }
                        .padding(.top, 90)
                        .padding(.trailing, 14)
                        .accessibilityLabel(Text(muted ? "Turn the sound on" : "Turn the sound off"))
                    }
            } else if let url = Avatar.resolve(media.url) ?? URL(string: media.url) {
                AsyncImage(url: url) { phase in
                    switch phase {
                    case .success(let image):
                        image.resizable().aspectRatio(contentMode: fills ? .fill : .fit)
                    case .failure:
                        Image(systemName: "photo").foregroundStyle(Palette.paperMuted)
                    default:
                        ProgressView().tint(.white)
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
                StoryPlacedLayer(layer: layer, context: context, interactive: true, spoken: layer.isInteractiveInViewer)
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
