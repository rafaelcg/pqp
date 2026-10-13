import AVFoundation
import SwiftUI
import UIKit

/// The viewer's picture of a story: the base (a photo, a video, a card
/// background) and, over it, every layer the author placed, on the 9:16 canvas
/// the editor drew them on.
///
/// The canvas is a 9:16 box that COVERS the card, centered: on a tall phone it
/// is as tall as the screen and a little wider than it, so the strip of canvas
/// past each side is clipped, layers included, as on the web. Everything the
/// author placed is a fraction of the canvas, so it sits where they put it.
enum StoryStage {
    /// The smallest 9:16 box that covers `size`, centered on it.
    static func canvas(in size: CGSize) -> CGRect {
        let width = max(size.width, size.height * StoryCanvas.aspect)
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
            Color.black
            if story.isText {
                LinearGradient(colors: StoryRules.backgroundColors(story.background), startPoint: .top, endPoint: .bottom)
                if !StoryStage.usesLayers(story) {
                    // From before layers: the line in the middle, as it was.
                    Text(verbatim: story.text ?? "")
                        .font(.system(size: 34, weight: .heavy, design: .rounded))
                        .foregroundStyle(.white)
                        .multilineTextAlignment(.center)
                        .minimumScaleFactor(0.5)
                        .padding(.horizontal, 28)
                }
            } else if let media = story.media {
                mediaView(media)
            }
        }
        .frame(width: canvas.width, height: canvas.height)
        .position(x: size.width / 2, y: size.height / 2)
        .frame(width: size.width, height: size.height)
        .clipped()
    }

    @ViewBuilder
    private func mediaView(_ media: StoryMedia) -> some View {
        let fills = StoryStage.fillsCanvas(width: media.width, height: media.height)
        ZStack {
            // A photo that does not fill the canvas sits over a blurred copy of
            // itself; a video, over black.
            if !fills, !media.isVideo, let url = Avatar.resolve(media.url) ?? URL(string: media.url) {
                AsyncImage(url: url) { phase in
                    if case .success(let image) = phase {
                        image.resizable().scaledToFill().blur(radius: 28).scaleEffect(1.15).overlay(Color.black.opacity(0.25))
                    }
                }
                .clipped()
            }
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
        .position(x: size.width / 2, y: size.height / 2)
        .frame(width: size.width, height: size.height)
        // Layers outside the card are clipped, as the author's canvas was.
        .clipped()
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
            roomName: live.channelName, serverName: serverName, serverId: live.serverId,
            serverIconUrl: serverIconUrl, participants: live.participants, count: live.count,
            state: state, joinable: live.joinable
        )
    }
}

extension Story {
    /// What a screen reader says for the story: the alt text the author's app
    /// wrote, else the caption, else the text of a card.
    var spokenDescription: String? {
        for candidate in [altText, caption, text] {
            if let candidate, !candidate.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { return candidate }
        }
        return nil
    }
}
