@preconcurrency import AVFoundation
import SwiftUI
import UIKit

/// A video past 30 s is not refused: the person picks the 30 s that go in the
/// story. A filmstrip of the whole clip, a window of exactly the limit that
/// slides along it, and the chosen part looping above.
struct StoryTrimRequest: Identifiable {
    let id = UUID()
    let url: URL
    let durationMs: Int
}

struct StoryTrimView: View {
    let request: StoryTrimRequest
    let onUse: (Int) -> Void
    let onCancel: () -> Void

    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var startMs = 0
    @State private var dragOrigin: Int?
    @State private var thumbnails: [UIImage] = []
    @State private var player = AVPlayer()
    @State private var observer: Any?
    @State private var edgeTick = 0

    private let maxMs = StoryLimits.maxVideoMs
    private let stripHeight: CGFloat = 64

    private var kept: (startMs: Int, lengthMs: Int) {
        StoryTrim.keptRange(startMs: startMs, durationMs: request.durationMs, maxMs: maxMs)
    }

    var body: some View {
        ZStack {
            Color.black.ignoresSafeArea()
            VStack(spacing: 18) {
                HStack {
                    Button(action: onCancel) {
                        Image(systemName: "xmark")
                            .font(.system(size: 16, weight: .bold))
                            .foregroundStyle(.white)
                            .frame(width: 40, height: 40)
                            .background(Circle().fill(.white.opacity(0.14)))
                    }
                    .accessibilityLabel(Text("Close"))
                    .accessibilityIdentifier("trim.close")
                    Spacer()
                }
                .padding(.horizontal, 14)

                LoopPlayerView(player: player)
                    .aspectRatio(9 / 16, contentMode: .fit)
                    .clipShape(RoundedRectangle(cornerRadius: 18, style: .continuous))
                    .frame(maxHeight: .infinity)
                    .padding(.horizontal, 36)
                    .accessibilityHidden(true)

                VStack(spacing: 6) {
                    Text(verbatim: String(localized: "This video is \(StoryRecordingClock.label(Double(request.durationMs) / 1000)). Pick the 30 s that go in your story."))
                        .font(Typography.callout)
                        .foregroundStyle(.white.opacity(0.85))
                        .multilineTextAlignment(.center)
                        .fixedSize(horizontal: false, vertical: true)
                        .padding(.horizontal, 28)
                    Text(verbatim: StoryTrim.label(startMs: kept.startMs, lengthMs: kept.lengthMs))
                        .font(.system(size: 15, weight: .bold))
                        .monospacedDigit()
                        .foregroundStyle(Palette.signal)
                        .accessibilityIdentifier("trim.range")
                }

                strip
                    .padding(.horizontal, 20)

                Button {
                    onUse(kept.startMs)
                } label: {
                    Text("Use this part")
                        .font(.system(size: 16, weight: .bold))
                        .foregroundStyle(Palette.inkDeep)
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 14)
                        .background(Capsule().fill(Palette.signal))
                }
                .padding(.horizontal, 20)
                .padding(.bottom, 10)
                .accessibilityIdentifier("trim.use")
            }
        }
        .preferredColorScheme(.dark)
        .sensoryFeedback(.impact(flexibility: .soft, intensity: 0.6), trigger: edgeTick)
        .task { await load() }
        .onChange(of: startMs) { _, _ in rewindWindow() }
        .onDisappear {
            player.pause()
            if let observer { player.removeTimeObserver(observer) }
        }
    }

    // MARK: Strip

    private var strip: some View {
        GeometryReader { proxy in
            let width = proxy.size.width
            let windowWidth = max(60, width * CGFloat(min(1, Double(maxMs) / Double(max(1, request.durationMs)))))
            let travel = max(0, width - windowWidth)
            let maxStart = max(1, StoryTrim.maxStartMs(durationMs: request.durationMs, maxMs: maxMs))
            let x = travel * CGFloat(Double(kept.startMs) / Double(maxStart))
            ZStack(alignment: .leading) {
                HStack(spacing: 0) {
                    ForEach(Array(thumbnails.enumerated()), id: \.offset) { _, image in
                        Image(uiImage: image)
                            .resizable()
                            .scaledToFill()
                            .frame(width: width / CGFloat(max(1, thumbnails.count)), height: stripHeight)
                            .clipped()
                    }
                }
                .frame(width: width, height: stripHeight)
                .background(Color.white.opacity(0.08))
                .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
                .overlay(Color.black.opacity(0.55).clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous)))

                RoundedRectangle(cornerRadius: 10, style: .continuous)
                    .strokeBorder(Palette.signal, lineWidth: 3)
                    .frame(width: windowWidth, height: stripHeight)
                    .background(
                        RoundedRectangle(cornerRadius: 10, style: .continuous).fill(.white.opacity(0.06))
                    )
                    .offset(x: x)
            }
            .frame(width: width, height: stripHeight)
            .contentShape(Rectangle())
            .gesture(
                DragGesture(minimumDistance: 0)
                    .onChanged { value in
                        guard travel > 0 else { return }
                        // The window follows the finger from wherever it was
                        // grabbed: no jump to the fingertip.
                        let origin = dragOrigin ?? kept.startMs
                        dragOrigin = origin
                        let delta = Double(value.translation.width / travel) * Double(maxStart)
                        let next = StoryTrim.clampedStartMs(origin + Int(delta), durationMs: request.durationMs, maxMs: maxMs)
                        if (next == 0 || next == maxStart) && next != startMs { edgeTick += 1 }
                        startMs = next
                    }
                    .onEnded { _ in dragOrigin = nil }
            )
            .accessibilityElement()
            .accessibilityLabel(Text("Part of the video"))
            .accessibilityValue(Text(verbatim: StoryTrim.label(startMs: kept.startMs, lengthMs: kept.lengthMs)))
            .accessibilityAdjustableAction { direction in
                let step = 2_000
                switch direction {
                case .increment: startMs = StoryTrim.clampedStartMs(startMs + step, durationMs: request.durationMs, maxMs: maxMs)
                case .decrement: startMs = StoryTrim.clampedStartMs(startMs - step, durationMs: request.durationMs, maxMs: maxMs)
                @unknown default: break
                }
            }
            .accessibilityIdentifier("trim.strip")
        }
        .frame(height: stripHeight)
    }

    // MARK: Playback

    private func load() async {
        let asset = AVURLAsset(url: request.url)
        let item = AVPlayerItem(asset: asset)
        player.replaceCurrentItem(with: item)
        player.isMuted = true
        player.play()
        observer = player.addPeriodicTimeObserver(forInterval: CMTime(seconds: 0.1, preferredTimescale: 600), queue: .main) { time in
            let end = Double(kept.startMs + kept.lengthMs) / 1000
            if time.seconds >= end - 0.05 { rewindWindow() }
        }

        let generator = AVAssetImageGenerator(asset: asset)
        generator.appliesPreferredTrackTransform = true
        generator.maximumSize = CGSize(width: 160, height: 160)
        let count = 10
        let step = Double(request.durationMs) / 1000 / Double(count)
        var frames: [UIImage] = []
        for index in 0..<count {
            let time = CMTime(seconds: step * (Double(index) + 0.5), preferredTimescale: 600)
            if let image = try? await generator.image(at: time).image { frames.append(UIImage(cgImage: image)) }
        }
        thumbnails = frames
    }

    private func rewindWindow() {
        let target = CMTime(seconds: Double(kept.startMs) / 1000, preferredTimescale: 600)
        player.seek(to: target, toleranceBefore: .zero, toleranceAfter: .zero)
        if player.timeControlStatus != .playing { player.play() }
    }
}

/// An `AVPlayerLayer` with no controls: a loop, not a player.
private struct LoopPlayerView: UIViewRepresentable {
    let player: AVPlayer

    final class View: UIView {
        override class var layerClass: AnyClass { AVPlayerLayer.self }
        var playerLayer: AVPlayerLayer { layer as! AVPlayerLayer }
    }

    func makeUIView(context: Context) -> View {
        let view = View()
        view.playerLayer.player = player
        view.playerLayer.videoGravity = .resizeAspectFill
        view.backgroundColor = .black
        return view
    }

    func updateUIView(_ uiView: View, context: Context) {}
}
